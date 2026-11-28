import type { Database } from "bun:sqlite";
import { finalText } from "../feedback/prompt.ts";
import { PERMISSION_MODE, type TeamPermission, type TeamStore } from "../team/store.ts";
import { DELEGATION_STATES, type DelegationNoteView, type DelegationState, type DelegationView, ENDED_STATES, type NoteKind, delegationLabel, resultHeader } from "./delegation-view.ts";
import type { ChatImage } from "./images.ts";
import { type RemoteMachines, peerAgentPath, readRunEvents, splitDelegate } from "./delegations-remote.ts";
import { RunStateError, type RunInfo, type RunRegistry } from "./runs.ts";

/**
 * Delegation (docs/orders.md#delegation): an agent's run hands a piece of work to a member of the
 * team, may add a message to it while it runs or stop it, and gets the result back in its own
 * session. The two controls are the runtimes' own (`RunRegistry.steer` and `stop`); this adds the
 * record, the run token, the result's delivery and the events.
 *
 * - **Record**: `delegations` and `delegation_notes` in space.db. The brief is note 1 and is never
 *   rewritten; every added message, the stop and the result are appended. The only later write to
 *   a note is `read_at`, when the delegate's run reports it read the message (its `steer` event).
 * - **Run token**: `SPACE_RUN_TOKEN` in the environment of a turn of an agent that may delegate
 *   (today only `space/director`), tied to that run and so to its agent and session; it lives as
 *   long as the run. A delegated run gets none.
 * - **Result**: when the delegated run ends, its result goes to the delegator's session: added to
 *   the running turn there (`steer`), else a new turn with the trigger `delegation`. At most
 *   `MAX_RESULT_TURNS` such turns in a row without a turn of the person's; past that the result is
 *   held, shown, and the delegator's topic waits for the person. A delegation its delegator stopped
 *   is not delivered again: `stop` already answered with what the delegate had said.
 * - **Restart**: a delegation whose run did not live to its end is marked as its run is
 *   (`interrupted`) at start, and that result is delivered.
 * - **Another machine** (docs/orders.md#on-another-machine): a member `<peer>/<app>/<agent>` runs
 *   on that peer through its `/api/peer/agents/…` routes (`RemoteMachines`); the row keeps
 *   `to_machine` and the peer's run id in `run_id`. The run is followed on the peer's event stream,
 *   read again after the last seq when it drops; `to_seq` is the last event whose effect is recorded,
 *   so a replay after a restart reads nothing twice. While the machine does not answer the
 *   delegation stays running with `unreachable_since`; after `REMOTE_GIVE_UP_MS` it is `interrupted`.
 */

/** Agents whose turns get a run token and may delegate. */
export const DELEGATORS = ["space/director"] as const;
/** Result-triggered turns in a row on one session before the person is asked. */
export const MAX_RESULT_TURNS = 4;
/** The delegate's final reply in the delivered result, at most. */
export const MAX_RESULT = 8_000;
export const MAX_BRIEF = 20_000;
export const MAX_SAY = 8_000;
/** What an event carries of a brief or result, at most. */
export const MAX_EVENT_SUMMARY = 600;
/**
 * A delegate on another machine whose machine has not answered for this long is given up: the
 * delegation ends `interrupted`. Longer than a run's own timeout on the peer (60 min by default), so
 * a machine that comes back within the day still reports how its run ended; a peer keeps its last
 * 200 finished runs, which the day of a busy Space can outgrow.
 */
export const REMOTE_GIVE_UP_MS = 24 * 60 * 60_000;
/** The peer's event stream sends a heartbeat every 20 s; this long without a byte is a dead link. */
export const REMOTE_IDLE_MS = 70_000;
/** Waits between attempts to read a remote run again: growing to the last one. */
const REMOTE_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_IMAGES = 4;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delegations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_agent   TEXT NOT NULL,
  from_session TEXT,
  from_run     TEXT,
  to_agent     TEXT NOT NULL,
  to_role      TEXT NOT NULL,
  to_title     TEXT NOT NULL DEFAULT '',
  to_machine   TEXT NOT NULL DEFAULT '',
  to_session   TEXT,
  run_id       TEXT,
  state        TEXT NOT NULL,
  permission   TEXT NOT NULL DEFAULT 'ask',
  order_id     INTEGER,
  continued    INTEGER,
  delivered    TEXT,
  created_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  to_seq       INTEGER NOT NULL DEFAULT 0,
  unreachable_since INTEGER
);
CREATE INDEX IF NOT EXISTS delegations_from ON delegations(from_agent, from_session, id);
CREATE TABLE IF NOT EXISTS delegation_notes (
  delegation_id INTEGER NOT NULL,
  seq           INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  taken         INTEGER,
  read_at       INTEGER,
  reason        TEXT,
  PRIMARY KEY (delegation_id, seq)
);
`;

/** Columns added after phase 2; each is added once to an older table. */
const ADDED: [column: string, decl: string][] = [
  ["to_seq", "INTEGER NOT NULL DEFAULT 0"],
  ["unreachable_since", "INTEGER"],
];

export type Delegation = {
  id: number;
  fromAgent: string;
  fromSession: string | null;
  fromRun: string | null;
  toAgent: string;
  toRole: string;
  toTitle: string;
  toMachine: string;
  toSession: string | null;
  runId: string | null;
  state: DelegationState;
  permission: TeamPermission;
  orderId: number | null;
  continued: number | null;
  delivered: "steered" | "turn" | "held" | "skipped" | null;
  createdAt: number;
  endedAt: number | null;
  /** A delegate on another machine: the last event of its run whose effect (a message read) is recorded. */
  toSeq: number;
  /** A delegate on another machine: since when its machine does not answer; null while it does. */
  unreachableSince: number | null;
};

export type DelegationNote = { delegationId: number; seq: number; at: number; kind: NoteKind; text: string; taken: boolean | null; readAt: number | null; reason: string | null };

type Row = {
  id: number;
  from_agent: string;
  from_session: string | null;
  from_run: string | null;
  to_agent: string;
  to_role: string;
  to_title: string;
  to_machine: string;
  to_session: string | null;
  run_id: string | null;
  state: string;
  permission: string;
  order_id: number | null;
  continued: number | null;
  delivered: string | null;
  created_at: number;
  ended_at: number | null;
  to_seq: number;
  unreachable_since: number | null;
};
type NoteRow = { delegation_id: number; seq: number; at: number; kind: string; text: string; taken: number | null; read_at: number | null; reason: string | null };

export class DelegationStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(SCHEMA);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(delegations)").all();
    for (const [column, decl] of ADDED) if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE delegations ADD COLUMN ${column} ${decl}`);
  }

  /** `toAgent` is the agent on its machine (`<app>/<agent>`); `toMachine` the peer it runs on, empty for this Space. */
  create(d: Pick<Delegation, "fromAgent" | "fromSession" | "fromRun" | "toAgent" | "toRole" | "toTitle" | "permission" | "orderId" | "continued"> & { toMachine?: string }, brief: string): Delegation {
    const at = this.now();
    const id = this.db.transaction(() => {
      const r = this.db
        .query("INSERT INTO delegations (from_agent, from_session, from_run, to_agent, to_role, to_title, to_machine, state, permission, order_id, continued, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)")
        .run(d.fromAgent, d.fromSession, d.fromRun, d.toAgent, d.toRole, d.toTitle, d.toMachine ?? "", d.permission, d.orderId, d.continued, at);
      const id = Number(r.lastInsertRowid);
      this.db.query("INSERT INTO delegation_notes (delegation_id, seq, at, kind, text) VALUES (?, 1, ?, 'brief', ?)").run(id, at, brief);
      return id;
    })();
    return this.get(id)!;
  }

  get(id: number): Delegation | undefined {
    const row = this.db.query<Row, [number]>("SELECT * FROM delegations WHERE id = ?").get(id);
    return row ? delegationOf(row) : undefined;
  }

  /** A session's delegations, oldest first. */
  ofSession(agent: string | null, session: string): Delegation[] {
    const rows = agent
      ? this.db.query<Row, [string, string]>("SELECT * FROM delegations WHERE from_agent = ? AND from_session = ? ORDER BY id").all(agent, session)
      : this.db.query<Row, [string]>("SELECT * FROM delegations WHERE from_session = ? ORDER BY id").all(session);
    return rows.map(delegationOf);
  }

  /** The delegations not ended, and the ended ones whose result was never handled (a restart in between). */
  unsettled(): Delegation[] {
    return this.db.query<Row, []>("SELECT * FROM delegations WHERE state IN ('running', 'waiting') OR delivered IS NULL ORDER BY id").all().map(delegationOf);
  }

  recent(limit = 50): Delegation[] {
    return this.db.query<Row, [number]>("SELECT * FROM delegations ORDER BY id DESC LIMIT ?").all(limit).map(delegationOf);
  }

  patch(id: number, p: Partial<Pick<Delegation, "toSession" | "runId" | "state" | "delivered" | "endedAt" | "fromSession" | "toSeq" | "unreachableSince">>): void {
    const cols: string[] = [];
    const vals: (string | number | null)[] = [];
    const map: Record<string, string> = { toSession: "to_session", runId: "run_id", state: "state", delivered: "delivered", endedAt: "ended_at", fromSession: "from_session", toSeq: "to_seq", unreachableSince: "unreachable_since" };
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined) continue;
      cols.push(`${map[k]} = ?`);
      vals.push(v as string | number | null);
    }
    if (cols.length) this.db.query(`UPDATE delegations SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  /** A delegator's session got a new id from its runtime: its delegations follow it. */
  renameSession(agent: string, from: string, to: string): void {
    this.db.query("UPDATE delegations SET from_session = ? WHERE from_agent = ? AND from_session = ?").run(to, agent, from);
  }

  /** Append a note; the record is never rewritten. */
  note(id: number, kind: NoteKind, text: string, extra: { taken?: boolean; reason?: string } = {}): DelegationNote {
    const seq = (this.db.query<{ n: number | null }, [number]>("SELECT MAX(seq) AS n FROM delegation_notes WHERE delegation_id = ?").get(id)?.n ?? 0) + 1;
    this.db.query("INSERT INTO delegation_notes (delegation_id, seq, at, kind, text, taken, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, seq, this.now(), kind, text, extra.taken === undefined ? null : extra.taken ? 1 : 0, extra.reason ?? null);
    return this.notes(id).find((n) => n.seq === seq)!;
  }

  notes(id: number): DelegationNote[] {
    return this.db.query<NoteRow, [number]>("SELECT * FROM delegation_notes WHERE delegation_id = ? ORDER BY seq").all(id).map(noteOf);
  }

  /** The oldest message taken and not yet read whose text is `text` (else the oldest one): it is read now. */
  markRead(id: number, text: string): DelegationNote | undefined {
    const open = this.notes(id).filter((n) => n.kind === "say" && n.taken && n.readAt === null);
    const hit = open.find((n) => n.text.trim() === text.trim()) ?? open[0];
    if (!hit) return undefined;
    this.db.query("UPDATE delegation_notes SET read_at = ? WHERE delegation_id = ? AND seq = ?").run(this.now(), id, hit.seq);
    return { ...hit, readAt: this.now() };
  }
}

function delegationOf(r: Row): Delegation {
  return {
    id: r.id,
    fromAgent: r.from_agent,
    fromSession: r.from_session,
    fromRun: r.from_run,
    toAgent: r.to_agent,
    toRole: r.to_role,
    toTitle: r.to_title,
    toMachine: r.to_machine,
    toSession: r.to_session,
    runId: r.run_id,
    state: (DELEGATION_STATES as readonly string[]).includes(r.state) ? (r.state as DelegationState) : "error",
    permission: r.permission === "edit" || r.permission === "full" ? r.permission : "ask",
    orderId: r.order_id,
    continued: r.continued,
    delivered: (["steered", "turn", "held", "skipped"] as const).find((x) => x === r.delivered) ?? null,
    createdAt: r.created_at,
    endedAt: r.ended_at,
    toSeq: r.to_seq ?? 0,
    unreachableSince: r.unreachable_since ?? null,
  };
}

function noteOf(r: NoteRow): DelegationNote {
  return { delegationId: r.delegation_id, seq: r.seq, at: r.at, kind: r.kind as NoteKind, text: r.text, taken: r.taken === null ? null : r.taken === 1, readAt: r.read_at, reason: r.reason };
}

// ---------------------------------------------------------------------------- run tokens

/** Who a run token belongs to: the run of an agent that may delegate. */
export type RunCaller = { agent: string; runId: string };

/**
 * The run tokens (docs/orders.md#who-may-call): a random secret per turn of a delegating agent,
 * minted before the turn starts and bound to its run once the run exists; it stops working when
 * the run ends. Kept in memory only: a restart ends every run.
 */
export class RunTokens {
  private readonly byToken = new Map<string, { agent: string; runId: string | null }>();

  constructor(private readonly runs: RunRegistry) {}

  /** A token for a turn of `agent`, or undefined when the agent may not delegate. */
  mint(agent: string): { token: string; bind: (runId: string) => void; drop: () => void } | undefined {
    if (!(DELEGATORS as readonly string[]).includes(agent)) return undefined;
    const token = `srt_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
    const entry = { agent, runId: null as string | null };
    this.byToken.set(token, entry);
    return {
      token,
      bind: (runId) => {
        entry.runId = runId;
        this.runs.subscribe(runId, Number.MAX_SAFE_INTEGER, { onEvent() {}, onEnd: () => this.byToken.delete(token) });
      },
      drop: () => this.byToken.delete(token),
    };
  }

  /** The run a token belongs to while that run runs; undefined for anything else. */
  resolve(token: string): RunCaller | undefined {
    const e = this.byToken.get(token);
    if (!e?.runId) return undefined;
    if (this.runs.get(e.runId)?.status !== "running") {
      this.byToken.delete(token);
      return undefined;
    }
    return { agent: e.agent, runId: e.runId };
  }

  /** Whether the string is a run token at all (for the host guard). */
  known(token: string): boolean {
    return this.byToken.has(token);
  }
}

// ---------------------------------------------------------------------------- service

type ChatHandler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

export class DelegationError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export type DelegationServiceOptions = {
  store: DelegationStore;
  team: TeamStore;
  runs: RunRegistry;
  /** The agents' chat route (`POST /api/agents/:app/:agent/chat`), called in process. */
  chat: ChatHandler;
  /** Whether `<app>/<agent>` is an agent of this Space now. */
  agentExists: (id: string) => Promise<boolean> | boolean;
  /** The orders behind a session (docs/orders.md#delegation): the newest order of its topic, its topic, and an order's screenshot when the order belongs to that session. */
  orders?: {
    of: (session: string) => { orderId: number | null; topicId: number | null };
    image: (orderId: number, session: string) => Promise<ChatImage | undefined>;
  };
  publish?: (name: string, data: Record<string, unknown>) => void;
  /** The peers whose agents a member may be (`<peer>/<app>/<agent>`); absent: delegation stays on this machine. */
  machines?: RemoteMachines;
  /** Tests: the remote timings (give up, a quiet stream, the waits between attempts). */
  remote?: { giveUpMs?: number; idleMs?: number; retryMs?: number[] };
  log?: (line: string) => void;
  now?: () => number;
};

export type StartInput = { to: string; brief: string; continue?: number; images?: number[] };

export type SayOutcome = { ok: true } | { ok: false; reason: "ended" | "unsupported" | "unreachable"; error: string };

/** The agent a delegation went to, with its machine: `<peer>/<app>/<agent>` or `<app>/<agent>`. */
export const delegateOf = (d: Pick<Delegation, "toAgent" | "toMachine">) => (d.toMachine ? `${d.toMachine}/${d.toAgent}` : d.toAgent);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class DelegationService {
  private readonly store: DelegationStore;
  private readonly runs: RunRegistry;
  private readonly log: (line: string) => void;
  /** Followed delegate runs, by delegation id: their lines so far, what they wait on, and (remote) the stream's abort. */
  private readonly followed = new Map<number, Followed>();
  /** Delegations being stopped, and by whom. */
  private readonly stopping = new Map<number, "delegator" | "person">();
  private readonly listeners = new Set<(d: DelegationView) => void>();
  private readonly heldListeners = new Set<(d: DelegationView) => void>();
  private unwatch: (() => void) | null = null;
  private pending: Promise<unknown>[] = [];

  constructor(private readonly opts: DelegationServiceOptions) {
    this.store = opts.store;
    this.runs = opts.runs;
    this.log = opts.log ?? ((l) => console.log(`[delegations] ${l}`));
  }

  /** Told whenever a delegation starts or changes. */
  onChange(fn: (d: DelegationView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Told when a result is held at the limit of result-triggered turns: the person must look. */
  onHeld(fn: (d: DelegationView) => void): () => void {
    this.heldListeners.add(fn);
    return () => this.heldListeners.delete(fn);
  }

  /**
   * After a restart: delegations whose run is gone are marked as the run was, and their results
   * delivered. A delegate on another machine is followed again on its machine's event stream, from the
   * start: it tells whether the run still runs, how it ended while this Space was down, and its steps.
   */
  start(): void {
    for (const d of this.store.unsettled()) {
      if ((d.state === "running" || d.state === "waiting") && d.toMachine) {
        if (d.runId) this.followRemote(d.id);
        else this.finish(d.id, "interrupted", "ai-space restarted before the delegate's turn started", "");
      } else if (d.state === "running" || d.state === "waiting") {
        const run = d.runId ? this.runs.get(d.runId) : null;
        if (run?.status === "running") {
          this.follow(d.id, d.runId!);
          continue;
        }
        const state = (run && (ENDED_STATES as readonly string[]).includes(run.status) ? run.status : "interrupted") as DelegationState;
        this.finish(d.id, state, run?.error || "ai-space restarted during the delegated turn", "");
      } else if (d.delivered === null) {
        this.track(this.deliver(d.id));
      }
    }
    // A delegator's session that its runtime renamed: its delegations follow it.
    this.unwatch = this.runs.watch((news) => {
      if (news.type !== "run" || news.run.status === "running") return;
      const r = news.run;
      if (!(DELEGATORS as readonly string[]).includes(r.agent) || !r.sessionId || !r.sid || r.sessionId === r.sid) return;
      this.store.renameSession(r.agent, r.sessionId, r.sid);
    });
  }

  stop(): void {
    this.unwatch?.();
    this.unwatch = null;
    for (const [id, f] of this.followed) {
      if (!f.abort) continue;
      f.abort.abort();
      this.followed.delete(id);
    }
  }

  /** Resolves once the deliveries in flight have settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.pending.length) {
      const now = this.pending;
      this.pending = [];
      await Promise.allSettled(now);
    }
  }

  private track(p: Promise<unknown>): void {
    this.pending.push(p.catch((e) => this.log(`delivery failed: ${(e as Error).message}`)));
  }

  // ---------------------------------------------------------------- views

  view(id: number): DelegationView | undefined {
    const d = this.store.get(id);
    return d ? this.viewOf(d) : undefined;
  }

  viewOf(d: Delegation): DelegationView {
    const notes = this.store.notes(d.id);
    return {
      id: d.id,
      label: delegationLabel(d.id),
      from: { agent: d.fromAgent, session: d.fromSession },
      to: { agent: d.toAgent, role: d.toRole, title: d.toTitle, machine: d.toMachine, session: this.sessionOfDelegate(d), runId: d.runId },
      state: d.state,
      permission: d.permission,
      orderId: d.orderId,
      continued: d.continued,
      createdAt: new Date(d.createdAt).toISOString(),
      endedAt: d.endedAt === null ? null : new Date(d.endedAt).toISOString(),
      notes: notes.map(noteView),
      delivered: d.delivered === "skipped" ? null : d.delivered,
      asking: [...(this.followed.get(d.id)?.asking.values() ?? [])],
      unreachableSince: d.unreachableSince === null ? null : new Date(d.unreachableSince).toISOString(),
    };
  }

  /** A session's delegations, oldest first. */
  ofSession(session: string, agent?: string): DelegationView[] {
    return this.store.ofSession(agent ?? null, session).map((d) => this.viewOf(d));
  }

  /** Whether a session has a delegation running now, and whether one waits for the person. */
  activity(session: string): { running: boolean; waiting: boolean; asking: string[]; full: boolean } {
    const ds = this.store.ofSession(null, session).filter((d) => d.state === "running" || d.state === "waiting");
    const asking = ds.flatMap((d) => [...(this.followed.get(d.id)?.asking.values() ?? [])].map((a) => `${d.toTitle || d.toRole}: ${a}`));
    return { running: ds.length > 0, waiting: ds.some((d) => d.state === "waiting"), asking, full: ds.some((d) => d.permission === "full") };
  }

  /** `show`: the record and the tail of the delegate's steps. */
  async show(id: number): Promise<{ delegation: DelegationView; tail: string[] }> {
    const view = this.view(id);
    if (!view) throw new DelegationError(404, `unknown delegation ${id}`);
    return { delegation: view, tail: tailOf(await this.linesOf(this.store.get(id)!)) };
  }

  // ---------------------------------------------------------------- the delegator's calls

  /** The session of a delegator's running turn; refused while the runtime has not named it. */
  private sessionOf(caller: RunCaller): string {
    const run = this.runs.get(caller.runId);
    const session = run?.sid ?? run?.sessionId ?? null;
    if (!session) throw new DelegationError(409, "this turn has no session yet; try again in a moment");
    return session;
  }

  /** The ids the caller's session goes by: the one it resumed and the one its runtime reported. */
  private sessionsOf(caller: RunCaller): string[] {
    const run = this.runs.get(caller.runId);
    return [run?.sid, run?.sessionId].filter((s): s is string => !!s);
  }

  /** A delegation of the caller's own session, or a refusal. */
  private own(caller: RunCaller | null, id: number): Delegation {
    const d = this.store.get(id);
    if (!d) throw new DelegationError(404, `unknown delegation ${id}`);
    if (caller && (d.fromAgent !== caller.agent || !d.fromSession || !this.sessionsOf(caller).includes(d.fromSession))) throw new DelegationError(403, `${delegationLabel(id)} belongs to another conversation`);
    return d;
  }

  /** Read a delegation: the caller's own, or any for the owner (`caller` null). */
  read(caller: RunCaller | null, id: number): DelegationView {
    return this.viewOf(this.own(caller, id));
  }

  /** The delegations of the caller's session, or of a named session for the owner. */
  list(caller: RunCaller | null, session: string | null): DelegationView[] {
    if (caller) {
      const seen = new Set<number>();
      return this.sessionsOf(caller).flatMap((sid) => this.ofSession(sid, caller.agent)).filter((d) => !seen.has(d.id) && !!seen.add(d.id)).sort((a, b) => a.id - b.id);
    }
    if (!session) return this.store.recent().reverse().map((d) => this.viewOf(d));
    return this.ofSession(session);
  }

  /** `start`: a turn of the member with the brief; answers at once, the work goes on. */
  async begin(caller: RunCaller, input: StartInput): Promise<DelegationView> {
    if (!(DELEGATORS as readonly string[]).includes(caller.agent)) throw new DelegationError(403, `${caller.agent} may not delegate`);
    const session = this.sessionOf(caller);
    const brief = typeof input.brief === "string" ? input.brief.trim() : "";
    if (!brief) throw new DelegationError(400, "the brief is empty");
    if (brief.length > MAX_BRIEF) throw new DelegationError(400, `the brief is ${brief.length} characters; the limit is ${MAX_BRIEF}`);
    const to = typeof input.to === "string" ? input.to.trim() : "";
    if (!to) throw new DelegationError(400, "name the member: a role of the team (engineer) or its agent");
    const parts = to.split("/");
    if (parts.length > 3) throw new DelegationError(400, `${to} is not a role or an agent (<app>/<agent>, <peer>/<app>/<agent>)`);
    const member = parts.length >= 2 ? this.opts.team.byAgent(to) : this.opts.team.get(to);
    if (!member) throw new DelegationError(403, `${to} is not a member of the team; the team has ${this.opts.team.list().filter((m) => m.enabled && m.role !== "director").map((m) => m.role).join(", ") || "no one else"}`, "not-member");
    if (member.agent === caller.agent) throw new DelegationError(400, "a delegator cannot delegate to itself", "self");
    if (!member.enabled) throw new DelegationError(403, `${member.role} is disabled on the team`, "disabled");
    const where = splitDelegate(member.agent);
    if (where.machine) {
      const machines = this.opts.machines;
      if (!machines) throw new DelegationError(400, `${member.role}'s agent ${member.agent} is on ${where.machine}, and this Space reaches no other machine's agents`, "other-machine");
      const access = machines.access(where.machine);
      if (!access.ok) throw new DelegationError(access.reason === "offline" ? 503 : 409, `${member.role} runs on ${where.machine}: ${access.error}`, access.reason === "offline" ? "machine-offline" : access.reason === "no-agents" ? "machine-no-agents" : "machine-unlisted");
      if (!machines.hasAgent(where.machine, where.agent)) throw new DelegationError(409, `${member.role}'s agent ${where.agent} is not on ${where.machine} any more (its last snapshot does not list it)`, "removed");
    } else if (!(await this.opts.agentExists(member.agent))) throw new DelegationError(409, `${member.role}'s agent ${member.agent} is not on this Space any more`, "removed");
    let earlier: Delegation | undefined;
    if (input.continue !== undefined) {
      earlier = this.own(caller, Number(input.continue));
      if (delegateOf(earlier) !== member.agent) throw new DelegationError(400, `${delegationLabel(earlier.id)} went to ${earlier.toRole}, not ${member.role}`);
      if (earlier.state === "running" || earlier.state === "waiting") throw new DelegationError(409, `${delegationLabel(earlier.id)} is still running: add to it (say) or stop it first`);
      if (!this.sessionOfDelegate(earlier)) throw new DelegationError(409, `${delegationLabel(earlier.id)} has no session to continue`);
    }
    const ids = input.images ?? [];
    if (!Array.isArray(ids) || ids.length > MAX_IMAGES || !ids.every((x) => Number.isInteger(x) && x > 0)) throw new DelegationError(400, `images must list at most ${MAX_IMAGES} order ids`);
    const images: ChatImage[] = [];
    for (const orderId of ids) {
      const img = await this.opts.orders?.image(orderId, session);
      if (!img) throw new DelegationError(400, `order #${orderId} has no screenshot in this conversation`);
      images.push(img);
    }
    const context = this.opts.orders?.of(session) ?? { orderId: null, topicId: null };
    const d = this.store.create({ fromAgent: caller.agent, fromSession: session, fromRun: caller.runId, toAgent: where.agent, toMachine: where.machine, toRole: member.role, toTitle: member.title, permission: member.permission, orderId: ids[0] ?? context.orderId, continued: earlier?.id ?? null }, brief);
    const [app, agent] = where.agent.split("/") as [string, string];
    const toSession = earlier ? this.sessionOfDelegate(earlier) : null;
    const permissionMode = PERMISSION_MODE[member.permission];
    const body = {
      message: `〔${delegationLabel(d.id)} · from ${caller.agent === "space/director" ? "the Director" : caller.agent}〕\n${brief}`,
      ...(images.length ? { images } : {}),
      ...(toSession ? { sessionId: toSession } : member.model ? { model: member.model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      interactive: true,
    };
    let res: Response;
    if (where.machine) {
      // On the peer: its chat route, through the peer client (the hub's link is the owner there).
      try {
        res = await this.opts.machines!.request(where.machine, peerAgentPath(where.agent, "/chat"), { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        const reason = clip(String((e as Error).message ?? e), 300);
        this.store.note(d.id, "result", `The delegate's turn did not start: ${where.machine} did not answer (${reason})`);
        this.store.patch(d.id, { state: "error", endedAt: this.now(), delivered: "skipped" });
        this.changed(d.id);
        throw new DelegationError(502, `${member.role}'s turn did not start: ${where.machine} did not answer (${reason})`, "machine-offline");
      }
    } else {
      const req = Object.assign(new Request(`http://space.local/api/agents/${app}/${agent}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: { app, agent } });
      res = await this.opts.chat(req);
    }
    const runId = res.headers.get("x-run-id");
    if (!res.ok || !runId) {
      let reason = await res.text().catch(() => "");
      try {
        reason = (JSON.parse(reason) as { error?: string }).error ?? reason;
      } catch { /* text */ }
      reason = clip(reason || `HTTP ${res.status}`, 600);
      this.store.note(d.id, "result", `The delegate's turn did not start: ${reason}`);
      this.store.patch(d.id, { state: "error", endedAt: this.now(), delivered: "skipped" });
      this.changed(d.id);
      throw new DelegationError(res.status === 409 ? 409 : 502, `${member.role}'s turn did not start: ${reason}`, res.status === 409 ? "busy" : "not-started");
    }
    await res.body?.cancel().catch(() => {});
    this.store.patch(d.id, { runId, ...(toSession ? { toSession } : {}) });
    this.publish("delegation.started", { id: d.id, ...(d.orderId !== null ? { order: d.orderId } : {}), ...(context.topicId !== null ? { topic: context.topicId } : {}), from: caller.agent, to: member.agent, role: member.role });
    if (where.machine) this.followRemote(d.id);
    else this.follow(d.id, runId);
    this.changed(d.id);
    return this.view(d.id)!;
  }

  /** `say`: the message added to the delegate's running turn, or the reason it was not. Never queued. */
  async say(caller: RunCaller, id: number, message: string): Promise<SayOutcome> {
    const d = this.own(caller, id);
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) throw new DelegationError(400, "the message is empty");
    if (text.length > MAX_SAY) throw new DelegationError(400, `the message is ${text.length} characters; the limit is ${MAX_SAY}`);
    let outcome: SayOutcome;
    const running = (d.state === "running" || d.state === "waiting") && !!d.runId && (d.toMachine ? true : this.runs.get(d.runId)?.status === "running");
    if (d.toMachine && running) outcome = await this.sayRemote(d, text);
    else if (!running) outcome = { ok: false, reason: "ended", error: `${delegationLabel(id)} has ended; start again with --continue ${id} to go on in its session` };
    else if (!this.runs.steerable(d.runId!)) outcome = { ok: false, reason: "unsupported", error: "the delegate's runtime cannot take a message while it runs; stop it and start again, or wait for the result" };
    else {
      try {
        await this.runs.steer(d.runId!, { message: text });
        outcome = { ok: true };
      } catch (e) {
        if (!(e instanceof RunStateError)) throw e;
        outcome = this.runs.get(d.runId!)?.status === "running"
          ? { ok: false, reason: "unsupported", error: `the delegate's runtime did not take the message now (${e.message})` }
          : { ok: false, reason: "ended", error: `${delegationLabel(id)} ended just now; start again with --continue ${id} to go on in its session` };
      }
    }
    this.store.note(id, "say", text, { taken: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
    // Read already, before the runtime's answer to the steer came back.
    const unread = this.followed.get(id)?.unread;
    const early = outcome.ok && unread ? unread.findIndex((u) => u.trim() === text) : -1;
    if (early >= 0) {
      unread!.splice(early, 1);
      this.store.markRead(id, text);
    }
    this.publish("delegation.noted", { id, kind: "say", taken: outcome.ok });
    this.changed(id);
    return outcome;
  }

  /** A message for a delegate on another machine: its run's steer route there. */
  private async sayRemote(d: Delegation, text: string): Promise<SayOutcome> {
    const m = this.opts.machines!;
    const path = peerAgentPath(d.toAgent, `/runs/${encodeURIComponent(d.runId!)}`);
    const unreachable = (e: unknown): SayOutcome => ({ ok: false, reason: "unreachable", error: `${d.toMachine} did not answer (${clip(String((e as Error).message ?? e), 200)}); the message was not sent` });
    let res: Response;
    try {
      res = await m.request(d.toMachine, `${path}/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text }), signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return unreachable(e);
    }
    if (res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: true };
    }
    const why = await errorText(res);
    if (res.status !== 409) return res.status === 404 ? { ok: false, reason: "ended", error: `${delegationLabel(d.id)}'s run is no longer on ${d.toMachine}` } : unreachable(new Error(`HTTP ${res.status}: ${why}`));
    // Refused: still running there (the runtime takes no message now), or it ended just now.
    let status: string | undefined;
    try {
      const r = await m.request(d.toMachine, path, { signal: AbortSignal.timeout(8_000) });
      status = ((await r.json()) as { run?: { status?: string } }).run?.status;
    } catch { /* unknown: read as ended below only when it says so */ }
    return status === "running"
      ? { ok: false, reason: "unsupported", error: `the delegate's runtime did not take the message now (${why})` }
      : { ok: false, reason: "ended", error: `${delegationLabel(d.id)} ended just now; start again with --continue ${d.id} to go on in its session` };
  }

  /** `stop`: the delegate's turn is stopped; answers with what it had said up to then. */
  async halt(caller: RunCaller | null, id: number): Promise<{ stopped: boolean; last: string }> {
    const d = this.own(caller, id);
    if ((d.state !== "running" && d.state !== "waiting") || !d.runId) return { stopped: false, last: this.resultText(d) };
    const last = finalText(await this.linesOf(d));
    const by = caller ? "delegator" : "person";
    this.stopping.set(id, by);
    const stopped = d.toMachine ? await this.stopRemote(d) : this.runs.stop(d.runId);
    if (!stopped) this.stopping.delete(id);
    else {
      this.store.note(id, "stop", by === "person" ? "Stopped by the person." : "Stopped by the delegator.", { reason: by });
      this.publish("delegation.noted", { id, kind: "stop" });
      this.changed(id);
    }
    return { stopped, last };
  }

  /** Stop a delegate on another machine; throws when the machine does not answer (the run may go on there). */
  private async stopRemote(d: Delegation): Promise<boolean> {
    let res: Response;
    try {
      res = await this.opts.machines!.request(d.toMachine, peerAgentPath(d.toAgent, `/runs/${encodeURIComponent(d.runId!)}/stop`), { method: "POST", signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      this.stopping.delete(d.id);
      throw new DelegationError(502, `${d.toMachine} did not answer (${clip(String((e as Error).message ?? e), 200)}); ${delegationLabel(d.id)} may still be running there`, "unreachable");
    }
    if (res.status === 404) return false;
    if (!res.ok) {
      this.stopping.delete(d.id);
      throw new DelegationError(502, `${d.toMachine} refused the stop: ${await errorText(res)}`, "unreachable");
    }
    return ((await res.json().catch(() => ({}))) as { stopped?: boolean }).stopped === true;
  }

  // ---------------------------------------------------------------- the delegate's run

  private sessionOfDelegate(d: Delegation): string | null {
    if (d.toMachine) return d.toSession;
    return d.toSession ?? (d.runId ? (this.runs.get(d.runId)?.sid ?? null) : null);
  }

  private async linesOf(d: Delegation): Promise<string[]> {
    const live = this.followed.get(d.id)?.lines;
    if (live) return live;
    if (!d.runId) return [];
    const lines: string[] = [];
    if (d.toMachine) {
      // An ended run on another machine: its events read once from there (nothing when it does not answer).
      try {
        const res = await this.opts.machines!.request(d.toMachine, peerAgentPath(d.toAgent, `/runs/${encodeURIComponent(d.runId)}/events`), { headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(8_000) });
        if (res.ok && res.body) await readRunEvents(res.body, { onEvent: (_, line) => lines.push(line), onEnd: () => {} }, 8_000);
        else await res.body?.cancel().catch(() => {});
      } catch { /* not reachable now */ }
      return lines;
    }
    this.runs.subscribe(d.runId, 0, { onEvent: (e) => lines.push(e.line), onEnd: () => {} })?.();
    return lines;
  }

  private resultText(d: Delegation): string {
    return [...this.store.notes(d.id)].reverse().find((n) => n.kind === "result")?.text ?? "";
  }

  /**
   * One event line of a delegate's run: kept, and what it means for the record (the delegate's
   * session, a message it read, an approval it waits on). `effects` false: a replayed line whose
   * effect is recorded already (a remote run read again after a restart), kept for the steps only.
   */
  private onLine(id: number, entry: Followed, line: string, effects = true): void {
    entry.lines.push(line);
    const kind = /^\s*\{\s*"type"\s*:\s*"(approval_request|approval_resolved|steer|system)"/.exec(line)?.[1];
    if (!kind) return;
    let p: { id?: unknown; title?: unknown; tool?: unknown; text?: unknown; subtype?: unknown; session_id?: unknown; questions?: { question?: unknown }[] };
    try {
      p = JSON.parse(line) as typeof p;
    } catch {
      return;
    }
    if (kind === "system") {
      if (p.subtype === "init" && typeof p.session_id === "string" && !this.store.get(id)?.toSession) this.store.patch(id, { toSession: p.session_id });
      return;
    }
    if (kind === "steer") {
      if (!effects) return;
      const text = typeof p.text === "string" ? p.text : "";
      if (this.store.markRead(id, text)) this.changed(id);
      else entry.unread.push(text);
      return;
    }
    if (typeof p.id !== "string") return;
    if (kind === "approval_request") {
      const asked = typeof p.questions?.[0]?.question === "string" ? p.questions[0].question : typeof p.title === "string" && p.title ? p.title : `Approve ${String(p.tool ?? "a step")}`;
      entry.asking.set(p.id, clip(String(asked), 200));
      this.store.patch(id, { state: "waiting" });
    } else {
      entry.asking.delete(p.id);
      if (!entry.asking.size && this.store.get(id)?.state === "waiting") this.store.patch(id, { state: "running" });
    }
    this.changed(id);
  }

  private follow(id: number, runId: string): void {
    if (this.followed.has(id)) return;
    // `unread`: messages the runtime reported read before `say` recorded them (Codex answers its steer after the item starts).
    const entry: Followed = { lines: [], asking: new Map(), unread: [] };
    this.followed.set(id, entry);
    const off = this.runs.subscribe(runId, 0, {
      onEvent: (ev) => this.onLine(id, entry, ev.line),
      onEnd: (run) => {
        const sid = run.sid ?? run.sessionId;
        if (sid) this.store.patch(id, { toSession: sid });
        const status = (ENDED_STATES as readonly string[]).includes(run.status) ? (run.status as DelegationState) : "error";
        this.followed.delete(id);
        this.finish(id, status, run.error ?? "", finalText(entry.lines));
      },
    });
    if (!off) {
      this.followed.delete(id);
      this.finish(id, "error", "the delegate's run is gone", "");
    }
  }

  /**
   * Follow a delegate's run on another machine until it ends: its event stream there, from the start
   * (the steps are rebuilt; what `to_seq` covers is not applied again), read again after the last
   * seq whenever it drops. While the machine does not answer the delegation stays as it is, with
   * `unreachable_since`; past `REMOTE_GIVE_UP_MS` it ends `interrupted`. A run the machine no longer
   * knows ends the same way.
   */
  private followRemote(id: number): void {
    if (this.followed.has(id)) return;
    const entry: Followed = { lines: [], asking: new Map(), unread: [], abort: new AbortController() };
    this.followed.set(id, entry);
    void this.remoteLoop(id, entry).catch((e) => this.log(`${delegationLabel(id)}: following it failed: ${(e as Error).message}`));
  }

  private async remoteLoop(id: number, entry: Followed): Promise<void> {
    const machines = this.opts.machines;
    const giveUp = this.opts.remote?.giveUpMs ?? REMOTE_GIVE_UP_MS;
    const idleMs = this.opts.remote?.idleMs ?? REMOTE_IDLE_MS;
    const waits = this.opts.remote?.retryMs ?? REMOTE_RETRY_MS;
    const signal = entry.abort!.signal;
    let after = 0;
    let failures = 0;
    const end = (state: DelegationState, error: string) => {
      this.followed.delete(id);
      this.finish(id, state, error, finalText(entry.lines));
    };
    while (!signal.aborted) {
      const d = this.store.get(id);
      if (!d || ENDED_STATES.includes(d.state) || !d.runId) {
        this.followed.delete(id);
        return;
      }
      if (!machines) return end("interrupted", `this Space no longer reaches ${d.toMachine}`);
      const path = peerAgentPath(d.toAgent, `/runs/${encodeURIComponent(d.runId)}`);
      let problem = "";
      try {
        const res = await machines.request(d.toMachine, `${path}/events?after=${after}`, { headers: { accept: "text/event-stream" }, signal });
        if (res.status === 404) {
          await res.body?.cancel().catch(() => {});
          return end("interrupted", `the delegate's run is no longer on ${d.toMachine}`);
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${await errorText(res)}`);
        this.reachable(id);
        failures = 0;
        let ended: { status?: string; error?: string } | null = null;
        const done = await readRunEvents(res.body, {
          onEvent: (seq, line) => {
            if (seq <= after) return;
            after = seq;
            const fresh = seq > (this.store.get(id)?.toSeq ?? 0);
            this.onLine(id, entry, line, fresh);
            if (fresh && /^\s*\{\s*"type"\s*:\s*"steer"/.test(line)) this.store.patch(id, { toSeq: seq });
          },
          onEnd: (line) => {
            try {
              const ev = JSON.parse(line) as { type?: string; status?: string; error?: string };
              if (ev.type === "error") ended = { status: ev.status, error: ev.error };
            } catch { /* not JSON */ }
          },
        }, idleMs, signal);
        if (done) {
          // How it ended, and its session, from the run's record there; the stream's last line if that does not answer.
          let run: { status?: string; error?: string | null; sid?: string | null; sessionId?: string | null } | undefined;
          try {
            const r = await machines.request(d.toMachine, path, { signal: AbortSignal.timeout(8_000) });
            if (r.ok) run = ((await r.json()) as { run?: typeof run }).run;
          } catch { /* the stream said enough */ }
          const status = run?.status ?? (ended as { status?: string } | null)?.status ?? "done";
          const sid = run?.sid ?? run?.sessionId;
          if (sid) this.store.patch(id, { toSession: sid });
          return end((ENDED_STATES as readonly string[]).includes(status) ? (status as DelegationState) : "error", run?.error ?? (ended as { error?: string } | null)?.error ?? "");
        }
        problem = "the event stream ended early";
      } catch (e) {
        if (signal.aborted) return;
        problem = clip(String((e as Error).message ?? e), 200);
      }
      // Dropped or not reachable: wait, and read again after the last seq.
      if (problem !== "the event stream ended early" || failures > 0) this.unreachable(id, problem);
      const since = this.store.get(id)?.unreachableSince;
      if (since !== null && since !== undefined && this.now() - since >= giveUp) {
        return end("interrupted", `${d.toMachine} did not answer for ${Math.round(giveUp / 3_600_000) || "<1"} h (${problem}); the run may have gone on there`);
      }
      const wait = waits[Math.min(failures, waits.length - 1)] ?? 1_000;
      failures++;
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, wait);
        signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }

  /** The delegate's machine answers (again). */
  private reachable(id: number): void {
    if (this.store.get(id)?.unreachableSince === null) return;
    this.store.patch(id, { unreachableSince: null });
    this.log(`${delegationLabel(id)}: its machine answers again`);
    this.changed(id);
  }

  /** The delegate's machine does not answer: since when, once. */
  private unreachable(id: number, why: string): void {
    const d = this.store.get(id);
    if (!d || d.unreachableSince !== null) return;
    this.store.patch(id, { unreachableSince: this.now() });
    this.log(`${delegationLabel(id)}: ${d.toMachine} does not answer (${why}); it stays running until it does`);
    this.changed(id);
  }

  /** The delegated run ended: the result is recorded, published, and delivered to the delegator. */
  private finish(id: number, state: DelegationState, error: string, reply: string): void {
    const d = this.store.get(id);
    if (!d || ENDED_STATES.includes(d.state)) return;
    const by = this.stopping.get(id);
    this.stopping.delete(id);
    const f = this.followed.get(id);
    if (f?.abort) {
      f.abort.abort();
      this.followed.delete(id);
    }
    const text = clip(reply.trim() || (error ? `(no reply; ${error})` : "(no reply)"), MAX_RESULT);
    this.store.note(id, "result", text, { ...(error && state !== "done" ? { reason: clip(error, 300) } : {}) });
    this.store.patch(id, { state, endedAt: this.now(), ...(by === "delegator" ? { delivered: "skipped" } : {}) });
    this.publish("delegation.ended", { id, state, summary: clip(text, MAX_EVENT_SUMMARY) });
    this.changed(id);
    if (by !== "delegator") this.track(this.deliver(id));
  }

  /** The message a result is delivered as: which delegation, how it ended, the reply (trimmed, with where the rest is). */
  private resultMessage(d: Delegation): string {
    const text = this.resultText(d);
    const agent = d.toMachine ? `${d.toAgent} on ${d.toMachine}` : d.toAgent;
    const where = d.toSession ? `${agent}, session ${d.toSession}` : agent;
    return [
      resultHeader(d.id, d.toRole, d.state),
      `${delegationLabel(d.id)} to ${d.toTitle || d.toRole} ended: ${d.state}. Check the result against your brief; tell the person what was done and what is left.`,
      `The delegate's final reply${text.length >= MAX_RESULT ? " (trimmed; the full text is in its conversation" : " (its conversation"}: ${where}):`,
      "",
      text,
    ].join("\n");
  }

  /** Result-triggered turns in a row on a session, newest first, since a turn of the person's. */
  private resultTurnsInRow(agent: string, session: string): number {
    let n = 0;
    for (const r of this.runs.list({ agent, limit: 50 })) {
      if (r.sessionId !== session && r.sid !== session) continue;
      if (r.trigger === "background") continue;
      if (r.trigger !== "delegation") break;
      n++;
    }
    return n;
  }

  /** Deliver a result: into the delegator's running turn, else as a new turn, else held at the limit. */
  private async deliver(id: number): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const d = this.store.get(id);
      if (!d || d.delivered !== null || !d.fromSession) return;
      const message = this.resultMessage(d);
      const running = this.runs.running().find((r) => r.agent === d.fromAgent && (r.sessionId === d.fromSession || r.sid === d.fromSession));
      if (running) {
        try {
          await this.runs.steer(running.id, { message });
          this.store.patch(id, { delivered: "steered" });
          this.changed(id);
          return;
        } catch (e) {
          if (!(e instanceof RunStateError)) throw e;
          if (this.runs.get(running.id)?.status === "running") {
            // The delegator's runtime cannot take it now: the result starts the next turn when this one ends.
            await new Promise<void>((resolve) => {
              const off = this.runs.subscribe(running.id, Number.MAX_SAFE_INTEGER, { onEvent() {}, onEnd: () => resolve() });
              if (!off) resolve();
            });
          }
          continue;
        }
      }
      if (this.resultTurnsInRow(d.fromAgent, d.fromSession) >= MAX_RESULT_TURNS) {
        this.store.patch(id, { delivered: "held" });
        this.log(`${delegationLabel(id)}: ${MAX_RESULT_TURNS} result turns in a row on ${d.fromSession}; the result waits for the person`);
        const view = this.view(id)!;
        this.changed(id);
        for (const fn of this.heldListeners) fn(view);
        return;
      }
      const [app, agent] = d.fromAgent.split("/") as [string, string];
      const req = Object.assign(new Request(`http://space.local/api/agents/${app}/${agent}/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, sessionId: d.fromSession, interactive: true, ...(this.delegatorMode(d) ? { permissionMode: this.delegatorMode(d) } : {}) }) }), { params: { app, agent }, spaceTrigger: "delegation" as const });
      const res = await this.opts.chat(req);
      if (res.status === 409) {
        await res.body?.cancel().catch(() => {});
        continue; // a turn started on the session in between: add to it next round
      }
      const runId = res.headers.get("x-run-id");
      if (!res.ok || !runId) {
        const text = await res.text().catch(() => "");
        this.log(`${delegationLabel(id)}: the result's turn did not start: ${clip(text, 300)}`);
        this.store.patch(id, { delivered: "held" });
        const view = this.view(id)!;
        this.changed(id);
        for (const fn of this.heldListeners) fn(view);
        return;
      }
      await res.body?.cancel().catch(() => {});
      this.store.patch(id, { delivered: "turn" });
      this.changed(id, runId);
      return;
    }
    this.log(`${delegationLabel(id)}: the delegator's session stayed busy; the result is not delivered`);
  }

  /** The delegator's permission mode, from its team row (the Director's turns run with it). */
  private delegatorMode(d: Delegation): string | undefined {
    const m = this.opts.team.byAgent(d.fromAgent);
    return m ? PERMISSION_MODE[m.permission] : undefined;
  }

  /** Tell the listeners, and the delegator's running turn (its chat step). */
  private changed(id: number, runId?: string): void {
    const view = this.view(id);
    if (!view) return;
    const line = JSON.stringify({ type: "delegation", delegation: view });
    const d = this.store.get(id)!;
    const targets = new Set<string>();
    if (runId) targets.add(runId);
    for (const r of this.runs.running()) if (r.agent === d.fromAgent && d.fromSession && (r.sessionId === d.fromSession || r.sid === d.fromSession)) targets.add(r.id);
    if (d.fromRun && this.runs.get(d.fromRun)?.status === "running") targets.add(d.fromRun);
    for (const t of targets) this.runs.inject(t, line);
    for (const fn of this.listeners) {
      try {
        fn(view);
      } catch (e) {
        this.log(`a listener failed: ${(e as Error).message}`);
      }
    }
  }

  private publish(name: string, data: Record<string, unknown>): void {
    try {
      this.opts.publish?.(name, data);
    } catch (e) {
      this.log(`space/${name} not published: ${(e as Error).message}`);
    }
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }
}

/** A followed delegate run: its lines so far, what it waits on, messages read before `say` recorded them, and (another machine's) the stream's abort. */
type Followed = { lines: string[]; asking: Map<string, string>; unread: string[]; abort?: AbortController };

/** A refusal's `error`, else its status. */
async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const e = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof e === "string") return clip(e, 300);
  } catch { /* text */ }
  return clip(text || `HTTP ${res.status}`, 300);
}

function noteView(n: DelegationNote): DelegationNoteView {
  return {
    seq: n.seq,
    at: new Date(n.at).toISOString(),
    kind: n.kind,
    text: n.text,
    ...(n.kind === "say" ? { taken: n.taken === true, readAt: n.readAt === null ? null : new Date(n.readAt).toISOString() } : {}),
    ...(n.reason ? { reason: n.reason } : {}),
  };
}

/** The tail of a delegate's steps: its last tool calls and words, one line each. */
export function tailOf(lines: string[], max = 12): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let ev: { type?: string; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line) as typeof ev;
    } catch {
      continue;
    }
    if (ev.type === "approval_request") out.push(`waiting for the person: ${clip(String((ev as { title?: unknown }).title ?? (ev as { tool?: unknown }).tool ?? "an approval"), 160)}`);
    if (ev.type !== "assistant" || !Array.isArray(ev.message?.content)) continue;
    for (const b of ev.message.content as { type?: string; name?: string; text?: string; input?: Record<string, unknown> }[]) {
      if (b.type === "tool_use") {
        const i = b.input ?? {};
        const hint = String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? "").replace(/\s+/g, " ");
        out.push(`${b.name ?? "tool"}${hint ? `: ${clip(hint, 160)}` : ""}`);
      } else if (b.type === "text" && b.text?.trim()) out.push(`said: ${clip(b.text.trim().replace(/\s+/g, " "), 200)}`);
    }
  }
  return out.slice(-max);
}

export type { RunInfo };
