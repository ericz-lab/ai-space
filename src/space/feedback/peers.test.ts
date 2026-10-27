import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createFeedbackPeerServeRoutes, createFeedbackRoutes } from "./api.ts";
import { PeerFeedbackSync, holds, patchForPeer, type PeerLink, type PeerSettingsView } from "./peers.ts";
import { FeedbackService } from "./service.ts";
import { FeedbackStore } from "./store.ts";
import { TodoSink } from "./todo.ts";
import { DEFAULT_SETTINGS, type FeedbackSettings } from "./types.ts";

const app = (name: string) => ({ app: name, title: name, status: "active", enabled: false });

function peerView(over: Partial<PeerSettingsView> = {}): PeerSettingsView {
  return {
    settings: structuredClone(DEFAULT_SETTINGS),
    apps: [app("theme-watch"), app("ai-todo")],
    machines: [{ value: "", label: "laptop" }, { value: "hub", label: "hub" }],
    models: [{ value: "claude/intermediate" }],
    counts: { later: 0 },
    ...over,
  };
}

const hubSettings = (over: Partial<FeedbackSettings> = {}): FeedbackSettings => ({ ...structuredClone(DEFAULT_SETTINGS), enabled: true, ...over });

describe("patchForPeer", () => {
  test("the peer gets the hub's switches, and each of its own apps as the hub sets it", () => {
    const p = patchForPeer(hubSettings({ apps: { "theme-watch": "on", "only-on-hub": "off" }, mode: "later", effort: "high", errors: false }), "hub", { name: "laptop", view: peerView() });
    expect(p).toEqual({ enabled: true, appsDefault: true, mode: "later", effort: "high", errors: false, machine: "hub", model: "claude/intermediate", apps: { "theme-watch": "on", "ai-todo": "default" } });
  });

  test("Fix on: the peer's own name is its own machine; a machine it does not know is too", () => {
    expect(patchForPeer(hubSettings({ machine: "laptop" }), "hub", { name: "laptop", view: peerView() }).machine).toBe("");
    expect(patchForPeer(hubSettings({ machine: "elsewhere" }), "hub", { name: "laptop", view: peerView() }).machine).toBe("");
    // The hub itself ("" there) is named for a peer that knows the hub, and is the app's machine otherwise.
    expect(patchForPeer(hubSettings({ machine: "" }), "hub", { name: "laptop", view: peerView() }).machine).toBe("hub");
    expect(patchForPeer(hubSettings({ machine: "" }), "hub", { name: "laptop", view: peerView({ machines: [{ value: "", label: "laptop" }] }) }).machine).toBe("");
  });

  test("a model the peer does not offer leaves the peer's choice alone", () => {
    expect("model" in patchForPeer(hubSettings({ model: "codex/senior" }), "hub", { name: "laptop", view: peerView() })).toBe(false);
    expect(patchForPeer(hubSettings({ model: "" }), "hub", { name: "laptop", view: peerView() }).model).toBe("");
  });

  test("holds compares every field and treats a missing app as default", () => {
    const view = peerView();
    const patch = patchForPeer(hubSettings(), "hub", { name: "laptop", view });
    expect(holds(view.settings, patch)).toBe(false);
    const s = { ...view.settings, enabled: true, machine: "hub" };
    expect(holds(s, patch)).toBe(true);
    expect(holds(s, { ...patch, apps: { "ai-todo": "on" } })).toBe(false);
  });
});

/** A space with its feedback service and routes: the hub, or a peer reached through `link`. */
function space(name: string, apps: string[], opts: { peers?: PeerLink[]; machines?: string[] } = {}) {
  const store = new FeedbackStore(new Database(":memory:"));
  const service = new FeedbackService({
    store,
    name,
    app: (a) => (apps.includes(a) ? { title: a, hasDeployCheck: true } : undefined),
    todo: () => new TodoSink(async () => ({ status: 201, text: '{"ok":true,"todos":[{"id":1}]}' }), ""),
    fixer: { start: async () => "run-1", wait: () => new Promise(() => {}) },
    machines: () => opts.machines ?? [],
    log: () => {},
  });
  const lists = {
    service,
    apps: () => apps.map((a) => ({ app: a, title: a, status: a.startsWith("paused-") ? "paused" : "active" })),
    machines: () => [{ value: "", label: name }, ...(opts.machines ?? []).map((m) => ({ value: m, label: m }))],
    models: () => [{ value: "claude/intermediate", runtime: "claude", tier: "intermediate", model: "opus" }],
  };
  const sync = opts.peers ? new PeerFeedbackSync({ hubName: name, peers: () => opts.peers! }) : undefined;
  const routes = createFeedbackRoutes({ ...lists, script: async () => ({ js: "", etag: '"x"' }), ...(sync ? { peers: sync } : {}) }) as Record<string, Record<string, (r: Request) => Promise<Response>>>;
  const serve = createFeedbackPeerServeRoutes(lists) as Record<string, Record<string, (r: Request) => Promise<Response>>>;
  const call = async (method: string, path: string, body?: unknown) => {
    const url = new URL(path, "http://space.test");
    const res = await routes[url.pathname]![method]!(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }));
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  /** How the hub reaches this space: its `/api/peer/feedback*` routes, in process. */
  const link = (as: string, calls: string[] = []): PeerLink => ({
    name: as,
    request: async (path, init = {}) => {
      const url = new URL(path, "http://peer.test");
      calls.push(`${init.method ?? "GET"} ${url.pathname}`);
      const route = serve[url.pathname]?.[init.method ?? "GET"];
      if (!route) return new Response('{"ok":false,"error":"not found"}', { status: 404 });
      return route(new Request(url, { method: init.method ?? "GET", ...(init.body ? { body: init.body as string } : {}) }));
    },
  });
  return { service, store, call, link };
}

describe("a hub's settings reach the apps on its peers", () => {
  test("turning feedback on at the hub turns the button on for the peer's apps", async () => {
    const laptop = space("laptop", ["theme-watch", "ai-todo"], { machines: ["hub"] });
    const calls: string[] = [];
    const hub = space("hub", ["notes", "paused-x"], { peers: [laptop.link("laptop", calls)], machines: ["laptop"] });

    // The peer's own page asks the peer: off until the hub says otherwise.
    expect(laptop.service.config("theme-watch", "").enabled).toBe(false);
    const r = await hub.call("PUT", "/api/panel/feedback/settings", { enabled: true, apps: { "ai-todo": "off" }, machine: "laptop" });
    expect(r.status).toBe(200);
    expect(r.json.peers).toEqual([
      { name: "laptop", ok: true, synced: true, apps: [{ ...app("theme-watch"), enabled: true }, { ...app("ai-todo"), enabled: false }], counts: expect.any(Object) },
    ]);
    expect(laptop.service.config("theme-watch", "").enabled).toBe(true);
    expect(laptop.service.enabledFor("ai-todo")).toBe(false);
    // "Fix on laptop" is the laptop's own machine there.
    expect(laptop.service.settings().machine).toBe("");

    // Nothing to send when the peer already holds it.
    calls.length = 0;
    await hub.call("GET", "/api/panel/feedback/settings");
    expect(calls).toEqual(["GET /api/peer/feedback/settings"]);

    // A change made on the peer itself is put back the next time the hub's page is read.
    laptop.service.saveSettings({ enabled: false });
    await hub.call("GET", "/api/panel/feedback/settings");
    expect(laptop.service.settings().enabled).toBe(true);
  });

  test("an app paused here that runs on a peer is listed once, under the peer", async () => {
    const laptop = space("laptop", ["paused-x"]);
    const hub = space("hub", ["notes", "paused-x"], { peers: [laptop.link("laptop")] });
    const r = await hub.call("GET", "/api/panel/feedback/settings");
    expect(r.json.apps.map((a: { app: string }) => a.app)).toEqual(["notes"]);
    expect(r.json.peers[0].apps.map((a: { app: string }) => a.app)).toEqual(["paused-x"]);
  });

  test("a peer that cannot be reached, or runs an older ai-space, is shown, and the hub still saves", async () => {
    const down: PeerLink = { name: "far", request: async () => { throw new Error("connect refused"); } };
    const old: PeerLink = { name: "old", request: async () => new Response("Not found", { status: 404 }) };
    const hub = space("hub", ["notes"], { peers: [down, old] });
    const r = await hub.call("PUT", "/api/panel/feedback/settings", { enabled: true });
    expect(r.status).toBe(200);
    expect(r.json.settings.enabled).toBe(true);
    expect(r.json.peers.map((p: { name: string; ok: boolean; error: string }) => [p.name, p.ok, p.error])).toEqual([
      ["far", false, "unreachable: connect refused"],
      ["old", false, "its ai-space has no feedback for a hub yet (upgrade it)"],
    ]);
  });

  test("the peers' recent feedback is listed with the hub's, and Fix now reaches the peer", async () => {
    const laptop = space("laptop", ["theme-watch"]);
    const hub = space("hub", ["notes"], { peers: [laptop.link("laptop")] });
    await hub.call("PUT", "/api/panel/feedback/settings", { enabled: true, mode: "later" });
    const ctx = { url: "https://t.example/", path: "/", title: "t", viewport: { w: 1, h: 1, dpr: 1 }, touch: false, theme: "light", lang: "en", elements: [], errors: [], tz: "UTC" };
    await laptop.service.submit("theme-watch", { text: "the chart is cut off", context: ctx }, "");
    await hub.service.submit("notes", { text: "typo", context: ctx }, "");

    const list = await hub.call("GET", "/api/panel/feedback?limit=10");
    expect(list.json.items.map((i: { app: string; peer: string }) => [i.app, i.peer]).sort()).toEqual([["notes", ""], ["theme-watch", "laptop"]]);
    const view = await hub.call("GET", "/api/panel/feedback/settings");
    expect(view.json.peers[0].counts.later).toBe(1);

    const fixed = await hub.call("POST", "/api/panel/feedback/fix", { peer: "laptop" });
    expect(fixed.json).toEqual({ ok: true, queued: 1 });
    expect(laptop.store.list({ app: "theme-watch" })[0]!.status).not.toBe("later");
    expect(hub.store.list({ app: "notes" })[0]!.status).toBe("later");

    expect((await hub.call("POST", "/api/panel/feedback/fix", { peer: "nobody" })).status).toBe(404);
  });
});

describe("the peer side", () => {
  test("needs the hub's token and leaves out the apps legacy peers do not share", async () => {
    const { createPeerServeRoutes } = await import("../peers/serve.ts");
    const laptop = space("laptop", ["theme-watch", "packaged"]);
    const feedback = createFeedbackPeerServeRoutes({
      service: laptop.service,
      apps: () => [{ app: "theme-watch", title: "theme-watch", status: "active" }, { app: "packaged", title: "packaged", status: "active" }],
      machines: () => [{ value: "", label: "laptop" }],
      models: () => [],
    });
    // Every other mirrored route only has to exist here.
    const any = new Proxy({}, { get: () => ({ GET: () => new Response(), POST: () => new Response(), PATCH: () => new Response(), DELETE: () => new Response() }) });
    const routes = createPeerServeRoutes({ token: "tok", name: "laptop", panel: any, agents: any, feedback, allowApp: (a) => a !== "packaged" }) as Record<string, Record<string, (r: Request & { params: Record<string, string> }, s: unknown) => Promise<Response>>>;
    const call = (method: string, path: string, auth?: string, body?: unknown) =>
      routes[path]![method]!(Object.assign(new Request(`http://peer.test${path}`, { method, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: {} }), undefined);
    expect((await call("GET", "/api/peer/feedback/settings")).status).toBe(401);
    expect((await call("PUT", "/api/peer/feedback/settings", "wrong", { enabled: true })).status).toBe(401);
    const r = await call("GET", "/api/peer/feedback/settings", "tok");
    expect(((await r.json()) as { apps: { app: string }[] }).apps.map((a) => a.app)).toEqual(["theme-watch"]);
    const put = await call("PUT", "/api/peer/feedback/settings", "tok", { enabled: true });
    expect(put.status).toBe(200);
    expect(laptop.service.settings().enabled).toBe(true);
  });
});
