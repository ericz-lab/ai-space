import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemp } from "../testing.ts";
import { DECREES_TOPIC_KEY, importOrders, transcriptPrompt } from "./import.ts";
import { IMPORTED_RUN, OrdersStore } from "./store.ts";

/**
 * The old path's import (docs/orders.md#importing-the-old-path) on two stand-in apps: a decree db
 * with its images directory, and a copy of hive's db with its decree-images directory, in the
 * schemas the two apps have. The sources are never written: their bytes and times are checked.
 */

let dir = "";
let decreeDb = "";
let hiveDb = "";
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 4, 5, 6]);
const T0 = Date.parse("2026-11-01T08:00:00Z");

beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "space-import-")));
  // ---- decree, on the Mac (hive calls it "mac"): three decrees, two with pictures, one empty
  await mkdir(join(dir, "decree", "images"), { recursive: true });
  decreeDb = join(dir, "decree", "main.db");
  const d = new Database(decreeDb);
  d.exec("PRAGMA journal_mode = WAL");
  d.exec("CREATE TABLE decrees (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, source TEXT NOT NULL, origin TEXT, status TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, image_mime TEXT, image_bytes INTEGER)");
  const add = d.query("INSERT INTO decrees (id, text, source, created_at, image_mime) VALUES (?, ?, ?, ?, ?)");
  add.run(1, "Fix the notes header", "voice", T0, "image/jpeg");
  add.run(2, "Look up the train times", "text", T0 + 60_000, null);
  add.run(3, "   ", "widget", T0 + 120_000, null);
  add.run(4, "Picture went missing", "app", T0 + 180_000, "image/png");
  d.close();
  await writeFile(join(dir, "decree", "images", "1.jpg"), JPG);
  // ---- hive's copy, from david: one topic room with decree 1 (from mac) and one of david's own; an inbox decree
  await mkdir(join(dir, "hive", "decree-images"), { recursive: true });
  hiveDb = join(dir, "hive", "hive.db");
  const h = new Database(hiveDb);
  h.exec(`CREATE TABLE rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, agents TEXT NOT NULL DEFAULT '[]', created_at TEXT DEFAULT (datetime('now')), lead TEXT, decree_inbox INTEGER DEFAULT 0, topic_of INTEGER);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id INTEGER NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE decrees (peer TEXT NOT NULL, decree_id INTEGER NOT NULL, room_id INTEGER, message_id INTEGER, source TEXT, issued_at TEXT, text TEXT, image_mime TEXT, image_state TEXT, PRIMARY KEY (peer, decree_id));`);
  h.exec(`INSERT INTO rooms (id, name, created_at, decree_inbox) VALUES (1, 'Decrees', '2026-10-01 00:00:00', 1);
    INSERT INTO rooms (id, name, created_at, topic_of) VALUES (2, 'Notes header', '2026-11-01 08:00:05', 1);
    INSERT INTO messages (room_id, sender, content, status, created_at) VALUES
      (2, 'user', 'Fix the notes header', 'done', '2026-11-01 08:00:05'),
      (2, 'engineer', 'Fixed: the header no longer overlaps.', 'done', '2026-11-01 08:10:00'),
      (2, 'engineer', '', 'pending', '2026-11-01 08:11:00'),
      (2, 'user', 'and the footer, from david', 'done', '2026-11-02 09:00:00');
    INSERT INTO decrees (peer, decree_id, room_id, source, issued_at, text, image_mime, image_state) VALUES
      ('mac', 1, 2, 'voice', '2026-11-01 08:00:00', 'Fix notes header (hive)', 'image/jpeg', 'ok'),
      ('', 7, 2, 'text', '2026-11-02 09:00:00', 'and the footer, from david', 'image/png', 'ok'),
      ('mac', 9, 1, 'voice', '2026-11-03 10:00:00', 'Still in the inbox', NULL, NULL),
      ('', 8, 1, 'voice', '2026-11-03 11:00:00', NULL, NULL, NULL);`);
  h.close();
  await writeFile(join(dir, "hive", "decree-images", "_-7.png"), PNG);
});

afterAll(() => removeTemp(dir));

const fresh = () => new OrdersStore(new Database(":memory:"), { dataDir: join(dir, `space-${crypto.randomUUID()}`) });
const opts = { dataDir: "/nowhere", spaceName: "mac" };
const fingerprint = async (path: string) => {
  const names = (await readdir(join(path, ".."))).sort();
  return Promise.all(names.map(async (n) => {
    const st = await stat(join(path, "..", n));
    return [n, st.mtimeMs, st.isFile() ? (await Bun.file(join(path, "..", n)).bytes()).length : "dir"].join(":");
  }));
};

describe("importing decree", () => {
  test("its orders become orders in one topic, with their pictures; a dry run writes nothing; a second run adds nothing", async () => {
    const store = fresh();
    const before = await fingerprint(decreeDb);
    const dry = await importOrders(store, { ...opts, kind: "decree", from: decreeDb, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, added: { topics: 1, orders: 3, pictures: 1, transcripts: 0 } });
    expect(store.topics()).toEqual([]);
    const r = await importOrders(store, { ...opts, kind: "decree", from: decreeDb });
    expect(r).toMatchObject({ added: { topics: 1, orders: 3, pictures: 1 }, matched: 0, unchanged: 0 });
    expect(r.skipped).toEqual([
      { item: "decree #3", reason: "no text" },
      { item: "decree #4's picture", reason: expect.stringContaining("4.png is not there") },
    ]);
    const topic = store.topicByImportKey(DECREES_TOPIC_KEY)!;
    expect(topic).toMatchObject({ title: "Imported decrees", sessionId: null, state: "done", archived: false, lastActiveAt: T0 + 180_000 });
    const orders = store.ofTopic(topic.id);
    expect(orders.map((o) => [o.text, o.via, o.createdAt, o.runId, o.routedBy])).toEqual([
      ["Fix the notes header", "voice", T0, IMPORTED_RUN, "import"],
      ["Look up the train times", "type", T0 + 60_000, IMPORTED_RUN, "import"],
      ["Picture went missing", "type", T0 + 180_000, IMPORTED_RUN, "import"],
    ]);
    expect(await Bun.file(orders[0]!.imagePath!).bytes()).toEqual(JPG);
    // Nothing waits: the service would dispatch nothing, sort nothing.
    expect(store.unsorted()).toEqual([]);
    expect(store.topicsWaiting()).toEqual([]);
    const again = await importOrders(store, { ...opts, kind: "decree", from: decreeDb });
    expect(again).toMatchObject({ added: { topics: 0, orders: 0, pictures: 0 }, matched: 0, unchanged: 3 });
    expect(store.ofTopic(topic.id).length).toBe(3);
    // The source was read from a copy: its files are as they were.
    expect(await fingerprint(decreeDb)).toEqual(before);
  });

  test("from decree's URL: the list and each picture through its API", async () => {
    const store = fresh();
    const calls: string[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (String(url).endsWith("/api/decrees/image")) return Response.json({ ok: true, id: 1, mime: "image/jpeg", data: Buffer.from(JPG).toString("base64") });
      return Response.json({ ok: true, decrees: [
        { id: 2, text: "Look up the train times", source: "text", createdAt: new Date(T0 + 60_000).toISOString(), image: null },
        { id: 1, text: "Fix the notes header", source: "voice", createdAt: new Date(T0).toISOString(), image: { mime: "image/jpeg", bytes: 7 } },
      ] });
    }) as typeof fetch;
    const r = await importOrders(store, { ...opts, kind: "decree", from: "http://127.0.0.1:9196/", fetch: f });
    expect(r).toMatchObject({ added: { topics: 1, orders: 2, pictures: 1 } });
    expect(calls).toEqual(["GET http://127.0.0.1:9196/api/decrees?limit=500", "POST http://127.0.0.1:9196/api/decrees/image"]);
    expect(store.ofTopic(store.topicByImportKey(DECREES_TOPIC_KEY)!.id).map((o) => o.text)).toEqual(["Fix the notes header", "Look up the train times"]);
  });

  test("refuses what is not decree's database, and a missing file", async () => {
    await expect(importOrders(fresh(), { ...opts, kind: "decree", from: hiveDb })).rejects.toThrow("not decree's database");
    await expect(importOrders(fresh(), { ...opts, kind: "decree", from: join(dir, "nope.db") })).rejects.toThrow("is not a file");
  });
});

describe("importing hive", () => {
  test("a topic room becomes a topic with its orders and its transcript; a decree in both apps is one order with hive's topic and decree's text and picture", async () => {
    const store = fresh();
    const hiveBefore = await fingerprint(hiveDb);
    const r = await importOrders(store, { ...opts, kind: "hive", from: hiveDb, hiveMachine: "david" });
    expect(r).toMatchObject({ added: { topics: 2, orders: 3, pictures: 1, transcripts: 1 }, matched: 0 });
    expect(r.skipped).toEqual([
      { item: "hive decree (hive's machine)#8", reason: "hive kept no text of it (import decree for its text)" },
      { item: "hive decree mac#1's picture", reason: expect.stringContaining("mac-1.jpg is not there") },
    ]);
    const topic = store.topicByImportKey("hive/2")!;
    expect(topic).toMatchObject({ title: "Notes header", sessionId: null, state: "done", archived: false, createdAt: Date.parse("2026-11-01T08:00:05Z"), lastActiveAt: Date.parse("2026-11-02T09:00:00Z"), summary: "Fixed: the header no longer overlaps." });
    expect(store.ofTopic(topic.id).map((o) => [o.text, o.clientId])).toEqual([["Fix notes header (hive)", "import:decree/mac/1"], ["and the footer, from david", "import:decree/david/7"]]);
    expect(await Bun.file(store.ofTopic(topic.id)[1]!.imagePath!).bytes()).toEqual(PNG);
    const tr = store.transcript(topic.id)!;
    expect(tr).toMatchObject({ source: "hive · Notes header", givenAt: null });
    expect(tr.lines.map((l) => [l.who, l.text])).toEqual([["person", "Fix the notes header"], ["engineer", "Fixed: the header no longer overlaps."], ["person", "and the footer, from david"]]);
    // The inbox decree: in the imported decrees' topic.
    expect(store.ofTopic(store.topicByImportKey(DECREES_TOPIC_KEY)!.id).map((o) => o.text)).toEqual(["Still in the inbox"]);
    // decree afterwards: its text and picture on the matched order, which stays in hive's topic.
    const d = await importOrders(store, { ...opts, kind: "decree", from: decreeDb });
    expect(d).toMatchObject({ added: { topics: 0, orders: 2, pictures: 1 }, matched: 1 });
    const one = store.orderByImportKey("decree/mac/1")!;
    expect(one).toMatchObject({ topicId: topic.id, text: "Fix the notes header" });
    expect(await Bun.file(one.imagePath!).bytes()).toEqual(JPG);
    // Both again: nothing added, nothing changed.
    expect(await importOrders(store, { ...opts, kind: "hive", from: hiveDb, hiveMachine: "david" })).toMatchObject({ added: { topics: 0, orders: 0, pictures: 0, transcripts: 0 }, matched: 0, unchanged: 3 });
    expect(await importOrders(store, { ...opts, kind: "decree", from: decreeDb })).toMatchObject({ added: { orders: 0 }, matched: 0, unchanged: 3 });
    expect(store.ofTopic(topic.id).length).toBe(2);
    expect(await fingerprint(hiveDb)).toEqual(hiveBefore);
  });

  test("decree first, then hive: the order moves into hive's topic and keeps decree's text and picture", async () => {
    const store = fresh();
    await importOrders(store, { ...opts, kind: "decree", from: decreeDb });
    const before = store.orderByImportKey("decree/mac/1")!;
    const r = await importOrders(store, { ...opts, kind: "hive", from: hiveDb, hiveMachine: "david" });
    expect(r).toMatchObject({ added: { topics: 1, orders: 2 }, matched: 1 });
    const after = store.orderByImportKey("decree/mac/1")!;
    expect(after).toMatchObject({ id: before.id, topicId: store.topicByImportKey("hive/2")!.id, text: "Fix the notes header", imagePath: before.imagePath });
  });

  test("without --hive-machine, hive's own decrees are skipped with the reason; a URL is refused", async () => {
    const r = await importOrders(fresh(), { ...opts, kind: "hive", from: hiveDb });
    expect(r.skipped.filter((s) => s.reason.includes("--hive-machine")).length).toBe(2);
    await expect(importOrders(fresh(), { ...opts, kind: "hive", from: "http://david:8915" })).rejects.toThrow("copy of its db file");
    await expect(importOrders(fresh(), { ...opts, kind: "hive" })).rejects.toThrow("--from");
  });
});

describe("the transcript for the first new turn", () => {
  test("keeps the newest messages within the limit and says how many it left out", () => {
    const lines = Array.from({ length: 50 }, (_, i) => ({ at: i, who: i % 2 ? "engineer" : "person", text: `message ${i} ${"x".repeat(200)}` }));
    const p = transcriptPrompt("hive · Notes", lines, 2_000);
    expect(p.length).toBeLessThan(2_400);
    expect(p).toContain("message 49");
    expect(p).not.toContain("message 10 ");
    expect(p).toMatch(/the \d+ oldest messages are left out/);
  });
});
