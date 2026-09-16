import type { Database } from "bun:sqlite";

/**
 * The terminal's audit trail in space.db: one row per session with when it
 * ran, from where (user agent), how much went through and how it ended.
 * Keystrokes and output are never stored, matching the chat's rule.
 */

export type SessionRecord = {
  id: string;
  startedAt: number;
  endedAt?: number;
  /** Exit code; null when the shell was killed; undefined while it runs. */
  exitCode?: number | null;
  /** Why it ended: exit, closed (browser left), idle, killed, lost (ai-space restarted). */
  reason?: string;
  agent: string;
  bytesIn: number;
  bytesOut: number;
  cols: number;
  rows: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,
  exit_code  INTEGER,
  reason     TEXT,
  agent      TEXT NOT NULL DEFAULT '',
  bytes_in   INTEGER NOT NULL DEFAULT 0,
  bytes_out  INTEGER NOT NULL DEFAULT 0,
  cols       INTEGER NOT NULL DEFAULT 80,
  rows       INTEGER NOT NULL DEFAULT 24
);
CREATE INDEX IF NOT EXISTS terminal_sessions_started ON terminal_sessions (started_at DESC);
`;

type Row = { id: string; started_at: number; ended_at: number | null; exit_code: number | null; reason: string | null; agent: string; bytes_in: number; bytes_out: number; cols: number; rows: number };

export class TerminalStore {
  constructor(
    private readonly db: Database,
    private readonly keep = 200,
  ) {
    db.exec(SCHEMA);
    // A session still open in the table was cut by a restart of ai-space.
    db.query("UPDATE terminal_sessions SET ended_at = started_at, reason = 'lost' WHERE ended_at IS NULL").run();
  }

  open(s: { id: string; startedAt: number; agent: string; cols: number; rows: number }): void {
    this.db.query("INSERT INTO terminal_sessions (id, started_at, agent, cols, rows) VALUES (?, ?, ?, ?, ?)").run(s.id, s.startedAt, s.agent.slice(0, 200), s.cols, s.rows);
    this.db.query("DELETE FROM terminal_sessions WHERE id NOT IN (SELECT id FROM terminal_sessions ORDER BY started_at DESC LIMIT ?)").run(this.keep);
  }

  close(s: { id: string; endedAt: number; exitCode: number | null; reason: string; bytesIn: number; bytesOut: number }): void {
    this.db.query("UPDATE terminal_sessions SET ended_at = ?, exit_code = ?, reason = ?, bytes_in = ?, bytes_out = ? WHERE id = ?").run(s.endedAt, s.exitCode, s.reason, s.bytesIn, s.bytesOut, s.id);
  }

  recent(limit = 20): SessionRecord[] {
    return this.db
      .query<Row, [number]>("SELECT * FROM terminal_sessions ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: r.id,
        startedAt: r.started_at,
        ...(r.ended_at !== null ? { endedAt: r.ended_at } : {}),
        ...(r.ended_at !== null ? { exitCode: r.exit_code } : {}),
        ...(r.reason ? { reason: r.reason } : {}),
        agent: r.agent,
        bytesIn: r.bytes_in,
        bytesOut: r.bytes_out,
        cols: r.cols,
        rows: r.rows,
      }));
  }
}
