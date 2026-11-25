import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { terminalWebSocket } from "../terminal/api.ts";
import { rejection } from "../testing.ts";
import { Connections } from "./connections.ts";
import { PackageLinks, createConnectionRoutes } from "./links.ts";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const f of cleanups.splice(0).reverse()) f(); });
function store() { const db = new Database(":memory:"); cleanups.push(() => db.close()); return new Connections(db, crypto.randomUUID()); }

test("local grants default closed, credentials bind remote identity and patches are atomic", () => {
  const hub = store(), peer = store();
  const { connection, token } = hub.create({ remoteSpaceId: peer.spaceId, direction: "incoming", apps: ["notes"] });
  expect(hub.authenticate(token!, peer.spaceId)?.id).toBe(connection.id);
  expect(hub.authenticate(token!, crypto.randomUUID())).toBeUndefined();
  const reverse = peer.create({ remoteSpaceId: hub.spaceId, direction: "outgoing", url: "https://hub.example", tokenEnv: "HUB_ACCESS" }).connection;
  expect(peer.allows(reverse.id, "notes")).toBe(false);
  peer.update(reverse.id, { apps: ["notes"] });
  expect(peer.allows(reverse.id, "notes")).toBe(true);
  expect(() => peer.update(reverse.id, { apps: ["secret"], enabled: "yes" })).toThrow();
  expect(peer.allows(reverse.id, "notes")).toBe(true);
  expect(() => peer.update(reverse.id, { apps: ["other-peer/notes"] })).toThrow();
  const next = hub.rotate(connection.id);
  expect(hub.authenticate(token!, peer.spaceId)).toBeUndefined();
  expect(hub.authenticate(next, peer.spaceId)?.id).toBe(connection.id);
  expect(JSON.stringify(hub.list())).not.toContain(next);
  expect(() => peer.create({ remoteSpaceId: crypto.randomUUID(), direction: "outgoing", url: "http://public.example", tokenEnv: "TOKEN" })).toThrow(/HTTPS/);
});

test("a removed connection loses its credential and grants and can be created again", () => {
  const hub = store(), peer = store();
  const first = hub.create({ remoteSpaceId: peer.spaceId, direction: "incoming", apps: ["notes"] });
  expect(() => hub.create({ remoteSpaceId: peer.spaceId, direction: "incoming" })).toThrow();
  const seen: string[] = []; hub.onChange((id) => seen.push(id));
  expect(hub.remove(first.connection.id).id).toBe(first.connection.id);
  expect(seen).toEqual([first.connection.id]);
  expect(hub.authenticate(first.token!, peer.spaceId)).toBeUndefined();
  expect(hub.allows(first.connection.id, "notes")).toBe(false);
  expect(() => hub.remove(first.connection.id)).toThrow(/not found/);
  const second = hub.create({ remoteSpaceId: peer.spaceId, direction: "incoming" });
  expect(second.connection.apps).toEqual([]);
  expect(hub.authenticate(second.token!, peer.spaceId)?.id).toBe(second.connection.id);
});

test("one outbound peer connection carries both directions; reverse grants are enforced and revocable", async () => {
  const hubStore = store(), peerStore = store();
  const incoming = hubStore.create({ remoteSpaceId: peerStore.spaceId, direction: "incoming", apps: ["hub-app"] });
  const hub = new PackageLinks(hubStore, { env: {}, apps: () => [{ app: "hub-app", title: "Hub", version: "1.0.0" }], handle: async () => new Response("hub content") });
  cleanups.push(() => hub.close());
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: createConnectionRoutes({ links: hub, token: "operator" }), websocket: terminalWebSocket, fetch: () => new Response("missing", { status: 404 }) });
  cleanups.push(() => server.stop(true));
  const outgoing = peerStore.create({ remoteSpaceId: hubStore.spaceId, direction: "outgoing", url: server.url.origin, tokenEnv: "HUB_ACCESS" }).connection;
  let streamAborted = false;
  let otherAborted = false;
  // A stream that keeps delivering: a chunk every 10 ms until it is cancelled.
  const ticking = (signal: AbortSignal, onAbort: () => void) => {
    signal.addEventListener("abort", onAbort);
    let timer: ReturnType<typeof setInterval>;
    return new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("event")); timer = setInterval(() => { try { c.enqueue(new TextEncoder().encode(".")); } catch { clearInterval(timer); } }, 10); },
      cancel() { clearInterval(timer); },
    }));
  };
  const peer = new PackageLinks(peerStore, { env: { HUB_ACCESS: incoming.token }, apps: () => [{ app: "peer-app", title: "Peer", version: "1.0.0" }, { app: "peer-other", title: "Other", version: "1.0.0" }], handle: async (_c, meta, _body, signal) => {
    if ((meta as { path: string }).path === "/stream") return ticking(signal, () => { if ((meta as { app: string }).app === "peer-app") streamAborted = true; else otherAborted = true; });
    return new Response("peer content");
  } });
  cleanups.push(() => peer.close());
  peer.refresh();
  const connected = async () => {
    for (let i = 0; i < 100; i++) { if (peer.status()[0]?.connected && hub.status()[0]?.connected) return; await Bun.sleep(10); }
    throw new Error("connection did not establish");
  };
  await connected();
  expect(await (await peer.request(outgoing.id, { operation: "fetch", app: "hub-app", path: "/" })).text()).toBe("hub content");
  expect((await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-app", path: "/" })).status).toBe(403);
  expect((await (await hub.request(incoming.connection.id, { operation: "catalogue" })).json() as { apps: unknown[] }).apps).toEqual([]);
  peerStore.update(outgoing.id, { apps: ["peer-app"] });
  await connected();
  expect(await (await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-app", path: "/" })).text()).toBe("peer content");
  expect((await peer.request(outgoing.id, { operation: "install", app: "hub-app" })).status).toBe(403);
  // Adding an app closes nothing: the stream opened before keeps flowing on the same channel.
  const streaming = await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-app", path: "/stream" });
  const reader = streaming.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event");
  const channel = (peer as unknown as { live: Map<string, { channel?: unknown }> }).live.get(outgoing.id)!.channel;
  peerStore.update(outgoing.id, { apps: ["peer-app", "peer-other"] });
  expect((await reader.read()).value).toBeDefined();
  const other = (await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-other", path: "/stream" })).body!.getReader();
  expect(new TextDecoder().decode((await other.read()).value)).toBe("event");
  // Removing one app ends only its streams; the channel and the other app's stream stay up.
  // (`rejection`, not `expect().rejects`: this code runs inside the hub socket's callback; testing.ts says why.)
  peerStore.update(outgoing.id, { apps: ["peer-other"] });
  const drained = async () => { for (;;) { const r = await reader.read(); if (r.done) return "ended"; } };
  expect((await rejection(drained()))?.message).toMatch(/cancelled/);
  expect(streamAborted).toBe(true);
  expect(otherAborted).toBe(false);
  expect((await other.read()).done).toBe(false);
  expect((peer as unknown as { live: Map<string, { channel?: unknown }> }).live.get(outgoing.id)!.channel).toBe(channel);
  expect(peer.status()[0]?.connected).toBe(true);
  // New requests to the revoked app are refused at once, without a reconnect.
  expect((await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-app", path: "/" })).status).toBe(403);
  expect((await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-other", path: "/" })).status).toBe(200);
  await other.cancel();
  for (let i = 0; i < 100 && !otherAborted; i++) await Bun.sleep(5);
  otherAborted = false;
  // Disabling still closes the whole channel and every stream on it.
  const last = (await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-other", path: "/stream" })).body!.getReader();
  await last.read();
  peerStore.update(outgoing.id, { enabled: false });
  const rest = async () => { for (;;) { const r = await last.read(); if (r.done) return "ended"; } };
  expect(await rejection(rest())).toBeInstanceOf(Error);
  expect(otherAborted).toBe(true);
  expect(peer.status()[0]?.connected).toBe(false);
});

test("a grant change reports which apps it took away; enabling and disabling reset", () => {
  const hub = store(), peer = store();
  const { connection } = hub.create({ remoteSpaceId: peer.spaceId, direction: "incoming", apps: ["a", "b"] });
  const seen: unknown[] = []; hub.onChange((_id, change) => seen.push(change));
  hub.update(connection.id, { apps: ["a", "b", "c"] });
  hub.update(connection.id, { apps: ["c"] });
  hub.update(connection.id, { enabled: false });
  hub.update(connection.id, { enabled: false, apps: [] });
  hub.rotate(connection.id);
  hub.remove(connection.id);
  expect(seen).toEqual([{ kind: "grants", revoked: [], revokedScopes: [] }, { kind: "grants", revoked: ["a", "b"], revokedScopes: [] }, { kind: "reset" }, { kind: "grants", revoked: ["c"], revokedScopes: [] }, { kind: "reset" }, { kind: "reset" }]);
});

test("Spaces of different channel protocols refuse each other with an error naming the upgrade", async () => {
  // A Space of this version accepting a dialer that sends no protocol (an older ai-space): 426, said on the connection.
  const hubStore = store(), oldPeer = crypto.randomUUID();
  const incoming = hubStore.create({ remoteSpaceId: oldPeer, direction: "incoming" });
  const hub = new PackageLinks(hubStore, { env: {}, apps: () => [] });
  cleanups.push(() => hub.close());
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: createConnectionRoutes({ links: hub, token: "operator" }), websocket: terminalWebSocket, fetch: () => new Response("missing", { status: 404 }) });
  cleanups.push(() => server.stop(true));
  const refused = await fetch(`${server.url.origin}/api/connections/channel`, { headers: { authorization: `Bearer ${incoming.token}`, "x-space-id": oldPeer, upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  expect(refused.status).toBe(426);
  expect((await refused.json() as { error: string }).error).toMatch(/older ai-space.*upgrade it/);
  expect(hub.status()[0]?.error).toMatch(/older ai-space/);
  expect(hub.status()[0]?.connected).toBe(false);

  // A Space of this version dialing one whose hello says protocol 1: no channel, and the reason on the connection.
  const oldHub = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("no", { status: 400 })), websocket: { open: (ws) => void ws.send(JSON.stringify({ kind: "hello", spaceId: hubStore.spaceId, protocol: 1 })), message: () => {} } });
  cleanups.push(() => oldHub.stop(true));
  const peerStore = store();
  peerStore.create({ remoteSpaceId: hubStore.spaceId, direction: "outgoing", url: oldHub.url.origin, tokenEnv: "HUB_ACCESS" });
  const peer = new PackageLinks(peerStore, { env: { HUB_ACCESS: "token" }, apps: () => [] });
  cleanups.push(() => peer.close());
  peer.refresh();
  for (let i = 0; i < 100 && !peer.status()[0]?.error; i++) await Bun.sleep(10);
  expect(peer.status()[0]?.error).toMatch(/channel protocol 1, this one 2: upgrade both Spaces/);
  expect(peer.status()[0]?.connected).toBe(false);
});

test("scopes, full trust and the alias default to nothing, are validated strictly and say what a change took away", () => {
  const hub = store(), peer = store();
  const { connection } = hub.create({ remoteSpaceId: peer.spaceId, direction: "incoming" });
  expect(connection).toMatchObject({ scopes: [], fullTrust: false, alias: null, remoteName: null });
  expect(hub.allowsScope(connection.id, "panel")).toBe(false);
  for (const bad of [{ scopes: ["admin"] }, { scopes: "panel" }, { scopes: ["panel", "panel"] }, { fullTrust: "yes" }, { alias: "Bad Name" }, { alias: "a/b" }, { alias: "" }]) expect(() => hub.update(connection.id, bad)).toThrow();
  expect(() => hub.create({ remoteSpaceId: crypto.randomUUID(), direction: "incoming", scopes: ["root"] })).toThrow(/unknown scope/);
  const seen: unknown[] = []; hub.onChange((_id, c) => seen.push(c));
  hub.update(connection.id, { scopes: ["terminal", "panel", "agents"] });
  expect(hub.get(connection.id)!.scopes).toEqual(["panel", "agents", "terminal"]);
  hub.update(connection.id, { scopes: ["panel"] });
  hub.update(connection.id, { fullTrust: true });
  expect(hub.allowsScope(connection.id, "manage")).toBe(true);
  hub.update(connection.id, { fullTrust: false });
  hub.update(connection.id, { alias: "office" });
  hub.update(connection.id, { alias: null });
  hub.setRemoteName(connection.id, "Box");
  hub.setRemoteName(connection.id, "box"); // the same name: no change
  expect(hub.get(connection.id)!.remoteName).toBe("box");
  expect(seen).toEqual([
    { kind: "grants", revoked: [], revokedScopes: [] },
    { kind: "grants", revoked: [], revokedScopes: ["agents", "terminal"] },
    { kind: "grants", revoked: [], revokedScopes: [] },
    { kind: "grants", revoked: [], revokedScopes: ["agents", "events", "model", "tasks", "terminal", "apps", "manage"] },
    { kind: "label" }, { kind: "label" }, { kind: "label" },
  ]);
  // A disabled connection grants no scope, whatever it holds.
  hub.update(connection.id, { fullTrust: true, enabled: false });
  expect(hub.allowsScope(connection.id, "panel")).toBe(false);
});

test("a connection table from before scopes gets them with nothing granted", () => {
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  db.exec("CREATE TABLE package_connections (id TEXT PRIMARY KEY, remoteSpaceId TEXT NOT NULL UNIQUE, direction TEXT NOT NULL, url TEXT, tokenEnv TEXT, token_hash TEXT, apps TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1)");
  db.query("INSERT INTO package_connections(id, remoteSpaceId, direction, apps) VALUES (?, ?, 'incoming', '[\"notes\"]')").run("c1", crypto.randomUUID());
  const c = new Connections(db, crypto.randomUUID());
  expect(c.get("c1")).toMatchObject({ apps: ["notes"], scopes: [], fullTrust: false, alias: null, remoteName: null });
  expect(new Connections(db, crypto.randomUUID()).list()).toHaveLength(1);
});

test("an outgoing connection sends an access layer's headers from its variable, and cannot replace its own", async () => {
  const hubStore = store(), peerStore = store();
  const incoming = hubStore.create({ remoteSpaceId: peerStore.spaceId, direction: "incoming" });
  expect(() => hubStore.create({ remoteSpaceId: crypto.randomUUID(), direction: "incoming", headersEnv: "X" })).toThrow(/headersEnv/);
  expect(() => peerStore.create({ remoteSpaceId: crypto.randomUUID(), direction: "outgoing", url: "https://hub.example", tokenEnv: "T", headersEnv: "lower" })).toThrow(/environment variable/);
  const hub = new PackageLinks(hubStore, { env: {}, apps: () => [] });
  cleanups.push(() => hub.close());
  const routes = createConnectionRoutes({ links: hub, token: "operator" });
  const seen: Record<string, string | null>[] = [];
  // An access layer in front of the hub: the channel's upgrade only with its service token.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket: terminalWebSocket, fetch: () => new Response("missing", { status: 404 }), routes: {
    "/api/connections/channel": (req: Request, srv: unknown) => {
      seen.push({ id: req.headers.get("cf-access-client-id"), secret: req.headers.get("cf-access-client-secret"), space: req.headers.get("x-space-id") });
      if (req.headers.get("cf-access-client-secret") !== "s3cret") return new Response("forbidden by the access layer", { status: 403 });
      return (routes["/api/connections/channel"]!.GET as (r: Request, s: unknown) => Response | undefined)(req, srv);
    },
  } as never });
  cleanups.push(() => server.stop(true));
  const env: Record<string, string | undefined> = { HUB_ACCESS: incoming.token, HUB_HEADERS: "CF-Access-Client-Id: abc.access; CF-Access-Client-Secret: s3cret; X-Space-Id: forged" };
  const outgoing = peerStore.create({ remoteSpaceId: hubStore.spaceId, direction: "outgoing", url: server.url.origin, tokenEnv: "HUB_ACCESS", headersEnv: "HUB_HEADERS" }).connection;
  expect(outgoing.headersEnv).toBe("HUB_HEADERS");
  const peer = new PackageLinks(peerStore, { env, apps: () => [] });
  cleanups.push(() => peer.close());
  for (let i = 0; i < 200 && !hub.status()[0]?.connected; i++) { peer.refresh(); await Bun.sleep(10); }
  expect(hub.status()[0]?.connected).toBe(true);
  expect(seen[0]).toEqual({ id: "abc.access", secret: "s3cret", space: peerStore.spaceId });
  // Without the variable the connection says so instead of dialing.
  const other = store();
  const lone = other.create({ remoteSpaceId: hubStore.spaceId, direction: "outgoing", url: server.url.origin, tokenEnv: "HUB_ACCESS", headersEnv: "MISSING" }).connection;
  const links = new PackageLinks(other, { env: { HUB_ACCESS: "x" }, apps: () => [] });
  cleanups.push(() => links.close());
  links.refresh();
  expect(links.status().find((s) => s.id === lone.id)?.error).toContain("MISSING");
});

/** A TCP server that takes connections and answers nothing, or (with `hello`) completes the upgrade, sends that one frame and then goes silent: no pongs, no close. */
function silentServer(hello?: string) {
  let opened = 0;
  const server = Bun.listen<{ upgraded: boolean }>({ hostname: "127.0.0.1", port: 0, socket: {
    open: (s) => { opened++; s.data = { upgraded: false }; },
    data: (s, chunk) => {
      if (!hello || s.data.upgraded) return;
      const key = /sec-websocket-key: *(\S+)/i.exec(chunk.toString())?.[1];
      if (!key) return;
      s.data.upgraded = true;
      const accept = new Bun.CryptoHasher("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      const payload = Buffer.from(hello);
      s.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      s.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
    },
  } });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, opened: () => opened };
}

test("a dial the other Space never answers is given up and dialed again", async () => {
  const peerStore = store(), hubId = crypto.randomUUID();
  const hub = silentServer();
  peerStore.create({ remoteSpaceId: hubId, direction: "outgoing", url: hub.url, tokenEnv: "HUB_ACCESS" });
  const peer = new PackageLinks(peerStore, { env: { HUB_ACCESS: "token" }, apps: () => [], handshakeMs: 50 });
  cleanups.push(() => peer.close());
  peer.refresh();
  for (let i = 0; i < 100 && !peer.status()[0]?.error; i++) await Bun.sleep(10);
  expect(peer.status()[0]?.error).toMatch(/did not answer/);
  expect(peer.status()[0]?.connected).toBe(false);
  peer.refresh();
  for (let i = 0; i < 100 && hub.opened() < 2; i++) await Bun.sleep(10);
  expect(hub.opened()).toBe(2);
});

test("an open channel that stops answering pings is dropped and dialed again", async () => {
  const peerStore = store(), hubId = crypto.randomUUID();
  const hub = silentServer(JSON.stringify({ kind: "hello", spaceId: hubId, protocol: 2 }));
  peerStore.create({ remoteSpaceId: hubId, direction: "outgoing", url: hub.url, tokenEnv: "HUB_ACCESS" });
  const peer = new PackageLinks(peerStore, { env: { HUB_ACCESS: "token" }, apps: () => [], heartbeatMs: 30 });
  cleanups.push(() => peer.close());
  peer.refresh();
  for (let i = 0; i < 100 && !peer.status()[0]?.connected; i++) await Bun.sleep(5);
  expect(peer.status()[0]?.connected).toBe(true);
  for (let i = 0; i < 100 && !peer.status()[0]?.error; i++) await Bun.sleep(10);
  expect(peer.status()[0]?.error).toMatch(/stopped answering/);
  expect(peer.status()[0]?.connected).toBe(false);
  peer.refresh();
  for (let i = 0; i < 100 && hub.opened() < 2; i++) await Bun.sleep(10);
  expect(hub.opened()).toBe(2);
});
