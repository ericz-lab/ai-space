import type { Database } from "bun:sqlite";
import type { ApprovalDecision, BackgroundJob, ChatCallbacks, ChatHandle, ChatTurn, QuestionAnswers, RuntimeAdapter, SteerInput } from "../runtimes/types.ts";

/**
 * Chat turns as background runs (docs/panel.md#chat). A turn belongs to the server, not to the
 * HTTP request that started it: the browser that sent the message can go away, a refreshed page
 * attaches again and replays what it missed, and only an explicit stop, the run timeout or the
 * service shutting down end the runtime process.
 *
 * A run's events live in memory with a sequence number each, so a subscriber can resume after
 * the last one it saw. The row in `agent_runs` (space.db) holds the run's identity and status from
 * the start and its events once it ends, so a finished turn is still there after its memory copy
 * is dropped, or after a restart; a row still `running` at boot is marked `interrupted`.
 *
 * A live conversation may also speak by itself (docs/runtimes.md#background-work): after a
 * background job it started reports back, the runtime runs a turn of its own. That turn is a run
 * too, `trigger: "background"`, with an empty message, on the same session; `watch` tells an open
 * panel about it, and about the session's background jobs.
 */

export type RunStatus = "running" | "done" | "error" | "stopped" | "timeout" | "interrupted";
/** Who started the run: the person's message, or the runtime answering a background job's report. */
export type RunTrigger = "user" | "background";

export type RunInfo = {
  id: string;
  /** `<app>/<agent>` on this space. */
  agent: string;
  /** The session the turn resumed, if any. */
  sessionId: string | null;
  /** The session the runtime reported for this turn. */
  sid: string | null;
  message: string;
  runtime: string;
  model: string | null;
  status: RunStatus;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** Sequence number of the newest event (0: none yet). */
  lastSeq: number;
  trigger: RunTrigger;
};

export type RunEvent = { seq: number; line: string };

/** What `watch` tells: a run started or ended, or a session's background jobs changed (the whole list). */
export type RunNews = { type: "run"; run: RunInfo } | { type: "jobs"; agent: string; sessionId: string; jobs: BackgroundJob[] };

export type RunListener = {
  onEvent: (ev: RunEvent) => void;
  onEnd: (run: RunInfo) => void;
};

export type StartRun = {
  agent: string;
  runtime: RuntimeAdapter;
  turn: ChatTurn;
  model?: string;
  onSession?: (sid: string) => void;
};

export type RunRegistryOptions = {
  /** A turn still going after this long is stopped (SPACE_CHAT_TIMEOUT_MINUTES; default 60 minutes). */
  timeoutMs?: number;
  /** Event bytes kept per run; past it, text deltas an assistant message repeats go first, then the oldest events. */
  maxEventBytes?: number;
  /** A finished run stays in memory this long for subscribers (default 10 minutes); afterwards it is read back from the row. */
  keepFinishedMs?: number;
  /** At most this many finished runs in memory (default 20). */
  keepFinished?: number;
  /** Rows kept in `agent_runs` (default 200); older ones are deleted when a run ends. */
  keepRows?: number;
  /** After a stop, the run is closed this long later even if the runtime has not exited (default 5 s). */
  killGraceMs?: number;
  /** Told when a turn starts and when it ends, e.g. for the usage service; a throw here never reaches the run. */
  onRunStart?: (run: RunInfo) => void;
  onRunEnd?: (run: RunInfo) => void;
  now?: () => number;
};

export class RunBusyError extends Error {}
export class RunClosedError extends Error {}
/** The run is over, or its runtime cannot take this now. */
export class RunStateError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_runs (
  id          TEXT PRIMARY KEY,
  agent       TEXT NOT NULL,
  session_id  TEXT,
  sid         TEXT,
  message     TEXT NOT NULL,
  runtime     TEXT NOT NULL,
  model       TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  events      TEXT,
  trigger     TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS agent_runs_started ON agent_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs(agent, started_at DESC);
`;

type Row = {
  id: string;
  agent: string;
  session_id: string | null;
  sid: string | null;
  message: string;
  runtime: string;
  model: string | null;
  status: RunStatus;
  error: string | null;
  started_at: number;
  finished_at: number | null;
  last_seq: number;
  events: string | null;
  trigger: RunTrigger | null;
};

type Live = {
  info: RunInfo;
  events: (RunEvent & { kind: string })[];
  bytes: number;
  listeners: Set<RunListener>;
  handle: ChatHandle;
  timer?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  /** Why the run is being ended, set by `stop`; the runtime's own error is kept out of it. */
  ending?: { status: RunStatus; error: string };
  ended: Promise<void>;
  resolveEnded: () => void;
};

const DEFAULTS = { timeoutMs: 60 * 60_000, maxEventBytes: 4 * 1024 * 1024, keepFinishedMs: 10 * 60_000, keepFinished: 20, keepRows: 200, killGraceMs: 5_000 };

export class RunRegistry {
  private readonly live = new Map<string, Live>();
  private readonly opts: typeof DEFAULTS;
  private readonly now: () => number;
  private readonly hooks: Pick<RunRegistryOptions, "onRunStart" | "onRunEnd">;
  private closing = false;
  /** Each conversation's background jobs, by `agent \n session`: the runtime's last whole list. */
  private readonly jobLists = new Map<string, BackgroundJob[]>();
  private readonly watchers = new Set<(news: RunNews) => void>();

  constructor(
    private readonly db: Database,
    options: RunRegistryOptions = {},
  ) {
    this.opts = { ...DEFAULTS, ...Object.fromEntries(Object.entries(options).filter(([, v]) => typeof v === "number")) };
    this.now = options.now ?? Date.now;
    this.hooks = { onRunStart: options.onRunStart, onRunEnd: options.onRunEnd };
    db.exec(SCHEMA);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(agent_runs)").all();
    if (!columns.some((c) => c.name === "trigger")) db.exec("ALTER TABLE agent_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'user'");
    // A run the previous process left running died with it.
    db.query("UPDATE agent_runs SET status = 'interrupted', error = 'ai-space restarted during the turn', finished_at = COALESCE(finished_at, ?) WHERE status = 'running'").run(this.now());
  }

  /** The turns running now (docs/local.md#updates). */
  running(): RunInfo[] {
    return [...this.live.values()].filter((l) => l.info.status === "running").map((l) => l.info);
  }

  /** Start a turn on `runtime`. Throws RunBusyError when the conversation already has a turn running, RunClosedError while shutting down. */
  start(spec: StartRun): RunInfo {
    if (this.closing) throw new RunClosedError("ai-space is shutting down; try again in a moment");
    const sessionId = spec.turn.sessionId ?? null;
    if (sessionId) {
      for (const r of this.live.values()) {
        if (r.info.status === "running" && r.info.agent === spec.agent && (r.info.sessionId === sessionId || r.info.sid === sessionId)) {
          throw new RunBusyError("this conversation already has a turn running; stop it or wait for it to finish");
        }
      }
    }
    const run = this.open({ agent: spec.agent, sessionId, message: spec.turn.message, runtime: spec.runtime.name, model: spec.model ?? null, trigger: "user" });
    try {
      run.handle = spec.runtime.chat(spec.turn, {
        ...this.callbacks(run, spec.onSession),
        onWake: (handle) => this.wake(spec, run, handle),
        onJobs: (jobs) => this.setJobs(spec.agent, run.info.sid ?? run.info.sessionId, jobs),
      });
    } catch (e) {
      this.finish(run, (e as Error).message);
    }
    return { ...run.info };
  }

  /**
   * Follow what happens to the runs: each start and end, and each change of a conversation's
   * background jobs. Returns the function that stops it.
   */
  watch(listener: (news: RunNews) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /** A conversation's background jobs as the runtime last reported them; empty when it never did. */
  jobs(agent: string, sessionId: string): BackgroundJob[] {
    return (this.jobLists.get(`${agent}\n${sessionId}`) ?? []).map((j) => ({ ...j }));
  }

  /** Every conversation with background jobs known, of `agent` or of every agent (null), newest report last. */
  jobsOf(agent: string | null): { agent: string; sessionId: string; jobs: BackgroundJob[] }[] {
    return [...this.jobLists.entries()].flatMap(([k, jobs]) => {
      const at = k.indexOf("\n");
      const owner = k.slice(0, at);
      return agent === null || owner === agent ? [{ agent: owner, sessionId: k.slice(at + 1), jobs: jobs.map((j) => ({ ...j })) }] : [];
    });
  }

  /** A run by id: the live copy, else its row. */
  get(id: string): RunInfo | null {
    const r = this.live.get(id);
    if (r) return { ...r.info };
    const row = this.db.query<Row, [string]>("SELECT * FROM agent_runs WHERE id = ?").get(id);
    return row ? fromRow(row) : null;
  }

  /**
   * Runs newest first: every running one, and those that ended within `recentMs` (default: any),
   * optionally of one agent.
   */
  list(filter: { agent?: string; recentMs?: number; limit?: number } = {}): RunInfo[] {
    const since = filter.recentMs === undefined ? 0 : this.now() - filter.recentMs;
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const rows = filter.agent
      ? this.db.query<Row, [string, number, number]>("SELECT * FROM agent_runs WHERE agent = ? AND (status = 'running' OR finished_at >= ?) ORDER BY started_at DESC LIMIT ?").all(filter.agent, since, limit)
      : this.db.query<Row, [number, number]>("SELECT * FROM agent_runs WHERE status = 'running' OR finished_at >= ? ORDER BY started_at DESC LIMIT ?").all(since, limit);
    return rows.map((row) => {
      const r = this.live.get(row.id);
      return r ? { ...r.info } : fromRow(row);
    });
  }

  /**
   * Replay the events after `after`, then follow the run live; a finished run ends right after
   * its replay. Returns the function that unsubscribes, or null for an unknown run. Unsubscribing
   * never touches the run itself.
   */
  subscribe(id: string, after: number, listener: RunListener): (() => void) | null {
    const r = this.live.get(id);
    if (r) {
      for (const ev of r.events) if (ev.seq > after) listener.onEvent({ seq: ev.seq, line: ev.line });
      if (r.info.status !== "running") {
        listener.onEnd({ ...r.info });
        return () => {};
      }
      r.listeners.add(listener);
      return () => r.listeners.delete(listener);
    }
    const row = this.db.query<Row, [string]>("SELECT * FROM agent_runs WHERE id = ?").get(id);
    if (!row) return null;
    for (const ev of parseEvents(row.events)) if (ev.seq > after) listener.onEvent(ev);
    listener.onEnd(fromRow(row));
    return () => {};
  }

  /** Stop a running turn; false when it is unknown or already over. */
  stop(id: string, reason: { status: "stopped" | "interrupted"; error: string } = { status: "stopped", error: "stopped" }): boolean {
    const r = this.live.get(id);
    if (!r || r.info.status !== "running") return false;
    this.end(r, reason.status, reason.error);
    return true;
  }

  /**
   * Add the person's message to a running turn. Throws RunStateError when the run is over or its
   * runtime cannot take a message now (not a live turn, or between two of the runtime's steps);
   * the caller then sends it as the next turn.
   */
  async steer(id: string, input: SteerInput): Promise<void> {
    const r = this.live.get(id);
    if (!r || r.info.status !== "running" || r.ending) throw new RunStateError("the turn has ended");
    if (!r.handle.steer) throw new RunStateError("this turn cannot take messages while it runs");
    try {
      await r.handle.steer(input);
    } catch (e) {
      throw new RunStateError((e as Error).message);
    }
  }

  /** Answer an approval or a question the running turn is waiting on; false when the run or the request is not open. */
  respond(id: string, requestId: string, decision: ApprovalDecision, answers?: QuestionAnswers): boolean {
    const r = this.live.get(id);
    if (!r || r.info.status !== "running" || r.ending || !r.handle.respond) return false;
    return r.handle.respond(requestId, decision, answers);
  }

  /** Number of runs still going. */
  get active(): number {
    let n = 0;
    for (const r of this.live.values()) if (r.info.status === "running") n++;
    return n;
  }

  /**
   * The service is going down: no new run starts, the running ones get `graceMs` to finish, and
   * what is left is stopped and recorded as interrupted.
   */
  async shutdown(graceMs = 0): Promise<{ finished: number; interrupted: number }> {
    this.closing = true;
    const running = [...this.live.values()].filter((r) => r.info.status === "running");
    if (!running.length) return { finished: 0, interrupted: 0 };
    const all = Promise.all(running.map((r) => r.ended));
    if (graceMs > 0) await Promise.race([all, Bun.sleep(graceMs)]);
    let interrupted = 0;
    for (const r of running) {
      if (r.info.status !== "running") continue;
      interrupted++;
      this.end(r, "interrupted", "ai-space shut down during the turn");
    }
    await Promise.race([all, Bun.sleep(this.opts.killGraceMs + 100)]);
    return { finished: running.length - interrupted, interrupted };
  }

  // ------------------------------------------------------------------ internals

  /** A new running run: in memory, in its row, its timeout armed, its start told. */
  private open(fields: Pick<RunInfo, "agent" | "sessionId" | "message" | "runtime" | "model" | "trigger">): Live {
    const info: RunInfo = { id: crypto.randomUUID(), ...fields, sid: null, status: "running", error: null, startedAt: this.now(), finishedAt: null, lastSeq: 0 };
    let resolveEnded = () => {};
    const ended = new Promise<void>((r) => (resolveEnded = r));
    const run: Live = { info, events: [], bytes: 0, listeners: new Set(), handle: { kill: () => {} }, ended, resolveEnded };
    this.live.set(info.id, run);
    this.db
      .query("INSERT INTO agent_runs (id, agent, session_id, message, runtime, model, status, started_at, trigger) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)")
      .run(info.id, info.agent, info.sessionId, info.message, info.runtime, info.model, info.startedAt, info.trigger);
    this.notify("onRunStart", info);
    if (this.opts.timeoutMs > 0) {
      run.timer = setTimeout(() => this.end(run, "timeout", `timed out after ${Math.round(this.opts.timeoutMs / 60_000)} min`), this.opts.timeoutMs);
    }
    this.announce({ type: "run", run: { ...info } });
    return run;
  }

  private callbacks(run: Live, onSession?: (sid: string) => void): ChatCallbacks {
    return {
      onEvent: (line) => this.push(run, line),
      onSession: (sid) => {
        run.info.sid = sid;
        this.db.query("UPDATE agent_runs SET sid = ? WHERE id = ?").run(sid, run.info.id);
        onSession?.(sid);
      },
      onFinish: (error) => this.finish(run, error),
    };
  }

  /** The runtime answers a background report by itself: a run of its own on the conversation of `origin`. */
  private wake(spec: StartRun, origin: Live, handle: ChatHandle): ChatCallbacks | null {
    if (this.closing) return null;
    const run = this.open({ agent: spec.agent, sessionId: origin.info.sid ?? origin.info.sessionId, message: "", runtime: spec.runtime.name, model: spec.model ?? null, trigger: "background" });
    run.handle = handle;
    return this.callbacks(run, spec.onSession);
  }

  private setJobs(agent: string, sessionId: string | null, jobs: BackgroundJob[]): void {
    if (!sessionId) return;
    const key = `${agent}\n${sessionId}`;
    this.jobLists.delete(key); // newest last
    this.jobLists.set(key, jobs.map((j) => ({ ...j })));
    while (this.jobLists.size > 200) this.jobLists.delete(this.jobLists.keys().next().value!);
    this.announce({ type: "jobs", agent, sessionId, jobs: this.jobs(agent, sessionId) });
  }

  private announce(news: RunNews): void {
    for (const w of this.watchers) {
      try {
        w(news);
      } catch (e) {
        console.error(`[agents] run watcher failed: ${(e as Error).message}`);
      }
    }
  }

  private notify(hook: "onRunStart" | "onRunEnd", info: RunInfo): void {
    try {
      this.hooks[hook]?.({ ...info });
    } catch (e) {
      console.error(`[agents] ${hook} failed: ${(e as Error).message}`);
    }
  }

  private push(run: Live, line: string): void {
    if (run.info.status !== "running" || run.ending) return;
    const ev = { seq: ++run.info.lastSeq, line, kind: kindOf(line) };
    run.events.push(ev);
    run.bytes += line.length;
    if (run.bytes > this.opts.maxEventBytes) this.compact(run);
    for (const l of run.listeners) l.onEvent({ seq: ev.seq, line });
  }

  /** Drop text deltas an assistant message after them repeats, then the oldest events, until the buffer fits. */
  private compact(run: Live): void {
    run.events = dropRepeatedDeltas(run.events);
    run.bytes = run.events.reduce((n, e) => n + e.line.length, 0);
    while (run.bytes > this.opts.maxEventBytes && run.events.length > 1) run.bytes -= run.events.shift()!.line.length;
  }

  /** End the run on the server's decision: kill the runtime, and close the run if it does not exit in time. */
  private end(run: Live, status: RunStatus, error: string): void {
    if (run.info.status !== "running" || run.ending) return;
    run.ending = { status, error };
    clearTimeout(run.timer);
    try {
      run.handle.kill();
    } catch {
      /* already gone */
    }
    run.grace = setTimeout(() => this.finish(run, error), this.opts.killGraceMs);
  }

  private finish(run: Live, error: string | null): void {
    if (run.info.status !== "running") return;
    clearTimeout(run.timer);
    clearTimeout(run.grace);
    const info = run.info;
    info.status = run.ending?.status ?? (error ? "error" : "done");
    info.error = run.ending?.error ?? error;
    info.finishedAt = this.now();
    run.events = dropRepeatedDeltas(run.events);
    run.bytes = run.events.reduce((n, e) => n + e.line.length, 0);
    this.db
      .query("UPDATE agent_runs SET status = ?, error = ?, finished_at = ?, last_seq = ?, sid = COALESCE(?, sid), events = ? WHERE id = ?")
      .run(info.status, info.error, info.finishedAt, info.lastSeq, info.sid, JSON.stringify(run.events.map((e) => [e.seq, e.line])), info.id);
    this.db.query("DELETE FROM agent_runs WHERE status != 'running' AND id NOT IN (SELECT id FROM agent_runs ORDER BY started_at DESC LIMIT ?)").run(this.opts.keepRows);
    for (const l of run.listeners) l.onEnd({ ...info });
    run.listeners.clear();
    this.notify("onRunEnd", info);
    this.announce({ type: "run", run: { ...info } });
    run.resolveEnded();
    setTimeout(() => this.live.delete(info.id), this.opts.keepFinishedMs).unref?.();
    this.evict();
  }

  /** Keep at most `keepFinished` finished runs in memory, oldest out first. */
  private evict(): void {
    const finished = [...this.live.values()].filter((r) => r.info.status !== "running");
    finished.sort((a, b) => (a.info.finishedAt ?? 0) - (b.info.finishedAt ?? 0));
    while (finished.length > this.opts.keepFinished) this.live.delete(finished.shift()!.info.id);
  }
}

function kindOf(line: string): string {
  const m = /^\s*\{\s*"type"\s*:\s*"([a-z_]+)"/.exec(line);
  if (m) return m[1]!;
  try {
    const t = (JSON.parse(line) as { type?: unknown }).type;
    return typeof t === "string" ? t : "";
  } catch {
    return "";
  }
}

/** `stream_event` lines (text deltas) followed by an `assistant` message carry nothing that message does not. */
function dropRepeatedDeltas<T extends { kind: string }>(events: T[]): T[] {
  let lastAssistant = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return events;
  return events.filter((e, i) => i > lastAssistant || e.kind !== "stream_event");
}

function parseEvents(text: string | null): RunEvent[] {
  if (!text) return [];
  try {
    return (JSON.parse(text) as [number, string][]).map(([seq, line]) => ({ seq, line }));
  } catch {
    return [];
  }
}

function fromRow(row: Row): RunInfo {
  return {
    id: row.id,
    agent: row.agent,
    sessionId: row.session_id,
    sid: row.sid,
    message: row.message,
    runtime: row.runtime,
    model: row.model,
    status: row.status,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    lastSeq: row.last_seq,
    trigger: row.trigger ?? "user",
  };
}
