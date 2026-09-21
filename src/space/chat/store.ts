import { Database } from "bun:sqlite";
import type { Attachment, Message, Role, Thread } from "./types.ts";

/**
 * Threads, messages and attachments, in ai-space's own database next to the
 * ledger. Same migration rule as the other stores: extend ADDED_COLUMNS with
 * nullable columns, never rewrite tables. Attachment bytes live on disk; the
 * row holds the path, and whoever deletes a row deletes the file.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_threads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT NOT NULL,
  scope       TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_threads_scope ON chat_threads(app, scope, updated_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  error       TEXT,
  call_id     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(thread_id, id);
CREATE TABLE IF NOT EXISTS chat_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT NOT NULL,
  thread_id   INTEGER NOT NULL,
  message_id  INTEGER,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_attachments_thread ON chat_attachments(thread_id, message_id);
`;

const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [];

type ThreadRow = { id: number; app: string; scope: string; title: string; created_at: number; updated_at: number };
type MessageRow = { id: number; thread_id: number; role: Role; content: string; error: string | null; call_id: number | null; created_at: number };
type AttachmentRow = { id: number; app: string; thread_id: number; message_id: number | null; name: string; type: string; size: number; path: string; created_at: number };

const thread = (r: ThreadRow): Thread => ({ id: r.id, app: r.app, scope: r.scope, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at });
const message = (r: MessageRow): Message => ({
  id: r.id, threadId: r.thread_id, role: r.role, content: r.content, createdAt: r.created_at,
  ...(r.error === null ? {} : { error: r.error }),
  ...(r.call_id === null ? {} : { callId: r.call_id }),
});
const attachment = (r: AttachmentRow): Attachment => ({
  id: r.id, app: r.app, threadId: r.thread_id, name: r.name, type: r.type, size: r.size, path: r.path, createdAt: r.created_at,
  ...(r.message_id === null ? {} : { messageId: r.message_id }),
});

export class ChatStore {
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

  // ---------------------------------------------------------------- threads

  createThread(app: string, scope: string, title = "", at = Date.now()): Thread {
    const r = this.db.query("INSERT INTO chat_threads (app, scope, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(app, scope, title, at, at);
    return this.getThread(app, Number(r.lastInsertRowid))!;
  }

  getThread(app: string, id: number): Thread | undefined {
    const r = this.db.query<ThreadRow, [string, number]>("SELECT * FROM chat_threads WHERE app = ? AND id = ?").get(app, id);
    return r ? thread(r) : undefined;
  }

  listThreads(app: string, scope: string, limit = 50): Thread[] {
    return this.db.query<ThreadRow, [string, string, number]>("SELECT * FROM chat_threads WHERE app = ? AND scope = ? ORDER BY updated_at DESC, id DESC LIMIT ?").all(app, scope, limit).map(thread);
  }

  /** A thread already imported: same app, scope and creation time. */
  findThread(app: string, scope: string, createdAt: number): Thread | undefined {
    const r = this.db.query<ThreadRow, [string, string, number]>("SELECT * FROM chat_threads WHERE app = ? AND scope = ? AND created_at = ?").get(app, scope, createdAt);
    return r ? thread(r) : undefined;
  }

  /** Bump a thread; a title is set only when given. */
  touchThread(id: number, at = Date.now(), title?: string): void {
    if (title === undefined) this.db.query("UPDATE chat_threads SET updated_at = ? WHERE id = ?").run(at, id);
    else this.db.query("UPDATE chat_threads SET updated_at = ?, title = ? WHERE id = ?").run(at, title, id);
  }

  renameThread(app: string, id: number, title: string): boolean {
    return this.db.query("UPDATE chat_threads SET title = ? WHERE app = ? AND id = ?").run(title, app, id).changes > 0;
  }

  /** Remove a thread with its messages and attachment rows; returns the attachment paths to unlink. */
  deleteThread(app: string, id: number): string[] | undefined {
    if (!this.getThread(app, id)) return undefined;
    const paths = this.db.query<{ path: string }, [number]>("SELECT path FROM chat_attachments WHERE thread_id = ?").all(id).map((r) => r.path);
    this.db.transaction(() => {
      this.db.query("DELETE FROM chat_attachments WHERE thread_id = ?").run(id);
      this.db.query("DELETE FROM chat_messages WHERE thread_id = ?").run(id);
      this.db.query("DELETE FROM chat_threads WHERE id = ?").run(id);
    })();
    return paths;
  }

  /** Remove every thread of a scope; returns the attachment paths to unlink. */
  deleteScope(app: string, scope: string): string[] {
    const paths: string[] = [];
    for (const t of this.listThreads(app, scope, 100_000)) paths.push(...(this.deleteThread(app, t.id) ?? []));
    return paths;
  }

  // ---------------------------------------------------------------- messages

  addMessage(threadId: number, m: { role: Role; content: string; error?: string; callId?: number }, at = Date.now()): Message {
    const r = this.db
      .query("INSERT INTO chat_messages (thread_id, role, content, error, call_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(threadId, m.role, m.content, m.error ?? null, m.callId ?? null, at);
    return this.getMessage(Number(r.lastInsertRowid))!;
  }

  getMessage(id: number): Message | undefined {
    const r = this.db.query<MessageRow, [number]>("SELECT * FROM chat_messages WHERE id = ?").get(id);
    return r ? message(r) : undefined;
  }

  listMessages(threadId: number): Message[] {
    return this.db.query<MessageRow, [number]>("SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id").all(threadId).map(message);
  }

  countMessages(threadId: number): number {
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?").get(threadId)!.n;
  }

  // ---------------------------------------------------------------- attachments

  /** The row is written first so its id can name the file; the caller writes the bytes and calls `setAttachmentPath`, or `removeAttachment` on failure. */
  addAttachment(a: { app: string; threadId: number; name: string; type: string; size: number }, at = Date.now()): Attachment {
    const r = this.db
      .query("INSERT INTO chat_attachments (app, thread_id, message_id, name, type, size, path, created_at) VALUES (?, ?, NULL, ?, ?, ?, '', ?)")
      .run(a.app, a.threadId, a.name, a.type, a.size, at);
    return this.getAttachment(a.app, Number(r.lastInsertRowid))!;
  }

  setAttachmentPath(id: number, path: string): void {
    this.db.query("UPDATE chat_attachments SET path = ? WHERE id = ?").run(path, id);
  }

  removeAttachment(id: number): void {
    this.db.query("DELETE FROM chat_attachments WHERE id = ?").run(id);
  }

  getAttachment(app: string, id: number): Attachment | undefined {
    const r = this.db.query<AttachmentRow, [string, number]>("SELECT * FROM chat_attachments WHERE app = ? AND id = ?").get(app, id);
    return r ? attachment(r) : undefined;
  }

  listAttachments(threadId: number): Attachment[] {
    return this.db.query<AttachmentRow, [number]>("SELECT * FROM chat_attachments WHERE thread_id = ? ORDER BY id").all(threadId).map(attachment);
  }

  countAttachments(threadId: number): number {
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM chat_attachments WHERE thread_id = ?").get(threadId)!.n;
  }

  /** Attach uploaded files to the message that carries them. Every id must be an unbound attachment of that thread, or nothing is bound. */
  bindAttachments(ids: number[], threadId: number, messageId: number): boolean {
    if (!ids.length) return true;
    try {
      this.db.transaction(() => {
        for (const id of ids) {
          const n = this.db.query("UPDATE chat_attachments SET message_id = ? WHERE id = ? AND thread_id = ? AND message_id IS NULL").run(messageId, id, threadId).changes;
          if (n !== 1) throw new Error("not an unbound attachment of this thread");
        }
      })();
      return true;
    } catch {
      return false;
    }
  }

  /** Attachments uploaded before `olderThan` and never sent; the rows are removed and the paths returned for unlinking. */
  pruneOrphans(olderThan: number): string[] {
    const rows = this.db.query<{ id: number; path: string }, [number]>("SELECT id, path FROM chat_attachments WHERE message_id IS NULL AND created_at < ?").all(olderThan);
    for (const r of rows) this.removeAttachment(r.id);
    return rows.map((r) => r.path).filter(Boolean);
  }
}
