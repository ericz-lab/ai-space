import type { Router } from "./router.ts";

/**
 * The router's HTTP surface, shaped as a Bun.serve `routes` table.
 *
 *   GET  /api/router        backend, domain, port, file, every route with its status, the last sync
 *   POST /api/router/sync   write and reload now; answers the sync result
 *
 * Panel routes: no bearer token, reached through the operator's access layer
 * or loopback (docs/panel.md).
 */

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

export function createRouterRoutes(opts: { router: Router }): Routes {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return {
    "/api/router": { GET: () => json({ ok: true, ...opts.router.status() }) },
    "/api/router/sync": { POST: async () => json({ ok: true, sync: await opts.router.syncNow() }) },
  };
}
