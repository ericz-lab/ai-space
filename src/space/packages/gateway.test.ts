import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalWebSocket } from "../terminal/api.ts";
import { Connections } from "./connections.ts";
import { PackageGateway } from "./gateway.ts";
import { PackageLinks, createConnectionRoutes } from "./links.ts";
import { parsePackageManifest } from "./manifest.ts";
import { PackageRuntime } from "./runtime.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
async function machine(label: string) {
  const dir = await mkdtemp(join(tmpdir(), "space-gateway-")); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  const connections = new Connections(db, crypto.randomUUID());
  const runtime = new PackageRuntime({ logDir: join(dir, "logs"), envFor: async () => ({ LABEL: label }), startTimeoutMs: 3000 });
  cleanups.push(() => runtime.close(0));
  await Bun.write(join(dir, "app.ts"), `
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT),
  async fetch(req, server) {
    const path = new URL(req.url).pathname;
    if (path === "/healthz") return new Response("ok");
    if (path === "/socket") {
      if (server.upgrade(req)) return;
      return new Response("failed", {status: 400});
    }
    if (path === "/redirect") return new Response(null, {status: 302, headers: {location: "http://127.0.0.1:"+server.port+"/api/echo"}});
    if (path === "/cookies") { const h=new Headers(); h.append("set-cookie", "one=1; Domain=localhost; Path=/"); h.append("set-cookie", "two=2; Path=/"); return new Response("cookies",{headers:h}); }
    if (path === "/stream") return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("data: started\\n\\n"));}}), {headers:{"content-type":"text/event-stream"}});
    return Response.json({label:process.env.LABEL, method:req.method, body:await req.text(),cookie:req.headers.get("cookie")});
  }, websocket: {message(ws,m){ws.send(m)}}
});`);
  const manifest = parsePackageManifest("spec: 2\nname: notes\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz, idleTimeoutMs: 1000 }\n");
  await runtime.register({ manifest, dir, index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] } });
  let gateway: PackageGateway;
  const env: Record<string, string | undefined> = {};
  const links = new PackageLinks(connections, { env, apps: () => [{ app: "notes", title: label, version: "1.0.0" }], handle: (_c, meta, body, signal) => gateway.local(meta, body, signal) });
  cleanups.push(() => links.close());
  gateway = new PackageGateway(runtime, links, connections.spaceId);
  const port = gateway.start(0); cleanups.push(() => gateway.close());
  return { gateway, connections, links, runtime, port, env };
}

async function browser(gateway: PackageGateway, target: Parameters<PackageGateway["open"]>[0]) {
  const opened = await gateway.open(target);
  const url = new URL(opened.url);
  const request = (path: string, init: RequestInit = {}) => {
    const local = new URL(path, url); local.hostname = "127.0.0.1";
    return fetch(local, { ...init, redirect: "manual", headers: { host: url.host, ...Object.fromEntries(new Headers(init.headers)) } });
  };
  const response = await request(url.pathname + url.search);
  expect(response.status).toBe(303);
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  return { url, cookie, request: (path: string, init: RequestInit = {}) => request(path, { ...init, headers: { cookie, ...Object.fromEntries(new Headers(init.headers)) } }) };
}

test("local app has an isolated authenticated origin, proxies writes and preserves redirects/cookies", async () => {
  const m = await machine("local");
  const b = await browser(m.gateway, { app: "notes", spaceId: m.connections.spaceId });
  expect(b.url.hostname).toEndWith(".localhost");
  expect(m.runtime.status("notes")?.state).toBe("idle");
  expect(await (await b.request("/api/echo", { method: "POST", headers: { origin: b.url.origin }, body: "hello" })).json()).toMatchObject({ label: "local", method: "POST", body: "hello", cookie: null });
  expect((await b.request("/api/echo", { method: "POST", headers: { origin: "https://other.example" }, body: "bad" })).status).toBe(403);
  expect((await b.request("/api/echo", { headers: { cookie: "" } })).status).toBe(401);
  expect((await b.request("/redirect")).headers.get("location")).toBe("/api/echo");
  const cookies = (await b.request("/cookies")).headers.getSetCookie();
  expect(cookies).toHaveLength(2); expect(cookies.join(";")).not.toContain("Domain=");
});

test("a streaming response holds its runtime lease until cancellation", async () => {
  const m = await machine("stream");
  const response = await m.gateway.local({ operation: "fetch", app: "notes", path: "/stream" }, null, new AbortController().signal);
  const reader = response.body!.getReader();
  await reader.read(); expect(m.runtime.status("notes")?.leases).toBe(1);
  await reader.cancel(); expect(m.runtime.status("notes")?.leases).toBe(0);
});

test("remote HTTP and WebSocket work over the peer outbound channel and revoke immediately", async () => {
  const hub = await machine("hub"), peer = await machine("peer");
  const invite = hub.connections.create({ remoteSpaceId: peer.connections.spaceId, direction: "incoming", apps: ["notes"] });
  const control = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: createConnectionRoutes({ links: hub.links, token: "operator" }), websocket: terminalWebSocket, fetch: () => new Response("missing", { status: 404 }) });
  cleanups.push(() => { control.stop(true); });
  peer.env.LINK_TOKEN = invite.token;
  const outgoing = peer.connections.create({ remoteSpaceId: hub.connections.spaceId, direction: "outgoing", url: control.url.origin, tokenEnv: "LINK_TOKEN" }).connection;
  peer.links.refresh();
  const connected = async () => { for (let i = 0; i < 100; i++) { if (peer.links.status()[0]?.connected && hub.links.status()[0]?.connected) return; await Bun.sleep(10); } throw new Error("offline"); };
  await connected();
  const b = await browser(peer.gateway, { app: "notes", spaceId: hub.connections.spaceId, connectionId: outgoing.id });
  expect(await (await b.request("/api/echo", { method: "POST", headers: { origin: b.url.origin }, body: "remote" })).json()).toMatchObject({ label: "hub", body: "remote" });
  expect((await b.request("/cookies")).headers.getSetCookie()).toHaveLength(2);
  await expect(hub.gateway.open({ app: "notes", spaceId: peer.connections.spaceId, connectionId: invite.connection.id })).rejects.toThrow(/not shared/);
  peer.connections.update(outgoing.id, { apps: ["notes"] }); await connected();
  const reverse = await browser(hub.gateway, { app: "notes", spaceId: peer.connections.spaceId, connectionId: invite.connection.id });
  expect(await (await reverse.request("/api/echo")).json()).toMatchObject({ label: "peer" });
  const endpoint = new URL("/socket", b.url); endpoint.protocol = "ws:"; endpoint.hostname = "127.0.0.1";
  const ws = new WebSocket(endpoint, { protocols: ["echo"], headers: { host: b.url.host, origin: b.url.origin, cookie: b.cookie } } as unknown as string[]);
  cleanups.push(() => ws.close());
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket failed")); });
  expect(ws.protocol).toBe("echo");
  const echo = new Promise<unknown>((resolve) => { ws.onmessage = (e) => resolve(e.data); });
  ws.send("through hub"); expect(await echo).toBe("through hub");
  expect(hub.runtime.status("notes")?.leases).toBeGreaterThan(0);
  const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
  hub.connections.update(invite.connection.id, { apps: [] }); await closed;
});
