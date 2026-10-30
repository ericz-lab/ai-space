import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusStore } from "../bus/store.ts";
import { ChatStore } from "../chat/store.ts";
import { FeedbackStore } from "../feedback/store.ts";
import { ModelStore } from "../model/store.ts";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { Store } from "../scheduler/store.ts";
import { ShortcutStore } from "../shortcuts/store.ts";
import { UsageStore } from "../usage/store.ts";
import { createPeerRoutes } from "./api.ts";
import { loadPeers } from "./config.ts";
import { PeerHub } from "./hub.ts";
import { checkRename, renameEnvText, renamePeer, renamePeerData, RenameError, type PeerRenamed } from "./rename.ts";
import { PeerStore } from "./store.ts";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tempDir = async () => {
  const d = await mkdtemp(join(tmpdir(), "peer-rename-"));
  dirs.push(d);
  return d;
};

/** A space.db with every store's tables, as boot opens it. */
async function spaceDb() {
  const path = join(await tempDir(), "space.db");
  const store = new Store(path);
  for (const S of [ModelStore, BusStore, ShortcutStore, ChatStore]) new S(path);
  const db = store.db;
  new PeerStore(db);
  new LayoutStore(db);
  new FeedbackStore(db);
  new UsageStore(db);
  db.exec("CREATE TABLE IF NOT EXISTS model_overrides (app TEXT NOT NULL, tag TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (app, tag))");
  db.exec("CREATE TABLE IF NOT EXISTS model_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  return { path, db, store };
}

describe("peer rename: .env", () => {
  test("renames the peer's lines in place and the model values that name it", () => {
    const text = [
      "# peers",
      "SPACE_PEER_OLD-BOX=x", // not a key; left alone
      "SPACE_PEER_BOX=https://box.example.com",
      "export SPACE_PEER_BOX_TOKEN=secret",
      'SPACE_PEER_BOX_HEADERS="A: b"',
      "SPACE_PEER_BOX_REFRESH=1m",
      "SPACE_PEER_BOXER=https://boxer.example.com",
      "SPACE_PEER_MODEL=codex",
      "SPACE_CHAT_MODEL=box:codex/basic",
      'SPACE_MODEL_DEFAULT="boxer:codex/basic"',
      "",
    ].join("\n");
    expect(renameEnvText(text, "box", "work-box")).toBe(
      [
        "# peers",
        "SPACE_PEER_OLD-BOX=x",
        "SPACE_PEER_WORK_BOX=https://box.example.com",
        "export SPACE_PEER_WORK_BOX_TOKEN=secret",
        'SPACE_PEER_WORK_BOX_HEADERS="A: b"',
        "SPACE_PEER_WORK_BOX_REFRESH=1m",
        "SPACE_PEER_BOXER=https://boxer.example.com",
        "SPACE_PEER_MODEL=codex",
        "SPACE_CHAT_MODEL=work-box:codex/basic",
        'SPACE_MODEL_DEFAULT="boxer:codex/basic"',
        "",
      ].join("\n"),
    );
  });

  test("checks the names before anything changes", () => {
    const peers = ["box", "lab"];
    expect(() => checkRename("nope", "x", peers)).toThrow(RenameError);
    expect(() => checkRename("box", "box", peers)).toThrow("the old one");
    expect(() => checkRename("box", "lab", peers)).toThrow("already exists");
    expect(() => checkRename("box", "Bad_Name", peers)).toThrow("invalid peer name");
    expect(() => checkRename("box", "a.b", peers)).toThrow("invalid peer name");
    expect(() => checkRename("box", "model", peers)).toThrow("SPACE_PEER_MODEL");
    expect(() => checkRename("box", "media", peers, (n) => n === "media")).toThrow("local app");
    expect(() => checkRename("box", "work-box", peers)).not.toThrow();
  });
});

describe("peer rename: data", () => {
  test("moves every row the hub keys by the peer's name, and nothing else", async () => {
    const { db } = await spaceDb();
    const peers = new PeerStore(db);
    peers.set("box", { name: "box-host", id: "space-1", apps: [], services: [], widgets: [], agents: [], terminal: false, capabilities: [], asOf: "2026-10-29T00:00:00.000Z" });
    peers.setCursor("box", 42);
    peers.setCursor("work-box", 7); // a leftover under the new name loses
    peers.setCursor("lab", 3);
    new LayoutStore(db).update({ hidden: ["box/media", "boxer/media", "notes"], order: { apps: ["box/media", "notes"], agents: ["box/media/helper"], widgets: [] }, sizes: { "box/media/clips": "2x1" }, screens: [{ id: "home", name: "Home", items: ["app:box/media", "builtin:settings", "app:notes"] }] });
    const call = (app: string, machine: string | null, backend: string, origin: string) =>
      db.query("INSERT INTO model_calls (app, tag, model, machine, backend, origin, status, started_at, duration_ms, prompt_chars) VALUES (?, '', 'm', ?, ?, ?, 'ok', 0, 0, 0)").run(app, machine, backend, origin);
    call("notes", "box", "peer:box", "app");
    call("box/pulse", null, "claude-code", "peer");
    call("boxer/pulse", null, "claude-code", "peer");
    db.query("INSERT INTO model_overrides (app, tag, model) VALUES ('notes', '', 'box:codex/basic'), ('pulse', '', 'boxer:codex/basic')").run();
    db.query("INSERT INTO model_preferences (key, value) VALUES ('default', 'box:claude/deep')").run();
    db.query("INSERT INTO chat_model_choices (app, model, updated_at) VALUES ('notes', 'box:codex/basic', 0)").run();
    db.query("INSERT INTO events (name, app, data, at, peer) VALUES ('pulse/x', 'pulse', '{}', 0, 'box'), ('pulse/y', 'pulse', '{}', 0, NULL)").run();
    db.query("INSERT INTO bus_calls (caller, app, capability, status, ok, duration_ms, at) VALUES ('notes', 'box/insight', 'research', 200, 1, 1, 0), ('box/pulse', 'insight', 'research', 200, 1, 1, 0)").run();
    db.query("INSERT INTO shortcut_patterns (action, peer, patterns) VALUES ('add', 'box', '[]'), ('add', '', '[]')").run();
    db.query("INSERT INTO feedback (app, text, context, client, status, todo_peer, run_machine, fix_machine, created_at, updated_at) VALUES ('notes', 't', '{}', 'web', 'new', 'box', 'box', 'box', 0, 0)").run();
    db.query("INSERT INTO feedback_settings (key, value) VALUES ('settings', ?)").run(JSON.stringify({ enabled: true, machine: "box" }));
    db.query("INSERT INTO usage_opens (kind, key, source, at) VALUES ('app', 'box/media', 'tile', 0), ('app', 'notes', 'tile', 0)").run();

    const moved = renamePeerData(db, "box", "work-box");

    expect(moved).toMatchObject({ snapshots: 1, cursors: 1, events: 1, "model ledger": 3, "model choices": 3, "bus calls": 2, shortcuts: 1, feedback: 4, usage: 1 });
    expect(moved.layout).toBe(5);
    const after = new PeerStore(db);
    expect(after.get("box")).toBeUndefined();
    expect(after.get("work-box")?.id).toBe("space-1");
    expect(after.cursor("work-box")).toBe(42);
    expect(after.cursor("lab")).toBe(3);
    const layout = new LayoutStore(db).read();
    expect(layout.hidden).toEqual(["work-box/media", "boxer/media", "notes"]);
    expect(layout.order.agents).toEqual(["work-box/media/helper"]);
    expect(layout.sizes).toEqual({ "work-box/media/clips": "2x1" });
    expect(layout.screens?.[0]?.items).toEqual(["app:work-box/media", "builtin:settings", "app:notes"]);
    expect(db.query("SELECT app, machine, backend FROM model_calls ORDER BY id").all()).toEqual([
      { app: "notes", machine: "work-box", backend: "peer:work-box" },
      { app: "work-box/pulse", machine: null, backend: "claude-code" },
      { app: "boxer/pulse", machine: null, backend: "claude-code" },
    ]);
    expect(db.query("SELECT model FROM model_overrides ORDER BY app").all()).toEqual([{ model: "work-box:codex/basic" }, { model: "boxer:codex/basic" }]);
    expect(db.query("SELECT value FROM model_preferences").get()).toEqual({ value: "work-box:claude/deep" });
    expect(db.query("SELECT peer FROM events ORDER BY id").all()).toEqual([{ peer: "work-box" }, { peer: null }]);
    expect(db.query("SELECT caller, app FROM bus_calls ORDER BY id").all()).toEqual([{ caller: "notes", app: "work-box/insight" }, { caller: "work-box/pulse", app: "insight" }]);
    expect(new FeedbackStore(db).settings().machine).toBe("work-box");
    expect(db.query("SELECT key FROM usage_opens ORDER BY id").all()).toEqual([{ key: "work-box/media" }, { key: "notes" }]);
  });

  test("a failure inside the transaction moves nothing", async () => {
    const { db } = await spaceDb();
    new PeerStore(db).setCursor("box", 5);
    expect(() =>
      renamePeerData(db, "box", "work-box", () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    expect(new PeerStore(db).cursor("box")).toBe(5);
  });
});

describe("peer rename: on a running hub", () => {
  test("rewrites .env, swaps the client, keeps the snapshot, publishes peer.renamed, shows the id in /api/peers", async () => {
    const { db, path } = await spaceDb();
    const envFile = join(await tempDir(), ".env");
    await writeFile(envFile, "SPACE_NAME=hub\nSPACE_PEER_BOX=https://box.example.com\nSPACE_PEER_BOX_TOKEN=t\n");
    const env: Record<string, string | undefined> = { SPACE_PEER_BOX: "https://box.example.com", SPACE_PEER_BOX_TOKEN: "t" };
    const seen: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push(`${url} ${(init?.headers as Record<string, string>)?.authorization ?? ""}`);
      if (url.endsWith("/api/peer/snapshot")) return Response.json({ ok: true, name: "box-host", id: "space-1", apps: [], services: [], widgets: [], agents: [] });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const hub = new PeerHub(loadPeers(env).peers, { store: new PeerStore(db), fetch: fakeFetch });
    await hub.refreshAll();
    const routes = createPeerRoutes({ hub, layout: new LayoutStore(db), registry: new AppRegistry(), rename: (from, to) => renamePeer({ hub, db, envFile, env, publish: (e) => published.push(e) }, from, to) }) as unknown as Record<string, Record<string, (req: Request & { params: Record<string, string> }) => Promise<Response>>>;
    const published: PeerRenamed[] = [];
    const list = async () => (await (await routes["/api/peers"]!.GET!(Object.assign(new Request("http://x/api/peers"), { params: {} }))).json()) as { peers: { name: string; id?: string }[] };
    expect((await list()).peers).toMatchObject([{ name: "box", id: "space-1" }]);

    const post = (peer: string, body: unknown) => routes["/api/peers/:peer/rename"]!.POST!(Object.assign(new Request("http://x", { method: "POST", body: JSON.stringify(body) }), { params: { peer } }));
    expect((await post("nope", { to: "x" })).status).toBe(404);
    expect((await post("box", { to: "Bad Name" })).status).toBe(400);

    const r = await post("box", { to: "work-box" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, from: "box", to: "work-box", id: "space-1", moved: { snapshots: 1 } });
    expect(published).toEqual([{ from: "box", to: "work-box", id: "space-1" }]);
    expect(await readFile(envFile, "utf8")).toBe("SPACE_NAME=hub\nSPACE_PEER_WORK_BOX=https://box.example.com\nSPACE_PEER_WORK_BOX_TOKEN=t\n");
    expect(env).toEqual({ SPACE_PEER_WORK_BOX: "https://box.example.com", SPACE_PEER_WORK_BOX_TOKEN: "t" });
    expect(hub.names()).toEqual(["work-box"]);
    // The new client starts from the moved snapshot and keeps the token.
    expect(hub.get("work-box")?.snapshot?.id).toBe("space-1");
    expect((await list()).peers).toMatchObject([{ name: "work-box", id: "space-1" }]);
    await hub.refreshAll();
    expect(seen.at(-1)).toBe("https://box.example.com/api/peer/snapshot Bearer t");
    // A restart reads the same: the .env names the peer work-box and its rows are there.
    const reloaded = new PeerHub(loadPeers({ SPACE_PEER_WORK_BOX: "https://box.example.com" }).peers, { store: new PeerStore(new Database(path)) });
    expect(reloaded.get("work-box")?.snapshot?.id).toBe("space-1");
  });

  test("a peer set outside the workspace .env is refused and nothing moves", async () => {
    const { db } = await spaceDb();
    const envFile = join(await tempDir(), ".env");
    await writeFile(envFile, "SPACE_NAME=hub\n");
    const hub = new PeerHub(loadPeers({ SPACE_PEER_BOX: "https://box.example.com" }).peers, { store: new PeerStore(db) });
    new PeerStore(db).setCursor("box", 9);
    await expect(renamePeer({ hub, db, envFile }, "box", "work-box")).rejects.toThrow("is not in");
    expect(hub.names()).toEqual(["box"]);
    expect(new PeerStore(db).cursor("box")).toBe(9);
  });
});
