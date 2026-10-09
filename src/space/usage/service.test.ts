import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { RunRegistry } from "../agents/runs.ts";
import type { ChatCallbacks, RuntimeAdapter } from "../runtimes/types.ts";
import { UsageService } from "./service.ts";
import { UsageStore } from "./store.ts";

/** A runtime whose turns the test finishes by hand, reporting `sid` for each. */
function runtime() {
  const turns: ChatCallbacks[] = [];
  const adapter = {
    name: "fake",
    kind: "claude-code",
    capabilities: { chat: true },
    chat(_turn: unknown, cb: ChatCallbacks) {
      turns.push(cb);
      return { kill: () => queueMicrotask(() => cb.onFinish("aborted")) };
    },
  } as unknown as RuntimeAdapter;
  return { adapter, turns };
}

describe("UsageService", () => {
  test("agent hooks: three turns of one conversation are three opens and one segment", () => {
    const db = new Database(":memory:");
    let now = Date.parse("2026-10-01T10:00:00.000Z");
    const usage = new UsageService(new UsageStore(db), { now: () => now });
    const runs = new RunRegistry(db, { now: () => now, onRunStart: usage.runStarted, onRunEnd: usage.runEnded });
    const { adapter, turns } = runtime();
    const start = now;
    let session: string | undefined;
    for (let i = 0; i < 3; i++) {
      runs.start({ agent: "ai-todo/planner", runtime: adapter, turn: { message: `turn ${i}`, cwd: "/", ...(session ? { sessionId: session } : {}) } });
      turns[i]!.onSession?.(`sid-${i}`);
      now += 40_000;
      turns[i]!.onFinish(null);
      session = `sid-${i}`;
      now += 3 * 60_000;
    }
    const [row] = usage.report("7d", "agent");
    expect(row).toMatchObject({ kind: "agent", key: "ai-todo/planner", opens: 3, sessions: 1, activeMs: 2 * (40_000 + 3 * 60_000) + 40_000 });
    expect(row!.activeMs).toBe(now - 3 * 60_000 - start);
  });

  test("a failing store never reaches the run", () => {
    const db = new Database(":memory:");
    const lines: string[] = [];
    const usage = new UsageService(new UsageStore(db), { log: (l) => lines.push(l) });
    db.exec("DROP TABLE usage_opens; DROP TABLE usage_sessions");
    const runs = new RunRegistry(db, { onRunStart: usage.runStarted, onRunEnd: usage.runEnded });
    const { adapter, turns } = runtime();
    const run = runs.start({ agent: "space/assistant", runtime: adapter, turn: { message: "hi", cwd: "/" } });
    turns[0]!.onFinish(null);
    expect(runs.get(run.id)?.status).toBe("done");
    expect(lines).toHaveLength(2);
  });

  test("opens and beats are validated", () => {
    const usage = new UsageService(new UsageStore(new Database(":memory:")));
    expect(() => usage.open({ kind: "widget", key: "x", source: "panel" })).toThrow(/kind/);
    expect(() => usage.open({ kind: "app", key: "../x", source: "panel" })).toThrow(/key/);
    expect(() => usage.open({ kind: "app", key: "x", source: "email" })).toThrow(/source/);
    usage.open({ kind: "app", key: "seoul/ai-todo", source: "library" });
    expect(() => usage.beat("ai-todo", "short")).toThrow(/tab/);
    expect(usage.beat("ai-todo", "tab-aaaa1")).toBe("new");
    expect(usage.report("all").map((r) => r.key).sort()).toEqual(["ai-todo", "seoul/ai-todo"]);
  });
});
