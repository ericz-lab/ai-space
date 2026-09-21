import { SPACE_AGENT, SPACE_APP } from "../agents/api.ts";

/**
 * The peer side: `/api/peer/*`, present only when `SPACE_HUB_TOKEN` is set.
 * Every route requires that bearer token and mirrors a panel or agent route
 * the browser already uses, with the same handler behind the check, plus one
 * snapshot that bundles the four lists a hub merges. Nothing here mutates the
 * peer.
 *
 *   GET  /api/peer/snapshot                        { ok, name, apps, services, widgets, agents, asOf }
 *   GET  /api/peer/apps/:app/icon                  = /api/apps/:app/icon
 *   GET  /api/peer/apps/:app/appcolor              = /api/panel/appcolor?app=
 *   GET  /api/peer/agents/:app/:agent/avatar       = /api/agents/:app/:agent/avatar
 *   GET  /api/peer/widgets/:app/:name/embed        = /api/widgets/:app/:name/embed
 *   GET  /api/peer/apps/:app/proxy/api/*           GET http://127.0.0.1:<service.port>/api/* on the app itself: an app on the
 *                                                  hub reading a peer app's API (an app without a service, or a path outside
 *                                                  /api/, is 404; only GET, so nothing is changed from afar)
 *   POST /api/peer/agents/:app/:agent/chat         = /api/agents/:app/:agent/chat
 *   GET  /api/peer/agents/:app/:agent/sessions[/:sid]
 *   GET  /api/peer/terminal                        = /api/terminal            ┐ only when the terminal is
 *   POST /api/peer/terminal/sessions               = /api/terminal/sessions   │ enabled here; the snapshot
 *   DELETE /api/peer/terminal/sessions/:id         = /api/terminal/sessions/:id │ says so with `terminal: true`
 *   GET  /api/peer/terminal/ws                     = /api/terminal/ws         ┘ (docs/terminal.md)
 */

// The server argument only matters to the terminal's socket route, which upgrades the request.
type Handler = (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>) => Response | undefined | Promise<Response | undefined>;
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Routes = Record<string, Handler | Partial<Record<Method, Handler>>>;

export type PeerServeOptions = {
  token: string;
  /** What this space calls itself (`SPACE_NAME`). */
  name: string;
  panel: Routes;
  agents: Routes;
  /** The terminal routes, when the terminal is enabled on this machine; absent = no terminal for the hub. */
  terminal?: Routes;
  /** The loopback port of an app's service, for the app API proxy; undefined = no service, 404. */
  servicePort?: (app: string) => number | undefined;
  /** Loopback fetch for the proxy (tests substitute one). */
  fetch?: typeof fetch;
  /** How long a proxied app call may take; an export of months of rows is not instant. */
  proxyTimeoutMs?: number;
};

const PROXY_TIMEOUT_MS = 60_000;

export function createPeerServeRoutes(opts: PeerServeOptions): Routes {
  if (!opts.token) return {};
  const expected = `Bearer ${opts.token}`;

  const guard =
    (h: Handler): Handler =>
    async (req, server) => {
      if (req.headers.get("authorization") !== expected) return json({ ok: false, error: "unauthorized" }, 401);
      try {
        return await h(req, server);
      } catch (e) {
        return json({ ok: false, error: (e as Error).message ?? String(e) }, 400);
      }
    };

  const mirror = (routes: Routes, path: string, method: Method): Handler => {
    const h = handlerOf(routes, path, method);
    return (req, server) => h(req, server);
  };

  /** Call a local GET route in-process and return its JSON body. */
  const local = async <T>(routes: Routes, path: string, base: string): Promise<T> => {
    const req = Object.assign(new Request(new URL(path, base)), { params: {} as Record<string, string> });
    const r = await handlerOf(routes, path, "GET")(req, undefined as unknown as Bun.Server<unknown>);
    return (await r!.json()) as T;
  };

  return {
    "/api/peer/snapshot": {
      GET: guard(async (req) => {
        const base = new URL(req.url).origin;
        // Services first: that list waits for the health probes, so the app views read after it
        // carry the same fresh result instead of "unknown" for a service not probed yet.
        const [services, widgets, agents] = await Promise.all([
          local<{ services: unknown[] }>(opts.panel, "/api/services", base),
          local<{ widgets: unknown[] }>(opts.panel, "/api/widgets", base),
          local<{ agents: { id: string }[] }>(opts.agents, "/api/agents", base),
        ]);
        const apps = await local<{ apps: unknown[] }>(opts.panel, "/api/apps", base);
        // Only what lives here: a peer that is itself a hub does not pass its own peers on
        // (a hub of hubs would list them twice, under the wrong name).
        const own = <T extends { peer?: string }>(list: T[]) => list.filter((x) => !x.peer);
        return json({
          ok: true,
          name: opts.name,
          apps: own(apps.apps as { peer?: string }[]),
          services: own(services.services as { peer?: string }[]),
          widgets: own(widgets.widgets as { peer?: string }[]),
          // The hub has its own space agent.
          agents: own(agents.agents as { id: string; peer?: string }[]).filter((a) => a.id !== `${SPACE_APP}/${SPACE_AGENT}`),
          terminal: opts.terminal !== undefined,
          asOf: new Date().toISOString(),
        });
      }),
    },
    "/api/peer/apps/:app": { DELETE: guard(mirror(opts.panel, "/api/apps/:app", "DELETE")) },
    "/api/peer/apps/:app/icon": { GET: guard(mirror(opts.panel, "/api/apps/:app/icon", "GET")) },
    "/api/peer/apps/:app/appcolor": {
      GET: guard((req) => {
        const url = new URL("/api/panel/appcolor", req.url);
        url.searchParams.set("app", req.params.app ?? "");
        return handlerOf(opts.panel, "/api/panel/appcolor", "GET")(Object.assign(new Request(url), { params: {} }), undefined as unknown as Bun.Server<unknown>);
      }),
    },
    "/api/peer/agents/:app/:agent/avatar": { GET: guard(mirror(opts.panel, "/api/agents/:app/:agent/avatar", "GET")) },
    "/api/peer/apps/:app/proxy/*": {
      GET: guard(async (req) => {
        const port = opts.servicePort?.(req.params.app ?? "");
        if (!port) return json({ ok: false, error: `no service for app "${req.params.app ?? ""}"` }, 404);
        const u = new URL(req.url);
        const rest = u.pathname.replace(/^\/api\/peer\/apps\/[^/]+\/proxy/, "");
        if (!rest.startsWith("/api/")) return json({ ok: false, error: "only the app's /api/ paths are proxied" }, 404);
        const up = await (opts.fetch ?? fetch)(`http://127.0.0.1:${port}${rest}${u.search}`, { headers: { accept: req.headers.get("accept") ?? "application/json" }, signal: AbortSignal.any([req.signal, AbortSignal.timeout(opts.proxyTimeoutMs ?? PROXY_TIMEOUT_MS)]) });
        return new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } });
      }),
    },
    "/api/peer/widgets/:app/:name/embed": { GET: guard(mirror(opts.panel, "/api/widgets/:app/:name/embed", "GET")) },
    "/api/peer/agents/:app/:agent/chat": { POST: guard(mirror(opts.agents, "/api/agents/:app/:agent/chat", "POST")) },
    "/api/peer/agents/:app/:agent/sessions": { GET: guard(mirror(opts.agents, "/api/agents/:app/:agent/sessions", "GET")) },
    "/api/peer/agents/:app/:agent/sessions/:sid": { GET: guard(mirror(opts.agents, "/api/agents/:app/:agent/sessions/:sid", "GET")) },
    ...(opts.terminal
      ? {
          "/api/peer/terminal": { GET: guard(mirror(opts.terminal, "/api/terminal", "GET")) },
          "/api/peer/terminal/sessions": { POST: guard(mirror(opts.terminal, "/api/terminal/sessions", "POST")) },
          "/api/peer/terminal/sessions/:id": { DELETE: guard(mirror(opts.terminal, "/api/terminal/sessions/:id", "DELETE")) },
          "/api/peer/terminal/ws": { GET: guard(mirror(opts.terminal, "/api/terminal/ws", "GET")) },
        }
      : {}),
  };
}

function handlerOf(routes: Routes, path: string, method: Method): Handler {
  const entry = routes[path];
  const h = typeof entry === "function" ? entry : entry?.[method];
  if (!h) throw new Error(`no ${method} handler for ${path}`);
  return h;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
