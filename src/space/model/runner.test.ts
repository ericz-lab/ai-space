import { describe, expect, test } from "bun:test";
import { API_MODELS, apiCost, cliArgs, cliEnv, createRunner, parseCliOutput, remoteCommand } from "./runner.ts";
import { fakeModelBin } from "./testing.ts";
import type { RunInput } from "./types.ts";

const input = (over: Partial<RunInput> = {}): RunInput => ({ prompt: "hello", system: "Be brief.", model: "haiku", tag: "t", tools: [], timeoutMs: 5000, maxTokens: 100, ...over });

describe("cliArgs", () => {
  test("lean by default: own system prompt, no tools, no MCP; the prompt stays off the command line", () => {
    expect(cliArgs(["claude"], input())).toEqual(["claude", "-p", "--output-format", "json", "--model", "haiku", "--strict-mcp-config", "--tools", "", "--system-prompt", "Be brief."]);
    expect(cliArgs(["claude"], input({ tools: ["WebSearch", "WebFetch"] }))).toEqual([
      "claude", "-p", "--output-format", "json", "--model", "haiku", "--strict-mcp-config", "--tools", "WebSearch,WebFetch", "--allowedTools", "WebSearch,WebFetch", "--system-prompt", "Be brief.",
    ]);
  });
});

describe("remoteCommand", () => {
  test("the system prompt goes base64, empty tools stay quoted, unsafe words are refused", () => {
    const b64 = Buffer.from("Be brief.").toString("base64");
    expect(remoteCommand(["claude"], input())).toEqual({ command: `claude -p --output-format json --model haiku --strict-mcp-config --tools "" --system-prompt "$(printf %s ${b64} | base64 -d)"` });
    expect(remoteCommand(["claude"], input({ tools: ["WebSearch"] }))).toEqual({
      command: `claude -p --output-format json --model haiku --strict-mcp-config --tools WebSearch --allowedTools WebSearch --system-prompt "$(printf %s ${b64} | base64 -d)"`,
    });
    expect(remoteCommand(["claude"], input({ thinking: 0 }))).toEqual({ command: `MAX_THINKING_TOKENS=0 claude -p --output-format json --model haiku --strict-mcp-config --tools "" --system-prompt "$(printf %s ${b64} | base64 -d)"` });
    expect(cliEnv(input(), { A: "1" })).toEqual({ A: "1" });
    expect(cliEnv(input({ thinking: 2048 }), { A: "1" })).toEqual({ A: "1", MAX_THINKING_TOKENS: "2048" });
    expect(remoteCommand(["claude"], input({ model: "x y" }))).toEqual({ bad: "x y" });
    expect(remoteCommand(["claude"], input({ system: "'; rm -rf / #" }))).toMatchObject({ command: expect.not.stringContaining("rm -rf") });
  });

  test("the remote shell decodes the system prompt back to the original text", async () => {
    const r = remoteCommand(["claude"], input({ system: "Ünïcode 中文 'quotes' $HOME `x`" }));
    if ("bad" in r) throw new Error(r.bad);
    // Run the same shell string with a stand-in for claude that prints its last argument: the decoded system prompt.
    const script = `claude() { printf %s "\${@: -1}"; }; ${r.command}`;
    const out = await new Response(Bun.spawn(["bash", "-c", script], { stdout: "pipe" }).stdout).text();
    expect(out).toBe("Ünïcode 中文 'quotes' $HOME `x`");
  });
});

describe("parseCliOutput", () => {
  test("reads the envelope, reports is_error, ignores anything else", () => {
    expect(parseCliOutput(JSON.stringify({ type: "result", result: " hi ", total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 } }))).toEqual({
      text: "hi",
      costUsd: 0.5,
      usage: { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 3, outputTokens: 2 },
    });
    expect(parseCliOutput(JSON.stringify({ type: "result", is_error: true, result: "boom" }))).toEqual({ error: "boom", usage: undefined, costUsd: undefined });
    expect(parseCliOutput(JSON.stringify({ type: "result", result: "" }))).toMatchObject({ error: "empty answer" });
    expect(parseCliOutput("plain text")).toBeUndefined();
    expect(parseCliOutput(JSON.stringify({ type: "assistant" }))).toBeUndefined();
  });
});

describe("local backend", () => {
  const runner = createRunner({ bin: fakeModelBin(), env: {} });

  test("runs the CLI, feeds the prompt on stdin and returns usage and cost", async () => {
    expect(runner.backend).toBe("local");
    const r = await runner.run(input({ tools: ["WebSearch"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.text).toBe("answer to: hello [args: -p --output-format json --model haiku --strict-mcp-config --tools WebSearch --allowedTools WebSearch --system-prompt Be brief.]");
    expect(r.usage).toEqual({ inputTokens: 10, cacheWriteTokens: 30, cacheReadTokens: 40, outputTokens: 20 });
    expect(r.costUsd).toBe(0.0123);
  });

  test("the thinking cap reaches the runtime's environment", async () => {
    const r = await runner.run(input({ thinking: 0 }));
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining("[thinking: 0]") });
    const none = await runner.run(input());
    expect(none).toMatchObject({ ok: true, text: expect.not.stringContaining("[thinking:") });
  });

  test("plain output (an older CLI) is the answer with no usage", async () => {
    process.env.FAKE_MODEL_MODE = "plain";
    try {
      const r = await runner.run(input());
      expect(r).toEqual({ ok: true, text: "plain answer to: hello", backend: "local" });
    } finally {
      delete process.env.FAKE_MODEL_MODE;
    }
  });

  test("an is_error envelope, a crash and a timeout are failures with the reason", async () => {
    try {
      process.env.FAKE_MODEL_MODE = "error";
      expect(await runner.run(input())).toMatchObject({ ok: false, error: "simulated runtime failure", usage: { inputTokens: 5 } });
      process.env.FAKE_MODEL_MODE = "exit";
      expect(await runner.run(input())).toMatchObject({ ok: false, error: "simulated crash" });
      process.env.FAKE_MODEL_MODE = "hang";
      expect(await runner.run(input({ timeoutMs: 200 }))).toMatchObject({ ok: false, error: "timed out after 0s" });
    } finally {
      delete process.env.FAKE_MODEL_MODE;
    }
  });

  test("a missing binary fails without throwing", async () => {
    const r = await createRunner({ bin: ["/nonexistent/claude-bin"], env: {} }).run(input());
    expect(r.ok).toBe(false);
  });
});

describe("ssh backend", () => {
  test("the remote command is built from validated pieces only", async () => {
    const runner = createRunner({ sshHost: "box", env: {} });
    expect(runner.backend).toBe("ssh:box");
    const r = await runner.run(input({ model: "x y" }));
    expect(r).toMatchObject({ ok: false, error: "argument not allowed over ssh: x y", backend: "ssh:box" });
    expect(() => createRunner({ sshHost: "box; rm", env: {} })).toThrow(/not a host name/);
  });
});

describe("api backend", () => {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const reply = { status: 200, body: {} as unknown };
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const runner = createRunner({ apiKey: "sk-test", fetch: fakeFetch, env: {} });

  test("maps aliases to model ids, sends the key, reads usage and prices it", async () => {
    reply.body = { content: [{ type: "text", text: "hi there" }], usage: { input_tokens: 1_000_000, output_tokens: 0 } };
    const r = await runner.run(input());
    expect(r).toEqual({ ok: true, text: "hi there", usage: { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }, costUsd: 1, backend: "api" });
    expect(calls[0]!.body).toMatchObject({ model: API_MODELS.haiku, max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: "hello" }] });
    expect(calls[0]!.headers["x-api-key"]).toBe("sk-test");
  });

  test("an unknown model is passed through with no cost; errors carry the status", async () => {
    reply.body = { content: [{ type: "text", text: "x" }], usage: { input_tokens: 1, output_tokens: 1 } };
    const r = await runner.run(input({ model: "claude-future-9" }));
    expect(r).toMatchObject({ ok: true, costUsd: undefined });
    expect(calls.at(-1)!.body.model).toBe("claude-future-9");
    reply.status = 429;
    reply.body = { error: { message: "slow down" } };
    expect(await runner.run(input())).toEqual({ ok: false, error: "API 429: slow down", backend: "api" });
    reply.status = 200;
  });

  test("tools are refused rather than dropped", async () => {
    expect(await runner.run(input({ tools: ["WebSearch"] }))).toMatchObject({ ok: false, error: expect.stringMatching(/tools need the CLI backend/) });
  });

  test("apiCost uses the list prices", () => {
    expect(apiCost("claude-sonnet-5", { inputTokens: 1e6, cacheWriteTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(2 + 2.5 + 0.2 + 10);
    expect(apiCost("nope", { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});
