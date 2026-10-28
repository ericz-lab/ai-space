import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createClaudeCode } from "./claude-code.ts";
import { ClaudeLive, jobKind } from "./claude-live.ts";
import { backgroundMs, LivePool, type LiveProcess } from "./live.ts";
import { fakeLiveBin } from "./testing-live.ts";
import type { BackgroundJob, ChatCallbacks, ChatHandle, ChatTurn } from "./types.ts";

/**
 * Background work in Claude Code live chat (docs/runtimes.md#background-work): the turns the CLI
 * starts by itself after a background job reports, and the job list. The recording in
 * `fixtures/claude-background.jsonl` is Claude Code 2.1.312's stdout for a turn that started a
 * Monitor (three ticks, 5 s apart) and a `run_in_background` Bash (`sleep 20`).
 */

const FIXTURE = join(import.meta.dir, "fixtures", "claude-background.jsonl");

type Ev = Record<string, unknown>;
type Seen = { events: Ev[]; error?: string | null; done: Promise<void> };

function watcher(): { cb: () => ChatCallbacks; seen: Seen } {
  let finish!: () => void;
  const seen: Seen = { events: [], done: new Promise((r) => (finish = r)) };
  return {
    seen,
    cb: () => ({
      onEvent: (line) => seen.events.push(JSON.parse(line)),
      onFinish: (error) => {
        seen.error = error;
        finish();
      },
    }),
  };
}

/** A conversation: its first turn, every turn the process starts by itself, and the job lists it reports. */
function conversation() {
  const wakes: Seen[] = [];
  const handles: ChatHandle[] = [];
  const jobs: BackgroundJob[][] = [];
  let woke = () => {};
  const hooks: Pick<ChatCallbacks, "onWake" | "onJobs"> = {
    onWake: (handle) => {
      const w = watcher();
      wakes.push(w.seen);
      handles.push(handle);
      woke();
      return w.cb();
    },
    onJobs: (list) => jobs.push(list),
  };
  /** Resolves once `n` turns of the process's own have ended. */
  const settled = async (n: number) => {
    const deadline = Date.now() + 5_000;
    while (wakes.length < n || wakes.slice(0, n).some((w) => w.error === undefined)) {
      if (Date.now() > deadline) throw new Error(`only ${wakes.length} wakes`);
      await new Promise<void>((r) => {
        woke = r;
        setTimeout(r, 20);
      });
    }
  };
  return { wakes, handles, jobs, hooks, settled };
}

const texts = (events: Ev[]) => events.flatMap((e) => (e.type === "assistant" ? ((e.message as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === "text").map((c) => c.text)) : []));
const base: ChatTurn = { message: "hi", cwd: process.cwd(), env: process.env, interactive: true };

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

describe("Claude Code background work", () => {
  test("the recorded Monitor and background Bash: each report the agent answers by itself is a turn of its own", async () => {
    const rt = createClaudeCode({ name: "claude", kind: "claude-code", bin: fakeLiveBin("claude"), chatArgs: [] });
    cleanup.push(() => rt.closeLive?.());
    const c = conversation();
    const first = watcher();
    rt.chat({ ...base, message: `fixture:${FIXTURE}` }, { ...first.cb(), ...c.hooks });
    await first.seen.done;
    expect(first.seen.error).toBeNull();
    expect(texts(first.seen.events)).toEqual(["started"]);
    // The Monitor's first tick came in while the turn ran: a report, not the person's message.
    expect(first.seen.events.some((e) => e.type === "steer")).toBe(false);
    expect(first.seen.events.find((e) => e.type === "user" && e.isReplay && (e.origin as Ev | undefined)?.kind === "task-notification")).toMatchObject({ message: { content: expect.stringContaining("<event>tick 1</event>") } });

    // Ticks 2 and 3, then the end of both jobs; the CLI's empty turn in between makes no run.
    await c.settled(3);
    await Bun.sleep(50);
    expect(c.wakes.map((w) => texts(w.events).join(" "))).toEqual(["Monitor 通知：tick 2。", "Monitor 通知：tick 3。", expect.stringContaining("两条通知")]);
    expect(c.wakes.every((w) => w.error === null)).toBe(true);
    expect(c.wakes[1]!.events.filter((e) => e.subtype === "task_notification")).toMatchObject([{ status: "completed", summary: expect.stringContaining("后台等待20秒后输出") }]);

    // Both jobs started running and ended completed; the Monitor is told from the Bash by its tool call.
    const running = c.jobs.find((list) => list.length === 2 && list.every((j) => j.status === "running"));
    expect(running?.map((j) => [j.kind, j.description])).toEqual([["monitor", "三次 tick 测试"], ["bash", "后台等待20秒后输出"]]);
    expect(c.jobs.at(-1)!.map((j) => [j.kind, j.status])).toEqual([["monitor", "completed"], ["bash", "completed"]]);
    // The CLI lists a job before it says what started it, and tells one end up to three ways: each list goes out once, right.
    expect(c.jobs[0]!.map((j) => j.kind)).toEqual(["monitor"]);
    expect([...new Set(c.jobs.map((l) => l.map((j) => j.status).join()))]).toEqual(["running", "running,running", "completed,running", "completed,completed"]);
    expect(c.jobs.every((l, i) => i === 0 || JSON.stringify(l) !== JSON.stringify(c.jobs[i - 1]))).toBe(true);
  });

  test("past the limit of turns in a row the agent's answers run unseen until the person writes", async () => {
    const live = new ClaudeLive(fakeLiveBin("claude"), base, [], 1);
    cleanup.push(() => live.close());
    const c = conversation();
    const first = watcher();
    live.turn({ ...base, message: "bg:3" }, { ...first.cb(), ...c.hooks });
    await first.seen.done;
    expect(live.background).toBe(true);
    await c.settled(2);
    await Bun.sleep(150);
    // One shown turn, then one run saying the rest is not shown; the third turn makes none.
    expect(c.wakes).toHaveLength(2);
    expect(texts(c.wakes[0]!.events)).toEqual(["woke 1"]);
    expect(c.wakes[1]!.events).toEqual([{ type: "notice", kind: "limit", text: expect.stringContaining("1 background reports") }]);
    expect(live.background).toBe(false);
    expect(live.busy).toBe(false);

    // The person writes: shown again.
    const next = watcher();
    live.turn({ ...base, message: "bg:1" }, { ...next.cb(), ...c.hooks });
    await next.seen.done;
    await c.settled(3);
    expect(texts(c.wakes[2]!.events)).toEqual(["woke 1"]);
  });

  test("a turn of the process's own can be stopped and steered like the person's", async () => {
    const live = new ClaudeLive(fakeLiveBin("claude"), base, []);
    cleanup.push(() => live.close());
    const c = conversation();
    const first = watcher();
    live.turn({ ...base, message: "bg:1" }, { ...first.cb(), ...c.hooks });
    await first.seen.done;
    await c.settled(1);
    expect(c.handles[0]!.steer).toBeFunction();
    expect(c.handles[0]!.respond!("nothing", "allow")).toBe(false);
  });

  test("a process nobody took a wake for still answers its reports, unseen", async () => {
    const live = new ClaudeLive(fakeLiveBin("claude"), base, []);
    cleanup.push(() => live.close());
    const jobs: BackgroundJob[][] = [];
    const first = watcher();
    live.turn({ ...base, message: "bg:2" }, { ...first.cb(), onWake: () => null, onJobs: (l) => jobs.push(l) });
    await first.seen.done;
    const deadline = Date.now() + 3000;
    while (jobs.at(-1)?.[0]?.status !== "completed" && Date.now() < deadline) await Bun.sleep(20);
    expect(jobs.at(-1)).toMatchObject([{ id: "job-1", kind: "bash", status: "completed", toolUseId: "bg-tool", summary: expect.stringContaining("completed") }]);
    expect(live.busy).toBe(false);
  });
});

describe("live pool and background work", () => {
  const fake = (over: Partial<LiveProcess> = {}) => {
    const p = { sid: "s1", fingerprint: "", alive: true, busy: false, background: false, lastActive: 0, closed: false, ...over } as LiveProcess & { closed: boolean; background: boolean; busy: boolean };
    (p as { turn: LiveProcess["turn"] }).turn = (_t, cb) => {
      queueMicrotask(() => cb.onFinish(null));
      return { kill() {} };
    };
    (p as { close: LiveProcess["close"] }).close = () => {
      p.closed = true;
      (p as { alive: boolean }).alive = false;
    };
    return p;
  };
  const run = async (pool: LivePool, p: LiveProcess) => {
    await new Promise<void>((r) => pool.run(base, { onEvent() {}, onFinish: () => r() }, () => p));
  };

  test("an idle process with background jobs stays open; once they end it closes after the idle time", async () => {
    const pool = new LivePool({ idleMs: 30, backgroundMs: 10_000 });
    const p = fake({ background: true });
    await run(pool, p);
    await Bun.sleep(120);
    expect(p.closed).toBe(false);
    p.background = false;
    await Bun.sleep(120);
    expect(p.closed).toBe(true);
  });

  test("background jobs keep a process only up to the limit", async () => {
    const pool = new LivePool({ idleMs: 20, backgroundMs: 60 });
    const p = fake({ background: true });
    await run(pool, p);
    await Bun.sleep(200);
    expect(p.closed).toBe(true);
  });

  test("the limit comes from SPACE_CHAT_BACKGROUND_MINUTES", () => {
    expect(backgroundMs(undefined)).toBe(120 * 60_000);
    expect(backgroundMs("30")).toBe(30 * 60_000);
    expect(backgroundMs("0")).toBe(0);
    expect(backgroundMs("soon")).toBe(120 * 60_000);
  });

  test("a job's kind: the tool that started it, else the CLI's task type", () => {
    expect(jobKind("Monitor", "local_bash")).toBe("monitor");
    expect(jobKind("Bash", "local_bash")).toBe("bash");
    expect(jobKind(undefined, "local_bash")).toBe("bash");
    expect(jobKind("Task", "local_agent")).toBe("agent");
    expect(jobKind(undefined, "remote")).toBe("other");
  });
});
