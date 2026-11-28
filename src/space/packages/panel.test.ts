import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { guardBrowserWrites } from "../auth.ts";
import { localViewer } from "../hosts.ts";
import { terminalWebSocket } from "../terminal/api.ts";
import { workspacePaths } from "../workspace.ts";
import { Connections } from "./connections.ts";
import { PackageGateway } from "./gateway.ts";
import { PackageInstaller } from "./install.ts";
import { PackageLinks } from "./links.ts";
import { createPackageRoutes } from "./api.ts";
import { parsePackageManifest } from "./manifest.ts";
import { createPackagePanelRoutes } from "./panel.ts";
import { PackageRuntime } from "./runtime.ts";
import { PackageStore } from "./store.ts";

test("panel operations use the panel CSRF boundary and never expose an unguarded connection channel", async () => {
  const db = new Database(":memory:"), store = new PackageStore(db);
  const runtime = new PackageRuntime({ logDir: "/unused", envFor: async () => ({}) });
  const links = new PackageLinks(new Connections(db, store.spaceId), { env: {}, apps: () => [] });
  const gateway = new PackageGateway(runtime, links, store.spaceId);
  const routes = createPackagePanelRoutes({ installer: new PackageInstaller(workspacePaths("/unused"), store), token: "operator-only", runtime, gateway, links });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: terminalWebSocket, routes: guardBrowserWrites(routes), fetch: () => new Response("missing", { status: 404 }) });
  try {
    const body = JSON.stringify({ remoteSpaceId: crypto.randomUUID(), direction: "incoming" });
    const post = (origin: string) => fetch(new URL("/api/panel/connections", server.url), { method: "POST", headers: { "content-type": "application/json", origin }, body });
    expect((await post("https://other.example")).status).toBe(403);
    const created = await (await post(server.url.origin)).json() as { token: string };
    expect(created.token).toBeTruthy();
    const listed = await (await fetch(new URL("/api/panel/connections", server.url))).text();
    expect(listed).not.toContain(created.token);
    expect(JSON.parse(listed).connections[0].apps).toEqual([]);
    expect((await fetch(new URL("/api/panel/connections/channel", server.url))).status).toBe(404);
    expect(await (await fetch(new URL("/api/panel/package-catalogue", server.url))).json()).toMatchObject({ apps: [], remotes: [{ available: false, apps: [] }] });
  } finally { server.stop(true); gateway.close(); links.close(); await runtime.close(0); db.close(); }
});

test("an app's process is started, stopped and given a mode over the operator route and the panel's, kept in the store", async () => {
  const db = new Database(":memory:"), store = new PackageStore(db);
  let starts = 0;
  const runtime = new PackageRuntime({
    logDir: "/unused", envFor: async () => ({}), port: () => 1234, probe: async () => true,
    settings: { get: (app) => store.runtimeSetting(app), set: (app, setting) => store.setRuntimeSetting(app, setting) },
    spawn: async () => {
      starts++;
      let code: number | null = null; let done: (n: number) => void = () => {};
      const exited = new Promise<number>((resolve) => { done = resolve; });
      return { pid: 77, exited, get exitCode() { return code; }, stop: async () => { code = 0; done(0); } };
    },
  });
  await runtime.register({
    dir: "/unused", index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] },
    manifest: parsePackageManifest("spec: 2\nname: demo\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz }"),
  });
  const links = new PackageLinks(new Connections(db, store.spaceId), { env: {}, apps: () => [] });
  const gateway = new PackageGateway(runtime, links, store.spaceId);
  const installer = new PackageInstaller(workspacePaths("/unused"), store);
  const routes = { ...createPackageRoutes({ installer, token: "operator-only", runtime }), ...createPackagePanelRoutes({ installer, token: "operator-only", runtime, gateway, links }) };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: terminalWebSocket, routes: guardBrowserWrites(routes), fetch: () => new Response("missing", { status: 404 }) });
  const send = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(new URL(path, server.url), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as { ok: boolean; error?: string; runtime?: { state: string; mode?: string; pid?: number } } };
  };
  try {
    const operator = { authorization: "Bearer operator-only" };
    expect((await send("/api/packages/apps/demo/runtime", { action: "start" })).status).toBe(401);
    expect((await send("/api/packages/apps/nope/runtime", { action: "start" }, operator)).status).toBe(404);
    expect((await send("/api/packages/apps/demo/runtime", { action: "kill" }, operator)).status).toBe(400);
    expect((await send("/api/packages/apps/demo/runtime", { mode: "forever" }, operator)).status).toBe(400);
    expect((await send("/api/packages/apps/demo/runtime", {}, operator)).status).toBe(400);
    expect((await send("/api/packages/apps/demo/runtime", { action: "start" }, operator)).body).toMatchObject({ ok: true, runtime: { state: "running", mode: "on-demand", pid: 77 } });
    // The panel's copy needs no token, only the same origin.
    expect((await send("/api/panel/packages/apps/demo/runtime", { action: "stop" }, { origin: "https://other.example" })).status).toBe(403);
    expect((await send("/api/panel/packages/apps/demo/runtime", { action: "stop", mode: "background" }, { origin: server.url.origin })).body).toMatchObject({ ok: true, runtime: { state: "stopped", mode: "background" } });
    expect(store.runtimeSetting("demo")).toEqual({ mode: "background", stopped: true });
    expect(starts).toBe(1);
    const listed = await (await fetch(new URL("/api/packages/apps/demo/runtime", server.url), { headers: operator })).json() as { runtime: object };
    expect(listed.runtime).toMatchObject({ state: "stopped", kind: "process", declaredMode: "on-demand" });
    expect((await send("/api/packages/apps/demo/runtime", { mode: "default", action: "restart" }, operator)).body).toMatchObject({ ok: true, runtime: { state: "running", mode: "on-demand" } });
    expect(store.runtimeSetting("demo")).toEqual({});
  } finally { server.stop(true); gateway.close(); links.close(); await runtime.close(0); db.close(); }
});

test("the panel's entry gives a viewer at this machine the loopback ticket, and one through a proxy the public", async () => {
  const db = new Database(":memory:"), store = new PackageStore(db);
  const runtime = new PackageRuntime({ logDir: "/unused", envFor: async () => ({}) });
  await runtime.register({
    dir: "/unused", index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] },
    manifest: parsePackageManifest("spec: 2\nname: demo\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz }"),
  });
  const links = new PackageLinks(new Connections(db, store.spaceId), { env: {}, apps: () => [] });
  const gateway = new PackageGateway(runtime, links, store.spaceId);
  const port = gateway.start(0, "https://apps.test");
  const routes = createPackagePanelRoutes({ installer: new PackageInstaller(workspacePaths("/unused"), store), token: "operator-only", runtime, gateway, links, localViewer });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: terminalWebSocket, routes, fetch: () => new Response("missing", { status: 404 }) });
  try {
    const open = async (headers: Record<string, string> = {}) => new URL((await fetch(new URL("/_space/apps/demo", server.url), { headers, redirect: "manual" })).headers.get("location")!).host;
    expect(await open()).toMatch(new RegExp(`^demo-[0-9a-f]{16}\\.localhost:${port}$`));
    expect(await open({ "x-forwarded-for": "203.0.113.9" })).toMatch(/^demo-[0-9a-f]{16}\.apps\.test$/);
  } finally { server.stop(true); gateway.close(); links.close(); await runtime.close(0); db.close(); }
});
