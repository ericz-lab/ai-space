import type { Database } from "bun:sqlite";
import { APP_SWITCHES, type ClientInfo, DEFAULT_SETTINGS, EFFORTS, type FeedbackRow, type FeedbackSettings, MODES, type PageContext, type RecentView, type Status, STATUSES } from "./types.ts";

/**
 * Feedback in space.db (docs/feedback.md): the settings as one JSON value, and one row per piece of
 * feedback with its context, its todo and the fix engineer's run. Instants are epoch milliseconds
 * (docs/time.md).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feedback_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app         TEXT NOT NULL,
  text        TEXT NOT NULL,
  context     TEXT NOT NULL,
  client      TEXT NOT NULL,
  status      TEXT NOT NULL,
  todo_id     INTEGER,
  todo_peer   TEXT NOT NULL DEFAULT '',
  todo_url    TEXT,
  run_id      TEXT,
  run_machine TEXT NOT NULL DEFAULT '',
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_app ON feedback(app, created_at DESC);
CREATE INDEX IF NOT EXISTS feedback_status ON feedback(status, app);
`;

type Row = {
  id: number;
  app: string;
  text: string;
  context: string;
  client: string;
  status: Status;
  todo_id: number | null;
  todo_peer: string;
  todo_url: string | null;
  run_id: string | null;
  run_machine: string;
  note: string | null;
  created_at: number;
  updated_at: number;
};

const fromRow = (r: Row): FeedbackRow => ({
  id: r.id,
  app: r.app,
  text: r.text,
  context: JSON.parse(r.context) as PageContext,
  client: JSON.parse(r.client) as ClientInfo,
  status: r.status,
  todoId: r.todo_id,
  todoPeer: r.todo_peer,
  todoUrl: r.todo_url,
  runId: r.run_id,
  runMachine: r.run_machine,
  note: r.note,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** A settings patch from the panel, checked field by field; anything else is an error. */
export function mergeSettings(cur: FeedbackSettings, patch: unknown): FeedbackSettings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("settings must be an object");
  const p = patch as Record<string, unknown>;
  const next = { ...cur, apps: { ...cur.apps } };
  for (const k of ["enabled", "appsDefault", "errors"] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== "boolean") throw new Error(`${k} must be true or false`);
    next[k] = p[k] as boolean;
  }
  if (p.mode !== undefined) {
    if (!(MODES as readonly unknown[]).includes(p.mode)) throw new Error(`mode must be one of ${MODES.join(", ")}`);
    next.mode = p.mode as FeedbackSettings["mode"];
  }
  if (p.effort !== undefined) {
    if (!(EFFORTS as readonly unknown[]).includes(p.effort)) throw new Error(`effort must be one of ${EFFORTS.join(", ")}`);
    next.effort = p.effort as FeedbackSettings["effort"];
  }
  if (p.machine !== undefined) {
    if (typeof p.machine !== "string" || (p.machine !== "" && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(p.machine))) throw new Error("machine must be empty (this machine) or a peer's name");
    next.machine = p.machine;
  }
  if (p.model !== undefined) {
    if (typeof p.model !== "string" || (p.model !== "" && !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]{1,64}$/i.test(p.model))) throw new Error("model must be empty or runtime/model");
    next.model = p.model;
  }
  if (p.apps !== undefined) {
    if (!p.apps || typeof p.apps !== "object" || Array.isArray(p.apps)) throw new Error("apps must map app names to default, on or off");
    for (const [app, v] of Object.entries(p.apps as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(app)) throw new Error(`invalid app name: ${app}`);
      if (!(APP_SWITCHES as readonly unknown[]).includes(v)) throw new Error(`apps.${app} must be one of ${APP_SWITCHES.join(", ")}`);
      if (v === "default") delete next.apps[app];
      else next.apps[app] = v as "on" | "off";
    }
  }
  return next;
}

export class FeedbackStore {
  constructor(private readonly db: Database, private readonly now: () => number = Date.now) {
    db.exec(SCHEMA);
  }

  settings(): FeedbackSettings {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM feedback_settings WHERE key = 'settings'").get();
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      // Unknown or broken fields fall back one by one, so an older or hand-edited value still loads.
      const stored = JSON.parse(row.value) as Record<string, unknown>;
      let out = structuredClone(DEFAULT_SETTINGS);
      for (const [k, v] of Object.entries(stored)) {
        try {
          out = mergeSettings(out, { [k]: v });
        } catch { /* keep the default */ }
      }
      return out;
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  saveSettings(patch: unknown): FeedbackSettings {
    const next = mergeSettings(this.settings(), patch);
    this.db.query("INSERT INTO feedback_settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
    return next;
  }

  add(r: { app: string; text: string; context: PageContext; client: ClientInfo; status: Status }): FeedbackRow {
    const at = this.now();
    const id = Number(
      this.db
        .query("INSERT INTO feedback (app, text, context, client, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(r.app, r.text, JSON.stringify(r.context), JSON.stringify(r.client), r.status, at, at).lastInsertRowid,
    );
    return this.get(id)!;
  }

  get(id: number): FeedbackRow | null {
    const r = this.db.query<Row, [number]>("SELECT * FROM feedback WHERE id = ?").get(id);
    return r ? fromRow(r) : null;
  }

  patch(id: number, p: Partial<Pick<FeedbackRow, "status" | "todoId" | "todoPeer" | "todoUrl" | "runId" | "runMachine" | "note">>): FeedbackRow | null {
    const cols: Record<string, string> = { status: "status", todoId: "todo_id", todoPeer: "todo_peer", todoUrl: "todo_url", runId: "run_id", runMachine: "run_machine", note: "note" };
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(p)) {
      if (v === undefined || !cols[k]) continue;
      if (k === "status" && !(STATUSES as readonly unknown[]).includes(v)) throw new Error(`invalid status: ${String(v)}`);
      sets.push(`${cols[k]} = ?`);
      vals.push(v as string | number | null);
    }
    if (!sets.length) return this.get(id);
    this.db.query(`UPDATE feedback SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, this.now(), id);
    return this.get(id);
  }

  list(filter: { app?: string; status?: Status[]; limit?: number } = {}): FeedbackRow[] {
    const where: string[] = [];
    const vals: (string | number)[] = [];
    if (filter.app) { where.push("app = ?"); vals.push(filter.app); }
    if (filter.status?.length) { where.push(`status IN (${filter.status.map(() => "?").join(", ")})`); vals.push(...filter.status); }
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    return this.db
      .query<Row, (string | number)[]>(`SELECT * FROM feedback ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...vals, limit)
      .map(fromRow);
  }

  /** How many came from one app since `since`: the hourly cap. */
  countSince(app: string, since: number): number {
    return this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM feedback WHERE app = ? AND created_at >= ?").get(app, since)?.n ?? 0;
  }

  /** The same text from the same app and path in the last 30 s: a double click, not a second report. */
  duplicate(app: string, text: string, path: string): FeedbackRow | null {
    const since = this.now() - 30_000;
    return this.list({ app, limit: 5 }).find((r) => r.createdAt >= since && r.text === text && r.context.path === path) ?? null;
  }

  /** Rows still `fixing` from before a restart: their runs are gone with the process. */
  interrupted(): FeedbackRow[] {
    return this.list({ status: ["fixing"], limit: 500 });
  }
}

export function recentView(r: FeedbackRow): RecentView {
  return { id: r.id, text: r.text.slice(0, 120), status: r.status, todoId: r.todoId, todoUrl: r.todoUrl, createdAt: r.createdAt };
}
