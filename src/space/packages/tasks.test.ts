import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRegistry } from "../panel/registry.ts";
import { createPeerServeRoutes } from "../peers/serve.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { Store } from "../scheduler/store.ts";
import { parsePackageManifest } from "./manifest.ts";
import { PackageRuntime } from "./runtime.ts";
import { runPackageTask } from "./tasks.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

test("owner sync preserves overrides; HTTP tasks activate locally and commands do not start a service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-package-tasks-")); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  await Bun.write(join(dir, "app.ts"), 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:r=>Response.json({status:"ok",trigger:r.headers.get("x-space-trigger")})});');
  const manifest = { ...parsePackageManifest(`spec: 2
name: tasks
version: 1.0.0
requires: {spaceApi: 1, bun: 1.3.0}
offline: {features: [Local jobs], online: []}
launch: {kind: process, runtime: bun, entry: app.ts, health: /healthz}
tasks:
  - name: refresh
    schedule: '0 9 * * *'
    timezone: Asia/Seoul
    run: {http: {url: /refresh}}
  - name: file
    every: 1h
    run: {command: 'pwd'}
agents: [{name: helper, prompt: agents/helper.md}]
`), dir };
  const runtime = new PackageRuntime({ logDir: join(dir, "logs"), envFor: async () => ({}) }); cleanup.push(() => runtime.close(0));
  await runtime.register({ manifest, dir, index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] } });
  const store = new Store(":memory:"); cleanup.push(() => store.close());
  const scheduler = new Scheduler({ store, log: () => {} });
  scheduler.syncManifest(manifest);
  const http = store.findTask("tasks", "refresh")!, command = store.findTask("tasks", "file")!;
  scheduler.patchTask(http.id, { enabled: false });
  scheduler.syncManifest(manifest);
  expect(store.listTasks()).toHaveLength(2);
  expect(store.findTask("tasks", "refresh")).toMatchObject({ id: http.id, overrides: { enabled: false } });
  const result = await runPackageTask(runtime, command, { signal: new AbortController().signal });
  expect(result.status).toBe("ok"); expect(result.output).toEndWith(dir.replace(/^\/var\//, "/private/var/"));
  expect(runtime.status("tasks")?.state).toBe("idle");
  expect(await runPackageTask(runtime, http, { signal: new AbortController().signal, trigger: "manual" })).toMatchObject({ status: "ok", output: expect.stringContaining('"trigger":"manual"') });
  expect(runtime.status("tasks")?.leases).toBe(0);
  const registry = new AppRegistry(); await registry.set(manifest);
  expect(registry.get("tasks")?.manifestOnly).toBe(false);
  expect(registry.get("tasks")?.manifest.agents[0]?.prompt).toBe("agents/helper.md");
  scheduler.syncManifest(Scheduler.schedulable({ ...manifest, status: "paused" }));
  expect(store.listTasks().every((t) => t.orphaned)).toBe(true);
});

test("legacy peer tokens cannot discover or invoke newly registered package apps and agents", async () => {
  const list = (key: string, rows: unknown[]) => ({ GET: () => Response.json({ ok: true, [key]: rows }) });
  const panel = {
    "/api/apps": list("apps", [{ name: "legacy" }, { name: "packaged" }]),
    "/api/services": list("services", []), "/api/widgets": list("widgets", [{ app: "packaged" }]),
    "/api/apps/:app": { DELETE: () => Response.json({ ok: true }) },
    "/api/apps/:app/icon": list("icon", []), "/api/agents/:app/:agent/avatar": list("avatar", []),
    "/api/widgets/:app/:name/embed": list("embed", []),
  };
  const agents: Record<string, { GET?: () => Response; POST?: () => Response }> = {
    "/api/agents": list("agents", [{ id: "packaged/helper", app: "packaged" }]),
    "/api/agents/runs": list("runs", [{ agent: "packaged/helper" }, { agent: "legacy/helper" }]),
  };
  for (const path of ["/chat", "/sessions", "/sessions/:sid", "/runs", "/runs/:id", "/runs/:id/events", "/runs/:id/stop", "/runs/:id/steer", "/runs/:id/approvals/:rid", "/watch"]) agents[`/api/agents/:app/:agent${path}`] = { GET: () => Response.json({}), POST: () => Response.json({}) };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", websocket: { message() {} }, routes: createPeerServeRoutes({ token: "old", name: "test", panel, agents, allowApp: (app) => app !== "packaged" }), fetch: () => new Response("missing", { status: 404 }) });
  cleanup.push(() => { server.stop(true); });
  const get = (path: string, method = "GET") => fetch(new URL(path, server.url), { method, headers: { authorization: "Bearer old" } });
  expect(await (await get("/api/peer/snapshot")).json()).toMatchObject({ apps: [{ name: "legacy" }], agents: [], widgets: [] });
  expect(await (await get("/api/peer/agents/runs")).json()).toMatchObject({ runs: [{ agent: "legacy/helper" }] });
  expect((await get("/api/peer/agents/packaged/helper/chat", "POST")).status).toBe(403);
  expect((await get("/api/peer/apps/packaged", "DELETE")).status).toBe(403);
});
