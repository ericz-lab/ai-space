import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { createPanelRoutes } from "./api.ts";
import { HealthProbe } from "./health.ts";
import { IconPacks, applyToAgent, applyToApp } from "./icons.ts";
import { LayoutStore } from "./layout.ts";
import { AppRegistry } from "./registry.ts";
import type { AgentView, AppView } from "./view.ts";
import { WidgetFeed } from "./widgets.ts";

let server: ReturnType<typeof Bun.serve>;
let base = "";
let home = "";
let icons: IconPacks;

const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/healthz")) return new Response("ok");
  return Response.json({ ok: true, items: [] });
}) as typeof fetch;

const SVG = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14'/></svg>";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "space-icons-"));
  const ws = workspacePaths(home);
  await mkdir(join(ws.apps, "notes", ".git"), { recursive: true });
  await writeFile(
    join(ws.apps, "notes", "space.yaml"),
    `name: notes
title: Notes
icon: icon.svg
url: https://notes.example.com
service: { command: bun src/index.ts, port: 8712, health: /healthz }
agents:
  - { name: librarian, title: Librarian }
widgets:
  - { name: recent, source: /api/widget }
`,
  );
  await writeFile(join(ws.apps, "notes", "icon.svg"), SVG);
  await mkdir(join(ws.apps, "docs"), { recursive: true });
  await writeFile(join(ws.apps, "docs", "space.yaml"), "name: docs\ntitle: Docs\nicon: '📚'\nurl: https://docs.example.com\n");
  const registry = new AppRegistry();
  for (const n of ["notes", "docs"]) await registry.set(await loadManifest(join(ws.apps, n)));
  const db = new Database(":memory:");
  icons = new IconPacks(home, db);
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: createPanelRoutes({
      ws,
      registry,
      layout: new LayoutStore(db),
      widgets: new WidgetFeed(registry, { fetch: fakeFetch }),
      health: new HealthProbe({ fetch: fakeFetch }),
      icons,
      onCreate: async () => {},
      onRemove: async () => {},
      fetch: fakeFetch,
    }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const call = (path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Body }));
const put = (path: string, body: BodyInit, type: string) => call(path, { method: "PUT", headers: { "content-type": type }, body });
const activate = (active: string | null) => call("/api/panel/icons", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ active }) });
const notes = async (q = "") => (await call(`/api/apps${q}`)).body.apps.find((a: Body) => a.name === "notes");

describe("icon packs", () => {
  test("uploads build a pack on disk; nothing changes until it is active", async () => {
    expect((await call("/api/panel/icons")).body).toEqual({ ok: true, active: null, packs: [] });
    const app = await put("/api/panel/icons/clean/app?id=notes", SVG, "image/svg+xml");
    expect(app.status).toBe(200);
    expect(app.body.icon).toMatchObject({ kind: "app", id: "notes", type: "image/svg+xml", size: SVG.length });
    expect(app.body.icon.url).toStartWith("/api/panel/icons/clean/app?id=notes&v=");
    expect((await put("/api/panel/icons/clean/agent?id=notes/librarian", PNG, "image/png")).status).toBe(200);
    expect((await put("/api/panel/icons/clean/app?id=david/media", SVG, "image/svg+xml")).status).toBe(200);
    expect((await readdir(join(home, "icons", "clean", "app"))).sort()).toEqual(["david~media.svg", "notes.svg"]);
    expect((await readdir(join(home, "icons", "clean", "agent"))).sort()).toEqual(["notes~librarian.png"]);

    const list = (await call("/api/panel/icons")).body;
    expect(list.active).toBeNull();
    expect(list.packs[0].icons.map((i: Body) => `${i.kind}:${i.id}`)).toEqual(["app:david/media", "app:notes", "agent:notes/librarian"]);
    expect((await notes()).icon).toBe("/api/apps/notes/icon");
  });

  test("the active pack replaces icons, avatars and corners in every list; ?icons=manifest returns the manifests'", async () => {
    expect((await activate("clean")).body).toEqual({ ok: true, active: "clean" });
    const n = await notes();
    expect(n.icon).toStartWith("/api/panel/icons/clean/app?id=notes&v=");
    expect(n.agents[0].avatar).toStartWith("/api/panel/icons/clean/agent?id=notes%2Flibrarian&v=");
    expect(n.agents[0].appIcon).toBe(n.icon);
    expect((await call("/api/services")).body.services[0].icon).toBe(n.icon);
    expect((await call("/api/widgets")).body.widgets[0].icon).toBe(n.icon);
    // A tile the pack has no file for keeps the manifest's icon.
    expect((await call("/api/apps")).body.apps.find((a: Body) => a.name === "docs").icon).toBe("📚");
    expect((await notes("?icons=manifest")).icon).toBe("/api/apps/notes/icon");
    // The panel's own tiles are covered by space/<name>.
    expect((await call("/api/apps")).body.builtins).toEqual({ inbox: "/inbox.svg", terminal: "/terminal.svg", settings: "/settings.svg" });
    const gear = (await put("/api/panel/icons/clean/app?id=space/settings", SVG, "image/svg+xml")).body.icon.url;
    expect((await call("/api/apps")).body.builtins).toEqual({ inbox: "/inbox.svg", terminal: "/terminal.svg", settings: gear });
    expect((await call("/api/panel/icons/clean/app?id=space/settings", { method: "DELETE" })).status).toBe(200);

    const file = await fetch(base + n.icon);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/svg+xml");
    expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await file.text()).toBe(SVG);
  });

  test("a new upload in another format replaces the tile's file and its version", async () => {
    const before = (await notes()).icon;
    await Bun.sleep(5);
    const r = await put("/api/panel/icons/clean/app?id=notes", PNG, "image/png");
    expect(r.body.icon.type).toBe("image/png");
    expect((await readdir(join(home, "icons", "clean", "app"))).sort()).toEqual(["david~media.svg", "notes.png"]);
    expect((await notes()).icon).not.toBe(before);
    expect((await fetch(base + (await notes()).icon)).headers.get("content-type")).toBe("image/png");
  });

  test("refuses bad names, ids, types and sizes", async () => {
    expect((await put("/api/panel/icons/clean/app?id=../x", SVG, "image/svg+xml")).status).toBe(400);
    expect((await put("/api/panel/icons/clean/app?id=a/b/c", SVG, "image/svg+xml")).status).toBe(400);
    expect((await put("/api/panel/icons/clean/agent?id=notes", SVG, "image/svg+xml")).status).toBe(400);
    expect((await put("/api/panel/icons/clean/widget?id=notes", SVG, "image/svg+xml")).status).toBe(404);
    expect((await put("/api/panel/icons/.hidden/app?id=notes", SVG, "image/svg+xml")).status).toBe(400);
    expect((await put("/api/panel/icons/clean/app?id=notes", SVG, "text/html")).status).toBe(400);
    expect((await put("/api/panel/icons/clean/app?id=notes", "", "image/svg+xml")).status).toBe(400);
    expect((await put("/api/panel/icons/clean/app?id=notes", new Uint8Array(512 * 1024 + 1), "image/png")).status).toBe(413);
    expect((await activate("missing")).status).toBe(404);
    expect((await call("/api/panel/icons", { method: "PUT", body: "{}" })).status).toBe(400);
    expect((await call("/api/panel/icons/clean/app?id=docs")).status).toBe(404);
  });

  test("deleting an icon falls back to the manifest; deleting the active pack turns packs off", async () => {
    expect((await call("/api/panel/icons/clean/agent?id=notes/librarian", { method: "DELETE" })).status).toBe(200);
    expect((await call("/api/panel/icons/clean/agent?id=notes/librarian", { method: "DELETE" })).status).toBe(404);
    expect((await notes()).agents[0].avatar).toBe("/api/apps/notes/icon");
    expect((await call("/api/panel/icons/clean", { method: "DELETE" })).body).toEqual({ ok: true, active: null });
    expect((await call("/api/panel/icons/clean", { method: "DELETE" })).status).toBe(404);
    expect((await notes()).icon).toBe("/api/apps/notes/icon");
    expect((await call("/api/panel/icons")).body.packs).toEqual([]);
  });

  test("an active pack whose directory went away is ignored", async () => {
    await icons.write("gone", "app", "notes", "image/svg+xml", new TextEncoder().encode(SVG));
    await icons.setActive("gone");
    await Bun.$`rm -rf ${join(home, "icons", "gone")}`;
    expect((await notes()).icon).toBe("/api/apps/notes/icon");
    await icons.setActive(null);
  });
});

describe("applying a pack to views", () => {
  const agent = (id: string, app: string, peer?: string): AgentView => ({ id, app, name: id.split("/").at(-1)!, title: "A", avatar: "🤖", appIcon: "📦", ...(peer ? { peer } : {}) });
  const o = { app: new Map([["david/media", "/m"], ["space", "/s"]]), agent: new Map([["david/media/helper", "/h"], ["space/assistant", "/a"]]) };

  test("peer tiles are matched by their prefixed ids, the space agent by space/assistant", () => {
    expect(applyToAgent(o, agent("david/media/helper", "media", "david"))).toMatchObject({ avatar: "/h", appIcon: "/m" });
    expect(applyToAgent(o, agent("media/helper", "media"))).toMatchObject({ avatar: "🤖", appIcon: "📦" });
    expect(applyToAgent(o, agent("space/assistant", "space"))).toMatchObject({ avatar: "/a", appIcon: "/s" });
    const app = { id: "david/media", name: "media", peer: "david", icon: "/api/peers/david/apps/media/icon", agents: [agent("david/media/helper", "media", "david")] } as unknown as AppView;
    expect(applyToApp(o, app)).toMatchObject({ icon: "/m", agents: [{ avatar: "/h", appIcon: "/m" }] });
  });
});
