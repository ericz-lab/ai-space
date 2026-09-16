import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOL_ROWS, buildPatch, createDeepseekHarness, dshCost, parseEvents, reasoningEffort, splitModel, translateEvent } from "./deepseek-harness.ts";
import { fakeDshBin } from "./testing-dsh.ts";
import type { CompleteInput, DeepseekHarnessSpec } from "./types.ts";

const input = (over: Partial<CompleteInput> = {}): CompleteInput => ({ prompt: "hello", system: "Be brief.", model: "deepseek-flash", tag: "t", tools: [], timeoutMs: 5000, maxTokens: 100, ...over });
const spec = (over: Partial<DeepseekHarnessSpec> = {}): DeepseekHarnessSpec => ({ name: "dsh", kind: "deepseek-harness", bin: fakeDshBin(), profile: "headless", ...over });

afterEach(() => {
  delete process.env.FAKE_DSH_MODE;
});

describe("buildPatch", () => {
  test("a lean answer: the system prompt replaced, thinking mapped, model set, every tool row off", () => {
    const patch = buildPatch({ system: 'Say "hi"\nonly.', model: "deepseek-flash", thinking: 0, leanTools: [] });
    expect(patch).toContain('personaPrefix: "Say \\"hi\\"\\nonly."');
    expect(patch).toContain("includeHarnessIdentity: false");
    expect(patch).toContain('reasoningEffort: "off"');
    expect(patch).toContain('provider: "deepseek-official"\n    model: "deepseek-flash"');
    for (const id of TOOL_ROWS) expect(patch).toContain(`- id: ${id}\n  disabled: true`);
    // The YAML is what the harness will read: it must parse back to the same rows.
    const rows = Bun.YAML.parse(patch) as { id: string; config?: Record<string, unknown>; disabled?: boolean }[];
    expect(rows[0]).toEqual({ id: "system-prompt", config: { includeHarnessIdentity: false, includeRuntimeContext: false, personaPrefix: 'Say "hi"\nonly.', personaSuffix: "" } });
    expect(rows.filter((r) => r.disabled)).toHaveLength(TOOL_ROWS.length);
  });

  test("web tools keep the web row; a chat persona keeps identity and tools; nothing asked gives an empty list", () => {
    const web = buildPatch({ system: "s", leanTools: ["WebSearch"] });
    expect(web).not.toContain("- id: tool-web");
    expect(web).toContain("- id: tool-bash");
    const chat = buildPatch({ persona: "You are the librarian." });
    expect(chat).toContain('personaPrefix: "You are the librarian."');
    expect(chat).not.toContain("includeHarnessIdentity");
    expect(chat).not.toContain("disabled");
    expect(buildPatch({})).toBe("[]\n");
    expect(buildPatch({ model: "zai:glm-5" })).toContain('provider: "zai"\n    model: "glm-5"');
  });

  test("helpers", () => {
    expect([undefined, 0, 1024, 4096, 20_000, 100_000].map(reasoningEffort)).toEqual([undefined, "off", "low", "low", "high", "max"]);
    expect(splitModel("deepseek-v4-pro")).toEqual({ provider: "deepseek-official", model: "deepseek-v4-pro" });
    expect(dshCost("deepseek-flash", { inputTokens: 1e6, cacheWriteTokens: 0, cacheReadTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(0.3 + 0.006 + 1.2);
    expect(dshCost("other", { inputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 })).toBeUndefined();
  });
});

describe("parseEvents", () => {
  test("sums the steps' usage, keeps the session id and the final text, reports a failed turn", () => {
    const lines = [
      { type: "session", sessionId: "session-1", cwd: "/x" },
      { type: "status", phase: "step_end", turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 } },
      { type: "status", phase: "step_end", turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 1 } },
      { type: "status", phase: "turn_end", turn: 1, reason: { kind: "completed" } },
      { type: "final", text: " pong " },
    ].map((e) => JSON.stringify(e));
    expect(parseEvents(`${lines.join("\n")}\nnot json\n`)).toEqual({ sessionId: "session-1", text: "pong", usage: { inputTokens: 150, cacheWriteTokens: 1, cacheReadTokens: 5, outputTokens: 12 }, final: true, error: undefined });
    const failed = [JSON.stringify({ type: "status", phase: "turn_end", turn: 1, reason: { kind: "error", error: { message: "no key" } } }), JSON.stringify({ type: "final", text: "" })].join("\n");
    expect(parseEvents(failed)).toMatchObject({ error: "no key", final: true, text: "" });
    expect(parseEvents(JSON.stringify({ type: "error", message: "bad session" }))).toMatchObject({ error: "bad session", final: false });
  });
});

describe("complete", () => {
  const runtime = createDeepseekHarness(spec());

  test("writes the overlay to a file, feeds the prompt on stdin, prices the summed usage", async () => {
    expect(runtime.backend).toBe("local");
    expect(runtime.capabilities).toEqual({ complete: true, agent: true, chat: true });
    const r = await runtime.complete(input({ thinking: 0 }));
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.text).toContain("answer to: hello [args: --profile headless --patch ");
    expect(r.text).toContain("--json -]");
    expect(r.text).toContain("[patch: system-prompt,llm-deepseek,agent-default-model,tool-bash,");
    expect(r.usage).toEqual({ inputTokens: 32, cacheWriteTokens: 0, cacheReadTokens: 640, outputTokens: 2 });
    expect(r.costUsd).toBeCloseTo((32 * 0.3 + 640 * 0.006 + 2 * 1.2) / 1e6);
  });

  test("DSH_HOME reaches the runtime when the spec names a home; foreign tools are refused", async () => {
    const r = await createDeepseekHarness(spec({ home: "/tmp/dsh-home" })).complete(input());
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining("[env: /tmp/dsh-home]") });
    expect(await runtime.complete(input({ tools: ["Bash(ls)"] }))).toMatchObject({ ok: false, error: "tools not available on this runtime: Bash(ls)" });
    const web = await runtime.complete(input({ tools: ["WebSearch"] }));
    expect(web).toMatchObject({ ok: true, text: expect.not.stringContaining("tool-web") });
  });

  test("a failed turn, a crash and a timeout are failures with the reason", async () => {
    process.env.FAKE_DSH_MODE = "error";
    expect(await runtime.complete(input())).toMatchObject({ ok: false, error: "simulated model failure" });
    process.env.FAKE_DSH_MODE = "crash";
    expect(await runtime.complete(input())).toMatchObject({ ok: false, error: "dsh: simulated crash" });
    process.env.FAKE_DSH_MODE = "hang";
    expect(await runtime.complete(input({ timeoutMs: 200 }))).toMatchObject({ ok: false, error: "timed out after 0s" });
    expect(await createDeepseekHarness(spec({ bin: ["/nonexistent/dsh"] })).complete(input())).toMatchObject({ ok: false, error: expect.stringContaining("could not start") });
  });

  test("over ssh the overlay travels base64 into a remote temp file; unsafe words are refused", async () => {
    const r = createDeepseekHarness(spec({ sshHost: "box", bin: ["/opt/dsh"] }));
    expect(r.backend).toBe("ssh:box");
    expect(await createDeepseekHarness(spec({ sshHost: "box", bin: ["d sh"] })).complete(input())).toMatchObject({ ok: false, error: "argument not allowed over ssh: d sh" });
    expect(() => createDeepseekHarness(spec({ sshHost: "box; rm" }))).toThrow(/not a host name/);
  });
});

describe("agent runs", () => {
  test("run the profile as configured with the prompt on stdin, a model overlay when named", async () => {
    const runtime = createDeepseekHarness(spec());
    const r = await runtime.runAgent({ prompt: "do it", cwd: process.cwd(), env: process.env, model: "deepseek-v4-pro", signal: new AbortController().signal });
    // (toMatchObject with an asymmetric matcher rewrites the received field in this Bun, so the text is checked on its own.)
    expect(r.text).toContain("answer to: do it [args: --profile headless --patch ");
    expect(r.text).toContain("[patch: agent-default-model]");
    expect(r).toMatchObject({ ok: true, backend: "local", usage: { inputTokens: 32 }, timedOut: false });
    expect(r.costUsd).toBeCloseTo((32 * 1.32 + 640 * 0.044 + 2 * 3.96) / 1e6);
    const plain = await runtime.runAgent({ prompt: "x", cwd: process.cwd(), env: process.env, signal: new AbortController().signal });
    expect(plain.text).toContain("[args: --profile headless --json -] [patch: ]");
    process.env.FAKE_DSH_MODE = "error";
    expect(await runtime.runAgent({ prompt: "x", cwd: process.cwd(), env: process.env, signal: new AbortController().signal })).toMatchObject({ ok: false, error: "simulated model failure", output: expect.stringContaining("MISSING_CREDENTIAL") });
  });
});

describe("chat", () => {
  const collect = (runtime: ReturnType<typeof createDeepseekHarness>, turn: Parameters<typeof runtime.chat>[0]) =>
    new Promise<{ events: Record<string, unknown>[]; sid?: string; error: string | null }>((resolve) => {
      const events: Record<string, unknown>[] = [];
      let sid: string | undefined;
      runtime.chat(turn, { onEvent: (l) => events.push(JSON.parse(l) as Record<string, unknown>), onSession: (s) => (sid = s), onFinish: (error) => resolve({ events, sid, error }) });
    });

  test("translates the harness's events into the panel's stream-json and reports the session", async () => {
    const runtime = createDeepseekHarness(spec());
    const { events, sid, error } = await collect(runtime, { message: "hi there", cwd: process.cwd(), systemPrompt: "You are the librarian.", model: "deepseek-flash" });
    expect(error).toBeNull();
    expect(sid).toBe("session-0000fake-0000-4000-8000-000000000001");
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"]);
    expect(events[0]).toMatchObject({ type: "system", subtype: "init", session_id: sid });
    const text = String((events[1] as { message: { content: { text: string }[] } }).message.content[0]!.text);
    expect(text).toContain("answer to: hi there");
    expect(text).toContain("[patch: system-prompt,agent-default-model]");
    expect(events[2]).toMatchObject({ type: "result", is_error: false, session_id: sid });
    // Resuming passes the id through.
    const again = await collect(runtime, { message: "more", cwd: process.cwd(), sessionId: "session-abc" });
    expect(again.sid).toBe("session-abc");
  });

  test("tool calls and failed results become tool_use and tool_result blocks; a failed turn is an error result", async () => {
    const runtime = createDeepseekHarness(spec());
    process.env.FAKE_DSH_MODE = "tools";
    const { events } = await collect(runtime, { message: "search", cwd: process.cwd() });
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
    expect((events[1] as { message: { content: unknown[] } }).message.content[0]).toEqual({ type: "tool_use", id: "call-1", name: "web_search", input: { queries: ["pong"] } });
    expect((events[2] as { message: { content: unknown[] } }).message.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "network down" });
    process.env.FAKE_DSH_MODE = "error";
    const failed = await collect(runtime, { message: "x", cwd: process.cwd() });
    expect(failed.error).toBe("simulated model failure");
    expect(failed.events.at(-1)).toMatchObject({ type: "result", is_error: true, result: "simulated model failure" });
  });

  test("translateEvent ignores thinking and status lines", () => {
    const state = {};
    expect(translateEvent(JSON.stringify({ type: "thinking", text: "hmm" }), state)).toEqual([]);
    expect(translateEvent(JSON.stringify({ type: "status", phase: "step_start" }), state)).toEqual([]);
    expect(translateEvent("garbage", state)).toEqual([]);
  });
});

describe("transcript", () => {
  let dir: string;
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("reads the session log under the harness home by the harness's own path encoding", async () => {
    dir = await mkdtemp(join(tmpdir(), "space-dsh-home-"));
    const cwd = "/srv/apps/notes";
    const sid = "session-11111111-2222-4333-8444-555555555555";
    const file = join(dir, "sessions", "--srv-apps-notes--", sid, "session.v3.jsonl");
    await Bun.write(file, "");
    const lines = [
      { type: "session", id: sid, cwd },
      { type: "user/message", data: { content: [{ type: "text", text: "hello" }], source: { kind: "user" } } },
      { type: "user/message", data: { content: [{ type: "text", text: "Current runtime context." }], source: { kind: "plugin" } } },
      { type: "tool/call", data: { name: "web_search", arguments: JSON.stringify({ queries: ["rates"] }) } },
      { type: "assistant/message", data: { message: { role: "assistant", content: [{ type: "reasoning", text: "think" }, { type: "text", text: "hi!" }] } } },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n"));
    const runtime = createDeepseekHarness(spec({ home: dir }));
    expect(await runtime.transcript!(cwd, sid)).toEqual([
      { role: "user", text: "hello" },
      { role: "ai", text: "hi!", tools: [{ name: "web_search", hint: "rates" }] },
    ]);
    expect(await runtime.transcript!(cwd, "session-nope0000")).toBeNull();
  });
});
