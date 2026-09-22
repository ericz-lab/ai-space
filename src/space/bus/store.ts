import { Database } from "bun:sqlite";
import { type CallRecord, type Delivery, type DeliveryKind, type DeliveryStatus, type HttpMethod, MAX_CALLS, MAX_DELIVERIES } from "./types.ts";

/**
 * SQLite persistence for deliveries and calls, in ai-space's own database next
 * to the scheduler's `events` table. A delivery row carries its target (kind,
 * method, path), so it can still be attempted after a restart or after the app
 * changed its manifest. Same migration rule as the other stores: add nullable
 * columns to ADDED_COLUMNS, never rewrite tables.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bus_deliveries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     INTEGER NOT NULL,
  event        TEXT NOT NULL,
  app          TEXT NOT NULL,
  kind         TEXT NOT NULL,
  method       TEXT,
  path         TEXT,
  status       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER,
  last_error   TEXT,
  last_status  INTEGER,
  sent_at      INTEGER,
  ended_at     INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bus_deliveries_status_next ON bus_deliveries(status, kind, next_at);
CREATE INDEX IF NOT EXISTS bus_deliveries_app_status ON bus_deliveries(app, status, id);
CREATE INDEX IF NOT EXISTS bus_deliveries_event ON bus_deliveries(event_id);
CREATE TABLE IF NOT EXISTS bus_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  caller       TEXT NOT NULL,
  app          TEXT NOT NULL,
  capability   TEXT NOT NULL,
  status       INTEGER NOT NULL,
  ok           INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  error        TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bus_calls_app_at ON bus_calls(app, at DESC);
`;

const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [];

type DeliveryRow = {
  id: number;
  event_id: number;
  event: string;
  app: string;
  kind: string;
  method: string | null;
  path: string | null;
  status: string;
  attempts: number;
  next_at: number | null;
  last_error: string | null;
  last_status: number | null;
  sent_at: number | null;
  ended_at: number | null;
  created_at: number;
};

type CallRow = {
  id: number;
  caller: string;
  app: string;
  capability: string;
  status: number;
  ok: number;
  duration_ms: number;
  error: string | null;
  at: number;
};

export type DeliveryCreate = {
  eventId: number;
  event: string;
  app: string;
  kind: DeliveryKind;
  method?: HttpMethod;
  path?: string;
  createdAt: number;
};

export type DeliveryPatch = Partial<Pick<Delivery, "status" | "attempts" | "nextAt" | "lastError" | "lastStatus" | "sentAt" | "endedAt">>;

export class BusStore {
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

  // ---------------------------------------------------------------- deliveries

  addDelivery(input: DeliveryCreate): Delivery {
    const r = this.db
      .query("INSERT INTO bus_deliveries (event_id, event, app, kind, method, path, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)")
      .run(input.eventId, input.event, input.app, input.kind, input.method ?? null, input.path ?? null, input.createdAt, input.createdAt);
    // Finished rows beyond the cap go first; a pending row is never dropped by the cap.
    this.db
      .query(`DELETE FROM bus_deliveries WHERE status IN ('ok', 'dead', 'skipped') AND id <= (SELECT MAX(id) FROM bus_deliveries) - ?`)
      .run(MAX_DELIVERIES);
    return { id: Number(r.lastInsertRowid), eventId: input.eventId, event: input.event, app: input.app, kind: input.kind, ...(input.method ? { method: input.method } : {}), ...(input.path ? { path: input.path } : {}), status: "pending", attempts: 0, nextAt: input.createdAt, createdAt: input.createdAt };
  }

  getDelivery(id: number): Delivery | undefined {
    const row = this.db.query<DeliveryRow, [number]>("SELECT * FROM bus_deliveries WHERE id = ?").get(id);
    return row ? rowToDelivery(row) : undefined;
  }

  patchDelivery(id: number, patch: DeliveryPatch): void {
    const sets: string[] = [];
    const args: (string | number | null)[] = [];
    const put = (col: string, v: string | number | null | undefined) => {
      if (v === undefined) return;
      sets.push(`${col} = ?`);
      args.push(v);
    };
    put("status", patch.status);
    put("attempts", patch.attempts);
    if ("nextAt" in patch) put("next_at", patch.nextAt ?? null);
    if ("lastError" in patch) put("last_error", patch.lastError ?? null);
    if ("lastStatus" in patch) put("last_status", patch.lastStatus ?? null);
    if ("sentAt" in patch) put("sent_at", patch.sentAt ?? null);
    if ("endedAt" in patch) put("ended_at", patch.endedAt ?? null);
    if (!sets.length) return;
    this.db.query(`UPDATE bus_deliveries SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
  }

  /** http deliveries whose next attempt is due, oldest first. */
  dueHttp(now: number, limit = 100): Delivery[] {
    return this.db
      .query<DeliveryRow, [number, number]>("SELECT * FROM bus_deliveries WHERE status = 'pending' AND kind = 'http' AND next_at <= ? ORDER BY id LIMIT ?")
      .all(now, limit)
      .map(rowToDelivery);
  }

  /** stream deliveries waiting for a consumer of the app, oldest first. */
  pendingStream(app: string, limit = 500): Delivery[] {
    return this.db
      .query<DeliveryRow, [string, number]>("SELECT * FROM bus_deliveries WHERE status = 'pending' AND kind = 'stream' AND app = ? ORDER BY id LIMIT ?")
      .all(app, limit)
      .map(rowToDelivery);
  }

  /** stream deliveries pushed to a consumer that has not acked them by their deadline. */
  unacked(now: number): Delivery[] {
    return this.db
      .query<DeliveryRow, [number]>("SELECT * FROM bus_deliveries WHERE status = 'sent' AND next_at <= ? ORDER BY id")
      .all(now)
      .map(rowToDelivery);
  }

  /** The earliest moment any pending http or sent stream delivery needs attention. */
  nextDueAt(): number | undefined {
    const row = this.db
      .query<{ next: number | null }, []>("SELECT MIN(next_at) AS next FROM bus_deliveries WHERE (status = 'pending' AND kind = 'http') OR status = 'sent'")
      .get();
    return row?.next ?? undefined;
  }

  listDeliveries(opts: { app?: string; status?: DeliveryStatus; eventId?: number; limit?: number } = {}): Delivery[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.app) {
      where.push("app = ?");
      args.push(opts.app);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.eventId !== undefined) {
      where.push("event_id = ?");
      args.push(opts.eventId);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const sql = `SELECT * FROM bus_deliveries ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.query<DeliveryRow, (string | number)[]>(sql).all(...args, limit).map(rowToDelivery);
  }

  countDeliveries(app: string): Record<DeliveryStatus, number> {
    const out: Record<DeliveryStatus, number> = { pending: 0, sent: 0, ok: 0, dead: 0, skipped: 0 };
    for (const r of this.db.query<{ status: DeliveryStatus; n: number }, [string]>("SELECT status, COUNT(*) AS n FROM bus_deliveries WHERE app = ? GROUP BY status").all(app)) out[r.status] = r.n;
    return out;
  }

  // ---------------------------------------------------------------- calls

  addCall(input: Omit<CallRecord, "id">): CallRecord {
    const r = this.db
      .query("INSERT INTO bus_calls (caller, app, capability, status, ok, duration_ms, error, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(input.caller, input.app, input.capability, input.status, input.ok ? 1 : 0, input.durationMs, input.error ?? null, input.at);
    this.db.query("DELETE FROM bus_calls WHERE id <= (SELECT MAX(id) FROM bus_calls) - ?").run(MAX_CALLS);
    return { id: Number(r.lastInsertRowid), ...input };
  }

  listCalls(opts: { app?: string; caller?: string; limit?: number } = {}): CallRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.app) {
      where.push("app = ?");
      args.push(opts.app);
    }
    if (opts.caller) {
      where.push("caller = ?");
      args.push(opts.caller);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
    const sql = `SELECT * FROM bus_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.query<CallRow, (string | number)[]>(sql).all(...args, limit).map(rowToCall);
  }

  /** Per capability: calls, failures and mean duration over the kept history. */
  callStats(app: string): { capability: string; calls: number; failures: number; meanMs: number }[] {
    return this.db
      .query<{ capability: string; calls: number; failures: number; mean_ms: number }, [string]>(
        "SELECT capability, COUNT(*) AS calls, SUM(CASE WHEN ok = 1 THEN 0 ELSE 1 END) AS failures, AVG(duration_ms) AS mean_ms FROM bus_calls WHERE app = ? GROUP BY capability",
      )
      .all(app)
      .map((r) => ({ capability: r.capability, calls: r.calls, failures: r.failures, meanMs: Math.round(r.mean_ms) }));
  }
}

function rowToDelivery(r: DeliveryRow): Delivery {
  return {
    id: r.id,
    eventId: r.event_id,
    event: r.event,
    app: r.app,
    kind: r.kind as DeliveryKind,
    ...(r.method ? { method: r.method as HttpMethod } : {}),
    ...(r.path ? { path: r.path } : {}),
    status: r.status as DeliveryStatus,
    attempts: r.attempts,
    ...(r.next_at !== null ? { nextAt: r.next_at } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
    ...(r.last_status !== null ? { lastStatus: r.last_status } : {}),
    ...(r.sent_at !== null ? { sentAt: r.sent_at } : {}),
    ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
    createdAt: r.created_at,
  };
}

function rowToCall(r: CallRow): CallRecord {
  return { id: r.id, caller: r.caller, app: r.app, capability: r.capability, status: r.status, ok: r.ok === 1, durationMs: r.duration_ms, ...(r.error ? { error: r.error } : {}), at: r.at };
}
