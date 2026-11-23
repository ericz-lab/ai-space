import type { Database } from "bun:sqlite";
import { isOperator } from "./auth.ts";

/**
 * How long this Space has run, across restarts (docs/usage.md#uptime). Each start of the service
 * opens a segment in space.db; a tick every minute moves its end forward, and shutdown moves it one
 * last time. A crash or power cut therefore loses at most one tick. Instants are epoch milliseconds
 * (docs/time.md). The figures are this machine's own: a hub never adds its peers' to them.
 *
 *   GET /api/space/uptime   owner: { ok, uptime: { startedAt, currentMs, totalMs, firstStartedAt, restarts } }
 *
 * `GET /api/space` carries { startedAt, totalMs } of the same for the operator.
 */

export const UPTIME_TICK_MS = 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS uptime_segments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  version     TEXT NOT NULL,
  edition     TEXT NOT NULL
);
`;

export type Uptime = {
  /** When this run of the service started (UTC ISO). */
  startedAt: string;
  /** How long this run has lasted. */
  currentMs: number;
  /** Every recorded run's length added up, this one included. */
  totalMs: number;
  /** When the first recorded run started (UTC ISO). */
  firstStartedAt: string;
  /** Recorded starts after the first one. */
  restarts: number;
};

export class UptimeStore {
  private current: { id: number; startedAt: number } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly db: Database, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    db.exec(SCHEMA);
  }

  /** Opens this run's segment and, with a tick, keeps its end current until `stop`. */
  start(meta: { version: string; edition: string }, tickMs: number | null = UPTIME_TICK_MS): void {
    if (this.current) return;
    const at = this.now();
    const row = this.db.query<{ id: number }, [number, number, string, string]>("INSERT INTO uptime_segments (started_at, last_at, version, edition) VALUES (?, ?, ?, ?) RETURNING id").get(at, at, meta.version, meta.edition)!;
    this.current = { id: row.id, startedAt: at };
    if (tickMs) {
      this.timer = setInterval(() => this.tick(), tickMs);
      this.timer.unref?.();
    }
  }

  /** Moves this run's end to now; a clock set back never shortens what was recorded. */
  tick(): void {
    if (!this.current) return;
    try {
      this.db.query("UPDATE uptime_segments SET last_at = MAX(last_at, ?) WHERE id = ?").run(this.now(), this.current.id);
    } catch (e) {
      console.error(`[uptime] tick not recorded: ${(e as Error).message}`);
    }
  }

  /** The last tick, at shutdown, before space.db closes. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tick();
    this.current = null;
  }

  /** Undefined until this run has started. */
  summary(): Uptime | undefined {
    if (!this.current) return undefined;
    const now = this.now();
    const past = this.db
      .query<{ ms: number | null; first: number | null; n: number }, [number]>("SELECT SUM(MAX(0, last_at - started_at)) AS ms, MIN(started_at) AS first, COUNT(*) AS n FROM uptime_segments WHERE id != ?")
      .get(this.current.id)!;
    const currentMs = Math.max(0, now - this.current.startedAt);
    const first = Math.min(past.first ?? this.current.startedAt, this.current.startedAt);
    return {
      startedAt: new Date(this.current.startedAt).toISOString(),
      currentMs,
      totalMs: (past.ms ?? 0) + currentMs,
      firstStartedAt: new Date(first).toISOString(),
      restarts: past.n,
    };
  }
}

export function createUptimeRoutes(opts: { uptime: UptimeStore; token: string }) {
  return {
    "/api/space/uptime": {
      GET: (req: Request) => {
        if (!isOperator(req, opts.token)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        const uptime = opts.uptime.summary();
        return uptime ? Response.json({ ok: true, uptime }, { headers: { "cache-control": "no-store" } }) : Response.json({ ok: false, error: "not started" }, { status: 503 });
      },
    },
  };
}
