import { USAGE_PATH, USAGE_SCRIPT } from "./script.ts";
import type { UsageService } from "./service.ts";
import { APP_PATTERN, KINDS, type Kind, WINDOWS, type Window } from "./types.ts";

/**
 * HTTP surface of the usage service (docs/usage.md), a Bun.serve `routes` table.
 *
 *   POST /api/panel/usage/open    {kind, key, source}   the panel's own pages (same origin, guardBrowserWrites)
 *   GET  /_space/usage.js                               the heartbeat script
 *   POST /_space/usage/beat       {tab}                 only through the router: the app is the `X-Space-App`
 *                                                       header it sets, never a value from the page
 *   GET  /api/usage?window=7d|30d|90d|all&kind=app|agent|builtin
 *
 * The writes answer 204 with no body: `sendBeacon` reads nothing back. The read
 * route carries no token, like `/api/model/usage`.
 */

export type UsageApiOptions = {
  service: UsageService;
  /** True for an app registered on this space; a beat for any other name is refused. */
  knownApp: (app: string) => boolean;
};

type Handler = (req: Request) => Response | Promise<Response>;
type Routes = Record<string, Partial<Record<"GET" | "POST", Handler>>>;

/** The header the router sets on `/_space/*` (src/space/router/caddyfile.ts). */
export const APP_HEADER = "x-space-app";

export function createUsageRoutes(opts: UsageApiOptions): Routes {
  const { service } = opts;
  // `sendBeacon` sends text/plain; the body is JSON either way.
  const body = async (req: Request): Promise<Record<string, unknown> | null> => {
    try {
      const parsed = JSON.parse(await req.text()) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  return {
    "/api/panel/usage/open": {
      POST: async (req) => {
        const b = await body(req);
        if (!b) return error(400, "body must be a JSON object");
        try {
          service.open(b);
        } catch (e) {
          return error(400, (e as Error).message);
        }
        return new Response(null, { status: 204 });
      },
    },

    "/_space/usage.js": {
      GET: () => new Response(USAGE_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600" } }),
    },

    [USAGE_PATH]: {
      POST: async (req) => {
        const app = req.headers.get(APP_HEADER)?.trim() ?? "";
        if (!app) return error(400, "no X-Space-App header: heartbeats arrive through the router");
        if (!APP_PATTERN.test(app) || !opts.knownApp(app)) return error(404, "unknown app");
        const b = await body(req);
        if (!b) return error(400, "body must be a JSON object");
        try {
          service.beat(app, b.tab);
        } catch (e) {
          return error(400, (e as Error).message);
        }
        return new Response(null, { status: 204 });
      },
    },

    "/api/usage": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const window = (q.get("window") || "30d") as Window;
        if (!WINDOWS.includes(window)) return error(400, `window must be one of ${WINDOWS.join(", ")}`);
        const kind = (q.get("kind") || undefined) as Kind | undefined;
        if (kind !== undefined && !KINDS.includes(kind)) return error(400, `kind must be one of ${KINDS.join(", ")}`);
        return json({ ok: true, window, usage: service.report(window, kind) });
      },
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
