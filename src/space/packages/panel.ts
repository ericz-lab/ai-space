import { createPackageRoutes } from "./api.ts";
import type { PackageGateway } from "./gateway.ts";
import { createConnectionRoutes, type PackageLinks } from "./links.ts";
import type { PackageRuntime } from "./runtime.ts";

/** Same trust boundary as the existing operator panel; never served on app origins. */
export function createPackagePanelRoutes(opts: Parameters<typeof createPackageRoutes>[0] & { gateway: PackageGateway; links: PackageLinks; runtime: PackageRuntime }) {
  const packages = createPackageRoutes({ ...opts, token: "" });
  const connections = createConnectionRoutes({ links: opts.links, token: "" });
  type RequestWithParams = Request & { params: Record<string, string> };
  const entry = async (req: RequestWithParams) => {
    if (req.headers.get("sec-fetch-site") === "cross-site") return new Response("Open from Space", { status: 403 });
    try {
      const connectionId = req.params.connection;
      const spaceId = connectionId ? opts.links.connections.get(connectionId)?.remoteSpaceId : opts.installer.store.spaceId;
      if (!spaceId) throw new Error("unknown Space connection");
      const result = await opts.gateway.open({ app: req.params.app!, spaceId, ...(connectionId ? { connectionId } : {}) });
      return new Response(null, { status: 303, headers: { location: result.url, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
    } catch (e) { return new Response((e as Error).message, { status: 503 }); }
  };
  return {
    ...Object.fromEntries(Object.entries(packages).map(([path, value]) => [path.replace("/api/packages", "/api/panel/packages"), value])),
    ...Object.fromEntries(Object.entries(connections).filter(([path]) => path !== "/api/connections/channel").map(([path, value]) => [path.replace("/api/connections", "/api/panel/connections"), value])),
    "/_space/apps/:app": { GET: entry },
    "/_space/connections/:connection/apps/:app": { GET: entry },
    "/api/panel/package-catalogue": { GET: async () => {
      const apps = opts.installer.store.list().filter((o) => o.state === "installed").map((o) => {
        const installed = opts.runtime.get(o.app);
        return { app: o.app, title: installed?.manifest.title ?? o.app, version: o.version, operationId: o.id,
          page: !!installed?.manifest.launch, state: opts.runtime.status(o.app)?.state ?? "unavailable",
          offline: installed?.manifest.offline, sourceIncluded: installed?.index.sourceIncluded,
          url: `/_space/apps/${encodeURIComponent(o.app)}` };
      });
      const remotes = await Promise.all(opts.links.status().map(async (c) => {
        try {
          const response = await opts.links.request(c.id, { operation: "catalogue" }, null, AbortSignal.timeout(3000));
          if (!response.ok) throw new Error("catalogue unavailable");
          const data = await response.json() as { apps: { app: string; title: string; version: string; page?: boolean }[] };
          return { connectionId: c.id, spaceId: c.remoteSpaceId, available: true, apps: data.apps.map((a) => ({ ...a, url: `/_space/connections/${c.id}/apps/${encodeURIComponent(a.app)}` })) };
        } catch { return { connectionId: c.id, spaceId: c.remoteSpaceId, available: false, apps: [] }; }
      }));
      return Response.json({ ok: true, spaceId: opts.installer.store.spaceId, apps, remotes });
    } },
  };
}
