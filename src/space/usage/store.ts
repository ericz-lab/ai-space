import type { Database } from "bun:sqlite";
import { AGENT_GAP_MS, BEAT_GAP_MS, BEAT_MAX_STEP_MS, BEAT_MIN_INTERVAL_MS, type DeviceAppUsageRow, type DeviceClient, type DeviceUsageRow, type BeatResult, type Kind, type Source, type UsageRow } from "./types.ts";

/**
 * Usage in space.db (docs/usage.md): one row per open, and segments of time in
 * use. An app's segment grows from the heartbeats of one browser tab; an agent's
 * from the turns of one conversation (`tab` is then the session id). Instants
 * are epoch milliseconds (docs/time.md); days are UTC, like the model ledger's.
 * With a retention set, rows older than it are pruned on insert.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_device_opens (
  device_id TEXT NOT NULL, client TEXT NOT NULL, event_id TEXT NOT NULL,
  key TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (device_id, client, event_id)
);
CREATE INDEX IF NOT EXISTS usage_device_opens_at ON usage_device_opens(at);
CREATE TABLE IF NOT EXISTS usage_device_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  client TEXT NOT NULL,
  session TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_device_session ON usage_device_segments(device_id, client, session, last_at DESC);
CREATE INDEX IF NOT EXISTS usage_device_last ON usage_device_segments(last_at);
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
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(usage_device_segments)").all().map(c => c.name));
    if (!columns.has("app")) db.exec("ALTER TABLE usage_device_segments ADD COLUMN app TEXT");
    if (!columns.has("sequence")) db.exec("ALTER TABLE usage_device_segments ADD COLUMN sequence INTEGER NOT NULL DEFAULT -1");
    const days = opts.retentionDays ?? 0;
    this.retentionMs = days > 0 ? days * 86400_000 : 0;
  }

  /** Server receipt times only. Missing beats never fill an offline/background gap. */
  deviceBeat(deviceId: string, client: DeviceClient, session: string, active: boolean, at: number, app: string | null = null, sequence = -1): void {
    this.db.transaction(() => {
      const previous = this.db.query<{ id: number; last_at: number; closed: number; app: string | null; sequence: number }, string[]>(
        "SELECT id, last_at, closed, app, sequence FROM usage_device_segments WHERE device_id = ? AND client = ? AND session = ? ORDER BY last_at DESC, id DESC LIMIT 1",
      ).get(deviceId, client, session);
      // Sequence numbers prevent an old in-flight app context from replacing a newer one.
      if (previous?.closed || (previous && (at < previous.last_at || (sequence >= 0 && sequence <= previous.sequence)))) return;
      const adjacent = previous && at - previous.last_at <= 45_000;
      if (adjacent) {
        this.db.query("UPDATE usage_device_segments SET last_at = ?, closed = ?, sequence = ? WHERE id = ?")
          .run(at, active ? 0 : 1, sequence, previous.id);
      }
      // Attribute the interval before a context change to the app that was actually visible.
      if (!adjacent || (active && previous.app !== app)) {
        this.db.query("INSERT INTO usage_device_segments (device_id, client, session, started_at, last_at, closed, app, sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(deviceId, client, session, at, at, active ? 0 : 1, app, sequence);
      }
      this.prune(at);
    })();
  }

  deviceOpen(deviceId: string, client: DeviceClient, eventId: string, key: string, at: number): void {
    this.db.query("INSERT OR IGNORE INTO usage_device_opens (device_id, client, event_id, key, at) VALUES (?, ?, ?, ?, ?)")
      .run(deviceId, client, eventId, key, at);
    this.prune(at);
  }

  /** Union foreground intervals per device; clip to the requested [since, until) window. */
  devices(since: number, until: number): DeviceUsageRow[] {
    const segments = this.db.query<{ device_id: string; client: DeviceClient; session: string; app: string | null; started_at: number; last_at: number }, number[]>(
      "SELECT device_id, client, session, app, started_at, last_at FROM usage_device_segments WHERE last_at >= ? AND started_at < ? ORDER BY started_at, last_at",
    ).all(since, until);
    const groups = new Map<string, { row: DeviceUsageRow; end: number; sessions: Set<string>; apps: Map<string, { row: DeviceAppUsageRow; end: number }> }>();
    for (const s of segments) {
      const key = `${s.client}:${s.device_id}`;
      let group = groups.get(key);
      if (!group) {
        group = { row: { apps: [], deviceId: s.device_id, client: s.client, sessions: 0, activeMs: 0, lastAt: new Date(s.last_at).toISOString() }, end: since, sessions: new Set(), apps: new Map() };
        groups.set(key, group);
      }
      const start = Math.max(since, s.started_at);
      const end = Math.min(until, s.last_at);
      group.row.activeMs += Math.max(0, end - Math.max(start, group.end));
      group.end = Math.max(group.end, end);
      group.sessions.add(s.session);
      if (s.app) {
        let app = group.apps.get(s.app);
        if (!app) {
          app = { row: { key: s.app, opens: 0, activeMs: 0, lastAt: new Date(s.last_at).toISOString() }, end: since };
          group.apps.set(s.app, app);
        }
        app.row.activeMs = (app.row.activeMs ?? 0) + Math.max(0, end - Math.max(start, app.end));
        app.end = Math.max(app.end, end);
        if (s.last_at > Date.parse(app.row.lastAt)) app.row.lastAt = new Date(s.last_at).toISOString();
      }
      if (s.last_at > Date.parse(group.row.lastAt)) group.row.lastAt = new Date(s.last_at).toISOString();
    }
    const opens = this.db.query<{ device_id: string; client: DeviceClient; key: string; n: number; at: number }, number[]>(
      "SELECT device_id, client, key, COUNT(*) AS n, MAX(at) AS at FROM usage_device_opens WHERE at >= ? AND at < ? GROUP BY device_id, client, key",
    ).all(since, until);
    for (const o of opens) {
      const key = `${o.client}:${o.device_id}`;
      let group = groups.get(key);
      const lastAt = new Date(o.at).toISOString();
      if (!group) {
        group = { row: { apps: [], deviceId: o.device_id, client: o.client, sessions: 0, activeMs: 0, lastAt }, end: since, sessions: new Set(), apps: new Map() };
        groups.set(key, group);
      }
      const app = group.apps.get(o.key) ?? { row: { key: o.key, opens: 0, activeMs: null, lastAt }, end: since };
      app.row.opens = o.n;
      if (lastAt > app.row.lastAt) app.row.lastAt = lastAt;
      if (lastAt > group.row.lastAt) group.row.lastAt = lastAt;
      group.apps.set(o.key, app);
    }
    return [...groups.values()].map(({ row, sessions, apps }) => ({ ...row, sessions: sessions.size,
      apps: [...apps.values()].map(a => a.row).sort((a, b) => (b.activeMs ?? 0) - (a.activeMs ?? 0) || b.opens - a.opens || a.key.localeCompare(b.key)),
    }))
      .sort((a, b) => b.activeMs - a.activeMs || b.lastAt.localeCompare(a.lastAt) || a.deviceId.localeCompare(b.deviceId));
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
    this.db.query("DELETE FROM usage_device_opens WHERE at < ?").run(before);
    this.db.query("DELETE FROM usage_device_segments WHERE last_at < ?").run(before);
    this.db.query("DELETE FROM usage_opens WHERE at < ?").run(before);
    this.db.query("DELETE FROM usage_sessions WHERE last_at < ?").run(before);
  }
}
