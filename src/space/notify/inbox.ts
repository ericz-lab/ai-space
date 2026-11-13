import type { Database } from "bun:sqlite";
import { type Level, isLevel } from "./types.ts";

/**
 * The inbox: every app's notifications in one list, for the panel (docs/notify.md#inbox).
 *
 * It reads the notifications notify already stores and adds only what a person does with them:
 * read and done. Notifications with the same `app` and `key` are one thread, so a task that
 * failed 300 times is one entry with a count; a notification without a key is a thread of its
 * own. State is kept per thread with the time it was set, and a newer notification in the thread
 * makes it unread and open again: "done" means done up to that point.
 *
 * `alert` and `warn` are the levels that ask for something to be done; the rest are results.
 */

export const ACTION_LEVELS: readonly Level[] = ["alert", "warn"];
export const INBOX_FILTERS = ["all", "unread", "open", "done"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

export type InboxItem = {
  thread: string;
  app: string;
  level: Level;
  title?: string;
  text: string;
  url?: string;
  key?: string;
  /** The latest notification of the thread. */
  notificationId: string;
  count: number;
  firstAt: number;
  lastAt: number;
  action: boolean;
  unread: boolean;
  done: boolean;
  readAt?: number;
  doneAt?: number;
};

export type InboxSummary = { unread: number; open: number };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox_state (
  thread      TEXT PRIMARY KEY,
  read_at     INTEGER,
  done_at     INTEGER
);
`;

/**
 * The thread of a notification row, in SQL: `k:<app>:<key>`, or the notification's own id
 * (`n_…`) without a key. An app name has no `:`, so the first one after the prefix ends it.
 */
const THREAD_SQL = "CASE WHEN key IS NULL THEN id ELSE 'k:' || app || ':' || key END";

type ItemRow = {
  thread: string;
  id: string;
  app: string;
  level: string;
  title: string | null;
  text: string;
  url: string | null;
  key: string | null;
  cnt: number;
  first_at: number;
  last_at: number;
  read_at: number | null;
  done_at: number | null;
};

export class Inbox {
  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
    this.prune();
  }

  list(opts: InboxQuery = {}): InboxItem[] {
    const { where, args, limit } = listWhere(opts);
    const rows = this.db
      .query<ItemRow, (string | number)[]>(
        `SELECT * FROM (${THREADS}) WHERE ${where} ORDER BY last_at DESC, thread LIMIT ?`,
      )
      .all(...args, limit);
    return rows.map(rowToItem);
  }

  /** Unread threads and threads still asking for something to be done. */
  summary(): InboxSummary {
    const row = this.db
      .query<{ unread: number | null; open: number | null }, string[]>(`SELECT ${SUMMARY_SQL} FROM (${THREADS}) WHERE rn = 1`)
      .get(...ACTION_LEVELS);
    return { unread: row?.unread ?? 0, open: row?.open ?? 0 };
  }

  /** Unread threads at an action level (`ACTION_LEVELS`), not done, whose latest notification came at or after `since`. */
  alerts(since: number): number {
    const row = this.db
      .query<{ n: number }, (string | number)[]>(
        `SELECT COUNT(*) AS n FROM (${THREADS}) WHERE rn = 1
           AND level IN (${ACTION_LEVELS.map(() => "?").join(", ")})
           AND (read_at IS NULL OR read_at < last_at) AND (done_at IS NULL OR done_at < last_at) AND last_at >= ?`,
      )
      .get(...ACTION_LEVELS, since);
    return row?.n ?? 0;
  }

  /** `list` and `summary` together, from one pass over the notifications (the panel's poll). */
  page(opts: InboxQuery = {}): { items: InboxItem[]; summary: InboxSummary } {
    const { where, args, limit } = listWhere(opts);
    // The summary row always comes back; a page with no item joins it to one row of nulls.
    const rows = this.db
      .query<ItemRow & { s_unread: number | null; s_open: number | null }, (string | number)[]>(
        `WITH th AS MATERIALIZED (SELECT * FROM (${THREADS}) WHERE rn = 1),
              s AS (SELECT ${SUMMARY_SQL} FROM th)
         SELECT f.*, s.unread AS s_unread, s.open AS s_open FROM s
         LEFT JOIN (SELECT * FROM th WHERE ${where} ORDER BY last_at DESC, thread LIMIT ?) f ON 1
         ORDER BY f.last_at DESC, f.thread`,
      )
      .all(...ACTION_LEVELS, ...args, limit);
    const first = rows[0];
    return {
      items: rows.filter((r) => r.thread !== null).map(rowToItem),
      summary: { unread: first?.s_unread ?? 0, open: first?.s_open ?? 0 },
    };
  }

  /**
   * Set threads read or done (`true`) or back (`false`). Done implies read. Unknown threads are
   * ignored; returns how many were known.
   */
  mark(threads: string[], patch: { read?: boolean; done?: boolean }, now: number): number {
    const known = this.db.query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM notifications WHERE ${THREAD_SQL} = ?`);
    const upsert = this.db.query(
      `INSERT INTO inbox_state (thread, read_at, done_at) VALUES (?, ?, ?)
       ON CONFLICT(thread) DO UPDATE SET read_at = excluded.read_at, done_at = excluded.done_at`,
    );
    const current = this.db.query<{ read_at: number | null; done_at: number | null }, [string]>("SELECT read_at, done_at FROM inbox_state WHERE thread = ?");
    return this.db.transaction(() => {
      let n = 0;
      for (const thread of new Set(threads)) {
        if (!(known.get(thread)?.n ?? 0)) continue;
        n++;
        const cur = current.get(thread);
        let readAt = cur?.read_at ?? null;
        let doneAt = cur?.done_at ?? null;
        if (patch.read === true) readAt = now;
        if (patch.read === false) readAt = null;
        if (patch.done === true) {
          doneAt = now;
          readAt = now;
        }
        if (patch.done === false) doneAt = null;
        upsert.run(thread, readAt, doneAt);
      }
      return n;
    })();
  }

  /** Mark every thread read, optionally of one app. Returns how many changed. */
  readAll(now: number, app?: string): number {
    let total = 0;
    // A page at a time until none is left unread; a page that changes nothing ends it.
    for (;;) {
      const threads = this.list({ app, filter: "unread", limit: 500 }).map((i) => i.thread);
      let changed = 0;
      for (let i = 0; i < threads.length; i += 100) changed += this.mark(threads.slice(i, i + 100), { read: true }, now);
      total += changed;
      if (threads.length < 500 || !changed) return total;
    }
  }

  /** Drop state rows whose thread has no notification left (pruned by the per-app cap). */
  prune(): number {
    return this.db.query(`DELETE FROM inbox_state WHERE thread NOT IN (SELECT DISTINCT ${THREAD_SQL} FROM notifications)`).run().changes;
  }
}

type InboxQuery = { app?: string; filter?: InboxFilter; action?: boolean; limit?: number };

/** The conditions of a list over the latest row of each thread (`rn = 1`), and the clamped limit. */
function listWhere(opts: InboxQuery): { where: string; args: (string | number)[]; limit: number } {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const where: string[] = ["rn = 1"];
  const args: (string | number)[] = [];
  if (opts.app) {
    where.push("app = ?");
    args.push(opts.app);
  }
  if (opts.action) {
    where.push(`level IN (${ACTION_LEVELS.map(() => "?").join(", ")})`);
    args.push(...ACTION_LEVELS);
  }
  if (opts.filter === "unread") where.push("(read_at IS NULL OR read_at < last_at)");
  else if (opts.filter === "open") where.push("(done_at IS NULL OR done_at < last_at)");
  else if (opts.filter === "done") where.push("done_at >= last_at");
  return { where: where.join(" AND "), args, limit };
}

/** Unread threads and open action threads over the latest rows; takes `ACTION_LEVELS` as arguments. */
const SUMMARY_SQL = `SUM(read_at IS NULL OR read_at < last_at) AS unread,
  SUM(level IN (${ACTION_LEVELS.map(() => "?").join(", ")}) AND (done_at IS NULL OR done_at < last_at)) AS open`;

/** One row per notification with its thread's count, first time and state; `rn = 1` is the latest of the thread. */
const THREADS = `
  SELECT t.*, s.read_at, s.done_at FROM (
    SELECT ${THREAD_SQL} AS thread, id, app, level, title, text, url, key,
           ROW_NUMBER() OVER w AS rn,
           COUNT(*) OVER (PARTITION BY ${THREAD_SQL}) AS cnt,
           MIN(created_at) OVER (PARTITION BY ${THREAD_SQL}) AS first_at,
           MAX(created_at) OVER (PARTITION BY ${THREAD_SQL}) AS last_at
    FROM notifications
    WINDOW w AS (PARTITION BY ${THREAD_SQL} ORDER BY created_at DESC, rowid DESC)
  ) t LEFT JOIN inbox_state s ON s.thread = t.thread`;

function rowToItem(r: ItemRow): InboxItem {
  const level = isLevel(r.level) ? r.level : "info";
  return {
    thread: r.thread,
    app: r.app,
    level,
    title: r.title ?? undefined,
    text: r.text,
    url: r.url ?? undefined,
    key: r.key ?? undefined,
    notificationId: r.id,
    count: r.cnt,
    firstAt: r.first_at,
    lastAt: r.last_at,
    action: ACTION_LEVELS.includes(level),
    unread: r.read_at === null || r.read_at < r.last_at,
    done: r.done_at !== null && r.done_at >= r.last_at,
    readAt: r.read_at ?? undefined,
    doneAt: r.done_at ?? undefined,
  };
}

export function parseInboxFilter(v: string | null): InboxFilter {
  if (v === null || v === "") return "all";
  if ((INBOX_FILTERS as readonly string[]).includes(v)) return v as InboxFilter;
  throw new Error(`filter must be one of ${INBOX_FILTERS.join(", ")}`);
}
