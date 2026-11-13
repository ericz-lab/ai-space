import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RunRegistry, type RunInfo, type RunStatus } from "../agents/runs.ts";
import type { ChatCallbacks, RuntimeAdapter } from "../runtimes/types.ts";
import { workspacePaths } from "../workspace.ts";
import { createPanelRoutes } from "./api.ts";
import { HealthProbe } from "./health.ts";
import { LayoutStore } from "./layout.ts";
import { ALERT_MS, DONE_MS, ERROR_MS, MOOD_CACHE_MS, QUIET_MS, SpaceMood, spaceMood, type MoodInput } from "./mood.ts";
import { AppRegistry } from "./registry.ts";
import { WidgetFeed } from "./widgets.ts";

const NOW = Date.parse("2026-11-13T10:00:00Z");

let n = 0;
function run(agent: string, status: RunStatus, startedAgo: number, endedAgo: number | null = null): RunInfo {
  return {
    id: `r${++n}`,
    agent,
    sessionId: null,
    sid: null,
    message: "hi",
    runtime: "fake",
    model: null,
    status,
    error: status === "error" ? "boom" : null,
    startedAt: NOW - startedAgo,
    finishedAt: endedAgo === null ? null : NOW - endedAgo,
    lastSeq: 0,
    trigger: "user",
  };
}

const quiet: MoodInput = { running: [], waiting: [], ended: [], unread: 0, alerts: 0, feedback: 0 };
const titles = (agent: string) => (agent === "ai-todo/planner" ? { en: "Planner", zh: "规划师" } : undefined);

describe("space mood", () => {
  test("a Space where nothing happened for two hours sleeps; after a turn it is idle", () => {
    expect(spaceMood(quiet, NOW)).toMatchObject({ ok: true, state: "sleep", move: "stay", asOf: "2026-11-13T10:00:00.000Z" });
    expect(spaceMood({ ...quiet, ended: [run("a/b", "done", QUIET_MS + 5_000, QUIET_MS + 1_000)] }, NOW).state).toBe("sleep");
    const idle = spaceMood({ ...quiet, ended: [run("a/b", "done", 20 * 60_000, 10 * 60_000)] }, NOW);
    expect(idle).toMatchObject({ state: "idle", move: "roam" });
    expect(idle.say).toBeUndefined();
    expect(idle.open).toBeUndefined();
  });

  test("running turns make it work, and say who", () => {
    const one = spaceMood({ ...quiet, running: [run("ai-todo/planner", "running", 5_000)], title: titles }, NOW);
    expect(one).toMatchObject({ state: "working", move: "roam", say: { en: "Planner is working", zh: "规划师 在干活" }, open: { kind: "chat", agent: "ai-todo/planner" }, counts: { running: 1 } });
    const two = spaceMood({ ...quiet, running: [run("a/old", "running", 60_000), run("a/new", "running", 1_000)] }, NOW);
    expect(two).toMatchObject({ state: "working", say: { en: "2 agents are working", zh: "2 个 agent 在干活" }, open: { kind: "chat", agent: "a/new" } });
  });

  test("a turn waiting on the person comes first and keeps the pet in its corner", () => {
    const asking = run("ai-todo/planner", "running", 5_000);
    const mood = spaceMood({ ...quiet, running: [asking, run("a/b", "running", 1_000)], waiting: [asking], ended: [run("c/d", "error", 60_000, 30_000)], unread: 3, title: titles }, NOW);
    expect(mood).toMatchObject({ state: "waiting", reason: "approval", move: "stay", say: { en: "Planner is waiting for you", zh: "规划师 在等你" }, open: { kind: "chat", agent: "ai-todo/planner" } });
    expect(mood.counts).toEqual({ running: 2, waiting: 1, failed: 1, unread: 3, alerts: 0, feedback: 0 });
  });

  test("a failure shows for ten minutes, until the agent runs again", () => {
    const failed = run("a/b", "error", 90_000, 60_000);
    expect(spaceMood({ ...quiet, ended: [failed], running: [run("x/y", "running", 1_000)] }, NOW)).toMatchObject({
      state: "error",
      move: "stay",
      say: { en: "a/b ran into a problem", zh: "a/b 出错了" },
      open: { kind: "chat", agent: "a/b" },
    });
    expect(spaceMood({ ...quiet, ended: [run("a/b", "timeout", ERROR_MS + 9_000, ERROR_MS + 1_000)] }, NOW).state).toBe("idle");
    // A later turn of the same agent ended well, or one is running: the person is on it.
    expect(spaceMood({ ...quiet, ended: [run("a/b", "error", 6 * 60_000, 5 * 60_000), run("a/b", "done", 3 * 60_000, 2 * 60_000)] }, NOW).state).toBe("idle");
    expect(spaceMood({ ...quiet, ended: [failed], running: [run("a/b", "running", 10_000)] }, NOW).state).toBe("working");
    // A turn the person stopped is no failure.
    expect(spaceMood({ ...quiet, ended: [run("a/b", "stopped", 90_000, 60_000)] }, NOW).state).toBe("idle");
  });

  test("a turn that just ended well is done for a minute", () => {
    expect(spaceMood({ ...quiet, ended: [run("ai-todo/planner", "done", 20_000, 10_000)], title: titles }, NOW)).toMatchObject({
      state: "done",
      move: "roam",
      say: { en: "Planner is done", zh: "规划师 做完了" },
      open: { kind: "chat", agent: "ai-todo/planner" },
    });
    expect(spaceMood({ ...quiet, ended: [run("a/b", "done", DONE_MS + 9_000, DONE_MS + 1_000)] }, NOW).state).toBe("idle");
  });

  test("unread alerts, then feedback, wait for the person while the pet roams", () => {
    expect(spaceMood({ ...quiet, unread: 40, alerts: 2, feedback: 4 }, NOW)).toMatchObject({ state: "waiting", reason: "inbox", move: "roam", say: { en: "2 unread alerts in the inbox", zh: "收件箱有 2 条警报未读" }, open: { kind: "inbox" } });
    expect(spaceMood({ ...quiet, alerts: 1 }, NOW).say?.en).toBe("1 unread alert in the inbox");
    // Plain unread news does not wait on the person.
    expect(spaceMood({ ...quiet, unread: 4050, ended: [run("a/b", "done", 30 * 60_000, 20 * 60_000)] }, NOW)).toMatchObject({ state: "idle", counts: { unread: 4050, alerts: 0 } });
    const fb = spaceMood({ ...quiet, feedback: 1 }, NOW);
    expect(fb).toMatchObject({ state: "waiting", reason: "feedback", move: "roam", say: { en: "1 piece of feedback waits for you", zh: "1 条反馈等你处理" } });
    expect(fb.open).toBeUndefined();
    // Work in progress outranks the inbox.
    expect(spaceMood({ ...quiet, alerts: 2, running: [run("a/b", "running", 1_000)] }, NOW).state).toBe("working");
  });
});

describe("SpaceMood", () => {
  test("reads its sources at most once per few seconds and survives a failing count", () => {
    let now = NOW;
    let reads = 0;
    const mood = new SpaceMood({
      running: () => (reads++, []),
      waiting: () => [],
      recent: () => [run("a/b", "done", 30_000, 20_000), run("a/c", "running", 5_000)],
      unread: () => {
        throw new Error("db locked");
      },
      now: () => now,
    });
    expect(mood.read()).toMatchObject({ state: "done", counts: { unread: 0 } });
    now += MOOD_CACHE_MS - 1;
    mood.read();
    expect(reads).toBe(1);
    now += 2;
    mood.read();
    expect(reads).toBe(2);
  });

  test("asks the inbox for the alerts of the last ALERT_MS", () => {
    let since = 0;
    const mood = new SpaceMood({
      running: () => [],
      waiting: () => [],
      recent: () => [],
      unread: () => 4050,
      alerts: (s) => ((since = s), 3),
      now: () => NOW,
    });
    expect(mood.read()).toMatchObject({ state: "waiting", reason: "inbox", counts: { unread: 4050, alerts: 3 } });
    expect(since).toBe(NOW - ALERT_MS);
  });
});

/** An in-process runtime whose events the test sends. */
function scriptedRuntime() {
  const turns: ChatCallbacks[] = [];
  const runtime = {
    name: "fake",
    kind: "claude-code",
    capabilities: { chat: true },
    chat(_turn: unknown, cb: ChatCallbacks) {
      turns.push(cb);
      return { kill: () => queueMicrotask(() => cb.onFinish("aborted")) };
    },
  } as unknown as RuntimeAdapter;
  return { runtime, turns };
}

describe("waiting turns", () => {
  test("a run waits while an approval request is open, and not once it is resolved or ends", () => {
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(new Database(":memory:"));
    const a = runs.start({ agent: "ai-todo/planner", runtime, turn: { message: "plan", cwd: "/" } });
    runs.start({ agent: "notes/librarian", runtime, turn: { message: "file", cwd: "/" } });
    expect(runs.waiting()).toEqual([]);
    turns[0]!.onEvent(JSON.stringify({ type: "approval_request", id: "q1", tool: "Bash", title: "Run ls" }));
    turns[0]!.onEvent(JSON.stringify({ type: "approval_request", id: "q2", tool: "AskUserQuestion", title: "Which?" }));
    expect(runs.waiting().map((r) => r.id)).toEqual([a.id]);
    turns[0]!.onEvent(JSON.stringify({ type: "approval_resolved", id: "q1", decision: "allow" }));
    expect(runs.waiting().map((r) => r.id)).toEqual([a.id]);
    turns[0]!.onEvent(JSON.stringify({ type: "approval_resolved", id: "q2", decision: "cancelled" }));
    expect(runs.waiting()).toEqual([]);
    turns[1]!.onEvent(JSON.stringify({ type: "approval_request", id: "q3", tool: "Edit", title: "Edit a file" }));
    expect(runs.waiting().map((r) => r.agent)).toEqual(["notes/librarian"]);
    turns[1]!.onFinish(null);
    expect(runs.waiting()).toEqual([]);
  });
});

describe("GET /api/pets/mood", () => {
  const routes = (mood?: SpaceMood) => {
    const registry = new AppRegistry();
    const r = createPanelRoutes({
      ws: workspacePaths("/nowhere"),
      registry,
      layout: new LayoutStore(new Database(":memory:")),
      widgets: new WidgetFeed(registry),
      health: new HealthProbe(),
      onCreate: async () => {},
      onRemove: async () => {},
      ...(mood ? { mood } : {}),
    });
    return (r["/api/pets/mood"] as { GET: (req: Request) => Promise<Response> }).GET;
  };

  test("serves the mood, and an idle one without a source", async () => {
    const mood = new SpaceMood({ running: () => [run("a/b", "running", 1_000)], waiting: () => [], recent: () => [], now: () => NOW });
    expect(await (await routes(mood)(new Request("http://x/api/pets/mood"))).json()).toMatchObject({ ok: true, state: "working", move: "roam", open: { kind: "chat", agent: "a/b" } });
    expect(await (await routes()(new Request("http://x/api/pets/mood"))).json()).toMatchObject({ ok: true, state: "idle", move: "roam", counts: { running: 0 } });
  });
});
