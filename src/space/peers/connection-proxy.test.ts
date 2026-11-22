import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalWebSocket } from "../terminal/api.ts";
import { rejection } from "../testing.ts";
import { RemoteCatalogue, sourceSharedApps } from "../packages/catalogue.ts";
import type { Manifest } from "../scheduler/manifest.ts";
import { Connections } from "../packages/connections.ts";
import { PackageGateway } from "../packages/gateway.ts";
import { PackageLinks, createConnectionRoutes } from "../packages/links.ts";
import { parsePackageManifest } from "../packages/manifest.ts";
import { PackageRuntime } from "../packages/runtime.ts";
import { createPeerRoutes } from "./api.ts";

// The hub's app proxy (`/api/peers/<peer>/apps/<app>/proxy/*`) reaching an app a package connection shares.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

const APP_SOURCE = `
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT),
  fetch(req, server) {
    const u = new URL(req.url);
    if (u.pathname === "/healthz") return new Response("ok");
    if (u.pathname === "/api/live") { if (server.upgrade(req)) return; return new Response("failed", { status: 400 }); }
    return Response.json({ app: process.env.APP, path: u.pathname + u.search, method: req.method, authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie") });
  }, websocket: { message(ws, m) { ws.send("echo:" + m); } } });`;

/** A Space with process packages `apps` (and spec-1 `source` apps), a connection store, links named `name` and the package gateway. */
async function space(name: string, apps: string[], source: Manifest[] = []) {
  const dir = await mkdtemp(join(tmpdir(), "space-conn-proxy-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  const connections = new Connections(db, crypto.randomUUID());
  const runtime = new PackageRuntime({ logDir: join(dir, "logs"), envFor: async (app) => ({ APP: app }), startTimeoutMs: 3000 });
  cleanups.push(() => runtime.close(0));
  for (const app of apps) {
    const appDir = join(dir, app);
    await Bun.write(join(appDir, "app.ts"), APP_SOURCE);
    const manifest = parsePackageManifest(`spec: 2\nname: ${app}\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz, idleTimeoutMs: 1000 }\n`);
    await runtime.register({ manifest, dir: appDir, index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] } });
  }
  let gateway: PackageGateway;
  const env: Record<string, string | undefined> = {};
  const links = new PackageLinks(connections, { env, name, apps: () => [...apps.map((app) => ({ app, title: app, version: "1.0.0" })), ...sourceSharedApps(source, (a) => apps.includes(a))], handle: (_c, meta, body, signal) => gateway.local(meta, body, signal) });
  cleanups.push(() => links.close());
  gateway = new PackageGateway(runtime, links, connections.spaceId);
  gateway.servicePort = (app) => source.find((m) => m.app === app)?.service?.port;
  return { connections, links, gateway, env };
}

/** A spec-1 app's service on loopback: it echoes, redirects to its own absolute address and has a socket. */
function sourceService() {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, s) {
      const u = new URL(req.url);
      if (u.pathname === "/api/live") { if (s.upgrade(req)) return; return new Response("failed", { status: 400 }); }
      if (u.pathname === "/api/redirect") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${s.port}/api/echo?moved=1` } });
      return Response.json({ source: true, path: u.pathname + u.search, authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie"), forwarded: req.headers.get("x-forwarded-host") });
    },
    websocket: { message(ws, m) { ws.send("source:" + m); } },
  });
  cleanups.push(() => { server.stop(true); });
  return { app: "notes-src", dir: "/unused", spec: 1, title: "Notes (source)", icon: "📝", status: "active", service: { port: server.port }, agents: [], widgets: [], tasks: [] } as unknown as Manifest;
}

const TOKENS: Record<string, string> = { "usage-token": "ai-usage", "other-token": "other" };
const callerApp = async (req: Request) => {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  return t ? TOKENS[t] ?? "" : null;
};

/** A hub with an incoming connection from a peer Space named "box", the peer granting `granted`. */
async function setup(granted: string[], legacy?: (req: Request, path: string) => Promise<Response>, source: Manifest[] = []) {
  const hub = await space("hub", []), peer = await space("box", ["ai-usage", "other"], source);
  const invite = hub.connections.create({ remoteSpaceId: peer.connections.spaceId, direction: "incoming" });
  const catalogue = new RemoteCatalogue(hub.links, { refreshMs: 3_600_000 }); cleanups.push(() => catalogue.close());
  const legacyHub = { get: (n: string) => (legacy && n === "box" ? { name: "box", forward: legacy } : undefined) };
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, websocket: terminalWebSocket, fetch: () => new Response("missing", { status: 404 }),
    routes: {
      ...createConnectionRoutes({ links: hub.links, token: "operator" }),
      ...createPeerRoutes({ hub: legacyHub as never, layout: {} as never, registry: {} as never, callerApp, connections: { find: (p, a) => catalogue.find(p, a), request: (id, meta, body, signal) => hub.links.request(id, meta, body, signal) } }),
    } as never,
  });
  cleanups.push(() => { server.stop(true); });
  peer.env.HUB_TOKEN = invite.token;
  const outgoing = peer.connections.create({ remoteSpaceId: hub.connections.spaceId, direction: "outgoing", url: server.url.origin, tokenEnv: "HUB_TOKEN", apps: granted }).connection;
  for (let i = 0; i < 200 && !(peer.links.status()[0]?.connected && hub.links.status()[0]?.connected); i++) { peer.links.refresh(); await Bun.sleep(10); }
  expect(hub.links.status()[0]?.connected).toBe(true);
  await catalogue.refresh();
  const base = server.url.origin;
  const get = (path: string, init: RequestInit = {}) => fetch(base + path, init);
  return { hub, peer, outgoing, catalogue, base, get };
}

test("a granted app's /api/ is reached over the connection, without the caller's credentials", async () => {
  const s = await setup(["ai-usage"]);
  const owner = await s.get("/api/peers/box/apps/ai-usage/proxy/api/export?since=1", { headers: { cookie: "__space_session=secret" } });
  expect(owner.status).toBe(200);
  expect(owner.headers.get("cache-control")).toBe("no-store");
  expect(await owner.json()).toEqual({ app: "ai-usage", path: "/api/export?since=1", method: "GET", authorization: null, cookie: null });
  // The app of the same name with its own token.
  const self = await s.get("/api/peers/box/apps/ai-usage/proxy/api/export", { headers: { authorization: "Bearer usage-token" } });
  expect(self.status).toBe(200);
  expect(await self.json()).toMatchObject({ app: "ai-usage", authorization: null });
});

test("another app's token, a non-/api/ path, a write and an ungranted app are refused", async () => {
  const s = await setup(["ai-usage"]);
  expect((await s.get("/api/peers/box/apps/ai-usage/proxy/api/export", { headers: { authorization: "Bearer other-token" } })).status).toBe(403);
  expect((await s.get("/api/peers/box/apps/ai-usage/proxy/api/export", { headers: { authorization: "Bearer unknown" } })).status).toBe(403);
  expect((await s.get("/api/peers/box/apps/ai-usage/proxy/board")).status).toBe(404);
  expect((await s.get("/api/peers/box/apps/ai-usage/proxy/api/export", { method: "POST" })).status).not.toBe(200);
  // Not in the peer's catalogue: no connection resolves, no legacy peer of that name either.
  expect((await s.get("/api/peers/box/apps/other/proxy/api/export")).status).toBe(404);
  expect((await s.get("/api/peers/elsewhere/apps/ai-usage/proxy/api/export")).status).toBe(404);
});

test("a grant revoked after the catalogue was read is refused by the owning Space", async () => {
  const s = await setup(["ai-usage"]);
  s.peer.connections.update(s.outgoing.id, { apps: [] });
  const r = await s.get("/api/peers/box/apps/ai-usage/proxy/api/export");
  expect(r.status).toBe(403);
});

test("an offline connection answers 502 with a short JSON error", async () => {
  const s = await setup(["ai-usage"]);
  s.peer.links.close();
  for (let i = 0; i < 200 && s.hub.links.status()[0]?.connected; i++) await Bun.sleep(10);
  const r = await s.get("/api/peers/box/apps/ai-usage/proxy/api/export");
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ ok: false, error: expect.stringContaining("unreachable") });
});

test("a legacy peer of the same name wins", async () => {
  const s = await setup(["ai-usage"], async (_req, path) => Response.json({ legacy: path }));
  expect(await (await s.get("/api/peers/box/apps/ai-usage/proxy/api/export")).json()).toEqual({ legacy: "/api/peer/apps/ai-usage/proxy/api/export" });
});

test("a socket on the app's /api/ is bridged over the connection", async () => {
  const s = await setup(["ai-usage"]);
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/api/peers/box/apps/ai-usage/proxy/api/live`);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket failed")); });
  const echo = new Promise<unknown>((resolve) => { ws.onmessage = (e) => resolve(e.data); });
  ws.send("hello"); expect(await echo).toBe("echo:hello");
  const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
  // From another site's page: refused before anything reaches the channel.
  const evil = new WebSocket(`${s.base.replace("http", "ws")}/api/peers/box/apps/ai-usage/proxy/api/live`, { headers: { origin: "https://evil.example" } } as unknown as string[]);
  expect(await new Promise<boolean>((resolve) => { evil.onopen = () => resolve(true); evil.onerror = () => resolve(false); })).toBe(false);
  ws.close(); await closed;
});

test("only spec-1 apps with a service port, not archived and not a package, are shareable, API only", () => {
  const m = (app: string, extra: Record<string, unknown>) => ({ app, dir: "/x", spec: 1, status: "active", agents: [], widgets: [], tasks: [], ...extra }) as unknown as Manifest;
  const shared = sourceSharedApps([
    m("svc", { service: { port: 4100 }, title: "Service", icon: "🛰" }),
    m("no-port", {}),
    m("old", { service: { port: 4101 }, status: "archived" }),
    m("pkg", { spec: 2, service: { port: 4102 } }),
    m("both", { service: { port: 4103 } }),
    m("file-icon", { service: { port: 4104 }, icon: "assets/icon.svg" }),
  ], (app) => app === "both");
  expect(shared).toEqual([{ app: "svc", title: "Service", version: "", page: false, icon: "🛰" }, { app: "file-icon", title: "file-icon", version: "", page: false }]);
});

test("a granted spec-1 app's /api/ is served from its service port; other paths and the page are refused", async () => {
  const s = await setup(["notes-src"], undefined, [sourceService()]);
  const view = s.catalogue.views(new Set()).find((v) => v.name === "notes-src")!;
  expect(view).toMatchObject({ id: "box/notes-src", peer: "box", title: "Notes (source)", icon: "📝" });
  expect(view.url).toBeUndefined();
  // ai-usage's token names another app.
  expect((await s.get("/api/peers/box/apps/notes-src/proxy/api/echo?x=1", { headers: { authorization: "Bearer usage-token" } })).status).toBe(403);
  const owner = await s.get("/api/peers/box/apps/notes-src/proxy/api/echo?x=1", { headers: { cookie: "__space_session=secret" } });
  expect(await owner.json()).toEqual({ source: true, path: "/api/echo?x=1", authorization: null, cookie: null, forwarded: null });
  const connection = s.hub.links.status()[0]!.id;
  // The owning side itself serves only /api/, whatever the other side asks.
  const page = await s.hub.links.request(connection, { operation: "fetch", app: "notes-src", path: "/", method: "GET" });
  expect(page.status).toBe(404); await page.body?.cancel();
  // Header filtering and redirect rewriting are the packages' own.
  const direct = await s.hub.links.request(connection, { operation: "fetch", app: "notes-src", path: "/api/redirect", method: "GET", headers: [["x-forwarded-host", "spoofed"]] });
  expect(direct.headers.get("location")).toBe("/api/echo?moved=1");
  await direct.body?.cancel();
  const filtered = await s.hub.links.request(connection, { operation: "fetch", app: "notes-src", path: "/api/echo", method: "GET", headers: [["x-forwarded-host", "spoofed"]] });
  expect(await filtered.json()).toMatchObject({ forwarded: null });
  // No page: the gateway refuses to open it.
  s.hub.gateway.start(0); cleanups.push(() => s.hub.gateway.close());
  // `rejection`, not `expect().rejects`: this code runs inside a socket callback (testing.ts says why).
  expect((await rejection(s.hub.gateway.open({ app: "notes-src", spaceId: s.peer.connections.spaceId, connectionId: connection })))?.message).toMatch(/no page/);
  // Taken off the grant: refused by the owning side.
  s.peer.connections.update(s.outgoing.id, { apps: [] });
  const revoked = await s.get("/api/peers/box/apps/notes-src/proxy/api/echo");
  expect(revoked.status).toBe(403);
});

test("a spec-1 app's socket on /api/ is bridged over the connection", async () => {
  const s = await setup(["notes-src"], undefined, [sourceService()]);
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/api/peers/box/apps/notes-src/proxy/api/live`);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket failed")); });
  const echo = new Promise<unknown>((resolve) => { ws.onmessage = (e) => resolve(e.data); });
  ws.send("hi"); expect(await echo).toBe("source:hi");
});
