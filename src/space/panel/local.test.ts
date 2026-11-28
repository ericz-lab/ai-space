import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEnvOverrides, loopbackUrl } from "../defaults.ts";
import { localViewer } from "../hosts.ts";
import type { PeerHub } from "../peers/hub.ts";
import { createPeerServeRoutes } from "../peers/serve.ts";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { createPanelRoutes } from "./api.ts";
import { HealthProbe } from "./health.ts";
import { LayoutStore } from "./layout.ts";
import { PetFeed } from "./pets.ts";
import { AppRegistry } from "./registry.ts";
import type { AppView } from "./view.ts";
import { WidgetFeed } from "./widgets.ts";

// A viewer at the app's own machine opens it on loopback (docs/router.md#a-viewer-on-this-machine).

const DOMAIN = "example.com";
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/widget")) return Response.json({ ok: true, items: [{ text: "One", url: "/n/1" }, { text: "Elsewhere", url: "https://other.example.org/x" }], blocks: [{ type: "metric", label: "N", value: 1, url: "/?f=1" }] });
  if (url.endsWith("/api/mood")) return Response.json({ ok: true, animation: "idle", link: "/today" });
  return new Response("ok");
}) as typeof fetch;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
type H = (req: Request & { params: Record<string, string> }, server?: unknown) => Response | Promise<Response | undefined> | undefined;
const loopback = { requestIP: () => ({ address: "127.0.0.1" }) };
const viaTunnel = { "x-forwarded-for": "203.0.113.9" };

/** One registry and one panel per switch setting; the peer is a stub hub with one app. */
async function panel(on: boolean) {
  const home = await mkdtemp(join(tmpdir(), "space-local-"));
  const ws = workspacePaths(home);
  const registry = new AppRegistry();
  const write = async (name: string, yaml: string) => {
    await mkdir(join(ws.apps, name), { recursive: true });
    await writeFile(join(ws.apps, name, "space.yaml"), yaml);
    return loadManifest(join(ws.apps, name));
  };
  const env = { SPACE_APP_URL_USAGE: "https://usage.hub.example.net/" };
  const register = async (name: string, yaml: string) => {
    const m = await write(name, yaml);
    await registry.set(applyEnvOverrides(m, env, { domain: DOMAIN }), { localUrl: loopbackUrl(m, env, { domain: DOMAIN }) });
  };
  await register("notes", "name: notes\nurl: /docs\nservice: { command: x, port: 8712 }\nwidgets:\n  - { name: recent, source: /api/widget, link: /#recent }\npets:\n  - { name: cat, sheet: /a.png, grid: 1x2, animations: { walk: { row: 0, frames: 1, ms: 500 }, idle: { row: 1, frames: 1, ms: 500 } }, rest: idle, mood: /api/mood }\n");
  await register("usage", "name: usage\nurl: /\nservice: { command: x, port: 8720 }\n");
  await register("site", "name: site\nurl: https://site.example.org/\nservice: { command: x, port: 8730 }\n");
  const peerApp = { id: "david/notes", name: "notes", peer: "david", title: "Notes", icon: "", url: "https://notes.david.example.net/docs", status: "active", manifestOnly: false, hidden: false, agents: [], widgets: [] } as AppView;
  const peers = { apps: () => [peerApp], widgets: () => [], services: () => [], status: () => [], agents: () => [] } as unknown as PeerHub;
  const routes = createPanelRoutes({
    ws, registry, layout: new LayoutStore(new Database(":memory:")), widgets: new WidgetFeed(registry, { fetch: fakeFetch }), pets: new PetFeed(registry, { fetch: fakeFetch }),
    health: new HealthProbe({ fetch: fakeFetch }), onCreate: async () => {}, onRemove: async () => {}, fetch: fakeFetch, peers,
    localViewer: (req, server) => localViewer(req, server, on),
  }) as unknown as Record<string, Record<string, H>>;
  const get = async (path: string, server: unknown, headers: Record<string, string> = {}): Promise<Body> => {
    const req = Object.assign(new Request(`http://127.0.0.1:8700${path}`, { headers }), { params: { app: "notes", name: "cat" } });
    const route = { "/api/apps/notes": "/api/apps/:app", "/api/pets/notes/cat/mood": "/api/pets/:app/:name/mood" }[path] ?? path;
    return (await routes[route]!.GET!(req, server))!.json();
  };
  const post = async (path: string, server: unknown): Promise<Body> => {
    const req = Object.assign(new Request(`http://127.0.0.1:8700${path}`, { method: "POST" }), { params: { app: "notes", name: "recent" } });
    return (await routes["/api/widgets/:app/:name/refresh"]!.POST!(req, server))!.json();
  };
  return { routes, get, post, registry };
}

let on: Awaited<ReturnType<typeof panel>>;
let off: Awaited<ReturnType<typeof panel>>;
beforeAll(async () => {
  on = await panel(true);
  off = await panel(false);
});

const byName = (apps: Body[], id: string) => apps.find((a) => a.id === id);

describe("a viewer at this machine", () => {
  test("loopbackUrl: only a path url with a port that a domain made public, and no override", async () => {
    expect(on.registry.get("notes")?.manifest.url).toBe("https://notes.example.com/docs");
    expect(on.registry.get("notes")?.localUrl).toBe("http://127.0.0.1:8712/docs");
    expect(on.registry.get("usage")?.localUrl).toBeUndefined();
    expect(on.registry.get("site")?.localUrl).toBeUndefined();
  });

  test("GET /api/apps gives a loopback request the loopback url and its widget links; a forwarded one the public", async () => {
    const local = (await on.get("/api/apps", loopback)).apps;
    expect(byName(local, "notes")).toMatchObject({ url: "http://127.0.0.1:8712/docs", widgets: [{ link: "http://127.0.0.1:8712/#recent" }] });
    expect(byName(local, "usage").url).toBe("https://usage.hub.example.net/");
    expect(byName(local, "site").url).toBe("https://site.example.org/");
    // A peer app is never rewritten.
    expect(byName(local, "david/notes").url).toBe("https://notes.david.example.net/docs");
    const remote = (await on.get("/api/apps", loopback, viaTunnel)).apps;
    expect(byName(remote, "notes")).toMatchObject({ url: "https://notes.example.com/docs", widgets: [{ link: "https://notes.example.com/#recent" }] });
    expect(byName(await on.get("/api/apps", { requestIP: () => ({ address: "192.168.1.5" }) }).then((b) => b.apps), "notes").url).toBe("https://notes.example.com/docs");
    expect((await on.get("/api/apps/notes", loopback)).app.url).toBe("http://127.0.0.1:8712/docs");
    expect((await on.get("/api/apps/notes", loopback, viaTunnel)).app.url).toBe("https://notes.example.com/docs");
  });

  test("widget payload links follow the viewer, from one cached read", async () => {
    const local = (await on.get("/api/widgets", loopback)).widgets[0];
    expect(local).toMatchObject({ link: "http://127.0.0.1:8712/#recent", items: [{ url: "http://127.0.0.1:8712/n/1" }, { url: "https://other.example.org/x" }], blocks: [{ url: "http://127.0.0.1:8712/?f=1" }] });
    const remote = (await on.get("/api/widgets", loopback, viaTunnel)).widgets[0];
    expect(remote).toMatchObject({ link: "https://notes.example.com/#recent", items: [{ url: "https://notes.example.com/n/1" }, { url: "https://other.example.org/x" }], blocks: [{ url: "https://notes.example.com/?f=1" }] });
    expect((await on.post("/api/widgets/notes/recent/refresh", loopback)).widget.items[0].url).toBe("http://127.0.0.1:8712/n/1");
    expect((await on.post("/api/widgets/notes/recent/refresh", undefined)).widget.items[0].url).toBe("https://notes.example.com/n/1");
  });

  test("a pet's link follows the viewer", async () => {
    expect((await on.get("/api/pets/notes/cat/mood", loopback)).link).toBe("http://127.0.0.1:8712/today");
    expect((await on.get("/api/pets/notes/cat/mood", loopback, viaTunnel)).link).toBe("https://notes.example.com/today");
  });

  test("SPACE_LOCAL_OPEN=off gives everyone the public url", async () => {
    const apps = (await off.get("/api/apps", loopback)).apps;
    expect(byName(apps, "notes")).toMatchObject({ url: "https://notes.example.com/docs", widgets: [{ link: "https://notes.example.com/#recent" }] });
    expect((await off.get("/api/widgets", loopback)).widgets[0].items[0].url).toBe("https://notes.example.com/n/1");
  });

  test("the peer snapshot always carries the public url, whatever address the hub's request came from", async () => {
    // Every agent route the peer side mirrors answers an empty list.
    const empty = () => Response.json({ ok: true, agents: [] });
    const agents = new Proxy({}, { get: () => ({ GET: empty, POST: empty }) });
    const serve = createPeerServeRoutes({ token: "s3cret", name: "box", panel: on.routes as never, agents: agents as never }) as unknown as Record<string, Record<string, H>>;
    const req = Object.assign(new Request("http://127.0.0.1:8700/api/peer/snapshot", { headers: { authorization: "Bearer s3cret" } }), { params: {} });
    const snap = (await (await serve["/api/peer/snapshot"]!.GET!(req, loopback))!.json()) as Body;
    expect(byName(snap.apps, "notes")).toMatchObject({ url: "https://notes.example.com/docs", widgets: [{ link: "https://notes.example.com/#recent" }] });
    expect(snap.widgets[0].items[0].url).toBe("https://notes.example.com/n/1");
    // A peer's call mirrored onto a panel route is not a viewer here either.
    expect(localViewer(new Request("http://127.0.0.1:8700/api/peer/agents/notes/a/sessions/x"), loopback)).toBe(false);
  });
});
