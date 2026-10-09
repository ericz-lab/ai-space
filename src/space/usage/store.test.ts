import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { UsageStore } from "./store.ts";

const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const S = 1000;

describe("UsageStore", () => {
  test("opens are counted per entry with the newest time; days are UTC", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.addOpen("app", "ai-todo", "panel", T0);
    store.addOpen("app", "ai-todo", "library", T0 + 15 * 3600 * S);
    store.addOpen("builtin", "settings", "panel", T0);
    const rows = store.summary(0);
    expect(rows.find((r) => r.key === "ai-todo")).toEqual({
      kind: "app",
      key: "ai-todo",
      opens: 2,
      activeMs: null,
      sessions: 0,
      lastAt: new Date(T0 + 15 * 3600 * S).toISOString(),
      daily: [
        { day: "2026-10-01", opens: 1, activeMs: 0 },
        { day: "2026-10-02", opens: 1, activeMs: 0 },
      ],
    });
    expect(rows.find((r) => r.key === "settings")?.activeMs).toBeNull();
    expect(store.summary(0, "builtin").map((r) => r.key)).toEqual(["settings"]);
  });

  test("heartbeats extend a segment, a long gap starts another, one step adds at most 60 s", () => {
    const store = new UsageStore(new Database(":memory:"));
    expect(store.beat("ai-todo", "tab-aaaa1", T0)).toBe("new");
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 30 * S)).toBe("extended");
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 60 * S)).toBe("extended");
    // 85 s later: within the gap, but one step is capped at 60 s.
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 145 * S)).toBe("extended");
    // Over 90 s: a break, a new segment that counts from its own first beat.
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 300 * S)).toBe("new");
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 330 * S)).toBe("extended");
    const [row] = store.summary(0, "app");
    expect(row).toMatchObject({ key: "ai-todo", sessions: 2, activeMs: (30 + 30 + 60 + 30) * S, lastAt: new Date(T0 + 330 * S).toISOString() });
  });

  test("a beat closer than 20 s to the last is dropped; tabs and apps are separate", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.beat("ai-todo", "tab-aaaa1", T0);
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 5 * S)).toBe("dropped");
    expect(store.beat("ai-todo", "tab-bbbb2", T0 + 5 * S)).toBe("new");
    expect(store.beat("ai-notes", "tab-aaaa1", T0 + 5 * S)).toBe("new");
    expect(store.beat("ai-todo", "tab-aaaa1", T0 + 25 * S)).toBe("extended");
    expect(store.summary(0, "app").find((r) => r.key === "ai-todo")).toMatchObject({ sessions: 2, activeMs: 25 * S });
  });

  test("an app that ever sent a beat shows 0 in a quiet window, not unknown", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.beat("ai-todo", "tab-aaaa1", T0);
    store.addOpen("app", "ai-todo", "panel", T0 + 40 * 86400 * S);
    expect(store.summary(T0 + 39 * 86400 * S)[0]).toMatchObject({ key: "ai-todo", opens: 1, activeMs: 0, sessions: 0 });
  });

  test("agent turns of one conversation within 10 minutes make one segment, first start to last end", () => {
    const store = new UsageStore(new Database(":memory:"));
    expect(store.agentTurn("ai-todo/planner", [], "sid-1", T0, T0 + 20 * S)).toBe("new");
    // The next turn resumes sid-1; the runtime reports a new id, which the segment then goes by.
    expect(store.agentTurn("ai-todo/planner", ["sid-1", "sid-2"], "sid-2", T0 + 5 * 60 * S, T0 + 6 * 60 * S)).toBe("extended");
    expect(store.agentTurn("ai-todo/planner", ["sid-2"], "sid-2", T0 + 15 * 60 * S, T0 + 16 * 60 * S)).toBe("extended");
    // Over 10 minutes after the last turn ended: a new segment.
    expect(store.agentTurn("ai-todo/planner", ["sid-2"], "sid-2", T0 + 27 * 60 * S, T0 + 28 * 60 * S)).toBe("new");
    // Another conversation never joins.
    expect(store.agentTurn("ai-todo/planner", ["other"], "other", T0 + 28 * 60 * S, T0 + 29 * 60 * S)).toBe("new");
    expect(store.summary(0, "agent")[0]).toMatchObject({ key: "ai-todo/planner", sessions: 3, activeMs: 16 * 60 * S + 60 * S + 60 * S });
  });

  test("retention prunes older rows on insert; 0 keeps everything", () => {
    const db = new Database(":memory:");
    const kept = new UsageStore(db);
    kept.addOpen("app", "old", "panel", T0);
    kept.beat("old", "tab-aaaa1", T0);
    const pruning = new UsageStore(db, { retentionDays: 30 });
    pruning.addOpen("app", "new", "panel", T0 + 10 * 86400 * S);
    expect(pruning.summary(0).map((r) => r.key).sort()).toEqual(["new", "old"]);
    pruning.addOpen("app", "new", "panel", T0 + 31 * 86400 * S);
    expect(pruning.summary(0).map((r) => r.key)).toEqual(["new"]);
  });
});
