import { describe, expect, test } from "bun:test";
import { chatArgs, cliArgs, cliEnv, createClaudeCode, parseCliOutput, remoteCommand } from "./claude-code.ts";
import { fakeModelBin } from "./testing.ts";
import type { ClaudeCodeSpec, CompleteInput } from "./types.ts";

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ prompt: "hello", system: "Be brief.", model: "haiku", tag: "t", tools: [], timeoutMs: 5000, maxTokens: 100, ...over });
const spec = (over: Partial<ClaudeCodeSpec> = {}): ClaudeCodeSpec => ({ name: "claude", kind: "claude-code", bin: fakeModelBin(), chatArgs: [], ...over });

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

describe("complete, locally", () => {
  const runtime = createClaudeCode(spec());

  test("runs the CLI, feeds the prompt on stdin and returns usage and cost", async () => {
    expect(runtime.backend).toBe("local");
    expect(runtime.capabilities).toEqual({ complete: true, agent: true, chat: true });
    const r = await runtime.complete(input({ tools: ["WebSearch"] }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.text).toBe("answer to: hello [args: -p --output-format json --model haiku --strict-mcp-config --tools WebSearch --allowedTools WebSearch --system-prompt Be brief.]");
    expect(r.usage).toEqual({ inputTokens: 10, cacheWriteTokens: 30, cacheReadTokens: 40, outputTokens: 20 });
    expect(r.costUsd).toBe(0.0123);
  });

  test("the thinking cap reaches the runtime's environment", async () => {
    const r = await runtime.complete(input({ thinking: 0 }));
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining("[thinking: 0]") });
    const none = await runtime.complete(input());
    expect(none).toMatchObject({ ok: true, text: expect.not.stringContaining("[thinking:") });
  });

  test("plain output (an older CLI) is the answer with no usage", async () => {
    process.env.FAKE_MODEL_MODE = "plain";
    try {
      const r = await runtime.complete(input());
      expect(r).toEqual({ ok: true, text: "plain answer to: hello", backend: "local" });
    } finally {
      delete process.env.FAKE_MODEL_MODE;
    }
  });

  test("an is_error envelope, a crash and a timeout are failures with the reason", async () => {
    try {
      process.env.FAKE_MODEL_MODE = "error";
      expect(await runtime.complete(input())).toMatchObject({ ok: false, error: "simulated runtime failure", usage: { inputTokens: 5 } });
      process.env.FAKE_MODEL_MODE = "exit";
      expect(await runtime.complete(input())).toMatchObject({ ok: false, error: "simulated crash" });
      process.env.FAKE_MODEL_MODE = "hang";
      expect(await runtime.complete(input({ timeoutMs: 200 }))).toMatchObject({ ok: false, error: "timed out after 0s" });
    } finally {
      delete process.env.FAKE_MODEL_MODE;
    }
  });

  test("a missing binary fails without throwing", async () => {
    const r = await createClaudeCode(spec({ bin: ["/nonexistent/claude-bin"] })).complete(input());
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("could not start") });
  });
});

describe("complete, over ssh", () => {
  test("the remote command is built from validated pieces only", async () => {
    const runtime = createClaudeCode(spec({ sshHost: "box" }));
    expect(runtime.backend).toBe("ssh:box");
    const r = await runtime.complete(input({ model: "x y" }));
    expect(r).toMatchObject({ ok: false, error: "argument not allowed over ssh: x y", backend: "ssh:box" });
    expect(() => createClaudeCode(spec({ sshHost: "box; rm" }))).toThrow(/not a host name/);
  });
});

describe("agent runs", () => {
  test("stay local even when answers go over ssh, and read the same envelope", async () => {
    const runtime = createClaudeCode(spec({ sshHost: "box" }));
    const r = await runtime.runAgent({ prompt: "do it", cwd: process.cwd(), env: process.env, model: "sonnet", signal: new AbortController().signal });
    expect(r).toMatchObject({ ok: true, backend: "local", text: expect.stringContaining("answer to: do it [args: -p --output-format json --model sonnet]"), usage: { inputTokens: 10 }, costUsd: 0.0123, timedOut: false });
    expect(r.output).toContain('"type":"result"');
  });

  test("a stop is a timeout with whatever came out; a crash keeps the output", async () => {
    const runtime = createClaudeCode(spec());
    process.env.FAKE_MODEL_MODE = "hang";
    try {
      const r = await runtime.runAgent({ prompt: "x", cwd: process.cwd(), env: process.env, signal: AbortSignal.timeout(150) });
      expect(r).toMatchObject({ ok: false, error: "timed out", timedOut: true });
      process.env.FAKE_MODEL_MODE = "exit";
      expect(await runtime.runAgent({ prompt: "x", cwd: process.cwd(), env: process.env, signal: new AbortController().signal })).toMatchObject({ ok: false, error: "exit code 3", output: expect.stringContaining("simulated crash") });
    } finally {
      delete process.env.FAKE_MODEL_MODE;
    }
  });
});

describe("chatArgs", () => {
  test("builds the stream-json command line with the spec's extra arguments last", () => {
    expect(chatArgs({ message: "hi", cwd: "/x" })).toEqual(["-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(chatArgs({ message: "hi", cwd: "/x", model: "opus", sessionId: "abc12345", permissionMode: "acceptEdits", systemPrompt: "S", allowedTools: ["Read", "Bash(ls *)"] }, ["--z"])).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "opus", "--resume", "abc12345", "--permission-mode", "acceptEdits", "--append-system-prompt", "S", "--allowedTools", "Read,Bash(ls *)", "--z",
    ]);
    expect(chatArgs({ message: "hi", cwd: "/x", permissionMode: "root" })).not.toContain("--permission-mode");
  });
});
