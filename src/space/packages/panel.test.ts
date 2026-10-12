import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { guardBrowserWrites } from "../auth.ts";
import { terminalWebSocket } from "../terminal/api.ts";
import { workspacePaths } from "../workspace.ts";
import { Connections } from "./connections.ts";
import { PackageGateway } from "./gateway.ts";
import { PackageInstaller } from "./install.ts";
import { PackageLinks } from "./links.ts";
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
