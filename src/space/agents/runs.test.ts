import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import type { ChatCallbacks, RuntimeAdapter } from "../runtimes/types.ts";
import { workspacePaths } from "../workspace.ts";
import { createAgentRoutes } from "./api.ts";
import { type RunEvent, type RunInfo, RunRegistry } from "./runs.ts";
import { SessionStore } from "./sessions.ts";

/** An in-process runtime: the test drives each turn's events; a kill finishes the turn as "aborted". */
function scriptedRuntime(opts: { ignoreKill?: boolean } = {}) {
  const turns: { cb: ChatCallbacks; killed: boolean; message: string }[] = [];
  const runtime = {
    name: "fake",
    kind: "claude-code",
    capabilities: { chat: true },
    chat(turn: { message: string }, cb: ChatCallbacks) {
      const t = { cb, killed: false, message: turn.message };
      turns.push(t);
      return {
        kill: () => {
          t.killed = true;
          if (!opts.ignoreKill) queueMicrotask(() => cb.onFinish("aborted"));
        },
      };
    },
  } as unknown as RuntimeAdapter;
  return { runtime, turns };
}

const collect = (runs: RunRegistry, id: string, after = 0) => {
  const seen: RunEvent[] = [];
  let ended: RunInfo | null = null;
  const unsubscribe = runs.subscribe(id, after, { onEvent: (e) => seen.push(e), onEnd: (r) => (ended = r) })!;
  return { seen, ended: () => ended as RunInfo | null, unsubscribe };
};

const text = (t: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const delta = (t: string) => JSON.stringify({ type: "stream_event", event: { delta: { type: "text_delta", text: t } } });

describe("run registry", () => {
  test("a subscriber leaving does not end the run; a new one replays and follows it", () => {
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(new Database(":memory:"));
    const run = runs.start({ agent: "space/assistant", runtime, turn: { message: "hi", cwd: "/" } });
    const first = collect(runs, run.id);
    turns[0]!.cb.onSession?.("sid-1");
    turns[0]!.cb.onEvent(text("one"));
    first.unsubscribe();
    turns[0]!.cb.onEvent(text("two"));
    expect(turns[0]!.killed).toBe(false);
    expect(first.seen.map((e) => e.seq)).toEqual([1]);
    expect(runs.get(run.id)).toMatchObject({ status: "running", sid: "sid-1", lastSeq: 2 });

    // Reconnect after the last event seen: the missed one, then live.
    const second = collect(runs, run.id, 1);
    expect(second.seen.map((e) => e.line)).toEqual([text("two")]);
    turns[0]!.cb.onEvent(text("three"));
    turns[0]!.cb.onFinish(null);
    expect(second.seen.map((e) => e.seq)).toEqual([2, 3]);
    expect(second.ended()).toMatchObject({ status: "done", error: null });
  });

  test("a finished run is read back from its row with its events", () => {
    const db = new Database(":memory:");
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(db, { keepFinished: 0 });
    const run = runs.start({ agent: "notes/librarian", runtime, turn: { message: "hi", cwd: "/" } });
    turns[0]!.cb.onEvent(delta("o"));
    turns[0]!.cb.onEvent(delta("ne"));
    turns[0]!.cb.onEvent(text("one"));
    turns[0]!.cb.onFinish("boom");
    // Evicted from memory at once (keepFinished 0): the row answers.
    const again = collect(runs, run.id);
    // The deltas the assistant message repeats are not kept.
    expect(again.seen).toEqual([{ seq: 3, line: text("one") }]);
    expect(again.ended()).toMatchObject({ status: "error", error: "boom" });
    expect(runs.list({ agent: "notes/librarian" })).toMatchObject([{ id: run.id, status: "error", lastSeq: 3 }]);
    expect(runs.list({ agent: "other" })).toEqual([]);
    // A row left running by a previous process is interrupted at boot.
    db.query("UPDATE agent_runs SET status = 'running', finished_at = NULL").run();
    const reopened = new RunRegistry(db);
    expect(reopened.get(run.id)).toMatchObject({ status: "interrupted" });
  });

  test("stop kills the runtime and records the run as stopped", async () => {
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(new Database(":memory:"));
    const run = runs.start({ agent: "space/assistant", runtime, turn: { message: "hi", cwd: "/" } });
    const sub = collect(runs, run.id);
    expect(runs.stop(run.id)).toBe(true);
    expect(turns[0]!.killed).toBe(true);
    await Bun.sleep(5);
    expect(sub.ended()).toMatchObject({ status: "stopped", error: "stopped" });
    expect(runs.stop(run.id)).toBe(false);
  });

  test("a runtime that ignores the kill is closed after the grace", async () => {
    const { runtime } = scriptedRuntime({ ignoreKill: true });
    const runs = new RunRegistry(new Database(":memory:"), { killGraceMs: 20 });
    const run = runs.start({ agent: "space/assistant", runtime, turn: { message: "hi", cwd: "/" } });
    runs.stop(run.id);
    expect(runs.get(run.id)!.status).toBe("running");
    await Bun.sleep(40);
    expect(runs.get(run.id)).toMatchObject({ status: "stopped" });
  });

  test("the timeout stops a turn that runs too long", async () => {
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(new Database(":memory:"), { timeoutMs: 30 });
    const run = runs.start({ agent: "space/assistant", runtime, turn: { message: "hi", cwd: "/" } });
    await Bun.sleep(60);
    expect(turns[0]!.killed).toBe(true);
    expect(runs.get(run.id)).toMatchObject({ status: "timeout" });
  });

  test("shutdown waits for the grace, then interrupts what is left and refuses new runs", async () => {
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(new Database(":memory:"));
    const quick = runs.start({ agent: "a/x", runtime, turn: { message: "quick", cwd: "/" } });
    const slow = runs.start({ agent: "a/y", runtime, turn: { message: "slow", cwd: "/" } });
    setTimeout(() => turns[0]!.cb.onFinish(null), 10);
    const result = await runs.shutdown(50);
    expect(result).toEqual({ finished: 1, interrupted: 1 });
    expect(runs.get(quick.id)!.status).toBe("done");
    expect(turns[1]!.killed).toBe(true);
    expect(runs.get(slow.id)).toMatchObject({ status: "interrupted" });
    expect(() => runs.start({ agent: "a/x", runtime, turn: { message: "late", cwd: "/" } })).toThrow(/shutting down/);
  });

  test("one turn at a time per conversation; the event buffer stays bounded", () => {
    const { runtime, turns } = scriptedRuntime();
    const runs = new RunRegistry(new Database(":memory:"), { maxEventBytes: 400 });
    const run = runs.start({ agent: "a/x", runtime, turn: { message: "hi", cwd: "/", sessionId: "s1" } });
    expect(() => runs.start({ agent: "a/x", runtime, turn: { message: "again", cwd: "/", sessionId: "s1" } })).toThrow(/already has a turn/);
    for (let i = 0; i < 50; i++) turns[0]!.cb.onEvent(text(`line ${i}`));
    const sub = collect(runs, run.id);
    expect(sub.seen.length).toBeLessThan(50);
    expect(sub.seen.at(-1)!.seq).toBe(50);
    expect(sub.seen.reduce((n, e) => n + e.line.length, 0)).toBeLessThanOrEqual(400);
  });
});

// The HTTP surface with a real child process: a stand-in claude CLI.
const FAKE_CLI = `
const args = process.argv.slice(2);
const msg = args[args.indexOf("-p") + 1] ?? "";
const out = (o) => console.log(JSON.stringify(o));
const [verb, file, count] = msg.split(" ");
out({ type: "system", subtype: "init", session_id: "cafe0003-0000-4000-8000-000000000000", model: "fake" });
if (verb === "hang") { await Bun.write(file, String(process.pid)); await new Promise(() => {}); }
for (let i = 1; i <= Number(count ?? 3); i++) {
  await new Promise((r) => setTimeout(r, 60));
  out({ type: "assistant", message: { content: [{ type: "text", text: "part " + i }] } });
}
if (verb === "ticks") await Bun.write(file, "finished");
out({ type: "result", session_id: "cafe0003-0000-4000-8000-000000000000", is_error: false });
`;

let server: ReturnType<typeof Bun.serve>;
let base = "";
let home = "";
const runs = new RunRegistry(new Database(":memory:"));

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "space-runs-")));
  await mkdir(workspacePaths(home).apps, { recursive: true });
  await writeFile(join(home, "fake-claude.js"), FAKE_CLI);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: createAgentRoutes({ ws: workspacePaths(home), registry: new AppRegistry(), layout: new LayoutStore(new Database(":memory:")), sessions: new SessionStore(new Database(":memory:")), runtimes: claudeOnly(["bun", join(home, "fake-claude.js")]), runs }),
  });
  base = `http://127.0.0.1:${server.port}/api/agents`;
});

afterAll(() => server.stop(true));

const startChat = (message: string, signal?: AbortSignal) => fetch(`${base}/space/assistant/chat`, { method: "POST", body: JSON.stringify({ message }), signal });
/** Read SSE frames until `stop` says enough or the stream ends: [seq, parsed data]. */
async function readFrames(r: Response, stop: (frames: [number | null, Record<string, unknown>][]) => boolean = () => false) {
  const frames: [number | null, Record<string, unknown>][] = [];
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    buf = chunks.pop() ?? "";
    for (const c of chunks) {
      const lines = c.split("\n");
      const data = lines.find((l) => l.startsWith("data: "));
      if (!data) continue;
      const id = lines.find((l) => l.startsWith("id: "));
      frames.push([id ? Number(id.slice(4)) : null, JSON.parse(data.slice(6))]);
    }
    if (stop(frames)) {
      await reader.cancel();
      break;
    }
  }
  return frames;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(cond: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(20);
  }
  throw new Error("condition not met in time");
}

describe("background runs over HTTP", () => {
  test("closing the page does not kill the turn; reattaching replays and follows it", async () => {
    const marker = join(home, "ticks-finished");
    const ctrl = new AbortController();
    const r = await startChat(`ticks ${marker} 5`, ctrl.signal);
    const id = r.headers.get("x-run-id")!;
    expect(id).toBeTruthy();
    // Read the first runtime event, then go away as a closing tab does.
    const seen = await readFrames(r, (f) => f.some(([, d]) => d.type === "assistant"));
    ctrl.abort();
    const lastSeq = seen.at(-1)![0]!;
    expect(runs.get(id)!.status).toBe("running");

    // The page comes back: the run is listed, and its events after the last one seen follow.
    const listed = (await (await fetch(`${base}/runs?recent=60`)).json()) as { runs: RunInfo[] };
    expect(listed.runs.find((x) => x.id === id)).toMatchObject({ agent: "space/assistant", message: `ticks ${marker} 5`, status: "running" });
    const rest = await readFrames(await fetch(`${base}/space/assistant/runs/${id}/events?after=${lastSeq}`));
    expect(rest[0]![0]).toBe(lastSeq + 1);
    const texts = [...seen, ...rest].filter(([, d]) => d.type === "assistant").map(([, d]) => (d.message as { content: { text: string }[] }).content[0]!.text);
    expect(texts).toEqual(["part 1", "part 2", "part 3", "part 4", "part 5"]);
    expect(rest.at(-1)![1]).toEqual({ type: "done" });
    expect(await readFile(marker, "utf8")).toBe("finished");
    expect((await (await fetch(`${base}/space/assistant/runs/${id}`)).json()).run).toMatchObject({ status: "done", sid: "cafe0003-0000-4000-8000-000000000000" });

    // A finished run replays whole from the start.
    const replay = await readFrames(await fetch(`${base}/space/assistant/runs/${id}/events`));
    expect(replay.filter(([, d]) => d.type === "assistant")).toHaveLength(5);
  });

  test("stop ends the turn and kills its process", async () => {
    const pidFile = join(home, "hang.pid");
    const r = await startChat(`hang ${pidFile}`);
    const id = r.headers.get("x-run-id")!;
    const frames = readFrames(r);
    await until(async () => (await Bun.file(pidFile).exists()) && (await Bun.file(pidFile).text()).length > 0);
    const pid = Number(await Bun.file(pidFile).text());
    expect(alive(pid)).toBe(true);
    // Another agent's path does not reach the run.
    expect((await fetch(`${base}/notes/librarian/runs/${id}/stop`, { method: "POST" })).status).toBe(404);
    const stop = await fetch(`${base}/space/assistant/runs/${id}/stop`, { method: "POST" });
    expect(await stop.json()).toMatchObject({ ok: true, stopped: true });
    const ev = await frames;
    expect(ev.at(-2)![1]).toMatchObject({ type: "error", status: "stopped" });
    expect(ev.at(-1)![1]).toEqual({ type: "done" });
    await until(() => !alive(pid));
    expect(runs.get(id)!.status).toBe("stopped");
  });

  test("unknown runs are 404", async () => {
    expect((await fetch(`${base}/space/assistant/runs/nope/events`)).status).toBe(404);
    expect((await fetch(`${base}/space/assistant/runs/nope/stop`, { method: "POST" })).status).toBe(404);
  });
});
