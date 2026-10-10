import type { LayoutStore } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";
import type { PeerHub } from "./hub.ts";
import { peerId } from "./merge.ts";
import { sameOrigin } from "../auth.ts";
import { bridge, wantsWebSocket } from "../terminal/api.ts";

/**
 * The hub side of peers, shaped as a Bun.serve `routes` table.
 *
 *   GET   /api/peers                                    every peer: health, snapshot time, counts, duplicates
 *   PATCH /api/peers/:peer/apps/:app                    { hidden }: hide a peer app on this panel only
 *   DELETE /api/peers/:peer/apps/:app                   uninstall the app on the peer (forwarded), refresh its snapshot
 *   GET   /api/peers/:peer/apps/:app/icon               ┐
 *   GET   /api/peers/:peer/apps/:app/appcolor           │
 *   GET   /api/peers/:peer/agents/:app/:agent/avatar    │ forwarded to the peer's /api/peer/... with
 *   GET   /api/peers/:peer/widgets/:app/:name/embed     │ the token and extra headers added, the
 *   POST  /api/peers/:peer/agents/:app/:agent/chat      │ answer streamed back as is
 *   GET   /api/peers/:peer/agents/:app/:agent/sessions[/:sid] │
 *   GET   /api/peers/:peer/agents/runs                  │
 *   GET   /api/peers/:peer/agents/:app/:agent/runs[/:id[/events]] │
 *   POST  /api/peers/:peer/agents/:app/:agent/runs/:id/stop │
 *   GET   /api/peers/:peer/apps/:app/proxy/api/*        ┘ (the peer app's own API; docs/peers.md)
 *
 * A WebSocket upgrade on the last one is bridged to the peer app's socket at that path, frame
 * by frame, for an app on the hub that relays a live stream of its counterpart; a browser may
 * open it from the panel's own origin only.
 *
 * Only these paths are forwarded; anything else under /api/peers/ is 404 on
 * the hub without a call to the peer. Like the panel routes they carry no
 * bearer token; see docs/peers.md.
 */

export type PeerApiOptions = {
  hub: PeerHub;
  layout: LayoutStore;
  registry: AppRegistry;
};

// The server argument only matters to the app proxy, which may upgrade the request to a socket.
type Handler = (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>) => Response | undefined | Promise<Response | undefined>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>>;

const FORWARD_TIMEOUT_MS = 8_000;
const PROXY_TIMEOUT_MS = 65_000;

export function createPeerRoutes(opts: PeerApiOptions): Routes {
  const { hub, layout, registry } = opts;

  const clientOf = (name: string | undefined) => {
    const c = name ? hub.get(name) : undefined;
    if (!c) throw new NotFound(`unknown peer: ${name}`);
    return c;
  };

  /** Forward to the same path on the peer with `/api/peers/<peer>` replaced by `/api/peer`. */
  const proxy =
    (timeoutMs?: number): Handler =>
    async (req) => {
      let client;
      try {
        client = clientOf(req.params.peer);
      } catch (e) {
        return error(404, (e as Error).message);
      }
      const u = new URL(req.url);
      const path = u.pathname.replace(/^\/api\/peers\/[^/]+/, "/api/peer") + u.search;
      try {
        return await client.forward(req, path, timeoutMs ? { timeoutMs } : {});
      } catch (e) {
        return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
      }
    };

  return {
    "/api/peers": {
      GET: () => {
        const peers = hub.status().map((s) => ({ ...s, duplicates: duplicatesOf(s.name) }));
        return json({ ok: true, peers, asOf: new Date().toISOString() });
      },
    },

    "/api/peers/:peer/apps/:app": {
      PATCH: async (req) => {
        let client;
        try {
          client = clientOf(req.params.peer);
        } catch (e) {
          return error(404, (e as Error).message);
        }
        const app = req.params.app ?? "";
        if (!client.snapshot?.apps.some((a) => a.name === app)) return error(404, `unknown app: ${client.name}/${app}`);
        const body = (await req.json().catch(() => ({}))) as { hidden?: unknown };
        if (typeof body.hidden !== "boolean") return error(400, "hidden must be a boolean");
        const lay = layout.hide(peerId(client.name, app), body.hidden);
        const view = hub.apps(new Set(lay.hidden)).find((a) => a.id === peerId(client.name, app));
        return json({ ok: true, app: view });
      },
      // Uninstall on the peer, then refresh its snapshot so the hub's lists drop the app at once.
      DELETE: async (req) => {
        let client;
        try {
          client = clientOf(req.params.peer);
        } catch (e) {
          return error(404, (e as Error).message);
        }
        const app = req.params.app ?? "";
        if (!client.snapshot?.apps.some((a) => a.name === app)) return error(404, `unknown app: ${client.name}/${app}`);
        let res: Response;
        try {
          res = await client.forward(req, `/api/peer/apps/${encodeURIComponent(app)}`, { timeoutMs: FORWARD_TIMEOUT_MS * 10 });
        } catch (e) {
          return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
        // The next scheduled refresh catches up if this one fails.
        if (res.ok) await client.refresh().catch((e) => console.error(`[peers] ${client.name}: refresh after uninstall failed: ${(e as Error).message}`));
        return res;
      },
    },

    "/api/peers/:peer/apps/:app/icon": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/apps/:app/appcolor": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/avatar": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/widgets/:app/:name/embed": { GET: proxy(FORWARD_TIMEOUT_MS) },
    // A chat stream stays open as long as the peer's does; the browser leaving only detaches it,
    // the turn goes on on the peer as a background run (docs/panel.md#chat).
    "/api/peers/:peer/agents/:app/:agent/chat": { POST: proxy() },
    "/api/peers/:peer/agents/runs": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs/:id": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs/:id/events": { GET: proxy() },
    "/api/peers/:peer/agents/:app/:agent/runs/:id/stop": { POST: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/sessions": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/sessions/:sid": { GET: proxy(FORWARD_TIMEOUT_MS) },
    // An app on this hub reading a peer app's API; the peer bounds the call with its own timeout.
    "/api/peers/:peer/apps/:app/proxy/*": {
      GET: (req, server) => {
        if (!wantsWebSocket(req)) return proxy(PROXY_TIMEOUT_MS)(req, server);
        // A socket carries no token here, like the panel routes; an app's server sends no Origin,
        // and a page on another site must not reach a peer app through the operator's browser.
        if (!sameOrigin(req)) return error(403, "cross-origin request refused");
        const client = req.params.peer ? hub.get(req.params.peer) : undefined;
        if (!client) return error(404, `unknown peer: ${req.params.peer}`);
        const u = new URL(req.url);
        const rest = u.pathname.replace(/^\/api\/peers\/[^/]+\/apps\/[^/]+\/proxy/, "");
        if (!rest.startsWith("/api/")) return error(404, "only the app's /api/ paths are proxied");
        const url = `${client.config.url.replace(/^http/, "ws")}${u.pathname.replace(/^\/api\/peers\/[^/]+/, "/api/peer")}${u.search}`;
        if (server.upgrade(req, { data: { attachment: bridge(url, client.authHeaders(), `peer ${client.name}`) } })) return undefined;
        return error(400, "websocket upgrade failed");
      },
    },
  };

  /** Local manifest-only apps whose url is a peer app's url: link apps the peer makes unnecessary. */
  function duplicatesOf(peer: string): string[] {
    const snap = hub.get(peer)?.snapshot;
    if (!snap) return [];
    const urls = new Set(snap.apps.map((a) => a.url).filter((u): u is string => !!u));
    return registry
      .list()
      .filter((e) => e.manifestOnly && e.manifest.url && urls.has(e.manifest.url))
      .map((e) => e.manifest.app);
  }
}

class NotFound extends Error {}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
