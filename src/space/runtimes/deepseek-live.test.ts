import { afterEach, describe, expect, test } from "bun:test";
import { createDeepseekHarness } from "./deepseek-harness.ts";
import { acpModel, acpModelValue, buildAcpPatch, contentText, defaultAcpModel } from "./deepseek-live.ts";
import { fakeDshBin } from "./testing-dsh.ts";
import type { ChatHandle, ChatTurn, DeepseekHarnessSpec, RuntimeAdapter } from "./types.ts";

const spec = (over: Partial<DeepseekHarnessSpec> = {}): DeepseekHarnessSpec => ({
  name: "dsh",
  kind: "deepseek-harness",
  bin: fakeDshBin(),
  profile: "headless",
  liveProfile: "acp",
  provider: "deepseek-account",
  ...over,
});

const turn = (over: Partial<ChatTurn> = {}): ChatTurn => ({ message: "hello", cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: process.env.HOME }, interactive: true, ...over });

type Collected = { events: Record<string, unknown>[]; sid?: string; error: string | null };

/** Start one interactive turn; `onEvent` can answer approvals before the turn settles. */
function start(runtime: RuntimeAdapter, t: ChatTurn, onEvent?: (ev: Record<string, unknown>, handle: ChatHandle) => void): { done: Promise<Collected>; handle: ChatHandle; events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  let sid: string | undefined;
  let handle!: ChatHandle;
  let resolve!: (c: Collected) => void;
  const done = new Promise<Collected>((r) => (resolve = r));
  handle = runtime.chat(t, {
    onEvent: (line) => {
      const ev = JSON.parse(line) as Record<string, unknown>;
      events.push(ev);
      onEvent?.(ev, handle);
    },
    onSession: (s) => (sid = s),
    onFinish: (error) => resolve({ events, sid, error }),
  });
  return { done, handle, events };
}

function textOf(events: Record<string, unknown>[]): string {
  return events
    .filter((e) => e.type === "assistant")
    .map((e) => ((e.message as { content: { type: string; text?: string }[] }).content).filter((c) => c.type === "text").map((c) => c.text ?? "").join(""))
    .join("\n");
}

async function until(what: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out waiting for an event");
    await Bun.sleep(5);
  }
}

let runtimes: RuntimeAdapter[] = [];
const make = (over: Partial<DeepseekHarnessSpec> = {}): RuntimeAdapter => {
  const r = createDeepseekHarness(spec(over));
  runtimes.push(r);
  return r;
};

afterEach(() => {
  for (const r of runtimes) r.closeLive?.();
  runtimes = [];
});

describe("ACP live chat", () => {
  test("opens a session, reports it, translates the answer and carries the persona and tier", async () => {
    const runtime = make();
    const { done, handle } = start(runtime, turn({ message: "hello", systemPrompt: "You are the librarian.", model: "deepseek-flash", permissionMode: "acceptEdits" }));
    const { events, sid, error } = await done;
    expect(error).toBeNull();
    expect(sid).toBe("acp-session-0001");
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "result"]);
    expect(events[0]).toMatchObject({ type: "system", subtype: "init", session_id: "acp-session-0001", model: "deepseek-account:deepseek-flash" });
    const text = textOf(events);
    expect(text).toContain("echo: hello");
    expect(text).toContain("model: deepseek-account:deepseek-flash");
    expect(text).toContain("mode: workspace-write");
    expect(text).toContain("persona: You are the librarian.");
    expect(text).toContain("rows: system-prompt,acp");
    expect(textOf(events)).toContain("[pid:");
    // ACP carries one prompt at a time: no message can be added to a running turn.
    expect(handle.steer).toBeUndefined();
  });

  test("tool calls and their results become tool_use and tool_result blocks", async () => {
    const runtime = make();
    const { done } = start(runtime, turn({ message: "tool" }));
    const { events, error } = await done;
    expect(error).toBeNull();
    expect(events.map((e) => e.type)).toEqual(["system", "assistant", "user", "assistant", "result"]);
    expect(events[1]).toMatchObject({ message: { content: [{ type: "tool_use", name: "bash", input: { command: "echo hi" } }] } });
    expect(events[2]).toMatchObject({ message: { content: [{ type: "tool_result", is_error: false, content: "hi" }] } });
  });

  test("an approval request allows the tool call and reports the decision", async () => {
    const runtime = make();
    const { done } = start(runtime, turn({ message: "approve:echo hi" }), (ev, handle) => {
      if (ev.type === "approval_request") handle.respond!(String(ev.id), "allow");
    });
    const { events, error } = await done;
    expect(error).toBeNull();
    const request = events.find((e) => e.type === "approval_request")!;
    expect(request).toMatchObject({ tool: "bash", title: "echo hi", detail: "Run it", input: { command: "echo hi" } });
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ decision: "allow" });
    expect(events.find((e) => e.type === "user")).toMatchObject({ message: { content: [{ type: "tool_result", is_error: false, content: "ran echo hi" }] } });
    expect(textOf(events)).toContain("done allow");
  });

  test("a denied approval fails the tool call and the agent sees the refusal", async () => {
    const runtime = make();
    const { done } = start(runtime, turn({ message: "approve:echo hi" }), (ev, handle) => {
      if (ev.type === "approval_request") handle.respond!(String(ev.id), "deny");
    });
    const { events, error } = await done;
    expect(error).toBeNull();
    expect(events.find((e) => e.type === "approval_resolved")).toMatchObject({ decision: "deny" });
    expect(events.find((e) => e.type === "user")).toMatchObject({ message: { content: [{ type: "tool_result", is_error: true, content: "denied" }] } });
    expect(textOf(events)).toContain("done deny");
  });

  test("a stop cancels the turn and keeps the conversation", async () => {
    const runtime = make();
    const { done, handle, events } = start(runtime, turn({ message: "wait" }));
    await until(() => events.some((e) => e.type === "system"));
    handle.kill();
    const { error } = await done;
    expect(error).toBe("stopped");
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "cancelled" });
  });

  test("the next turn reuses the conversation's process; a new model switches it in place", async () => {
    const runtime = make();
    const first = await start(runtime, turn({ message: "hello", model: "deepseek-flash" })).done;
    expect(first.error).toBeNull();
    const pid = /\[pid: (\d+)\]/.exec(textOf(first.events))![1];
    const second = await start(runtime, turn({ message: "again", sessionId: first.sid, model: "deepseek-v4-pro" })).done;
    expect(second.error).toBeNull();
    expect(second.sid).toBe(first.sid);
    expect(textOf(second.events)).toContain(`[pid: ${pid}]`);
    expect(textOf(second.events)).toContain("model: deepseek-account:deepseek-v4-pro");
  });

  test("a known session id resumes the harness session", async () => {
    const runtime = make();
    const { done } = start(runtime, turn({ message: "hello", sessionId: "acp-previous" }));
    const { events, sid, error } = await done;
    expect(error).toBeNull();
    expect(sid).toBe("acp-previous");
    expect(textOf(events)).toContain("[resumed: true]");
  });

  test("a refused turn ends as an error", async () => {
    const runtime = make();
    const { done } = start(runtime, turn({ message: "fail" }));
    const { events, error } = await done;
    expect(error).toBe("the agent refused the turn");
    expect(events.at(-1)).toMatchObject({ type: "result", is_error: true });
  });
});

describe("ACP helpers", () => {
  test("the overlay carries the persona and the initial route", () => {
    const patch = buildAcpPatch({ persona: 'Say "hi".', provider: "deepseek-account", model: "deepseek-flash" });
    expect(Bun.YAML.parse(patch)).toEqual([
      { id: "system-prompt", config: { personaPrefix: 'Say "hi".' } },
      { id: "acp", config: { provider: "deepseek-account", model: "deepseek-flash" } },
    ]);
    expect(buildAcpPatch({ provider: "deepseek-official", model: "deepseek-v4-flash" })).not.toContain("system-prompt");
  });

  test("model routes and content blocks", () => {
    expect(acpModelValue("deepseek-account", "deepseek-flash")).toBe('["deepseek-account","deepseek-flash"]');
    expect(acpModel("deepseek-v4-pro", "deepseek-account")).toEqual({ provider: "deepseek-account", model: "deepseek-v4-pro" });
    expect(acpModel("zai:glm-5", "deepseek-account")).toEqual({ provider: "zai", model: "glm-5" });
    expect(defaultAcpModel("deepseek-account")).toBe("deepseek-flash");
    expect(defaultAcpModel("deepseek-official")).toBe("deepseek-v4-flash");
    expect(contentText({ type: "text", text: "hi" })).toBe("hi");
    expect(contentText([{ type: "content", content: { type: "text", text: "a" } }, { type: "content", content: { type: "text", text: "b" } }])).toBe("a\nb");
    expect(contentText(undefined)).toBe("");
  });
});
