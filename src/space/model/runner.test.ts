import { describe, expect, test } from "bun:test";
import { API_MODELS, apiCost, cliArgs, createRunner, parseCliOutput } from "./runner.ts";
import { fakeModelBin } from "./testing.ts";
import type { RunInput } from "./types.ts";

const input = (over: Partial<RunInput> = {}): RunInput => ({ prompt: "hello", model: "haiku", tag: "t", tools: [], timeoutMs: 5000, maxTokens: 100, ...over });

describe("cliArgs", () => {
  test("prompt stays off the command line; tools become --allowedTools", () => {
    expect(cliArgs(["claude"], input())).toEqual(["claude", "-p", "--output-format", "json", "--model", "haiku"]);
    expect(cliArgs(["claude"], input({ tools: ["WebSearch", "WebFetch"] }))).toEqual(["claude", "-p", "--output-format", "json", "--model", "haiku", "--allowedTools", "WebSearch,WebFetch"]);
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
    expect(r.text).toBe("answer to: hello [args: -p --output-format json --model haiku --allowedTools WebSearch]");
    expect(r.usage).toEqual({ inputTokens: 10, cacheWriteTokens: 30, cacheReadTokens: 40, outputTokens: 20 });
    expect(r.costUsd).toBe(0.0123);
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
    expect(calls[0]!.body).toMatchObject({ model: API_MODELS.haiku, max_tokens: 100, messages: [{ role: "user", content: "hello" }] });
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
