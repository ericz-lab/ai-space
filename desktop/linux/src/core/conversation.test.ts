import { describe, expect, test } from "bun:test";
import { type ChatApi, Conversation } from "./conversation.ts";
import { SpaceError } from "./check.ts";
import type { Permission } from "./chat.ts";
import type { SSEMessage } from "./sse.ts";

/** A stream the test feeds event by event; `fail()` drops it as a broken connection would. */
class Feed {
  private queue: (SSEMessage | Error | null)[] = [];
  private wake: (() => void) | undefined;
  closed = false;
  push(m: SSEMessage | Error | null) {
    this.queue.push(m);
    this.wake?.();
  }
  event(id: number, ev: object) {
    this.push({ id, data: JSON.stringify(ev) });
  }
  end() {
    this.push(null);
  }
  fail() {
    this.push(new Error("connection reset"));
  }
  close() {
    this.closed = true;
    this.push(null);
  }
  async *messages(): AsyncGenerator<SSEMessage> {
    for (;;) {
      while (!this.queue.length) await new Promise<void>((r) => (this.wake = r));
      const m = this.queue.shift()!;
      if (m === null) return;
      if (m instanceof Error) throw m;
      yield m;
    }
  }
}

function harness() {
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const feeds: Feed[] = [];
  const failSends = new Set<string>();
  let openError: Error | undefined;
  const api: ChatApi = {
    async events(method, path, body) {
      calls.push({ method, path, ...(body ? { body } : {}) });
      if (openError) {
        const e = openError;
        openError = undefined;
        throw e;
      }
      const feed = new Feed();
      feeds.push(feed);
      return { runId: method === "POST" ? "r1" : undefined, messages: feed.messages(), close: () => feed.close() };
    },
    async send(method, path, body) {
      calls.push({ method, path, body });
      if ([...failSends].some((s) => path.endsWith(s))) throw new SpaceError("http", "turn ended", 409);
      return { ok: true };
    },
    async get(path) {
      calls.push({ method: "GET", path });
      if (path.endsWith("/sessions")) return { ok: true, sessions: [{ sid: "s1", title: "Earlier", ts: 1 }] };
      return { ok: true, messages: [{ role: "user", text: "hi" }, { role: "assistant", text: "hello", steps: [{ kind: "tool", name: "Bash", input: "ls", output: "a", failed: false }, { kind: "text", text: "hello" }] }] };
    },
  };
  let permission: Permission = "";
  let n = 0;
  let changes = 0;
  const conv = new Conversation({ id: "space/assistant", base: "/api/agents/space/assistant" }, api, {
    permission: () => permission,
    setPermission: (p) => (permission = p),
    sleep: async () => {},
    newId: () => `m${++n}`,
    onChange: () => changes++,
    text: { stopped: "(stopped)", signIn: "Sign in first", lost: "lost", grantMessage: "I granted more", noTurn: "no turn", answerFailed: (w) => `failed: ${w}` },
  });
  const tick = () => new Promise((r) => setTimeout(r, 5));
  return { conv, calls, feeds, failSends, setOpenError: (e: Error) => (openError = e), permission: () => permission, tick, changes: () => changes };
}

const init = { type: "system", subtype: "init", session_id: "sess-1", model: "opus" };
const text = (t: string) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });

describe("a conversation", () => {
  test("a turn streams, names its session, and the next turn continues it", async () => {
    const h = harness();
    h.conv.send("  hello  ");
    await h.tick();
    expect(h.calls[0]).toEqual({ method: "POST", path: "/api/agents/space/assistant/chat", body: { message: "hello", interactive: true } });
    expect(h.conv.busy).toBe(true);
    h.feeds[0]!.event(1, init);
    h.feeds[0]!.event(2, { type: "stream_event", event: { delta: { type: "text_delta", text: "Hi" } } });
    await h.tick();
    expect(h.conv.messages[1]).toMatchObject({ role: "agent", text: "Hi", live: true });
    h.feeds[0]!.event(3, text("Hi there"));
    h.feeds[0]!.event(4, { type: "done" });
    await h.tick();
    expect(h.conv.busy).toBe(false);
    expect(h.conv.messages[1]).toMatchObject({ text: "Hi there", live: false });
    expect(h.conv.sessionId).toBe("sess-1");
    h.conv.send("again");
    await h.tick();
    expect(h.calls.at(-1)!.body).toMatchObject({ message: "again", sessionId: "sess-1" });
  });

  test("a dropped stream reattaches after the last event it saw, without resending", async () => {
    const h = harness();
    h.conv.send("long job");
    await h.tick();
    h.feeds[0]!.event(1, init);
    h.feeds[0]!.event(2, text("part one"));
    h.feeds[0]!.fail();
    await h.tick();
    expect(h.calls.at(-1)).toEqual({ method: "GET", path: "/api/agents/space/assistant/runs/r1/events?after=2" });
    // A replayed event is skipped by its sequence number.
    h.feeds[1]!.event(2, text("part one"));
    h.feeds[1]!.event(3, text("part two"));
    h.feeds[1]!.event(4, { type: "done" });
    await h.tick();
    expect(h.conv.messages[1]!.text).toBe("part one\n\npart two");
    expect(h.calls.filter((c) => c.method === "POST" && c.path.endsWith("/chat"))).toHaveLength(1);
  });

  test("a message written during a turn joins it; a refused one waits and is answered in order", async () => {
    const h = harness();
    h.conv.send("first");
    await h.tick();
    h.conv.send("also this");
    await h.tick();
    expect(h.calls.at(-1)).toEqual({ method: "POST", path: "/api/agents/space/assistant/runs/r1/steer", body: { message: "also this" } });
    expect(h.conv.messages.at(-1)!.pending).toEqual(["also this"]);
    h.feeds[0]!.event(1, { type: "steer", text: "also this" });
    await h.tick();
    expect(h.conv.messages.at(-1)!.pending).toEqual([]);

    h.failSends.add("/steer");
    h.conv.send("third");
    await h.tick();
    // Refused: it is a message of its own, sent as the next turn.
    expect(h.conv.messages.map((m) => [m.role, m.text])).toEqual([["user", "first"], ["agent", ""], ["user", "third"]]);
    h.feeds[0]!.event(2, { type: "done" });
    await h.tick();
    expect(h.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/agents/space/assistant/chat", body: { message: "third" } });
    expect(h.conv.messages.map((m) => m.role)).toEqual(["user", "agent", "user", "agent"]);
  });

  test("stop asks the Space; pressed before the run has an id, it is sent once it has one", async () => {
    const h = harness();
    h.conv.send("go");
    h.conv.stop();
    await h.tick();
    expect(h.calls.map((c) => c.path)).toEqual(["/api/agents/space/assistant/chat", "/api/agents/space/assistant/runs/r1/stop"]);
    h.feeds[0]!.event(1, { type: "error", status: "stopped" });
    h.feeds[0]!.event(2, { type: "done" });
    await h.tick();
    expect(h.conv.messages[1]!.text).toBe("(stopped)");
    expect(h.conv.busy).toBe(false);
  });

  test("a failed turn shows its reason and Try Again sends the message once more", async () => {
    const h = harness();
    h.conv.send("hi");
    await h.tick();
    h.feeds[0]!.event(1, { type: "error", error: "429 Too Many Requests" });
    h.feeds[0]!.event(2, { type: "done" });
    await h.tick();
    expect(h.conv.messages[1]!.failure).toMatchObject({ kind: "busy" });
    expect(h.conv.messages[1]!.text).toBe("");
    expect(h.conv.retryableMessage).toBe("hi");
    h.conv.retry();
    await h.tick();
    expect(h.conv.messages).toHaveLength(2);
    expect(h.calls.filter((c) => c.path.endsWith("/chat"))).toHaveLength(2);
  });

  test("a sign-in answer ends the turn with a sign-in failure", async () => {
    const h = harness();
    h.setOpenError(new SpaceError("signin", "sign in required", 401));
    h.conv.send("hi");
    await h.tick();
    expect(h.conv.busy).toBe(false);
    expect(h.conv.messages[1]!.failure).toEqual({ kind: "connection", detail: "Sign in first" });
  });

  test("approvals are answered by the person; grant and retry raises the permission", async () => {
    const h = harness();
    h.conv.send("edit");
    await h.tick();
    h.feeds[0]!.event(1, { type: "approval_request", id: "q1", tool: "Bash", title: "rm -rf build", detail: "clean" });
    await h.tick();
    expect(h.conv.messages[1]!.steps[0]).toMatchObject({ id: "approval:q1", kind: "approval", state: "waiting" });
    expect(await h.conv.answer("q1", true)).toBeUndefined();
    expect(h.calls.at(-1)).toEqual({ method: "POST", path: "/api/agents/space/assistant/runs/r1/approvals/q1", body: { decision: "allow" } });
    h.feeds[0]!.event(2, { type: "approval_resolved", id: "q1", decision: "allow" });
    h.feeds[0]!.event(3, { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } }] } });
    h.feeds[0]!.event(4, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "This tool requires approval" }] } });
    h.feeds[0]!.event(5, { type: "done" });
    await h.tick();
    expect(h.conv.messages[1]!.steps.map((s) => [s.kind, s.state])).toEqual([["approval", "allowed"], ["tool", "failed"]]);
    expect(h.conv.messages[1]!.denied).toEqual(["Edit"]);
    h.conv.grantAndRetry();
    await h.tick();
    expect(h.permission()).toBe("acceptEdits");
    expect(h.calls.at(-1)!.body).toMatchObject({ message: "I granted more", permissionMode: "acceptEdits" });
    h.feeds[1]!.event(1, { type: "done" });
    await h.tick();
    // No turn runs now: an answer cannot reach anyone.
    expect(await h.conv.answer("q1", true)).toBe("no turn");
  });

  test("an earlier session opens with its tool calls; a run in progress is picked up", async () => {
    const h = harness();
    await h.conv.loadSessions();
    expect(h.conv.sessions).toEqual([{ sid: "s1", title: "Earlier", ts: 1 }]);
    await h.conv.open(h.conv.sessions[0]!);
    expect(h.conv.sessionId).toBe("s1");
    expect(h.conv.messages.map((m) => [m.role, m.historic, m.steps.map((s) => s.kind)])).toEqual([["user", false, []], ["agent", true, ["tool", "text"]]]);

    const fresh = harness();
    fresh.conv.attachRunning([{ id: "r9", agent: "other/agent", message: "x", status: "running" }, { id: "r7", agent: "space/assistant", message: "still going", status: "running" }]);
    await fresh.tick();
    expect(fresh.calls[0]).toEqual({ method: "GET", path: "/api/agents/space/assistant/runs/r7/events?after=0" });
    expect(fresh.conv.messages[1]!.activity).toEqual({ kind: "reconnecting" });
  });
});
