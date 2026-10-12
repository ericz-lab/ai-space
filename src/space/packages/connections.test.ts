import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { terminalWebSocket } from "../terminal/api.ts";
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
  const peer = new PackageLinks(peerStore, { env: { HUB_ACCESS: incoming.token }, apps: () => [{ app: "peer-app", title: "Peer", version: "1.0.0" }], handle: async (_c, meta, _body, signal) => {
    if ((meta as { path: string }).path === "/stream") {
      signal.addEventListener("abort", () => { streamAborted = true; });
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("event")); } }));
    }
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
  const streaming = await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-app", path: "/stream" });
  const reader = streaming.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("event");
  peerStore.update(outgoing.id, { apps: [] });
  await expect(reader.read()).rejects.toThrow(/closed/);
  expect(streamAborted).toBe(true);
  await connected();
  expect((await hub.request(incoming.connection.id, { operation: "fetch", app: "peer-app", path: "/" })).status).toBe(403);
});
