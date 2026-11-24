import type { LayoutStore } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";
import type { PeerHub } from "./hub.ts";
import { peerId } from "./merge.ts";
import { RenameError, type PeerRenamed, type RenameCounts } from "./rename.ts";
import { sameOrigin } from "../auth.ts";
import { bridgeTo, wantsWebSocket } from "../terminal/api.ts";
import { EMBED_HEADERS } from "../panel/widgets.ts";
import { upgradeToChannelSocket } from "../packages/gateway.ts";
import type { WsData } from "../terminal/service.ts";

/**
 * The hub side of peers, shaped as a Bun.serve `routes` table.
 *
 *   GET   /api/peers                                    every peer: id, health, snapshot time, counts, duplicates
 *   POST  /api/peers/:peer/rename                       { to }: rename the peer and move what this hub keeps under its
 *                                                       name, then publish space/peer.renamed (docs/peers.md#renaming-a-peer)
 *   PATCH /api/peers/:peer/apps/:app                    { hidden }: hide a peer app on this panel only
 *   DELETE /api/peers/:peer/apps/:app                   uninstall the app on the peer (forwarded), refresh its snapshot
 *   GET   /api/peers/:peer/model/apps                   the peer's app-model rows and its own choices (forwarded)
 *   PATCH /api/peers/:peer/apps/:app/model              {tag?, model}: set or clear an app's override on the peer
 *                                                       (forwarded; same-origin browser requests only, like the local route)
 *   GET   /api/peers/:peer/tasks                        the peer's scheduled tasks (forwarded)
 *   GET   /api/peers/:peer/tasks/models                 the models a task can run on there (forwarded)
 *   GET   /api/peers/:peer/tasks/:id/runs               one task's runs (forwarded)
 *   PATCH /api/peers/:peer/tasks/:id/model              {model}: set or clear a task's model on the peer
 *                                                       (forwarded; same-origin browser requests only, like the local route)
 *   GET   /api/peers/:peer/apps/:app/icon               forwarded like the routes below, but read whole first
 *   GET   /api/peers/:peer/agents/:app/:agent/avatar    (`picture`): a cut-short image is a 502, never a 200
 *   GET   /api/peers/:peer/apps/:app/appcolor           ┐ forwarded to the peer's /api/peer/... with
 *   GET   /api/peers/:peer/widgets/:app/:name/embed     │ the token and extra headers added, the
 *   POST  /api/peers/:peer/agents/:app/:agent/chat      │ answer streamed back as is
 *   GET   /api/peers/:peer/agents/:app/:agent/sessions[/:sid] │
 *   GET   /api/peers/:peer/agents/runs                  │
 *   GET   /api/peers/:peer/agents/:app/:agent/runs[/:id[/events]] │
 *   POST  /api/peers/:peer/agents/:app/:agent/runs/:id/stop │
 *   POST  /api/peers/:peer/agents/:app/:agent/runs/:id/steer │
 *   POST  /api/peers/:peer/agents/:app/:agent/runs/:id/approvals/:rid │
 *   POST  /api/peers/:peer/agents/cards/state       │
 *   POST  /api/peers/:peer/agents/cards/action      │
 *   GET   /api/peers/:peer/agents/:app/:agent/watch     │
 *   GET   /api/peers/:peer/apps/:app/proxy/api/*        ┘ (the peer app's own API; docs/peers.md)
 *
 * A WebSocket upgrade on the last one is bridged to the peer app's socket at that path, frame
 * by frame, for an app on the hub that relays a live stream of its counterpart; a browser may
 * open it from the panel's own origin only.
 *
 * A peer is a `SPACE_PEER_<NAME>` one reached over HTTPS, or one reached over a package connection
 * (connection-peers.ts); every route above works the same for both, through the peer's client. The app
 * proxy resolves in this order: a legacy peer of that name; else a package connection whose Space has that
 * label and shares `:app` by an app grant (`connections` below); else a connection peer of that name, whose
 * `apps` scope the other Space must grant.
 *
 * Only these paths are forwarded; anything else under /api/peers/ is 404 on
 * the hub without a call to the peer. Like the panel routes they carry no
 * bearer token; see docs/peers.md.
 */

export type PeerApiOptions = {
  hub: PeerHub;
  layout: LayoutStore;
  registry: AppRegistry;
  /** Renaming a peer (rename.ts `renamePeer` with the hub's database and `.env`); absent = 404. */
  rename?: (from: string, to: string) => Promise<PeerRenamed & { moved: RenameCounts }>;
  /**
   * Who is calling the peers' agent routes (agents/api.ts `callerAppOf`): `null` for the owner, an app's
   * name for its token, `""` for any other credential. Absent: everyone is the owner.
   */
  callerApp?: (req: Request) => Promise<string | null>;
  /** Apps the operator lets reach every app's agents with their own token (SPACE_AGENT_CALLERS), on the peers too. */
  agentCallers?: readonly string[];
  /**
   * Package connections (packages/catalogue.ts, links.ts), the app proxy's second resolution: `find` names
   * the connection whose Space is labelled `peer` and whose last catalogue shares `app`; `request` sends one
   * operation over its channel. Absent: the proxy reaches legacy peers only.
   */
  connections?: {
    find: (peer: string, app: string) => string | undefined;
    request: (connection: string, meta: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal) => Promise<Response>;
  };
};

// The server argument only matters to the app proxy, which may upgrade the request to a socket.
type Handler = (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>) => Response | undefined | Promise<Response | undefined>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "PATCH" | "DELETE", Handler>>>;

const FORWARD_TIMEOUT_MS = 8_000;
/** Larger than any icon or avatar a Space accepts; a bigger answer is not a picture. */
const MAX_PICTURE_BYTES = 4 << 20;
const PROXY_TIMEOUT_MS = 65_000;
/** A card's state or action is a bus call on the peer, bounded there by the capability's timeout. */
const CARD_TIMEOUT_MS = 35_000;

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
        return relayed(await client.forward(req, path, timeoutMs ? { timeoutMs } : {}));
      } catch (e) {
        return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
      }
    };

  /**
   * An icon or an avatar: the whole picture or an error. Through `relayed` a body the link cuts short
   * still ends as a complete 200, and a client that caches pictures (the Mac's and iPhone's icon
   * stores) keeps the top part of an icon with nothing below for a day. A picture is small, so it
   * is read here before anything is answered, and sent with its length.
   */
  const picture =
    (timeoutMs: number): Handler =>
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
        const up = await client.forward(req, path, { timeoutMs });
        const declared = Number(up.headers.get("content-length") ?? NaN);
        const bytes = new Uint8Array(await up.arrayBuffer());
        if (bytes.byteLength > MAX_PICTURE_BYTES) return error(502, `peer ${client.name} answered a picture larger than ${MAX_PICTURE_BYTES} bytes`);
        if (Number.isFinite(declared) && declared !== bytes.byteLength) throw new Error(`picture cut short: ${bytes.byteLength} of ${declared} bytes`);
        const headers = new Headers(up.headers);
        headers.set("content-length", String(bytes.byteLength));
        return new Response(bytes, { status: up.status, statusText: up.statusText, headers });
      } catch (e) {
        return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
      }
    };

  /**
   * A peer's agent routes for the owner, or for an app the operator lists in SPACE_AGENT_CALLERS
   * (docs/panel.md#apps-and-their-agents); never a peer's Space Assistant. The peer sees the hub's token either way.
   */
  const agentProxy =
    (timeoutMs?: number): Handler =>
    async (req, server) => {
      if (opts.callerApp) {
        const caller = await opts.callerApp(req);
        const target = req.params.app;
        const granted = !!caller && !!target && target !== "space" && !!opts.agentCallers?.includes(caller);
        if (caller !== null && !granted) return error(403, "an app may reach a peer's agents only when the operator lists it in SPACE_AGENT_CALLERS");
      }
      return proxy(timeoutMs)(req, server);
    };

  /**
   * The app proxy over a package connection (docs/peers.md#an-apps-own-api): the same limits as a legacy
   * peer's (the app's `/api/` paths, GET, a bounded wait, a socket from the panel's origin only), and the
   * caller is the owner or the app of the same name. Nothing of the caller's credentials travels: the owning
   * side gets the path, `accept` and a socket's subprotocol, and grants or refuses by its own connection grant.
   */
  const connectionProxy = async (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>, connection: string): Promise<Response | undefined> => {
    const peer = req.params.peer ?? "", app = req.params.app ?? "";
    if (opts.callerApp) {
      const caller = await opts.callerApp(req);
      if (caller !== null && caller !== app) return error(403, "an app may reach only the app of its own name on a connected Space");
    }
    const u = new URL(req.url);
    const rest = u.pathname.replace(/^\/api\/peers\/[^/]+\/apps\/[^/]+\/proxy/, "");
    if (!rest.startsWith("/api/")) return error(404, "only the app's /api/ paths are proxied");
    const unreachable = (e: unknown) => error(502, `peer ${peer} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
    if (wantsWebSocket(req)) {
      if (!sameOrigin(req)) return error(403, "cross-origin request refused");
      const protocol = req.headers.get("sec-websocket-protocol");
      const meta = { operation: "socket", app, path: rest + u.search, method: "GET", headers: protocol ? [["sec-websocket-protocol", protocol]] : [] };
      try {
        return await upgradeToChannelSocket(req, server as Bun.Server<WsData>, (input, signal) => opts.connections!.request(connection, meta, input, signal));
      } catch (e) {
        return unreachable(e);
      }
    }
    const meta = { operation: "fetch", app, path: rest + u.search, method: "GET", headers: [["accept", req.headers.get("accept") ?? "application/json"]] };
    try {
      const up = await opts.connections!.request(connection, meta, null, AbortSignal.any([req.signal, AbortSignal.timeout(PROXY_TIMEOUT_MS)]));
      return relayed(new Response(up.body, { status: up.status, headers: { "content-type": up.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store" } }));
    } catch (e) {
      return unreachable(e);
    }
  };

  return {
    "/api/peers": {
      GET: () => {
        const peers = hub.status().map((s) => ({ ...s, duplicates: duplicatesOf(s.name) }));
        return json({ ok: true, peers, asOf: new Date().toISOString() });
      },
    },

    "/api/peers/:peer/rename": {
      POST: async (req) => {
        if (!opts.rename) return error(404, "renaming peers is not available here");
        const from = req.params.peer ?? "";
        if (!hub.get(from)) return error(404, `unknown peer: ${from}`);
        if (hub.get(from)!.config.connection) return error(400, `peer ${from} is a package connection: give the connection another alias instead`);
        const body = (await req.json().catch(() => ({}))) as { to?: unknown };
        if (typeof body.to !== "string" || !body.to.trim()) return error(400, "to must be the new peer name");
        try {
          return json({ ok: true, ...(await opts.rename(from, body.to.trim())) });
        } catch (e) {
          return error(e instanceof RenameError ? 400 : 500, (e as Error).message);
        }
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

    "/api/peers/:peer/model/apps": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/apps/:app/model": {
      PATCH: (req, server) => {
        if (!req.headers.get("origin") || !sameOrigin(req)) return error(403, "same-origin browser request required");
        return proxy(FORWARD_TIMEOUT_MS)(req, server);
      },
    },
    "/api/peers/:peer/tasks": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/tasks/models": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/tasks/:id/runs": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/tasks/:id/model": {
      PATCH: (req, server) => {
        if (!req.headers.get("origin") || !sameOrigin(req)) return error(403, "same-origin browser request required");
        return proxy(FORWARD_TIMEOUT_MS)(req, server);
      },
    },
    "/api/peers/:peer/apps/:app/icon": { GET: picture(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/apps/:app/appcolor": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/avatar": { GET: picture(FORWARD_TIMEOUT_MS) },
    // The peer's embed page arrives on this panel's origin: it keeps the sandbox the peer gave it.
    "/api/peers/:peer/widgets/:app/:name/embed": {
      GET: async (req, server) => {
        const r = await proxy(FORWARD_TIMEOUT_MS)(req, server);
        if (r) for (const [k, v] of Object.entries(EMBED_HEADERS)) r.headers.set(k, v);
        return r;
      },
    },
    // A chat stream stays open as long as the peer's does; the browser leaving only detaches it,
    // the turn goes on on the peer as a background run (docs/panel.md#chat).
    "/api/peers/:peer/agents/:app/:agent/chat": { POST: agentProxy() },
    "/api/peers/:peer/agents/runs": { GET: proxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs": { GET: agentProxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs/:id": { GET: agentProxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs/:id/events": { GET: agentProxy() },
    "/api/peers/:peer/agents/:app/:agent/runs/:id/stop": { POST: agentProxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs/:id/steer": { POST: agentProxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/runs/:id/approvals/:rid": { POST: agentProxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/watch": { GET: agentProxy() },
    // A peer agent's chat cards (docs/chat-cards.md): the owner's only, like the chat they come from.
    "/api/peers/:peer/agents/cards/state": { POST: agentProxy(CARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/cards/action": { POST: agentProxy(CARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/sessions": { GET: agentProxy(FORWARD_TIMEOUT_MS) },
    "/api/peers/:peer/agents/:app/:agent/sessions/:sid": { GET: agentProxy(FORWARD_TIMEOUT_MS) },
    // An app on this hub reading a peer app's API; the peer bounds the call with its own timeout.
    // A legacy peer of that name wins; otherwise a connection whose Space has that label and shares the app.
    "/api/peers/:peer/apps/:app/proxy/*": {
      GET: (req, server) => {
        const named = hub.get(req.params.peer ?? "");
        const legacy = named && !named.config?.connection;
        const connection = !legacy ? opts.connections?.find(req.params.peer ?? "", req.params.app ?? "") : undefined;
        if (connection) return connectionProxy(req, server, connection);
        if (!wantsWebSocket(req)) return proxy(PROXY_TIMEOUT_MS)(req, server);
        // A socket carries no token here, like the panel routes; an app's server sends no Origin,
        // and a page on another site must not reach a peer app through the operator's browser.
        if (!sameOrigin(req)) return error(403, "cross-origin request refused");
        const client = req.params.peer ? hub.get(req.params.peer) : undefined;
        if (!client) return error(404, `unknown peer: ${req.params.peer}`);
        const u = new URL(req.url);
        const rest = u.pathname.replace(/^\/api\/peers\/[^/]+\/apps\/[^/]+\/proxy/, "");
        if (!rest.startsWith("/api/")) return error(404, "only the app's /api/ paths are proxied");
        const path = `${u.pathname.replace(/^\/api\/peers\/[^/]+/, "/api/peer")}${u.search}`;
        if (server.upgrade(req, { data: { attachment: bridgeTo(() => client.socket(path), `peer ${client.name}`) } })) return undefined;
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

/**
 * A peer's answer as this route's own: a body the peer, the link or the channel cuts short (a revoked scope,
 * a dropped connection, a stopped run) ends the response here. Bun.serve ends it the same way when its body
 * stream errors, but prints the error as if it were uncaught; the browser sees no difference, the log a
 * stack trace for every revocation. The response then looks complete, which suits a stream (events, a
 * chat turn) but not a file: pictures go through `picture`, which reads the whole body first.
 */
function relayed(res: Response): Response {
  if (!res.body) return res;
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      } catch {
        c.close();
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
