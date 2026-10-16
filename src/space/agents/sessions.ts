import type { Database } from "bun:sqlite";

/**
 * Recent chat sessions per agent, so the panel can list and resume them.
 * Each turn of a resumed session gets a new session id from the runtime; the
 * previous id is replaced in place so a conversation stays one row.
 */

export type ChatSession = { sid: string; title: string; ts: number; runtime?: string | null; model?: string | null };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  agent TEXT NOT NULL,
  sid   TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  ts    INTEGER NOT NULL,
  PRIMARY KEY (agent, sid)
);
CREATE INDEX IF NOT EXISTS chat_sessions_agent_ts ON chat_sessions(agent, ts DESC);
`;

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly keep = 10,
  ) {
    db.exec(SCHEMA);
    const columns = db.query<{ name: string }, []>("PRAGMA table_info(chat_sessions)").all();
    for (const name of ["runtime", "model", "intent_id", "intent_timezone"]) {
      if (!columns.some((c) => c.name === name)) db.exec(`ALTER TABLE chat_sessions ADD COLUMN ${name} TEXT`);
    }
  }

  list(agent: string): ChatSession[] {
    return this.db.query<ChatSession, [string, number]>("SELECT sid, title, ts, runtime, model FROM chat_sessions WHERE agent = ? ORDER BY ts DESC LIMIT ?").all(agent, this.keep);
  }

  get(agent: string, sid: string): ChatSession | null {
    return this.db.query<ChatSession, [string, string]>("SELECT sid, title, ts, runtime, model FROM chat_sessions WHERE agent = ? AND sid = ?").get(agent, sid);
  }

  intentContext(agent: string, sid: string): { id: string; timezone: string } | null {
    const row = this.db.query<{ intent_id: string | null; intent_timezone: string | null }, [string, string]>("SELECT intent_id, intent_timezone FROM chat_sessions WHERE agent = ? AND sid = ?").get(agent, sid);
    return row?.intent_id && row.intent_timezone ? { id: row.intent_id, timezone: row.intent_timezone } : null;
  }

  /** Record `sid` for `agent`; when `prevSid` is known, that row is renamed instead of adding one. */
  record(agent: string, sid: string, prevSid: string | undefined, title: string, runtime?: string, model?: string, intent?: { id: string; timezone: string }): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const context = intent ?? (prevSid ? this.intentContext(agent, prevSid) : null);
      const prev = prevSid ? this.db.query<{ title: string }, [string, string]>("SELECT title FROM chat_sessions WHERE agent = ? AND sid = ?").get(agent, prevSid) : null;
      if (prev && prevSid && prevSid !== sid) this.db.query("DELETE FROM chat_sessions WHERE agent = ? AND sid = ?").run(agent, prevSid);
      this.db
        .query("INSERT INTO chat_sessions (agent, sid, title, ts, runtime, model, intent_id, intent_timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent, sid) DO UPDATE SET ts = excluded.ts, runtime = excluded.runtime, model = excluded.model, intent_id = excluded.intent_id, intent_timezone = excluded.intent_timezone")
        .run(agent, sid, prev?.title || title.slice(0, 80), now, runtime ?? null, model ?? null, context?.id ?? null, context?.timezone ?? null);
      this.db.query("DELETE FROM chat_sessions WHERE agent = ? AND sid NOT IN (SELECT sid FROM chat_sessions WHERE agent = ? ORDER BY ts DESC LIMIT ?)").run(agent, agent, this.keep);
    });
    tx();
  }
}
