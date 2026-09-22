import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRoutes } from "../agents/api.ts";
import { SessionStore } from "../agents/sessions.ts";
import { createBusRoutes } from "../bus/api.ts";
import { Bus } from "../bus/bus.ts";
import { BusStore } from "../bus/store.ts";
import { Store } from "../scheduler/store.ts";
import { createPanelRoutes } from "../panel/api.ts";
import { HealthProbe } from "../panel/health.ts";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { WidgetFeed } from "../panel/widgets.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { createPeerRoutes } from "./api.ts";
import { loadPeers, parseHeaders, parseRefresh } from "./config.ts";
import { PeerHub } from "./hub.ts";
import type { AppView } from "../panel/view.ts";
import type { WidgetView } from "../panel/widgets.ts";
import { dropSameLink, dropSameUrl, peerRoute } from "./merge.ts";
import { createPeerServeRoutes } from "./serve.ts";
import { PeerStore } from "./store.ts";

// Two spaces in one process: a peer (its panel behind /api/peer/*) and a hub that merges it.

const FAKE_CLI = `
const args = process.argv.slice(2);
const msg = args[args.indexOf("-p") + 1] ?? "";
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: "cafe0001-0000-4000-8000-000000000000", model: "fake", cwd: process.cwd() });
out({ type: "assistant", message: { content: [{ type: "text", text: "echo " + msg + " | cwd=" + process.cwd() }] } });
out({ type: "result", session_id: "cafe0001-0000-4000-8000-000000000000", is_error: false });
`;

const fakeLoopback = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/healthz")) return new Response("ok");
  if (url.includes("/api/latest")) return Response.json({ ok: true, items: [{ text: "Clip one", url: "https://media.example.com/1", time: "2026-09-05T08:00:00Z" }] });
  if (url.includes("/board?theme=")) return new Response(`<html>board ${url.split("theme=")[1]}</html>`, { headers: { "content-type": "text/html" } });
  return new Response("<html><head><meta name=\"theme-color\" content=\"#abcdef\"></head></html>", { headers: { "content-type": "text/html" } });
}) as typeof fetch;

let peerServer: ReturnType<typeof Bun.serve>;
let hubServer: ReturnType<typeof Bun.serve>;
let peerBase = "";
let hub = "";
let mediaDir = "";
let hubHome = "";
let clock = 1_000_000;
let outage = false;
let lastHeaders: Record<string, string> = {};
const hubDb = new Database(":memory:");
const hubRegistry = new AppRegistry();
let peers: PeerHub;
// The bus on both sides: the peer's media app provides `clip` and publishes `clip.added`; the hub mirrors and forwards.
let peerEvents: Store;
let hubEvents: Store;
const mirrored: { peer: string; app: string; name: string }[] = [];

// The hub's fetch: the real one towards the peer, with a switch that simulates the peer being unreachable.
const hubFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (outage) throw new Error("connect ECONNREFUSED");
  lastHeaders = Object.fromEntries(new Headers(init?.headers).entries());
  return fetch(input, init);
}) as typeof fetch;

beforeAll(async () => {
  // ---- the peer: one app with a page, a service, an agent, two widgets
  const peerHome = await realpath(await mkdtemp(join(tmpdir(), "space-peer-")));
  const pws = workspacePaths(peerHome);
  mediaDir = join(pws.apps, "media");
  await mkdir(join(mediaDir, "agents", ".git"), { recursive: true });
  await mkdir(join(mediaDir, ".git"), { recursive: true });
  await writeFile(
    join(mediaDir, "space.yaml"),
    `name: media
title: Media
description: Clips and streams.
icon: icon.svg
url: https://media.example.com
service: { command: bun src/index.ts, port: 8731, health: /healthz }
agents:
  - { name: helper, title: Helper, prompt: agents/helper.md, tools: [Read] }
widgets:
  - { name: latest, title: Media · Latest, source: /api/latest, link: /#latest }
  - { name: board, kind: embed, source: /board }
`,
  );
  await writeFile(join(mediaDir, "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(join(mediaDir, "agents", "helper.md"), "You help with media.");
  await mkdir(join(pws.apps, "secret"), { recursive: true });
  await writeFile(join(pws.apps, "secret", "space.yaml"), "name: secret\nurl: https://secret.example.com\n");
  await writeFile(join(peerHome, "fake-claude.js"), FAKE_CLI);
  const runtimes = claudeOnly(["bun", join(peerHome, "fake-claude.js")]);
  const peerRegistry = new AppRegistry();
  for (const n of ["media", "secret"]) await peerRegistry.set(await loadManifest(join(pws.apps, n)));
  const peerDb = new Database(":memory:");
  const peerLayout = new LayoutStore(peerDb);
  peerLayout.hide("secret", true); // hidden on the peer: never reaches the hub
  const peerPanel = createPanelRoutes({ ws: pws, registry: peerRegistry, layout: peerLayout, widgets: new WidgetFeed(peerRegistry, { fetch: fakeLoopback }), health: new HealthProbe({ fetch: fakeLoopback }), onCreate: async () => {}, onRemove: async () => {}, fetch: fakeLoopback });
  const peerAgents = createAgentRoutes({ ws: pws, registry: peerRegistry, layout: peerLayout, sessions: new SessionStore(peerDb), runtimes, defaultModel: "sonnet", home: peerHome });
  peerEvents = new Store(":memory:");
  // The port is fixed here: an earlier test uninstalls media from the peer's registry, the bus keeps its manifest until re-sync.
  const peerBus = new Bus({
    store: new BusStore(":memory:"),
    events: peerEvents,
    servicePort: (app) => (app === "media" ? 8731 : undefined),
    fetch: async (url, init) => Response.json({ echo: new Headers(init.headers).get("x-space-caller"), url }),
    log: () => {},
  });
  peerBus.syncApp("media", { events: { publishes: [{ name: "clip.added" }], consumes: [] }, provides: [{ name: "clip", method: "POST", path: "/api/clip", timeoutMs: 5000 }] });
  // The peer routes may upgrade a socket (the terminal's), so the server declares a websocket handler.
  peerServer = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: { ...peerPanel, ...peerAgents, ...createPeerServeRoutes({ token: "s3cret", name: "peer-box", panel: peerPanel, agents: peerAgents, servicePort: (app) => peerRegistry.get(app)?.manifest.service?.port, fetch: fakeLoopback, bus: peerBus, events: peerEvents }) }, websocket: { message() {} } });
  peerBase = `http://127.0.0.1:${peerServer.port}`;

  // ---- the hub: a local app, a link app that duplicates the peer's app, and the peer
  hubHome = await realpath(await mkdtemp(join(tmpdir(), "space-hub-")));
  const hws = workspacePaths(hubHome);
  await mkdir(join(hws.apps, "notes", ".git"), { recursive: true });
  await writeFile(join(hws.apps, "notes", "space.yaml"), "name: notes\ntitle: Notes\nicon: '📝'\nurl: https://notes.example.com\nagents:\n  - { name: librarian }\n");
  await mkdir(join(hws.apps, "media-link"), { recursive: true });
  await writeFile(join(hws.apps, "media-link", "space.yaml"), "name: media-link\ntitle: Media (link)\nicon: '🎬'\nurl: https://media.example.com\n");
  for (const n of ["notes", "media-link"]) await hubRegistry.set(await loadManifest(join(hws.apps, n)));
  const layout = new LayoutStore(hubDb);
  hubEvents = new Store(":memory:");
  peers = new PeerHub([{ name: "david", url: peerBase, token: "s3cret", headers: { "X-Access": "svc" }, refreshMs: 10_000 }], {
    store: new PeerStore(hubDb),
    fetch: hubFetch,
    now: () => clock,
    onEvents: (peer, list) => {
      for (const e of list) {
        hubEvents.addEvent(e, e.at ?? clock);
        mirrored.push({ peer, app: e.app, name: e.name });
      }
    },
  });
  const hubBus = new Bus({ store: new BusStore(":memory:"), events: hubEvents, servicePort: () => undefined, log: () => {} });
  const hubBusRoutes = createBusRoutes({ bus: hubBus, store: new BusStore(":memory:"), events: hubEvents, remote: { name: "hub-box", capabilities: () => peers.capabilities(), providerOf: (a, c) => peers.providerOf(a, c), get: (n) => peers.get(n) } });
  const hubPanel = createPanelRoutes({ ws: hws, registry: hubRegistry, layout, widgets: new WidgetFeed(hubRegistry, { fetch: fakeLoopback }), health: new HealthProbe({ fetch: fakeLoopback }), onCreate: async () => {}, onRemove: async () => {}, fetch: fakeLoopback, peers });
  const hubAgents = createAgentRoutes({ ws: hws, registry: hubRegistry, layout, sessions: new SessionStore(hubDb), runtimes, defaultModel: "sonnet", home: hubHome, peers });
  // The hub also serves as a peer (a hub of hubs), to check its snapshot carries only its own entries.
  hubServer = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: { ...hubPanel, ...hubAgents, ...hubBusRoutes, ...createPeerRoutes({ hub: peers, layout, registry: hubRegistry }), ...createPeerServeRoutes({ token: "hubtok", name: "hub-box", panel: hubPanel, agents: hubAgents, events: hubEvents }) }, websocket: { message() {} } });
  hub = `http://127.0.0.1:${hubServer.port}`;
});

afterAll(() => {
  peers.stop();
  peerServer.stop(true);
  hubServer.stop(true);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const get = (base: string, path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Body }));
const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const events = async (r: Response) =>
  (await r.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

describe("peer config", () => {
  test("reads SPACE_PEER_* with companions; malformed peers are reported, not thrown", () => {
    const { peers, errors } = loadPeers({
      SPACE_PEER_DAVID: "https://space-david.example.com/",
      SPACE_PEER_DAVID_TOKEN: " tok ",
      SPACE_PEER_DAVID_HEADERS: "CF-Access-Client-Id: id; CF-Access-Client-Secret: sec",
      SPACE_PEER_DAVID_REFRESH: "1m",
      SPACE_PEER_MY_LAPTOP: "http://127.0.0.1:8701",
      SPACE_PEER_BAD: "ftp://x",
      SPACE_PEER_ORPHAN_TOKEN: "t",
      SPACE_PEER_TOO_FAST_REFRESH: "1s",
      SPACE_PEER_TOO_FAST: "http://h",
      SPACE_HUB_TOKEN: "mine",
      SPACE_API_TOKEN: "x",
    });
    expect(peers).toEqual([
      { name: "david", url: "https://space-david.example.com", token: "tok", headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "sec" }, refreshMs: 60_000 },
      { name: "my-laptop", url: "http://127.0.0.1:8701", token: "", headers: {}, refreshMs: 30_000 },
      { name: "too-fast", url: "http://h", token: "", headers: {}, refreshMs: 10_000 },
    ]);
    expect([...errors.keys()].sort()).toEqual(["bad", "orphan"]);
    expect(errors.get("bad")).toContain("http");
    expect(parseRefresh(undefined)).toBe(30_000);
    expect(parseRefresh("500ms")).toBe(10_000);
    expect(() => parseHeaders("nonsense")).toThrow();
    expect(peerRoute("david", "/api/apps/media/icon")).toBe("/api/peers/david/apps/media/icon");
    expect(peerRoute("david", "🎬")).toBe("🎬");
    expect(peerRoute("david", "https://x/icon.png")).toBe("https://x/icon.png");
  });
});

describe("peer side", () => {
  test("/api/peer/* needs the bearer token; the snapshot bundles the visible lists without the space agent", async () => {
    expect((await get(peerBase, "/api/peer/snapshot")).status).toBe(401);
    expect((await get(peerBase, "/api/peer/snapshot", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const r = await get(peerBase, "/api/peer/snapshot", { headers: { authorization: "Bearer s3cret" } });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe("peer-box");
    expect(r.body.apps.map((a: Body) => a.name)).toEqual(["media"]);
    expect(r.body.agents.map((a: Body) => a.id)).toEqual(["media/helper"]);
    expect(r.body.widgets.map((w: Body) => w.id)).toEqual(["media/board", "media/latest"]);
    expect(r.body.services).toEqual([{ app: "media", title: "Media", icon: "/api/apps/media/icon", port: 8731, health: "ok", status: "active", hidden: false }]);
    expect(typeof r.body.asOf).toBe("string");
    expect((await fetch(`${peerBase}/api/peer/apps/media/icon`)).status).toBe(401);
    expect((await get(peerBase, "/api/peer/apps/media/appcolor", { headers: { authorization: "Bearer s3cret" } })).body).toEqual({ ok: true, color: "#abcdef" });
  });
});

describe("hub", () => {
  test("before the first snapshot the panel is local only and the peer reads down", async () => {
    expect((await get(hub, "/api/apps")).body.apps.map((a: Body) => a.id)).toEqual(["media-link", "notes"]);
    const p = (await get(hub, "/api/peers")).body.peers[0];
    expect(p).toMatchObject({ name: "david", health: "down", stale: true, apps: 0, duplicates: [] });
    expect(p).not.toHaveProperty("asOf");
  });

  test("merges the peer's apps, agents, widgets and services under its name, local entries first", async () => {
    await peers.refreshAll();
    expect(lastHeaders).toMatchObject({ authorization: "Bearer s3cret", "x-access": "svc" });
    const apps = (await get(hub, "/api/apps")).body.apps;
    expect(apps.map((a: Body) => a.id)).toEqual(["media-link", "notes", "david/media"]);
    const media = apps[2];
    expect(media).toMatchObject({ id: "david/media", name: "media", peer: "david", stale: false, title: "Media", icon: "/api/peers/david/apps/media/icon", url: "https://media.example.com", manifestOnly: false, hidden: false, service: { port: 8731, health: "ok" } });
    expect(media.agents[0]).toMatchObject({ id: "david/media/helper", app: "media", name: "helper", peer: "david", avatar: "/api/peers/david/apps/media/icon" });
    expect(media.widgets.map((w: Body) => w.id)).toEqual(["david/media/latest", "david/media/board"]);

    const agents = (await get(hub, "/api/agents")).body.agents;
    expect(agents.map((a: Body) => a.id)).toEqual(["notes/librarian", "space/assistant", "david/media/helper"]);

    const widgets = (await get(hub, "/api/widgets")).body.widgets;
    expect(widgets.map((w: Body) => w.id)).toEqual(["david/media/board", "david/media/latest"]);
    expect(widgets[1]).toMatchObject({ peer: "david", app: "media", name: "latest", stale: false, ok: true, items: [{ text: "Clip one" }], icon: "/api/peers/david/apps/media/icon" });

    const services = await get(hub, "/api/services");
    expect(services.body.services).toEqual([{ app: "media", peer: "david", title: "Media", icon: "/api/peers/david/apps/media/icon", port: 8731, health: "ok", status: "active", hidden: false }]);
    expect(services.body.peers[0]).toMatchObject({ name: "david", health: "ok", stale: false, apps: 1, agents: 1, widgets: 2, services: 1 });

    const p = (await get(hub, "/api/peers")).body.peers[0];
    expect(p).toMatchObject({ name: "david", url: peerBase, health: "ok", duplicates: ["media-link"] });
    expect(typeof p.asOf).toBe("string");

    // Served as a peer itself, the hub hands out only what lives on it: david's entries stay out.
    const own = await get(hub, "/api/peer/snapshot", { headers: { authorization: "Bearer hubtok" } });
    expect(own.body.apps.map((a: Body) => a.id)).toEqual(["media-link", "notes"]);
    expect(own.body.agents.map((a: Body) => a.id)).toEqual(["notes/librarian"]);
    expect(own.body.widgets).toEqual([]);
    expect(own.body.services).toEqual([]);
  });

  test("forwards icons, embed pages, chat and sessions to the peer; nothing else", async () => {
    const icon = await fetch(`${hub}/api/peers/david/apps/media/icon`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toContain("svg");
    expect((await fetch(`${hub}/api/peers/david/agents/media/helper/avatar`)).status).toBe(200);
    expect(await (await fetch(`${hub}/api/peers/david/widgets/media/board/embed?theme=dark`)).text()).toBe("<html>board dark</html>");
    expect((await get(hub, "/api/peers/david/apps/media/appcolor")).body).toEqual({ ok: true, color: "#abcdef" });

    const chat = await fetch(`${hub}/api/peers/david/agents/media/helper/chat`, jsonInit("POST", { message: "hello" }));
    expect(chat.headers.get("content-type")).toContain("text/event-stream");
    const ev = await events(chat);
    expect(ev[0]).toMatchObject({ type: "system", session_id: "cafe0001-0000-4000-8000-000000000000" });
    expect(String((ev[1] as { message: { content: { text: string }[] } }).message.content[0]!.text)).toContain(`cwd=${mediaDir}`);
    expect(ev.at(-1)).toEqual({ type: "done" });
    expect((await get(hub, "/api/peers/david/agents/media/helper/sessions")).body.sessions).toMatchObject([{ sid: "cafe0001-0000-4000-8000-000000000000", title: "hello" }]);
    expect((await get(hub, "/api/peers/david/agents/media/nobody/sessions")).status).toBe(404);

    // A peer app's own API, read by an app on the hub: only GET, only /api/, only apps with a service.
    const proxied = await get(hub, "/api/peers/david/apps/media/proxy/api/latest?since=1");
    expect(proxied.status).toBe(200);
    expect(proxied.body.items[0].text).toBe("Clip one");
    expect((await fetch(`${hub}/api/peers/david/apps/notes-link/proxy/api/latest`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/david/apps/media/proxy/board`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/david/apps/media/proxy/api/latest`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${peerBase}/api/peer/apps/media/proxy/api/latest`)).status).toBe(401);

    expect((await fetch(`${hub}/api/peers/nope/apps/media/icon`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/david/apps/media`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/david/panel/layout`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/david/apps`, jsonInit("POST", { name: "x" }))).status).toBe(404);
  });

  test("hides a peer app on the hub only; its agents and widgets follow", async () => {
    const hide = await get(hub, "/api/peers/david/apps/media", jsonInit("PATCH", { hidden: true }));
    expect(hide.status).toBe(200);
    expect(hide.body.app).toMatchObject({ id: "david/media", hidden: true });
    expect((await get(hub, "/api/apps")).body.apps.map((a: Body) => a.id)).toEqual(["media-link", "notes"]);
    expect((await get(hub, "/api/apps?all=1")).body.apps.map((a: Body) => a.id)).toEqual(["media-link", "notes", "david/media"]);
    expect((await get(hub, "/api/agents")).body.agents.map((a: Body) => a.id)).toEqual(["notes/librarian", "space/assistant"]);
    expect((await get(hub, "/api/widgets")).body.widgets).toEqual([]);
    expect((await get(hub, "/api/services")).body.services[0]).toMatchObject({ app: "media", peer: "david", hidden: true });
    // The peer itself is untouched.
    expect((await get(peerBase, "/api/apps")).body.apps.map((a: Body) => a.name)).toEqual(["media"]);
    expect((await get(hub, "/api/peers/david/apps/media", jsonInit("PATCH", { hidden: "x" }))).status).toBe(400);
    expect((await get(hub, "/api/peers/david/apps/ghost", jsonInit("PATCH", { hidden: true }))).status).toBe(404);
    expect((await get(hub, "/api/peers/david/apps/media", jsonInit("PATCH", { hidden: false }))).body.app.hidden).toBe(false);
  });

  test("layout order applies to peer entries by their prefixed id", async () => {
    await get(hub, "/api/panel/layout", jsonInit("PUT", { order: { apps: ["david/media", "notes"] } }));
    expect((await get(hub, "/api/apps")).body.apps.map((a: Body) => a.id)).toEqual(["david/media", "notes", "media-link"]);
    await get(hub, "/api/panel/layout", jsonInit("PUT", { order: { apps: [] } }));
  });

  test("a peer that stops answering keeps its last snapshot, muted and without health claims", async () => {
    outage = true;
    clock += 25_000; // beyond two refresh periods
    await peers.refreshAll();
    const p = (await get(hub, "/api/peers")).body.peers[0];
    expect(p).toMatchObject({ name: "david", health: "down", stale: true, error: expect.stringContaining("ECONNREFUSED"), apps: 1 });
    const media = (await get(hub, "/api/apps")).body.apps.find((a: Body) => a.id === "david/media");
    expect(media).toMatchObject({ stale: true, service: { port: 8731, health: "unknown" } });
    expect((await get(hub, "/api/widgets")).body.widgets[1]).toMatchObject({ id: "david/media/latest", stale: true, ok: true });
    expect((await get(hub, "/api/services")).body.services[0]).toMatchObject({ peer: "david", health: "unknown" });
    const r = await get(hub, "/api/peers/david/apps/media/icon");
    expect(r.status).toBe(502);
    expect(r.body.error).toContain("david unreachable");

    outage = false;
    await peers.refreshAll();
    expect((await get(hub, "/api/peers")).body.peers[0]).toMatchObject({ health: "ok", stale: false });
    expect((await get(hub, "/api/peers")).body.peers[0]).not.toHaveProperty("error");
  });

  test("a token the peer rejects is reported as such", async () => {
    const bad = new PeerHub([{ name: "x", url: peerBase, token: "wrong", headers: {}, refreshMs: 10_000 }], { fetch: hubFetch });
    await bad.refreshAll();
    expect(bad.status()[0]).toMatchObject({ health: "down", error: "token rejected", apps: 0 });
  });

  test("the last snapshot survives a hub restart and is listed as stale until refreshed", async () => {
    const again = new PeerHub([{ name: "david", url: peerBase, token: "s3cret", headers: {}, refreshMs: 10_000 }], { store: new PeerStore(hubDb), fetch: hubFetch, now: () => clock });
    expect(again.status()[0]).toMatchObject({ health: "down", stale: true, apps: 1 });
    expect(again.apps(new Set())[0]).toMatchObject({ id: "david/media", stale: true, service: { health: "unknown" } });
    await again.refreshAll();
    expect(again.status()[0]).toMatchObject({ health: "ok", stale: false });
    // A peer dropped from the configuration loses its stored snapshot.
    new PeerHub([], { store: new PeerStore(hubDb) });
    expect(new PeerStore(hubDb).get("david")).toBeUndefined();
  });

  test("uninstalls a peer app through the hub; the merged lists drop it at once", async () => {
    await peers.refreshAll();
    expect((await get(hub, "/api/peers/david/apps/ghost", { method: "DELETE" })).status).toBe(404);
    const del = await get(hub, "/api/peers/david/apps/media", { method: "DELETE" });
    expect(del.status).toBe(200);
    // The peer has no stop command configured: the directory still leaves its workspace.
    expect(del.body).toMatchObject({ ok: true, app: "media", stopped: "unconfigured", dir: { kind: "moved" } });
    expect((await get(peerBase, "/api/apps")).body.apps).toEqual([]);
    expect((await get(hub, "/api/apps?all=1")).body.apps.map((a: Body) => a.id)).toEqual(["media-link", "notes"]);
    expect((await get(hub, "/api/services")).body.services).toEqual([]);
    expect((await get(hub, "/api/peers/david/apps/media", { method: "DELETE" })).status).toBe(404);
  });
});

describe("bus over peers", () => {
  const auth = { headers: { authorization: "Bearer s3cret" } };

  test("the peer exports the events published there (not mirrored ones) after an id, and its snapshot lists capabilities", async () => {
    const a = peerEvents.addEvent({ app: "media", name: "clip.added", data: { id: "c1" } }, 5_000);
    peerEvents.addEvent({ app: "other", name: "x", peer: "elsewhere" }, 6_000);
    expect((await get(peerBase, "/api/peer/events")).status).toBe(401);
    const r = await get(peerBase, "/api/peer/events?since=0", auth);
    expect(r.body.events).toEqual([{ id: a.id, name: "media/clip.added", app: "media", at: new Date(5_000).toISOString(), data: { id: "c1" } }]);
    expect(r.body.latestId).toBe(a.id + 1);
    expect((await get(peerBase, `/api/peer/events?since=${a.id}`, auth)).body.events).toEqual([]);
    const snap = await get(peerBase, "/api/peer/snapshot", auth);
    expect(snap.body.capabilities).toEqual([{ app: "media", provides: [{ name: "clip", method: "POST", path: "/api/clip", timeoutMs: 5000 }], publishes: [{ name: "clip.added" }], consumes: [] }]);
  });

  test("the hub mirrors the peer's events on refresh, each once, and keeps the cursor in its store", async () => {
    outage = false;
    await peers.refreshAll();
    expect(mirrored).toEqual([{ peer: "david", app: "media", name: "clip.added" }]);
    expect(hubEvents.listEvents({ app: "media" })[0]).toMatchObject({ name: "media/clip.added", app: "media", peer: "david", at: 5_000, data: { id: "c1" } });
    await peers.refreshAll();
    expect(mirrored).toHaveLength(1);
    const b = peerEvents.addEvent({ app: "media", name: "clip.added", data: { id: "c2" } }, 7_000);
    await peers.refreshAll();
    expect(mirrored).toHaveLength(2);
    expect(new PeerStore(hubDb).cursor("david")).toBe(b.id);
    // The hub, serving as a peer itself, does not pass mirrored events on.
    expect((await get(hub, "/api/peer/events?since=0", { headers: { authorization: "Bearer hubtok" } })).body.events).toEqual([]);
  });

  test("a call to an app only the peer provides is forwarded there as <hub>/<caller>, and the catalogue merges the peer's", async () => {
    const r = await fetch(`${hub}/api/call/media/clip`, jsonInit("POST", { n: 1 }));
    expect(r.status).toBe(200);
    expect(r.headers.get("x-space-call-peer")).toBe("david");
    expect(await r.json()).toEqual({ echo: "hub-box/space", url: "http://127.0.0.1:8731/api/clip" });
    expect((await fetch(`${hub}/api/call/david/media/clip`, { method: "POST" })).status).toBe(200);
    expect((await get(hub, "/api/call/nowhere/media/clip", { method: "POST" })).status).toBe(404);
    expect((await get(hub, "/api/call/media/nope", { method: "POST" })).status).toBe(404);
    expect((await get(peerBase, "/api/peer/call/media/clip", { method: "POST", headers: { authorization: "Bearer s3cret" } })).status).toBe(400);
    const cat = await get(hub, "/api/capabilities");
    expect(cat.body.apps.map((a: Body) => a.app)).toContain("david/media");
    expect(cat.body.apps.find((a: Body) => a.app === "david/media")).toMatchObject({ peer: "david", provides: [{ name: "clip" }] });
    expect((await get(hub, "/api/calls?app=david/media")).body.calls[0]).toMatchObject({ caller: "space", app: "david/media", capability: "clip", status: 200, ok: true });
  });
});

describe("one tile per url", () => {
  const app = (id: string, url: string | undefined, extra: Partial<AppView> = {}): AppView =>
    ({ id, name: id.split("/").at(-1)!, title: id, icon: "x", status: "active", manifestOnly: false, hidden: false, agents: [], widgets: [], ...(url ? { url } : {}), ...extra }) as AppView;
  test("a peer app with a local real app's url, or an earlier peer's, is dropped; link apps and url-less entries do not count", () => {
    const local = [app("usage", "https://usage.example.com/?lang={lang}"), app("media-link", "https://media.example.com", { manifestOnly: true }), app("agent-only", undefined)];
    const remote = [app("a/usage", "https://usage.example.com/?lang={lang}"), app("a/media", "https://media.example.com"), app("a/tool", "https://tool.example.com"), app("b/usage", "https://usage.example.com/?lang={lang}"), app("b/tool", "https://tool.example.com"), app("b/silent", undefined)];
    expect(dropSameUrl(local, remote).map((a) => a.id)).toEqual(["a/media", "a/tool", "b/silent"]);
  });
  test("widget cards follow the same rule by link", () => {
    const w = (id: string, link: string) => ({ id, app: id.split("/").at(-1)!, name: "n", title: "t", kind: "items", size: "1x1", link, icon: "x", items: [] }) as unknown as WidgetView;
    expect(dropSameLink([w("usage/usage", "https://usage.example.com/")], [w("a/usage/usage", "https://usage.example.com/"), w("a/media/latest", "https://media.example.com/#latest"), w("b/media/latest", "https://media.example.com/#latest")]).map((x) => x.id)).toEqual(["a/media/latest"]);
  });
});
