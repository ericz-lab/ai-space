import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type OrdersStore, type TranscriptLine } from "./store.ts";
import { MAX_ORDER_TEXT, MAX_SUMMARY, MAX_TITLE, type OrderVia } from "./types.ts";

/**
 * Importing the old path's history (docs/orders.md#importing-the-old-path): the decree app's orders and
 * hive's topic rooms become orders and topics here. It only reads the two apps (a copy of their SQLite
 * file, or decree's HTTP API) and only adds to the orders store; it deletes and uninstalls nothing.
 *
 * - Every imported row carries an import key: an order `decree/<machine>/<decree id>` (the machine
 *   the decree was given on, as hive names it), a topic `hive/<room id>`, and `decrees` for the one
 *   topic that holds the orders no hive topic has. A second run adds nothing.
 * - A decree in both apps is one order: in hive's topic, with decree's text and picture.
 * - An imported order is taken already (`run_id` = `imported`): nothing dispatches it. An imported
 *   topic has no session; its room's messages are kept as a transcript, shown on the topic and given,
 *   trimmed, to the first new turn in it.
 */

export type ImportKind = "decree" | "hive";

export type ImportOptions = {
  kind: ImportKind;
  /** decree: its db file, or its URL; hive: a copy of its db file. Default for decree: this workspace's `data/decree/main.db`. */
  from?: string;
  /** The images directory beside the db (decree: `images/`, hive: `decree-images/`), when the copy put it elsewhere. */
  images?: string;
  /** decree: the name the decree's machine has in hive (default: this Space's name). */
  machine?: string;
  /** hive: the name of hive's own machine, for decrees hive took on its own machine (peer ''). */
  hiveMachine?: string;
  dryRun?: boolean;
  /** This workspace's data directory (`<home>/data`). */
  dataDir: string;
  /** This Space's name (SPACE_NAME). */
  spaceName: string;
  fetch?: typeof fetch;
};

export type ImportReport = {
  kind: ImportKind;
  from: string;
  dryRun: boolean;
  /** What was added (or, in a dry run, would be). */
  added: { topics: number; orders: number; pictures: number; transcripts: number };
  /** Orders already here from the other app, given this one's topic (hive) or text and picture (decree). */
  matched: number;
  /** Already imported by an earlier run: left as they are. */
  unchanged: number;
  skipped: { item: string; reason: string }[];
};

/** The topic of the orders no hive topic holds. */
export const DECREES_TOPIC_KEY = "decrees";
export const DECREES_TOPIC_TITLE = "Imported decrees";
/** What a transcript line keeps of a message, at most. */
export const MAX_TRANSCRIPT_TEXT = 4_000;
/** decree's API lists this many decrees at most: the newest. */
const DECREE_API_LIMIT = 500;

type Picture = { bytes: Uint8Array; mime: string };
type Item = { key: string; label: string; text: string; via: OrderVia | null; createdAt: number; picture: () => Promise<Picture | { missing: string } | undefined> };
type Room = { key: string; id: number; title: string; createdAt: number; lastActiveAt: number; summary: string; lines: TranscriptLine[]; items: Item[] };

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };

export class ImportError extends Error {}

/** Run one import. Reads only; writes only to `store`, and only rows it does not have. */
export async function importOrders(store: OrdersStore, opts: ImportOptions): Promise<ImportReport> {
  if (opts.kind === "decree") return importDecree(store, opts);
  if (opts.kind === "hive") return importHive(store, opts);
  throw new ImportError(`unknown import ${String(opts.kind)}: decree or hive`);
}

// ---------------------------------------------------------------- decree

async function importDecree(store: OrdersStore, opts: ImportOptions): Promise<ImportReport> {
  const machine = (opts.machine ?? opts.spaceName).trim();
  if (!machine) throw new ImportError("name the decree's machine with --machine (the name hive knows it by)");
  const from = opts.from?.trim() || join(opts.dataDir, "decree", "main.db");
  const report = emptyReport("decree", from, !!opts.dryRun);
  const items = /^https?:\/\//.test(from) ? await decreeFromUrl(from, machine, opts.fetch ?? fetch, report) : await withCopy(from, (db) => decreeFromDb(db, machine, opts.images ?? join(dirname(from), "images"), report));
  for (const item of items) {
    const have = store.orderByImportKey(item.key);
    if (have) {
      // From hive already, or from an earlier run: decree's text and picture, when they differ.
      const pic = !have.imagePath ? await item.picture() : undefined;
      const picture = pic && "bytes" in pic ? pic : undefined;
      if (have.text === item.text && !picture) {
        report.unchanged++;
        continue;
      }
      report.matched++;
      if (picture) report.added.pictures++;
      if (!opts.dryRun) await store.patchImported(have.id, { text: item.text, ...(picture ? { image: picture } : {}) });
      continue;
    }
    await addOrder(store, item, () => decreesTopic(store, report, !!opts.dryRun, item.createdAt), report, !!opts.dryRun);
  }
  return report;
}

type DecreeRow = { id: number; text: string; source: string | null; created_at: number; image_mime: string | null };

function decreeFromDb(db: Database, machine: string, images: string, report: ImportReport): Item[] {
  if (!hasTable(db, "decrees") || !["id", "text", "created_at"].every((c) => columnsOf(db, "decrees").has(c))) throw new ImportError("this is not decree's database: it has no decrees table with id, text and created_at");
  const rows = db.query<DecreeRow, []>("SELECT id, text, source, created_at, image_mime FROM decrees ORDER BY id").all();
  return rows.flatMap((r) => {
    const item = decreeItem(machine, r.id, r.text, r.source, r.created_at, report);
    if (!item) return [];
    item.picture = async () => (r.image_mime ? readPicture(join(images, `${r.id}.${EXT[r.image_mime] ?? "img"}`), r.image_mime) : undefined);
    return [item];
  });
}

async function decreeFromUrl(url: string, machine: string, f: typeof fetch, report: ImportReport): Promise<Item[]> {
  const base = url.replace(/\/+$/, "");
  const res = await f(`${base}/api/decrees?limit=${DECREE_API_LIMIT}`, { signal: AbortSignal.timeout(30_000) }).catch((e: Error) => {
    throw new ImportError(`decree at ${base} did not answer: ${e.message}`);
  });
  if (!res.ok) throw new ImportError(`decree at ${base} answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => ({}))) as { decrees?: { id: number; text: string; source?: string; createdAt: string; image?: { mime: string } | null }[] };
  if (!Array.isArray(body.decrees)) throw new ImportError(`${base}/api/decrees did not list decrees`);
  if (body.decrees.length >= DECREE_API_LIMIT) report.skipped.push({ item: "decrees older than the newest 500", reason: "decree's API lists 500 at most; import its db file for the rest" });
  return body.decrees
    .slice()
    .sort((a, b) => a.id - b.id)
    .flatMap((d) => {
      const item = decreeItem(machine, d.id, d.text, d.source ?? null, Date.parse(d.createdAt), report);
      if (!item) return [];
      item.picture = async () => {
        if (!d.image) return undefined;
        try {
          const r = await f(`${base}/api/decrees/image`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: d.id }), signal: AbortSignal.timeout(30_000) });
          const j = (await r.json()) as { ok?: boolean; mime?: string; data?: string; error?: string };
          if (!r.ok || !j.ok || !j.data || !j.mime) return { missing: `decree did not give the picture (${j.error ?? `HTTP ${r.status}`})` };
          return { bytes: new Uint8Array(Buffer.from(j.data, "base64")), mime: j.mime };
        } catch (e) {
          return { missing: `decree did not give the picture (${(e as Error).message})` };
        }
      };
      return [item];
    });
}

function decreeItem(machine: string, id: number, text: string | null, source: string | null, createdAt: number, report: ImportReport): Item | undefined {
  const label = `decree #${id}`;
  const t = (text ?? "").trim();
  if (!t) return void report.skipped.push({ item: label, reason: "no text" });
  if (!Number.isFinite(createdAt)) return void report.skipped.push({ item: label, reason: "no readable time" });
  return { key: `decree/${machine}/${id}`, label, text: t.slice(0, MAX_ORDER_TEXT), via: viaOf(source), createdAt, picture: async () => undefined };
}

/** decree's `source` (voice, text, app, widget) as an order's `via`. */
function viaOf(source: string | null): OrderVia | null {
  if (source === "voice") return "voice";
  if (source === "text" || source === "app" || source === "widget") return "type";
  return null;
}

// ---------------------------------------------------------------- hive

type HiveRoom = { id: number; name: string; created_at: string | null; topic_of: number | null };
type HiveMessage = { id: number; room_id: number; sender: string; content: string | null; status: string | null; created_at: string | null };
type HiveDecree = { peer: string; decree_id: number; room_id: number | null; text: string | null; source: string | null; issued_at: string | null; image_mime: string | null; image_state: string | null };

async function importHive(store: OrdersStore, opts: ImportOptions): Promise<ImportReport> {
  const from = opts.from?.trim();
  if (!from) throw new ImportError("hive runs on another machine: copy its db file (and decree-images/) here and give it with --from <path> (docs/orders.md#importing-the-old-path)");
  if (/^https?:\/\//.test(from)) throw new ImportError("hive is imported from a copy of its db file, not its URL: copy hive.db and decree-images/ here (docs/orders.md#importing-the-old-path)");
  const hiveMachine = (opts.hiveMachine ?? "").trim();
  const report = emptyReport("hive", from, !!opts.dryRun);
  const images = opts.images ?? join(dirname(from), "decree-images");
  const { rooms, loose } = await withCopy(from, (db) => hiveFromDb(db, hiveMachine, images, report));
  const dry = !!opts.dryRun;
  for (const room of rooms) {
    let topic = store.topicByImportKey(room.key);
    const topicId = (): number => {
      if (topic) return topic.id;
      if (dry) return -1;
      topic = store.importTopic({ key: room.key, title: room.title, createdAt: room.createdAt, lastActiveAt: room.lastActiveAt, summary: room.summary });
      return topic.id;
    };
    if (!topic) {
      report.added.topics++;
      topicId();
    }
    if (room.lines.length && (dry ? !topic || !store.transcript(topic.id) : !store.transcript(topicId()))) {
      report.added.transcripts++;
      if (!dry) store.setTranscript(topicId(), `hive · ${room.title}`, room.lines);
    }
    for (const item of room.items) {
      const have = store.orderByImportKey(item.key);
      if (have) {
        // From decree already (or an earlier run): hive's topic, decree's text and picture.
        if (topic && have.topicId === topic.id) report.unchanged++;
        else {
          report.matched++;
          if (!dry) await store.patchImported(have.id, { topicId: topicId() });
        }
        continue;
      }
      await addOrder(store, item, topicId, report, dry);
    }
  }
  for (const item of loose) {
    if (store.orderByImportKey(item.key)) report.unchanged++;
    else await addOrder(store, item, () => decreesTopic(store, report, dry, item.createdAt), report, dry);
  }
  return report;
}

function hiveFromDb(db: Database, hiveMachine: string, images: string, report: ImportReport): { rooms: Room[]; loose: Item[] } {
  for (const t of ["rooms", "messages", "decrees"]) if (!hasTable(db, t)) throw new ImportError(`this is not hive's database: it has no ${t} table`);
  const roomCols = columnsOf(db, "rooms");
  if (!roomCols.has("topic_of")) throw new ImportError("this hive has no topic rooms (rooms.topic_of): nothing to import");
  const rooms = db.query<HiveRoom, []>("SELECT id, name, created_at, topic_of FROM rooms WHERE topic_of IS NOT NULL ORDER BY id").all();
  const decreeCols = columnsOf(db, "decrees");
  const pick = (c: string) => (decreeCols.has(c) ? c : `NULL AS ${c}`);
  const decrees = db.query<HiveDecree, []>(`SELECT peer, decree_id, room_id, ${pick("text")}, ${pick("source")}, ${pick("issued_at")}, ${pick("image_mime")}, ${pick("image_state")} FROM decrees ORDER BY issued_at, decree_id`).all();
  const topicRooms = new Set(rooms.map((r) => r.id));
  const item = (d: HiveDecree): Item | undefined => {
    const machine = d.peer || hiveMachine;
    const label = `hive decree ${d.peer || "(hive's machine)"}#${d.decree_id}`;
    if (!machine) return void report.skipped.push({ item: label, reason: "taken on hive's own machine: name that machine with --hive-machine" });
    const text = (d.text ?? "").trim();
    if (!text) return void report.skipped.push({ item: label, reason: "hive kept no text of it (import decree for its text)" });
    const at = utc(d.issued_at);
    if (at === null) return void report.skipped.push({ item: label, reason: "no readable time" });
    const file = join(images, `${(d.peer || "_").replace(/[^a-z0-9._-]/gi, "_")}-${d.decree_id}.${EXT[d.image_mime ?? ""] ?? "img"}`);
    return { key: `decree/${machine}/${d.decree_id}`, label, text: text.slice(0, MAX_ORDER_TEXT), via: viaOf(d.source), createdAt: at, picture: async () => (d.image_mime && d.image_state === "ok" ? readPicture(file, d.image_mime) : undefined) };
  };
  const out: Room[] = rooms.map((r) => {
    const messages = db.query<HiveMessage, [number]>("SELECT id, room_id, sender, content, status, created_at FROM messages WHERE room_id = ? ORDER BY id").all(r.id);
    const lines: TranscriptLine[] = messages.flatMap((m) => {
      const text = (m.content ?? "").trim();
      if (!text || m.status === "pending") return [];
      return [{ at: utc(m.created_at) ?? 0, who: m.sender === "user" ? "person" : m.sender, text: (m.status === "error" ? "(this turn failed) " : "") + text.slice(0, MAX_TRANSCRIPT_TEXT) }];
    });
    const items = decrees.filter((d) => d.room_id === r.id).flatMap((d) => item(d) ?? []);
    const created = utc(r.created_at) ?? items[0]?.createdAt ?? Date.now();
    const last = Math.max(created, ...lines.map((l) => l.at), ...items.map((i) => i.createdAt));
    const lastAgent = [...lines].reverse().find((l) => l.who !== "person");
    return { key: `hive/${r.id}`, id: r.id, title: (r.name || `hive room ${r.id}`).slice(0, MAX_TITLE), createdAt: created, lastActiveAt: last, summary: (lastAgent?.text ?? "").slice(0, MAX_SUMMARY), lines, items };
  });
  // Decrees in no topic room (the inbox room, not routed yet): the imported decrees' topic.
  const loose = decrees.filter((d) => d.room_id === null || !topicRooms.has(d.room_id)).flatMap((d) => item(d) ?? []);
  return { rooms: out, loose };
}

/** hive's times: SQLite `datetime('now')`, UTC without a zone. */
function utc(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isFinite(t) ? t : null;
}

// ---------------------------------------------------------------- shared

function emptyReport(kind: ImportKind, from: string, dryRun: boolean): ImportReport {
  return { kind, from, dryRun, added: { topics: 0, orders: 0, pictures: 0, transcripts: 0 }, matched: 0, unchanged: 0, skipped: [] };
}

/**
 * The topic of the orders no hive topic holds; made on first use, as old as its first order (its
 * activity is its newest order's, so it falls outside the look-back window like any old topic).
 */
/** Dry runs that counted the imported decrees' topic already (it is made once). */
const planned = new WeakSet<ImportReport>();

function decreesTopic(store: OrdersStore, report: ImportReport, dry: boolean, at: number): number {
  const have = store.topicByImportKey(DECREES_TOPIC_KEY);
  if (have) return have.id;
  if (dry && planned.has(report)) return -1;
  report.added.topics++;
  if (dry) return planned.add(report), -1;
  return store.importTopic({ key: DECREES_TOPIC_KEY, title: DECREES_TOPIC_TITLE, createdAt: at, lastActiveAt: at, summary: "" }).id;
}

async function addOrder(store: OrdersStore, item: Item, topicId: () => number, report: ImportReport, dry: boolean): Promise<void> {
  const pic = await item.picture();
  if (pic && "missing" in pic) report.skipped.push({ item: `${item.label}'s picture`, reason: pic.missing });
  const picture = pic && "bytes" in pic ? pic : undefined;
  const id = topicId();
  report.added.orders++;
  if (picture) report.added.pictures++;
  if (dry) return;
  await store.importOrder({ key: item.key, topicId: id, text: item.text, via: item.via, createdAt: item.createdAt, ...(picture ? { image: picture } : {}) });
  // A topic is as recent as its newest order.
  const t = store.topic(id);
  if (t && t.lastActiveAt < item.createdAt) store.patchTopic(id, { lastActiveAt: item.createdAt });
}

async function readPicture(path: string, mime: string): Promise<Picture | { missing: string }> {
  if (!EXT[mime]) return { missing: `an image of type ${mime} is not kept` };
  try {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    return bytes.byteLength ? { bytes, mime } : { missing: `${basename(path)} is empty` };
  } catch {
    return { missing: `${path} is not there` };
  }
}

/**
 * Open a copy of an SQLite file (with its -wal and -shm), never the file itself: the app may be
 * running, and reading must not write to its data.
 */
async function withCopy<T>(path: string, read: (db: Database) => T | Promise<T>): Promise<T> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile()) throw new ImportError(`${path} is not a file`);
  const dir = await mkdtemp(join(tmpdir(), "space-import-"));
  try {
    const copy = join(dir, basename(path));
    await copyFile(path, copy);
    for (const ext of ["-wal", "-shm"]) await copyFile(path + ext, copy + ext).catch(() => {});
    const db = new Database(copy);
    try {
      return await read(db);
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`cannot read ${path}: ${(e as Error).message}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function hasTable(db: Database, name: string): boolean {
  return !!db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

/** The transcript as the first new turn in an imported topic reads it: the newest messages, within `max` characters. */
export function transcriptPrompt(source: string, lines: TranscriptLine[], max = 12_000): string {
  const out: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    const text = `${l.who}: ${l.text.length > 1_500 ? `${l.text.slice(0, 1_499)}…` : l.text}`;
    if (size + text.length > max) break;
    out.unshift(text);
    size += text.length + 1;
  }
  const dropped = lines.length - out.length;
  return [
    `〔This topic was imported from ${source}. Its earlier conversation there, for context only (read-only; that session is not continued)${dropped ? `; the ${dropped} oldest message${dropped > 1 ? "s are" : " is"} left out` : ""}:〕`,
    ...out,
    "〔End of the imported conversation. The new order follows.〕",
  ].join("\n");
}
