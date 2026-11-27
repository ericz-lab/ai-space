import type { Database } from "bun:sqlite";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS, EXT, MAX_TOPIC_DAYS, MIN_TOPIC_DAYS, type Order, type OrderVia, type OrdersSettings, type RoutedBy, type Topic, type TopicState } from "./types.ts";

/**
 * The orders and their topics, in `space.db` (docs/orders.md#data): the shared handle,
 * `CREATE TABLE IF NOT EXISTS`, additive `ALTER TABLE` for columns added later. A screenshot is a
 * file under `<workspace>/data/orders/images/`, never a blob in SQLite; deleting its order deletes it.
 * The two settings live in `panel_kv` beside the panel's own (`orders.topicDays`, `orders.notify`).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS order_topics (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  session_id     TEXT,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'working',
  archived       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS order_topics_active ON order_topics(archived, last_active_at DESC);
CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id   TEXT NOT NULL UNIQUE,
  topic_id    INTEGER,
  text        TEXT NOT NULL,
  via         TEXT,
  image_path  TEXT,
  image_mime  TEXT,
  image_bytes INTEGER,
  created_at  INTEGER NOT NULL,
  run_id      TEXT,
  routed_by   TEXT
);
CREATE INDEX IF NOT EXISTS orders_topic ON orders(topic_id, id);
CREATE TABLE IF NOT EXISTS panel_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Columns added after the first schema; each is added once to an older table. */
const ADDED: [table: string, column: string, decl: string][] = [
  ["order_topics", "run_id", "TEXT"],
  ["order_topics", "summary", "TEXT NOT NULL DEFAULT ''"],
];

type TopicRow = { id: number; title: string; session_id: string | null; run_id: string | null; created_at: number; last_active_at: number; state: string; summary: string; archived: number };
type OrderRow = { id: number; client_id: string; topic_id: number | null; text: string; via: string | null; image_path: string | null; image_mime: string | null; image_bytes: number | null; created_at: number; run_id: string | null; routed_by: string | null };

export type NewOrder = { clientId: string; text: string; via?: OrderVia; image?: { bytes: Uint8Array; mime: string } };

export class OrdersStore {
  readonly imageDir: string;
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    opts: { dataDir: string; now?: () => number },
  ) {
    this.imageDir = join(opts.dataDir, "orders", "images");
    this.now = opts.now ?? Date.now;
    db.exec(SCHEMA);
    for (const [table, column, decl] of ADDED) {
      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  // ---------------------------------------------------------------- orders

  /**
   * Store an order once per client id. The first call writes the screenshot's file, then the row;
   * a repeat answers the first order (`created: false`) and keeps nothing of its own. `onStored`
   * runs right after the row is written, before anything else can see the order unsorted.
   */
  async add(input: NewOrder, onStored?: (order: Order) => void): Promise<{ order: Order; created: boolean }> {
    const existing = this.byClientId(input.clientId);
    if (existing) return { order: existing, created: false };
    let path: string | null = null;
    if (input.image) {
      path = join(this.imageDir, `${input.clientId}-${crypto.randomUUID().slice(0, 8)}.${EXT[input.image.mime] ?? "bin"}`);
      await mkdir(this.imageDir, { recursive: true });
      await Bun.write(path, input.image.bytes);
    }
    let row: OrderRow;
    try {
      row = this.db
        .query<OrderRow, [string, string, string | null, string | null, string | null, number | null, number]>(
          "INSERT INTO orders (client_id, text, via, image_path, image_mime, image_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
        )
        .get(input.clientId, input.text, input.via ?? null, path, input.image?.mime ?? null, input.image?.bytes.byteLength ?? null, this.now())!;
    } catch (e) {
      if (path) await rm(path, { force: true });
      // The same id arrived twice at once: the first one is the order.
      const first = this.byClientId(input.clientId);
      if (first) return { order: first, created: false };
      throw e;
    }
    const order = orderOf(row);
    onStored?.(order);
    return { order, created: true };
  }

  get(id: number): Order | undefined {
    const row = this.db.query<OrderRow, [number]>("SELECT * FROM orders WHERE id = ?").get(id);
    return row ? orderOf(row) : undefined;
  }

  byClientId(clientId: string): Order | undefined {
    const row = this.db.query<OrderRow, [string]>("SELECT * FROM orders WHERE client_id = ?").get(clientId);
    return row ? orderOf(row) : undefined;
  }

  /** Orders stored but not sorted yet, oldest first. */
  unsorted(): Order[] {
    return this.db.query<OrderRow, []>("SELECT * FROM orders WHERE topic_id IS NULL ORDER BY id").all().map(orderOf);
  }

  /** A topic's orders, oldest first. */
  ofTopic(topicId: number): Order[] {
    return this.db.query<OrderRow, [number]>("SELECT * FROM orders WHERE topic_id = ? ORDER BY id").all(topicId).map(orderOf);
  }

  /** A topic's orders that no turn has taken yet, oldest first. */
  waiting(topicId: number): Order[] {
    return this.db.query<OrderRow, [number]>("SELECT * FROM orders WHERE topic_id = ? AND run_id IS NULL ORDER BY id").all(topicId).map(orderOf);
  }

  /** Every topic with an order no turn has taken (for the start). */
  topicsWaiting(): number[] {
    return this.db.query<{ topic_id: number }, []>("SELECT DISTINCT topic_id FROM orders WHERE topic_id IS NOT NULL AND run_id IS NULL ORDER BY topic_id").all().map((r) => r.topic_id);
  }

  sort(id: number, topicId: number, by: RoutedBy): void {
    this.db.query("UPDATE orders SET topic_id = ?, routed_by = ? WHERE id = ?").run(topicId, by, id);
  }

  /** The turn that took these orders. */
  taken(ids: number[], runId: string | null): void {
    const q = this.db.query("UPDATE orders SET run_id = ? WHERE id = ?");
    this.db.transaction(() => ids.forEach((id) => q.run(runId, id)))();
  }

  /** Delete an order and its screenshot's file. */
  async remove(id: number): Promise<boolean> {
    const order = this.get(id);
    if (!order) return false;
    this.db.query("DELETE FROM orders WHERE id = ?").run(id);
    if (order.imagePath) await rm(order.imagePath, { force: true });
    return true;
  }

  // ---------------------------------------------------------------- topics

  addTopic(title: string): Topic {
    const now = this.now();
    return topicOf(this.db.query<TopicRow, [string, number, number]>("INSERT INTO order_topics (title, created_at, last_active_at, state) VALUES (?, ?, ?, 'working') RETURNING *").get(title, now, now)!);
  }

  topic(id: number): Topic | undefined {
    const row = this.db.query<TopicRow, [number]>("SELECT * FROM order_topics WHERE id = ?").get(id);
    return row ? topicOf(row) : undefined;
  }

  /** Topics, most recently active first; archived ones only when asked. */
  topics(opts: { archived?: boolean; since?: number; limit?: number } = {}): Topic[] {
    const rows = this.db
      .query<TopicRow, [number, number, number]>("SELECT * FROM order_topics WHERE archived = ? AND last_active_at >= ? ORDER BY last_active_at DESC, id DESC LIMIT ?")
      .all(opts.archived ? 1 : 0, opts.since ?? 0, opts.limit ?? 500);
    return rows.map(topicOf);
  }

  /** The topic a Director session belongs to. */
  topicOfSession(sid: string): Topic | undefined {
    const row = this.db.query<TopicRow, [string]>("SELECT * FROM order_topics WHERE session_id = ?").get(sid);
    return row ? topicOf(row) : undefined;
  }

  topicOfRun(runId: string): Topic | undefined {
    const row = this.db.query<TopicRow, [string]>("SELECT * FROM order_topics WHERE run_id = ?").get(runId);
    return row ? topicOf(row) : undefined;
  }

  /** Sessions an unarchived topic points at: exempt from the chat sessions' retention. */
  pinnedSessions(): string[] {
    return this.db.query<{ session_id: string }, []>("SELECT session_id FROM order_topics WHERE archived = 0 AND session_id IS NOT NULL").all().map((r) => r.session_id);
  }

  patchTopic(id: number, patch: Partial<Pick<Topic, "title" | "sessionId" | "runId" | "state" | "summary" | "archived" | "lastActiveAt">>): Topic | undefined {
    const cols: Record<string, string> = { title: "title", sessionId: "session_id", runId: "run_id", state: "state", summary: "summary", archived: "archived", lastActiveAt: "last_active_at" };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || !cols[k]) continue;
      sets.push(`${cols[k]} = ?`);
      values.push(typeof v === "boolean" ? (v ? 1 : 0) : (v as string | number | null));
    }
    if (sets.length) this.db.query(`UPDATE order_topics SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.topic(id);
  }

  touch(id: number): void {
    this.db.query("UPDATE order_topics SET last_active_at = ? WHERE id = ?").run(this.now(), id);
  }

  // ---------------------------------------------------------------- settings

  settings(): OrdersSettings {
    const read = (key: string) => this.db.query<{ value: string }, [string]>("SELECT value FROM panel_kv WHERE key = ?").get(key)?.value;
    const days = Number(read("orders.topicDays"));
    const notify = read("orders.notify");
    return {
      topicDays: Number.isInteger(days) && days >= MIN_TOPIC_DAYS && days <= MAX_TOPIC_DAYS ? days : DEFAULT_SETTINGS.topicDays,
      notify: notify || DEFAULT_SETTINGS.notify,
    };
  }

  setSettings(patch: Partial<OrdersSettings>): OrdersSettings {
    const write = this.db.query("INSERT INTO panel_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    if (patch.topicDays !== undefined) write.run("orders.topicDays", String(patch.topicDays));
    if (patch.notify !== undefined) write.run("orders.notify", patch.notify);
    return this.settings();
  }
}

function topicOf(r: TopicRow): Topic {
  return { id: r.id, title: r.title, sessionId: r.session_id, runId: r.run_id, createdAt: r.created_at, lastActiveAt: r.last_active_at, state: r.state as TopicState, summary: r.summary ?? "", archived: r.archived === 1 };
}

function orderOf(r: OrderRow): Order {
  return {
    id: r.id,
    clientId: r.client_id,
    topicId: r.topic_id,
    text: r.text,
    via: r.via as OrderVia | null,
    imagePath: r.image_path,
    imageMime: r.image_mime,
    imageBytes: r.image_bytes,
    createdAt: r.created_at,
    runId: r.run_id,
    routedBy: r.routed_by as RoutedBy | null,
  };
}
