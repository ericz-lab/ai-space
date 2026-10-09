import type { Database } from "bun:sqlite";
import { AGENT_GAP_MS, BEAT_GAP_MS, BEAT_MAX_STEP_MS, BEAT_MIN_INTERVAL_MS, type BeatResult, type Kind, type Source, type UsageRow } from "./types.ts";

/**
 * Usage in space.db (docs/usage.md): one row per open, and segments of time in
 * use. An app's segment grows from the heartbeats of one browser tab; an agent's
 * from the turns of one conversation (`tab` is then the session id). Instants
 * are epoch milliseconds (docs/time.md); days are UTC, like the model ledger's.
 * With a retention set, rows older than it are pruned on insert.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_opens (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL,
  key     TEXT NOT NULL,
  source  TEXT NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_opens_at ON usage_opens(at);
CREATE TABLE IF NOT EXISTS usage_sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  key         TEXT NOT NULL,
  tab         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  active_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_sessions_tab ON usage_sessions(kind, key, tab, last_at DESC);
CREATE INDEX IF NOT EXISTS usage_sessions_started ON usage_sessions(started_at);
`;

type Segment = { id: number; started_at: number; last_at: number; active_ms: number };
type Group = { kind: Kind; key: string; n: number; ms: number; last: number };
type DayGroup = { kind: Kind; key: string; day: string; n: number; ms: number };

const DAY_SQL = (col: string) => `strftime('%Y-%m-%d', ${col} / 1000, 'unixepoch')`;

export class UsageStore {
  private readonly retentionMs: number;

  constructor(
    private readonly db: Database,
    opts: { retentionDays?: number } = {},
  ) {
    db.exec(SCHEMA);
    const days = opts.retentionDays ?? 0;
    this.retentionMs = days > 0 ? days * 86400_000 : 0;
  }

  addOpen(kind: Kind, key: string, source: Source, at: number): void {
    this.db.query("INSERT INTO usage_opens (kind, key, source, at) VALUES (?, ?, ?, ?)").run(kind, key, source, at);
    this.prune(at);
  }

  /**
   * One heartbeat of an app's tab: within BEAT_GAP_MS of the segment's last one it extends it by
   * the gap (at most BEAT_MAX_STEP_MS), later it starts a new segment; closer than
   * BEAT_MIN_INTERVAL_MS to the last one it is dropped.
   */
  beat(app: string, tab: string, at: number): BeatResult {
    const seg = this.latest("app", app, [tab]);
    if (seg && at - seg.last_at < BEAT_MIN_INTERVAL_MS) return "dropped";
    if (seg && at - seg.last_at <= BEAT_GAP_MS) {
      this.db.query("UPDATE usage_sessions SET last_at = ?, active_ms = active_ms + ? WHERE id = ?").run(at, Math.min(at - seg.last_at, BEAT_MAX_STEP_MS), seg.id);
      return "extended";
    }
    this.db.query("INSERT INTO usage_sessions (kind, key, tab, started_at, last_at, active_ms) VALUES ('app', ?, ?, ?, ?, 0)").run(app, tab, at, at);
    this.prune(at);
    return "new";
  }

  /**
   * One finished agent turn. It joins the conversation's latest segment (found under any of
   * `tabs`: the session it resumed, the session it reported) when it started within AGENT_GAP_MS
   * of that segment's end; the segment then runs from its first turn's start to this turn's end
   * and is filed under `tab`. Otherwise the turn is a segment of its own.
   */
  agentTurn(agent: string, tabs: string[], tab: string, startedAt: number, endedAt: number): BeatResult {
    const end = Math.max(startedAt, endedAt);
    const seg = this.latest("agent", agent, tabs);
    if (seg && startedAt - seg.last_at <= AGENT_GAP_MS) {
      const last = Math.max(seg.last_at, end);
      this.db.query("UPDATE usage_sessions SET tab = ?, last_at = ?, active_ms = ? WHERE id = ?").run(tab, last, last - seg.started_at, seg.id);
      return "extended";
    }
    this.db.query("INSERT INTO usage_sessions (kind, key, tab, started_at, last_at, active_ms) VALUES ('agent', ?, ?, ?, ?, ?)").run(agent, tab, startedAt, end, end - startedAt);
    this.prune(end);
    return "new";
  }

  /** Every entry used since `since`, by time in use and then opens, largest first. */
  summary(since: number, kind?: Kind): UsageRow[] {
    const where = (col: string) => `WHERE ${col} >= ?${kind ? " AND kind = ?" : ""}`;
    const args = kind ? [since, kind] : [since];
    const opens = this.db.query<Group, (string | number)[]>(`SELECT kind, key, COUNT(*) AS n, 0 AS ms, MAX(at) AS last FROM usage_opens ${where("at")} GROUP BY kind, key`).all(...args);
    const segs = this.db.query<Group, (string | number)[]>(`SELECT kind, key, COUNT(*) AS n, SUM(active_ms) AS ms, MAX(last_at) AS last FROM usage_sessions ${where("started_at")} GROUP BY kind, key`).all(...args);
    const openDays = this.db.query<DayGroup, (string | number)[]>(`SELECT kind, key, ${DAY_SQL("at")} AS day, COUNT(*) AS n, 0 AS ms FROM usage_opens ${where("at")} GROUP BY kind, key, day`).all(...args);
    const segDays = this.db.query<DayGroup, (string | number)[]>(`SELECT kind, key, ${DAY_SQL("started_at")} AS day, 0 AS n, SUM(active_ms) AS ms FROM usage_sessions ${where("started_at")} GROUP BY kind, key, day`).all(...args);
    // An app that ever sent a heartbeat measures time: 0 in a quiet window, not "unknown".
    const measured = new Set(this.db.query<{ id: string }, []>("SELECT DISTINCT kind || ':' || key AS id FROM usage_sessions").all().map((r) => r.id));

    const rows = new Map<string, UsageRow & { days: Map<string, { day: string; opens: number; activeMs: number }> }>();
    const row = (k: Kind, key: string) => {
      const id = `${k}:${key}`;
      let r = rows.get(id);
      if (!r) {
        r = { kind: k, key, opens: 0, activeMs: k === "agent" || measured.has(id) ? 0 : null, sessions: 0, lastAt: null, daily: [], days: new Map() };
        rows.set(id, r);
      }
      return r;
    };
    const later = (a: string | null, b: number) => (a === null || Date.parse(a) < b ? new Date(b).toISOString() : a);
    for (const g of opens) {
      const r = row(g.kind, g.key);
      r.opens = g.n;
      r.lastAt = later(r.lastAt, g.last);
    }
    for (const g of segs) {
      const r = row(g.kind, g.key);
      r.sessions = g.n;
      r.activeMs = (r.activeMs ?? 0) + g.ms;
      r.lastAt = later(r.lastAt, g.last);
    }
    for (const d of [...openDays, ...segDays]) {
      const r = row(d.kind, d.key);
      const day = r.days.get(d.day) ?? { day: d.day, opens: 0, activeMs: 0 };
      day.opens += d.n;
      day.activeMs += d.ms;
      r.days.set(d.day, day);
    }
    return [...rows.values()]
      .map(({ days, ...r }) => ({ ...r, daily: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) }))
      .sort((a, b) => (b.activeMs ?? 0) - (a.activeMs ?? 0) || b.opens - a.opens || a.key.localeCompare(b.key));
  }

  private latest(kind: Kind, key: string, tabs: string[]): Segment | null {
    if (!tabs.length) return null;
    return this.db
      .query<Segment, string[]>(`SELECT id, started_at, last_at, active_ms FROM usage_sessions WHERE kind = ? AND key = ? AND tab IN (${tabs.map(() => "?").join(", ")}) ORDER BY last_at DESC LIMIT 1`)
      .get(kind, key, ...tabs);
  }

  private prune(at: number): void {
    if (!this.retentionMs) return;
    const before = at - this.retentionMs;
    this.db.query("DELETE FROM usage_opens WHERE at < ?").run(before);
    this.db.query("DELETE FROM usage_sessions WHERE last_at < ?").run(before);
  }
}
