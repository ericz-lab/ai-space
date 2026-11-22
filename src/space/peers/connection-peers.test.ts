import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { RemoteCatalogue } from "../packages/catalogue.ts";
import { Connections } from "../packages/connections.ts";
import { PackageLinks, createConnectionRoutes } from "../packages/links.ts";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import type { WsAttachment } from "../terminal/service.ts";
import { createTerminalRoutes, terminalWebSocket } from "../terminal/api.ts";
import { createPeerRoutes } from "./api.ts";
import { ConnectionPeers } from "./connection-peers.ts";
import { createConnectionPeerServe } from "./connection-serve.ts";
import { PeerHub } from "./hub.ts";
import { createPeerRuntime } from "./model.ts";
import { PEER_ROUTES, PEER_SCOPES, type PeerScope } from "./scopes.ts";
import { createPeerServeHandlers, createPeerServeRoutes, type PeerServeOptions } from "./serve.ts";
import { PeerStore, } from "./store.ts";
import type { PeerSnapshot } from "./client.ts";

// A hub and a peer Space in one process, joined by a package connection the peer dials: the peer's
// /api/peer/* answers over the channel under the scopes it grants, and the hub shows it as a peer.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

type Req = Request & { params: Record<string, string> };
/** What reached a stubbed route of the peer: enough to tell the hub's credentials did not travel. */
const seen: { route: string; authorization: string | null; cookie: string | null; caller: string | null }[] = [];
const echo = (route: string) => async (req: Req) => {
  seen.push({ route, authorization: req.headers.get("authorization"), cookie: req.headers.get("cookie"), caller: req.headers.get("x-space-caller") });
  return Response.json({ ok: true, route, params: req.params }, { headers: { "set-cookie": "peer_session=leak; Path=/", "x-internal": "no" } });
};
/** A stream that sends `first` and then a tick every 20 ms until it is cancelled; `aborted` says when. */
function ticking(first: string, onAbort: () => void, signal?: AbortSignal) {
  let timer: ReturnType<typeof setInterval>;
  signal?.addEventListener("abort", onAbort);
  return new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(first)); timer = setInterval(() => { try { c.enqueue(new TextEncoder().encode("data: tick\n\n")); } catch { clearInterval(timer); } }, 20); },
    cancel() { clearInterval(timer); onAbort(); },
  }), { headers: { "content-type": "text/event-stream", "x-run-id": "run-1" } });
}

/** Every route the peer's /api/peer/* mirrors, stubbed; the snapshot's lists are small and fixed. */
function peerOptions(state: { chatAborted: boolean; terminalClosed: boolean; calls: string[] }): Omit<PeerServeOptions, "token"> {
  const app = { id: "media", name: "media", title: "Media", icon: "/api/apps/media/icon", url: "https://media.example", status: "active", manifestOnly: false, hidden: false, agents: [], widgets: [] };
  const panel = {
    "/api/apps": { GET: () => Response.json({ ok: true, apps: [app, { ...app, id: "pkg", name: "pkg" }] }) },
    "/api/services": { GET: () => Response.json({ ok: true, services: [] }) },
    "/api/widgets": { GET: () => Response.json({ ok: true, widgets: [] }) },
    "/api/apps/:app": { DELETE: echo("uninstall") },
    "/api/apps/:app/icon": { GET: echo("icon") },
    "/api/panel/appcolor": { GET: echo("appcolor") },
    "/api/agents/:app/:agent/avatar": { GET: echo("avatar") },
    "/api/widgets/:app/:name/embed": { GET: echo("embed") },
  };
  const agents: Record<string, Record<string, (req: Req) => Response | Promise<Response>>> = {
    "/api/agents": { GET: () => Response.json({ ok: true, agents: [{ id: "media/helper", app: "media", name: "helper", title: "Helper", avatar: "/api/agents/media/helper/avatar", appIcon: "" }] }) },
    "/api/agents/:app/:agent/chat": { POST: (req) => ticking("data: hello\n\n", () => { state.chatAborted = true; }, req.signal) },
  };
  for (const p of ["sessions", "sessions/:sid", "runs", "runs/:id", "runs/:id/events", "watch"]) agents[`/api/agents/:app/:agent/${p}`] = { GET: echo(`agents ${p}`) };
  for (const p of ["runs/:id/stop", "runs/:id/steer", "runs/:id/approvals/:rid"]) agents[`/api/agents/:app/:agent/${p}`] = { POST: echo(`agents ${p}`) };
  agents["/api/agents/runs"] = { GET: () => Response.json({ ok: true, runs: [] }) };
  // The terminal's socket: an echo, and `terminalClosed` once it is closed from either end.
  const terminal = {
    "/api/terminal": { GET: echo("terminal") },
    "/api/terminal/sessions": { POST: echo("terminal session") },
    "/api/terminal/sessions/:id": { DELETE: echo("terminal kill") },
    "/api/terminal/ws": { GET: (req: Req, server: { upgrade: (r: Request, o: unknown) => boolean }) => {
      if (new URL(req.url).searchParams.get("ticket") !== "t1") return Response.json({ ok: false, error: "ticket is unknown" }, { status: 401 });
      const attachment: WsAttachment = { open: (ws) => void ws.send("ready"), message: (ws, m) => void ws.send(`echo:${m}`), close: () => { state.terminalClosed = true; } };
      return server.upgrade(req, { data: { attachment } }) ? undefined : Response.json({ ok: false }, { status: 400 });
    } },
  };
  const sse = (text: string) => new Response(`event: done\ndata: ${JSON.stringify({ text, call: { model: "codex/gpt" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  return {
    name: "box", id: "box-space-id", panel: panel as never, agents: agents as never, terminal: terminal as never,
    allowApp: (a) => a !== "pkg",
    servicePort: () => undefined,
    bus: {
      capabilities: () => [{ app: "media", provides: [{ name: "clip" }], publishes: [], consumes: [] }],
      call: async (caller: string, app: string, capability: string) => { state.calls.push(`${caller} -> ${app}/${capability}`); return { status: 200, body: JSON.stringify({ ok: true }), contentType: "application/json", record: { id: 7, durationMs: 1 } }; },
    } as never,
    events: { listEventsSince: (since: number) => (since < 2 ? [{ id: 2, app: "media", name: "media/clip.added", data: { n: 1 }, at: 1_700_000_000_000 }] : []), latestEventId: () => 2 } as never,
    model: {
      "/api/peer/model/run": { POST: async (req: Req) => { state.calls.push(`model ${req.headers.get("x-space-caller")}`); return sse("answer from box"); } },
      "/api/peer/model/runs/:ref/cancel": { POST: echo("model cancel") },
      "/api/peer/model/image": { POST: echo("model image") },
    } as never,
    modelInfo: () => ({ serves: [{ name: "codex", kind: "codex-cli", image: false, tiers: {} }], cells: [] }),
    ledger: { "/api/peer/model/usage": { GET: echo("usage") }, "/api/peer/model/calls": { GET: echo("calls") } } as never,
    appModels: { "/api/peer/model/apps": { GET: () => Response.json({ ok: true, apps: [] }) }, "/api/peer/apps/:app/model": { PATCH: echo("app model") } } as never,
    tasks: {
      "/api/peer/tasks": { GET: () => Response.json({ ok: true, tasks: [] }) },
      "/api/peer/tasks/models": { GET: echo("task models") },
      "/api/peer/tasks/:id": { GET: () => Response.json({ ok: true, task: { app: "media" } }) },
      "/api/peer/tasks/:id/runs": { GET: echo("task runs") },
      "/api/peer/tasks/:id/model": { PATCH: echo("task model") },
    } as never,
    feedback: {
      "/api/peer/feedback/settings": { GET: () => Response.json({ ok: true, apps: [] }), PUT: () => Response.json({ ok: true, apps: [] }) },
      "/api/peer/feedback": { GET: () => Response.json({ ok: true, items: [] }) },
      "/api/peer/feedback/fix": { POST: echo("feedback fix") },
    } as never,
  };
}

async function setup(opts: { scopes?: PeerScope[]; fullTrust?: boolean; alias?: string; legacy?: "other" | "same"; stored?: { name: string; snapshot: PeerSnapshot }; extraRoute?: boolean; grantMedia?: boolean } = {}) {
  const state = { chatAborted: false, terminalClosed: false, calls: [] as string[], mirrored: [] as string[] };
  seen.length = 0;
  // ---- the peer: dials the hub, answers `peer` operations from its own /api/peer/* handlers
  const peerDb = new Database(":memory:"); cleanups.push(() => peerDb.close());
  const peerConns = new Connections(peerDb, crypto.randomUUID());
  const handlers = createPeerServeHandlers(peerOptions(state));
  if (opts.extraRoute) handlers["/api/peer/extra"] = { GET: () => Response.json({ ok: true, unmapped: true }) };
  const env: Record<string, string | undefined> = {};
  // `media` is a spec-1 app the snapshot lists; with `grantMedia` the connection also shares it by an app grant (API only).
  const peerLinks = new PackageLinks(peerConns, { env, name: "box", apps: () => [{ app: "media", title: "Media", version: "", page: false }] });
  peerLinks.peer = createConnectionPeerServe({ routes: handlers, allows: (id, scope) => peerConns.allowsScope(id, scope) });
  cleanups.push(() => peerLinks.close());

  // ---- the hub: accepts the connection, keeps peers, serves /api/peers/* and the terminal bridge
  const hubDb = new Database(":memory:"); cleanups.push(() => hubDb.close());
  const hubConns = new Connections(hubDb, crypto.randomUUID());
  const hubLinks = new PackageLinks(hubConns, { env: {}, name: "hub", apps: () => [] });
  cleanups.push(() => hubLinks.close());
  const store = new PeerStore(hubDb);
  if (opts.stored) store.set(opts.stored.name, opts.stored.snapshot);
  let legacyServer: ReturnType<typeof Bun.serve> | undefined;
  if (opts.legacy) {
    legacyServer = Bun.serve({ hostname: "127.0.0.1", port: 0, routes: createPeerServeRoutes({ token: "tok", ...peerOptions(state), name: "david", id: opts.legacy === "same" ? peerConns.spaceId : "david-space-id" }) as never, websocket: terminalWebSocket });
    cleanups.push(() => { legacyServer!.stop(true); });
  }
  const invite = hubConns.create({ remoteSpaceId: peerConns.spaceId, direction: "incoming", ...(opts.alias ? { alias: opts.alias } : {}) });
  const peers = new PeerHub(legacyServer ? [{ name: "david", url: legacyServer.url.origin, token: "tok", headers: {}, refreshMs: 3_600_000 }] : [], {
    store,
    channel: (id, meta, body, signal, o) => hubLinks.request(id, meta, body, signal, o),
    onEvents: (peer, list) => { for (const e of list) state.mirrored.push(`${peer}:${e.app}/${e.name}`); },
  }, hubConns.list().map((c) => c.alias ?? c.remoteSpaceId.slice(0, 8)));
  cleanups.push(() => peers.stop());
  peers.start();
  const catalogue = new RemoteCatalogue(hubLinks, { refreshMs: 3_600_000 }); cleanups.push(() => catalogue.close());
  const connectionPeers = new ConnectionPeers({ hub: peers, catalogue, connections: hubConns, refreshMs: 3_600_000, reserved: (n) => n === "notes" });
  cleanups.push(() => connectionPeers.close());
  hubLinks.peerState = (id) => connectionPeers.status().find((s) => s.connection === id);
  const registry = new AppRegistry();
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, websocket: terminalWebSocket, fetch: () => new Response("missing", { status: 404 }),
    routes: { ...createConnectionRoutes({ links: hubLinks, token: "operator" }), ...createPeerRoutes({ hub: peers, layout: new LayoutStore(hubDb), registry, rename: async () => { throw new Error("not reached") } }), ...createTerminalRoutes({ service: { enabled: false } as never, name: "hub", hub: peers }) } as never,
  });
  cleanups.push(() => { server.stop(true); });

  env.HUB_TOKEN = invite.token;
  const outgoing = peerConns.create({ remoteSpaceId: hubConns.spaceId, direction: "outgoing", url: server.url.origin, tokenEnv: "HUB_TOKEN", scopes: opts.scopes ?? [], fullTrust: opts.fullTrust ?? false, apps: opts.grantMedia ? ["media"] : [] }).connection;
  for (let i = 0; i < 200 && !(peerLinks.status()[0]?.connected && hubLinks.status()[0]?.connected); i++) { peerLinks.refresh(); await Bun.sleep(10); }
  expect(hubLinks.status()[0]?.connected).toBe(true);
  await catalogue.refresh();
  const connection = invite.connection.id;
  /** A `peer` operation straight on the channel, as the hub's client sends it. */
  const op = (method: string, path: string, headers: [string, string][] = []) => hubLinks.request(connection, { operation: "peer", method, path, headers });
  return { state, peers, catalogue, connectionPeers, peerConns, hubConns, hubLinks, outgoing, connection, base: server.url.origin, op, store };
}

/** A JSON answer's text; a stream (a chat turn) is let go unread. */
const textOf = async (r: Response) => (r.headers.get("content-type")?.includes("json") ? r.text() : (await r.body?.cancel(), ""));
/** A concrete path for a route pattern, for the app `media`. */
const concrete = (pattern: string) => pattern.replace(":app", "media").replace(/:[a-z]+/g, "x1").replace("*", "api/data");

test("the snapshot travels over the channel and the peer's apps show on the hub under its name", async () => {
  const s = await setup({ scopes: ["panel"] });
  expect(s.connectionPeers.status()).toEqual([{ connection: s.connection, name: "box", state: "peer", granted: { scopes: ["panel"], fullTrust: false } }]);
  const client = s.peers.get("box")!;
  expect(client.via).toBe("connection");
  await client.refresh();
  expect(client.error).toBeUndefined();
  // The stable id is the Space the connection is bound to, whatever the snapshot says.
  expect(client.snapshot?.id).toBe(s.peerConns.spaceId);
  const apps = s.peers.apps(new Set());
  // The package `pkg` stays out of the snapshot: a connection lists packages by its own app grant.
  expect(apps.map((a) => a.id)).toEqual(["box/media"]);
  expect(apps[0]).toMatchObject({ peer: "box", icon: "/api/peers/box/apps/media/icon", stale: false });
  expect(s.peers.agents(new Set()).map((a) => a.id)).toEqual(["box/media/helper"]);
  const listed = await (await fetch(`${s.base}/api/peers`)).json() as { peers: { name: string; via: string; connection?: string }[] };
  expect(listed.peers).toEqual([expect.objectContaining({ name: "box", via: "connection", connection: s.connection })]);
  // What the hub's connection list says about it.
  const conns = await (await fetch(`${s.base}/api/connections`, { headers: { authorization: "Bearer operator" } })).json() as { connections: { peer?: unknown }[] };
  expect(conns.connections[0]!.peer).toMatchObject({ name: "box", state: "peer" });
  // An icon through the hub's own route, over the channel.
  const icon = await fetch(`${s.base}/api/peers/box/apps/media/icon`);
  expect(await icon.json()).toMatchObject({ route: "icon", params: { app: "media" } });
});

test("an app both in the snapshot and shared by an app grant has one id, so the hub lists it once", async () => {
  const s = await setup({ scopes: ["panel"], grantMedia: true });
  await s.peers.get("box")!.refresh();
  const fromSnapshot = s.peers.apps(new Set()).map((a) => a.id);
  const fromCatalogue = s.catalogue.views(new Set()).map((a) => a.id);
  expect(fromSnapshot).toEqual(["box/media"]);
  expect(fromCatalogue).toEqual(["box/media"]);
  // panel/api.ts `listApps` drops a shared entry whose id a peer app already has (`taken`); this is the same rule.
  const taken = new Set(fromSnapshot);
  expect(s.catalogue.views(new Set()).filter((v) => !taken.has(v.id))).toEqual([]);
});

test("the connection routes carry scopes, full trust and the alias, strictly validated", async () => {
  const s = await setup({ scopes: [] });
  const patch = (body: unknown) => fetch(`${s.base}/api/connections/${s.connection}`, { method: "PATCH", headers: { authorization: "Bearer operator", "content-type": "application/json" }, body: JSON.stringify(body) });
  const ok = await patch({ scopes: ["terminal", "panel"], alias: "office" });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { connection: unknown }).connection).toMatchObject({ scopes: ["panel", "terminal"], fullTrust: false, alias: "office" });
  for (const bad of [{ scopes: ["root"] }, { fullTrust: 1 }, { alias: "Office" }, { owner: true }]) {
    const r = await patch(bad);
    expect(r.status).toBe(400);
    await r.body?.cancel();
  }
  const created = await fetch(`${s.base}/api/connections`, { method: "POST", headers: { authorization: "Bearer operator", "content-type": "application/json" }, body: JSON.stringify({ remoteSpaceId: crypto.randomUUID(), direction: "incoming", fullTrust: true, alias: "lab" }) });
  expect(((await created.json()) as { connection: unknown }).connection).toMatchObject({ scopes: [], fullTrust: true, alias: "lab" });
});

test("each scope gates its routes; a route not in the table and a path outside /api/peer/ are refused", async () => {
  const s = await setup({ scopes: [], extraRoute: true });
  const refusedFor = async (scope: PeerScope | undefined) => {
    const out: string[] = [];
    for (const r of PEER_ROUTES) {
      const res = await s.op(r.method, concrete(r.path), [["content-type", "application/json"]]);
      const body = await textOf(res);
      if (res.status === 403 && body.includes("does not grant")) out.push(`${r.method} ${r.path}`);
      if (r.scope === scope) expect(body).not.toContain("does not grant");
    }
    return out;
  };
  // Nothing granted: every route refused by its scope.
  expect(await refusedFor(undefined)).toHaveLength(PEER_ROUTES.length);
  for (const scope of PEER_SCOPES) {
    s.peerConns.update(s.outgoing.id, { scopes: [scope] });
    const refused = await refusedFor(scope);
    expect(refused).toEqual(PEER_ROUTES.filter((r) => r.scope !== scope).map((r) => `${r.method} ${r.path}`));
  }
  s.peerConns.update(s.outgoing.id, { fullTrust: true });
  const unmapped = await s.op("GET", "/api/peer/extra");
  expect(unmapped.status).toBe(403);
  expect(await unmapped.json()).toMatchObject({ error: expect.stringContaining("not available over a connection") });
  for (const path of ["/api/connections", "/api/peer/../connections", "/api/peer/%2e%2e/connections", "/api/peers/box/apps/media/icon"]) {
    const r = await s.op("GET", path);
    expect([400, 403]).toContain(r.status);
    await r.body?.cancel();
  }
  // A method the table does not give the path.
  expect((await s.op("POST", "/api/peer/snapshot")).status).toBe(403);
});

test("full trust grants every scope and is told apart from every scope ticked", async () => {
  const ticked = await setup({ scopes: [...PEER_SCOPES] });
  expect(ticked.catalogue.peerGrants()[0]!.grant).toEqual({ scopes: [...PEER_SCOPES], fullTrust: false });
  expect(ticked.peerConns.get(ticked.outgoing.id)).toMatchObject({ scopes: [...PEER_SCOPES], fullTrust: false });
  const s = await setup({ fullTrust: true });
  expect(s.peerConns.get(s.outgoing.id)).toMatchObject({ scopes: [], fullTrust: true });
  expect(s.catalogue.peerGrants()[0]!.grant).toEqual({ scopes: [...PEER_SCOPES], fullTrust: true });
  for (const r of PEER_ROUTES) {
    const res = await s.op(r.method, concrete(r.path), [["content-type", "application/json"]]);
    expect(await textOf(res)).not.toContain("does not grant");
  }
  // Turning full trust off keeps only what is ticked, and says which scopes went.
  const changes: unknown[] = [];
  s.peerConns.onChange((_id, c) => changes.push(c));
  s.peerConns.update(s.outgoing.id, { fullTrust: false, scopes: ["panel"] });
  expect(changes).toEqual([{ kind: "grants", revoked: [], revokedScopes: PEER_SCOPES.filter((x) => x !== "panel") }]);
  expect((await s.op("GET", "/api/peer/terminal")).status).toBe(403);
});

test("a chat stream survives an unrelated grant change and is cut when the agents scope goes", async () => {
  const s = await setup({ scopes: ["panel", "agents", "terminal"] });
  const chat = await fetch(`${s.base}/api/peers/box/agents/media/helper/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "hi" }) });
  expect(chat.status).toBe(200);
  expect(chat.headers.get("x-run-id")).toBe("run-1");
  const reader = chat.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("hello");
  // Another scope and the app list change: nothing closes.
  s.peerConns.update(s.outgoing.id, { scopes: ["panel", "agents"], apps: [] });
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("tick");
  expect(s.state.chatAborted).toBe(false);
  // Its own scope taken away: the stream ends, the peer's handler is aborted, the channel stays.
  s.peerConns.update(s.outgoing.id, { scopes: ["panel"] });
  const drained = async () => { for (;;) { const r = await reader.read(); if (r.done) return "ended"; } };
  // The hub ends the browser's response (api.ts `relayed`), as it ends one a dropped link cuts.
  expect(await drained()).toBe("ended");
  for (let i = 0; i < 100 && !s.state.chatAborted; i++) await Bun.sleep(5);
  expect(s.state.chatAborted).toBe(true);
  expect(s.hubLinks.status()[0]?.connected).toBe(true);
  // New turns are refused at once.
  const again = await fetch(`${s.base}/api/peers/box/agents/media/helper/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(again.status).toBe(403);
});

test("a terminal socket is bridged over the channel, survives another scope's removal and closes with its own", async () => {
  const s = await setup({ scopes: ["panel", "agents", "terminal"] });
  const ws = new WebSocket(`${s.base.replace("http", "ws")}/api/peers/box/terminal/ws?ticket=t1`);
  cleanups.push(() => ws.close());
  const inbox: string[] = [];
  let closed: { code: number; reason: string } | undefined;
  ws.onmessage = (e) => inbox.push(String(e.data));
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; };
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket failed")); });
  const next = async (n: number) => { for (let i = 0; i < 200 && inbox.length < n; i++) await Bun.sleep(5); return inbox[n - 1]; };
  expect(await next(1)).toBe("ready");
  ws.send("ls");
  expect(await next(2)).toBe("echo:ls");
  s.peerConns.update(s.outgoing.id, { scopes: ["panel", "terminal"] });
  ws.send("pwd");
  expect(await next(3)).toBe("echo:pwd");
  s.peerConns.update(s.outgoing.id, { scopes: ["panel"] });
  for (let i = 0; i < 200 && !closed; i++) await Bun.sleep(5);
  expect(closed).toBeDefined();
  for (let i = 0; i < 100 && !s.state.terminalClosed; i++) await Bun.sleep(5);
  expect(s.state.terminalClosed).toBe(true);
  // A wrong ticket is the peer's refusal, before any socket opens.
  const bad = new WebSocket(`${s.base.replace("http", "ws")}/api/peers/box/terminal/ws?ticket=nope`);
  s.peerConns.update(s.outgoing.id, { scopes: ["panel", "terminal"] });
  const refusal = await new Promise<{ code: number; reason: string }>((resolve) => { bad.onclose = (e) => resolve({ code: e.code, reason: e.reason }); });
  expect(refusal.reason).toMatch(/refused|ticket/);
});

test("a forwarded model call runs on the peer as the hub's caller", async () => {
  const s = await setup({ scopes: ["panel", "model"] });
  const client = s.peers.get("box")!;
  await client.refresh();
  expect(client.snapshot?.model?.serves.map((r) => r.name)).toEqual(["codex"]);
  const rt = createPeerRuntime(client, "hub", { name: "codex", kind: "codex-cli", image: false });
  const out = await rt.complete({ prompt: "hi", model: "basic", timeoutMs: 5000, caller: "notes" } as never);
  expect(out).toMatchObject({ ok: true, text: "answer from box", backend: "peer:box" });
  expect(s.state.calls).toContain("model hub/notes");
});

test("events are mirrored and bus calls forwarded over the channel, each under its scope", async () => {
  const s = await setup({ scopes: ["panel"] });
  const client = s.peers.get("box")!;
  await client.refresh();
  // Without the events scope the mirror has nothing to pull, and the snapshot still refreshes.
  expect(client.error).toBeUndefined();
  expect(s.state.mirrored).toEqual([]);
  s.peerConns.update(s.outgoing.id, { scopes: ["panel", "events"] });
  await client.refresh();
  expect(s.state.mirrored).toEqual(["box:media/clip.added"]);
  expect(client.provides("media", "clip")).toBe(true);
  const r = await client.forward(new Request("http://peer/", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), "/api/peer/call/media/clip", { headers: { "x-space-caller": "hub/space" } });
  expect(r.status).toBe(200);
  expect(s.state.calls).toEqual(["hub/space -> media/clip"]);
});

test("none of the hub caller's credentials reach the peer and none of the peer's cookies come back", async () => {
  const s = await setup({ scopes: ["panel", "agents"] });
  const r = await fetch(`${s.base}/api/peers/box/agents/media/helper/avatar`, { headers: { cookie: "__space_session=secret", authorization: "Bearer operator-token" } });
  expect(r.status).toBe(200);
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(seen.at(-1)).toEqual({ route: "avatar", authorization: null, cookie: null, caller: null });
  // The client's raw request: the peer's answer carries only the headers a hub uses.
  const raw = await s.peers.get("box")!.request("/api/peer/agents/media/helper/sessions", { headers: { authorization: "Bearer leaked", cookie: "a=b" } });
  expect(raw.headers.get("set-cookie")).toBeNull();
  expect(raw.headers.get("x-internal")).toBeNull();
  expect(raw.headers.get("content-type")).toContain("application/json");
  expect(seen.at(-1)).toMatchObject({ authorization: null, cookie: null });
});

test("a legacy peer and a connection peer side by side; one of the same name is not shown twice", async () => {
  const s = await setup({ scopes: ["panel"], legacy: "other" });
  await s.peers.refreshAll();
  expect(s.peers.status().map((p) => [p.name, p.via])).toEqual([["box", "connection"], ["david", "http"]]);
  expect(s.peers.apps(new Set()).map((a) => a.id)).toEqual(["box/media", "david/media"]);
  // The connection named after the legacy peer: the legacy one wins, the machine is listed once.
  s.hubConns.update(s.connection, { alias: "david" });
  s.connectionPeers.sync();
  expect(s.peers.status().map((p) => [p.name, p.via])).toEqual([["david", "http"]]);
  expect(s.connectionPeers.status()[0]).toMatchObject({ name: "david", state: "shadowed" });
  // A rename to a local app's name is not taken either.
  s.hubConns.update(s.connection, { alias: "notes" });
  s.connectionPeers.sync();
  expect(s.connectionPeers.status()[0]).toMatchObject({ name: "notes", state: "reserved" });
  s.hubConns.update(s.connection, { alias: null });
  s.connectionPeers.sync();
  expect(s.peers.names()).toEqual(["box", "david"]);
  // The rename route is the legacy one's; a connection peer is renamed by its alias.
  const rename = await fetch(`${s.base}/api/peers/box/rename`, { method: "POST", body: JSON.stringify({ to: "x" }) });
  expect(rename.status).toBe(400);
  expect(await rename.json()).toMatchObject({ error: expect.stringContaining("alias") });
});

test("a legacy peer that is the same Space as a connection wins under its own name", async () => {
  const s = await setup({ scopes: ["panel"], legacy: "same" });
  await s.peers.refreshAll();
  s.connectionPeers.sync();
  expect(s.peers.status().map((p) => [p.name, p.via])).toEqual([["david", "http"]]);
  expect(s.connectionPeers.status()[0]).toMatchObject({ name: "box", state: "shadowed", reason: expect.stringContaining("david") });
});

test("a machine moved from a legacy peer to a connection under the same name keeps its stored snapshot", async () => {
  const snapshot: PeerSnapshot = { name: "box", id: "box-space-id", apps: [{ id: "old", name: "old", title: "Old", icon: "", status: "active", manifestOnly: false, hidden: false, agents: [], widgets: [] } as never], services: [], widgets: [], agents: [], terminal: false, capabilities: [], asOf: "2026-01-01T00:00:00.000Z" };
  const s = await setup({ scopes: [], alias: "office", stored: { name: "office", snapshot } });
  // Before the peer grants the panel scope there is no peer, and the stored rows were kept (`keep`).
  expect(s.peers.names()).toEqual([]);
  expect(s.store.get("office")?.apps.map((a) => a.name)).toEqual(["old"]);
  s.peerConns.update(s.outgoing.id, { scopes: ["panel"] });
  await s.catalogue.refresh();
  const client = s.peers.get("office")!;
  // Restored from what the hub kept under that name, shown stale until the first refresh.
  expect(s.peers.apps(new Set()).map((a) => [a.id, a.stale])).toEqual([["office/old", true]]);
  await client.refresh();
  expect(s.peers.apps(new Set()).map((a) => a.id)).toEqual(["office/media"]);
  expect(s.store.get("office")?.apps.map((a) => a.name)).toEqual(["media"]);
});
