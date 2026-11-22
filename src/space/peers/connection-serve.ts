import type { Connection } from "../packages/connections.ts";
import { mapping } from "../packages/contract.ts";
import type { LinkHandler } from "../packages/links.ts";
import { attachmentResponse } from "../packages/socket.ts";
import type { WsAttachment } from "../terminal/service.ts";
import { peerRouteOf, type PeerScope } from "./scopes.ts";
import type { PeerRoutes } from "./serve.ts";

/**
 * The peer side of the connection transport (docs/app-packages.md#the-peer-operation): a `peer` operation
 * on a package connection is one request into this Space's own `/api/peer/*` handlers (serve.ts
 * `createPeerServeHandlers`), the same ones a hub reaches over HTTPS with `SPACE_HUB_TOKEN`. Instead of the
 * token, the route's scope (scopes.ts) must be granted to that connection here, or the connection trusts
 * fully. A path that is not in the scope table is refused, whatever handler might exist for it.
 *
 *   meta: { operation: "peer", method, path: "/api/peer/...?query", headers: [[name, value]], socket?: true }
 *
 * Only `/api/peer/*` is reachable: no other route of this Space (its operator API, its connections) and
 * nothing on another connection. Of the caller's headers only those the routes read pass (`PASS_HEADERS`);
 * of the answer's only those a hub uses come back (`ANSWER_HEADERS`), never a cookie. A `socket` request is
 * a route that upgrades (the terminal's socket, an app socket through the proxy): its handler runs against a
 * socket made of the stream's frames (packages/socket.ts `attachmentResponse`).
 */

/** What a hub's request may carry into a route: its body's type, what it accepts, who calls, the terminal's passphrase. */
const PASS_HEADERS = ["accept", "content-type", "x-space-caller", "x-terminal-passphrase", "last-event-id", "sec-websocket-protocol", "user-agent"];
/** What a route's answer carries back: its type and caching, a chat's run id, a call's record, an embed's sandbox. */
const ANSWER_HEADERS = ["content-type", "cache-control", "content-disposition", "content-security-policy", "x-content-type-options", "x-run-id", "x-space-call-id", "x-space-call-ms", "x-space-socket-protocol"];

export type ConnectionPeerServeOptions = {
  /** `createPeerServeHandlers(...)`: every route without its bearer check. */
  routes: PeerRoutes;
  /** Whether this Space grants `scope` to the connection now (connections.ts `allowsScope`). */
  allows: (connection: string, scope: PeerScope) => boolean;
};

export function createConnectionPeerServe(opts: ConnectionPeerServeOptions): LinkHandler {
  return async (connection: Connection, meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Response> => {
    let m: Record<string, unknown>;
    try { m = mapping(meta, "peer request", ["operation", "method", "path", "headers", "socket", "app"]); }
    catch (e) { return refuse(400, (e as Error).message); }
    const method = typeof m.method === "string" ? m.method.toUpperCase() : "GET";
    const raw = typeof m.path === "string" ? m.path : "";
    if (!raw.startsWith("/api/peer/") || raw.length > 8192 || /[\x00-\x20\x7f\\#]/.test(raw)) return refuse(400, "path must be an /api/peer/ path");
    const url = new URL(raw, "http://peer.invalid");
    // A dot segment or an encoded one would name another route than the one checked: the path must be as it is read.
    if (url.pathname + url.search !== raw || /%2e/i.test(url.pathname)) return refuse(400, "path must be an /api/peer/ path");
    const route = peerRouteOf(method, url.pathname);
    if (!route) return refuse(403, `${method} ${url.pathname} is not available over a connection`);
    if (!opts.allows(connection.id, route.scope)) return refuse(403, `this Space does not grant the ${route.scope} scope to the connection`);
    const entry = opts.routes[route.path];
    const handler = typeof entry === "function" ? entry : entry?.[route.method];
    if (!handler) return refuse(404, `${route.path} is not served here`);
    const socket = m.socket === true;
    if (socket && method !== "GET") return refuse(400, "a socket is opened with GET");

    const headers = new Headers();
    for (const pair of Array.isArray(m.headers) ? m.headers.slice(0, 64) : []) {
      if (!Array.isArray(pair) || typeof pair[0] !== "string" || typeof pair[1] !== "string") continue;
      const name = pair[0].toLowerCase();
      if (PASS_HEADERS.includes(name) && pair[1].length <= 4096) headers.set(name, pair[1]);
    }
    if (socket) { headers.set("upgrade", "websocket"); headers.set("connection", "Upgrade"); }
    const req = Object.assign(new Request(url, { method, headers, signal, ...(method === "GET" || method === "HEAD" || socket ? {} : { body }) }), { params: route.params });

    // A route that upgrades hands its socket handler to this stand-in for the server; nothing else is upgraded.
    let attachment: WsAttachment | undefined;
    const server = { upgrade: (_req: Request, o?: { data?: { attachment?: WsAttachment } }) => { if (!socket || !o?.data?.attachment) return false; attachment = o.data.attachment; return true; } };
    let response: Response | undefined;
    try { response = await handler(req, server as unknown as Bun.Server<unknown>); }
    catch (e) { return refuse(400, (e as Error).message ?? String(e)); }
    if (attachment) return attachmentResponse(attachment, body, signal, { attachment });
    if (!response) return refuse(400, "the route answered nothing");
    if (socket && response.ok) { await response.body?.cancel().catch(() => {}); return refuse(400, "the route did not open a socket"); }
    const out = new Headers();
    for (const name of ANSWER_HEADERS) { const v = response.headers.get(name); if (v !== null) out.set(name, v); }
    return new Response(response.body, { status: response.status, headers: out });
  };
}

function refuse(status: number, error: string): Response {
  return Response.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });
}
