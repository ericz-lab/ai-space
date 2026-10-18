import type { Database } from "bun:sqlite";

/**
 * The owner's account and sessions in `space.db` (docs/auth.md). Instants are
 * integer milliseconds since the epoch (docs/time.md). A session is stored by
 * the SHA-256 of its token, never the token itself.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS auth_owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions (expires_at);
`;

export type Owner = { passwordHash: string; createdAt: number; passwordChangedAt: number };

export type Session = {
  id: number;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
  userAgent: string;
};

type SessionRow = { id: number; created_at: number; expires_at: number; last_seen_at: number; revoked_at: number | null; user_agent: string };

const session = (r: SessionRow): Session => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at, userAgent: r.user_agent });

export class OwnerExists extends Error {
  constructor() {
    super("the owner is already initialized; use `space auth reset-password` on the server to change the password");
  }
}

export class AuthStore {
  constructor(readonly db: Database) {
    db.exec(SCHEMA);
  }

  owner(): Owner | undefined {
    const r = this.db.query<{ password_hash: string; created_at: number; password_changed_at: number }, []>("SELECT password_hash, created_at, password_changed_at FROM auth_owner WHERE id = 1").get();
    return r ? { passwordHash: r.password_hash, createdAt: r.created_at, passwordChangedAt: r.password_changed_at } : undefined;
  }

  /** Creates the owner; the primary key makes a second creation fail, also between two processes. */
  createOwner(passwordHash: string, at: number): void {
    try {
      this.db.query("INSERT INTO auth_owner (id, password_hash, created_at, password_changed_at) VALUES (1, ?, ?, ?)").run(passwordHash, at, at);
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY|constraint/i.test((e as Error).message)) throw new OwnerExists();
      throw e;
    }
  }

  /** False when there is no owner to update. */
  setPassword(passwordHash: string, at: number): boolean {
    return this.db.query("UPDATE auth_owner SET password_hash = ?, password_changed_at = ? WHERE id = 1").run(passwordHash, at).changes === 1;
  }

  addSession(tokenHash: string, at: number, expiresAt: number, userAgent: string): Session {
    const r = this.db
      .query<SessionRow, [string, number, number, number, string]>("INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at, expires_at, last_seen_at, revoked_at, user_agent")
      .get(tokenHash, at, expiresAt, at, userAgent.slice(0, 300))!;
    return session(r);
  }

  /** The live session behind a token hash: not revoked, not expired. */
  liveSession(tokenHash: string, now: number): Session | undefined {
    const r = this.db.query<SessionRow, [string, number]>("SELECT id, created_at, expires_at, last_seen_at, revoked_at, user_agent FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").get(tokenHash, now);
    return r ? session(r) : undefined;
  }

  touch(id: number, at: number): void {
    this.db.query("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  liveSessions(now: number): Session[] {
    return this.db.query<SessionRow, [number]>("SELECT id, created_at, expires_at, last_seen_at, revoked_at, user_agent FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC").all(now).map(session);
  }

  revoke(id: number, at: number): boolean {
    return this.db.query("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(at, id).changes === 1;
  }

  /** Revokes every live session except `keep`; the number revoked. */
  revokeAll(at: number, keep?: number): number {
    return this.db.query("UPDATE auth_sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id != ?").run(at, keep ?? -1).changes;
  }

  /** Drops rows that can never be valid again, a day after they stopped being valid. */
  prune(now: number): number {
    const before = now - 86_400_000;
    return this.db.query("DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(before, before).changes;
  }
}
