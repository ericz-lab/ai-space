import { Database } from "bun:sqlite";
import { type Effect, MAX_RUNS, type Run, type RunResult, type RunStatus } from "./types.ts";

/**
 * SQLite persistence for shortcut runs, in ai-space's own database. A run row holds everything the
 * page needs to show it again after the panel was closed: arguments as typed and as resolved, the
 * timezone, the status and the result. Same migration rule as the other stores: add nullable
 * columns to ADDED_COLUMNS, never rewrite tables. Only the newest MAX_RUNS rows are kept.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shortcut_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id       TEXT NOT NULL UNIQUE,
  action           TEXT NOT NULL,
  peer             TEXT,
  title            TEXT NOT NULL,
  effect           TEXT NOT NULL,
  args             TEXT NOT NULL,
  resolved         TEXT,
  timezone         TEXT,
  status           TEXT NOT NULL,
  result           TEXT,
  error            TEXT,
  idempotency_key  TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  call_id          INTEGER,
  task_id          TEXT,
  task_started_at  INTEGER,
  created_at       INTEGER NOT NULL,
  ended_at         INTEGER
);
CREATE INDEX IF NOT EXISTS shortcut_runs_status ON shortcut_runs(status, id);
`;

const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [];

type RunRow = {
  id: number;
  request_id: string;
  action: string;
  peer: string | null;
  title: string;
  effect: string;
  args: string;
  resolved: string | null;
  timezone: string | null;
  status: string;
  result: string | null;
  error: string | null;
  idempotency_key: string | null;
  attempts: number;
  call_id: number | null;
  task_id: string | null;
  task_started_at: number | null;
  created_at: number;
  ended_at: number | null;
};

export type RunCreate = Pick<Run, "requestId" | "action" | "title" | "effect" | "args" | "createdAt"> & Partial<Pick<Run, "peer" | "timezone" | "resolved" | "idempotencyKey">>;
export type RunPatch = Partial<Pick<Run, "status" | "result" | "error" | "resolved" | "attempts" | "callId" | "taskId" | "taskStartedAt" | "endedAt">>;

export class ShortcutStore {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /** A new run; undefined when a run with this request id exists already (a repeated submission). */
  addRun(input: RunCreate): Run | undefined {
    const r = this.db
      .query(
        `INSERT OR IGNORE INTO shortcut_runs (request_id, action, peer, title, effect, args, resolved, timezone, status, idempotency_key, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 0, ?)`,
      )
      .run(input.requestId, input.action, input.peer ?? null, input.title, input.effect, JSON.stringify(input.args), input.resolved ? JSON.stringify(input.resolved) : null, input.timezone ?? null, input.idempotencyKey ?? null, input.createdAt);
    if (!r.changes) return undefined;
    this.db.query(`DELETE FROM shortcut_runs WHERE status != 'running' AND id <= (SELECT MAX(id) FROM shortcut_runs) - ?`).run(MAX_RUNS);
    return this.getRun(Number(r.lastInsertRowid));
  }

  getRun(id: number): Run | undefined {
    const row = this.db.query<RunRow, [number]>("SELECT * FROM shortcut_runs WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  byRequest(requestId: string): Run | undefined {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM shortcut_runs WHERE request_id = ?").get(requestId);
    return row ? fromRow(row) : undefined;
  }

  listRuns(opts: { limit?: number; status?: RunStatus } = {}): Run[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 30), 1), 200);
    const rows = opts.status
      ? this.db.query<RunRow, [string, number]>("SELECT * FROM shortcut_runs WHERE status = ? ORDER BY id DESC LIMIT ?").all(opts.status, limit)
      : this.db.query<RunRow, [number]>("SELECT * FROM shortcut_runs ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map(fromRow);
  }

  patchRun(id: number, patch: RunPatch): Run | undefined {
    const cols: Record<keyof RunPatch, string> = { status: "status", result: "result", error: "error", resolved: "resolved", attempts: "attempts", callId: "call_id", taskId: "task_id", taskStartedAt: "task_started_at", endedAt: "ended_at" };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof RunPatch, unknown][]) {
      sets.push(`${cols[k]} = ?`);
      values.push(v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : (v as string | number));
    }
    if (sets.length) this.db.query(`UPDATE shortcut_runs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.getRun(id);
  }
}

function fromRow(r: RunRow): Run {
  return {
    id: r.id,
    requestId: r.request_id,
    action: r.action,
    ...(r.peer ? { peer: r.peer } : {}),
    title: r.title,
    effect: r.effect as Effect,
    args: JSON.parse(r.args) as Record<string, unknown>,
    ...(r.resolved ? { resolved: JSON.parse(r.resolved) as Record<string, unknown> } : {}),
    ...(r.timezone ? { timezone: r.timezone } : {}),
    status: r.status as RunStatus,
    ...(r.result ? { result: JSON.parse(r.result) as RunResult } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.idempotency_key ? { idempotencyKey: r.idempotency_key } : {}),
    attempts: r.attempts,
    ...(r.call_id !== null ? { callId: r.call_id } : {}),
    ...(r.task_id ? { taskId: r.task_id } : {}),
    ...(r.task_started_at !== null ? { taskStartedAt: r.task_started_at } : {}),
    createdAt: r.created_at,
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
  };
}
