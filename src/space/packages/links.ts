import type { Server } from "bun";
import { bearer, isOperator } from "../auth.ts";
import { peerRouteOf } from "../peers/scopes.ts";
import type { WsAttachment, WsData } from "../terminal/service.ts";
import { CHANNEL_PROTOCOL, PackageChannel, type RequestOptions } from "./channel.ts";
import { Connections, grantedScopes, type Connection } from "./connections.ts";
import { mapping } from "./contract.ts";

/** `icon` is a short text icon (an emoji); `iconFile` says the `icon` operation returns an image. */
export type SharedApp = { app: string; title: string; version: string; page?: boolean; icon?: string; iconFile?: boolean };
export type LinkHandler = (connection: Connection, meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>;
type Live = { channel?: PackageChannel; close: () => void };
/** The header a dialing Space names its channel protocol in (channel.ts `CHANNEL_PROTOCOL`). */
export const PROTOCOL_HEADER = "x-space-channel-protocol";

/**
 * Who a stream belongs to, for the channel's per-kind cap and for ending the streams of a revoked grant:
 * an app operation is its app's, a `peer` operation its route's scope (peers/scopes.ts).
 */
export function streamKind(meta: unknown): string | undefined {
  const m = meta as { operation?: unknown; app?: unknown; method?: unknown; path?: unknown } | null;
  if (!m || typeof m !== "object") return undefined;
  if (m.operation === "peer") {
    const route = typeof m.path === "string" ? peerRouteOf(typeof m.method === "string" ? m.method : "GET", m.path.split("?")[0]!) : undefined;
    return route ? `scope:${route.scope}` : undefined;
  }
  return typeof m.app === "string" ? `app:${m.app}` : undefined;
}

/** Peer-initiated channels carry requests in both directions; each owner checks its own grant. */
export class PackageLinks {
  private readonly live = new Map<string, Live>();
  private readonly errors = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private closed = false;
  /**
   * Answers a `peer` operation: one request into this Space's `/api/peer/*` handlers, checked against the
   * connection's scopes (peers/connection-serve.ts). Unset, the operation is 404.
   */
  peer?: LinkHandler;
  /** How a connection shows as a peer on this Space (peers/connection-peers.ts `status`), for the connection list; unset, nothing. */
  peerState?: (id: string) => unknown;
  constructor(readonly connections: Connections, private readonly options: {
    env: Record<string, string | undefined>;
    apps: () => SharedApp[];
    /** This Space's name (`SPACE_NAME`), sent with the catalogue as the label of its tiles elsewhere. */
    name?: string;
    /** The icon image of a locally owned app, for the tile a connected Space shows. */
    icon?: (app: string) => Promise<Response | undefined>;
    handle?: LinkHandler;
  }) {
    this.unsubscribe = connections.onChange((id, change) => {
      // A changed app list or scope set keeps the channel: only the streams that needed what was taken away
      // end, and every new request is checked against the grant as it arrives (`handle`). A new name changes nothing here.
      if (change.kind === "label") return;
      if (change.kind === "grants") {
        const kinds = [...change.revoked.map((a) => `app:${a}`), ...change.revokedScopes.map((s) => `scope:${s}`)];
        if (kinds.length) this.live.get(id)?.channel?.cancelKinds(kinds);
        return;
      }
      this.disconnect(id); // Disable, removal and rotation close in-flight work, including streaming responses.
      if (!connections.get(id)) this.errors.delete(id);
      this.refresh();
    });
    this.timer = setInterval(() => this.refresh(), 5000); this.timer.unref();
  }

  /** This Space's apps a grant can name: installed packages and spec-1 apps with a service port. */
  shareable(): SharedApp[] { return this.options.apps(); }

  status() {
    return this.connections.list().map((c) => {
      const peer = this.peerState?.(c.id);
      return { ...c, connected: !!this.live.get(c.id)?.channel, error: this.errors.get(c.id), ...(peer ? { peer } : {}) };
    });
  }

  async request(id: string, meta: unknown, body: ReadableStream<Uint8Array> | null = null, signal?: AbortSignal, opts?: RequestOptions): Promise<Response> {
    const connection = this.connections.get(id);
    const channel = this.live.get(id)?.channel;
    if (!connection?.enabled || !channel) throw new Error("remote Space is offline");
    return channel.request(meta, body, signal, opts);
  }

  refresh(): void {
    if (this.closed) return;
    for (const c of this.connections.list()) if (c.direction === "outgoing" && c.enabled && !this.live.has(c.id)) this.connect(c);
  }

  /** A dialing Space whose channel protocol is not this one's: refused before the upgrade, and said on the connection. */
  refuseProtocol(c: Connection, got: string | null): Response {
    const error = got ? `the connecting Space speaks channel protocol ${got}, this one ${CHANNEL_PROTOCOL}: upgrade both Spaces to the same ai-space version` : `the connecting Space runs an older ai-space (channel protocol 1, this one ${CHANNEL_PROTOCOL}): upgrade it`;
    this.errors.set(c.id, error);
    return Response.json({ ok: false, error }, { status: 426 });
  }

  accept(c: Connection, authorized: () => boolean = () => true): WsAttachment {
    let live: Live | undefined;
    return {
      open: (ws) => {
        // Recheck after upgrade: a grant may have been revoked between authentication and open.
        if (!this.connections.get(c.id)?.enabled || !authorized()) { ws.close(4003, "connection revoked"); return; }
        this.disconnect(c.id);
        const channel = new PackageChannel((data) => { if (ws.getBufferedAmount() > 4 * 1024 ** 2) throw new Error("connection backpressure limit"); ws.send(data); }, (meta, body, signal) => this.handle(c.id, meta, body, signal), "b", () => ws.close(4002, "channel closed"), { classify: streamKind });
        live = { channel, close: () => { channel.close(); ws.close(1000, "connection changed"); } };
        this.live.set(c.id, live); this.errors.delete(c.id);
        ws.send(JSON.stringify({ kind: "hello", spaceId: this.connections.spaceId, protocol: CHANNEL_PROTOCOL }));
      },
      message: (_ws, data) => { if (typeof data !== "string") { live?.close(); return; } live?.channel?.receive(data); },
      close: () => { live?.channel?.close(); if (this.live.get(c.id) === live) this.live.delete(c.id); },
    };
  }

  close(): void {
    this.closed = true; clearInterval(this.timer); this.unsubscribe();
    for (const id of [...this.live.keys()]) this.disconnect(id);
  }

  private connect(c: Connection): void {
    const token = c.tokenEnv ? this.options.env[c.tokenEnv] : undefined;
    if (!token) { this.errors.set(c.id, "connection credential is not configured"); return; }
    let socket: WebSocket;
    try { socket = new WebSocket(c.url!.replace(/^http/, "ws") + "/api/connections/channel", { headers: { authorization: `Bearer ${token}`, "x-space-id": this.connections.spaceId, [PROTOCOL_HEADER]: String(CHANNEL_PROTOCOL) } } as unknown as string[]); }
    catch { this.errors.set(c.id, "could not open connection"); return; }
    let channel: PackageChannel | undefined;
    const live: Live = { close: () => { channel?.close(); socket.close(1000, "connection changed"); } };
    this.live.set(c.id, live);
    const timeout = setTimeout(() => socket.close(4002, "identity handshake timed out"), 10_000);
    socket.onmessage = (e) => {
      if (typeof e.data !== "string") { socket.close(4002, "invalid channel data"); return; }
      if (!channel) {
        try {
          const hello = JSON.parse(e.data) as { kind: string; spaceId: string; protocol: number };
          if (hello.kind !== "hello" || hello.spaceId !== c.remoteSpaceId) throw new Error("remote Space identity mismatch");
          if (hello.protocol !== CHANNEL_PROTOCOL) throw new Error(`remote Space speaks channel protocol ${String(hello.protocol).slice(0, 8)}, this one ${CHANNEL_PROTOCOL}: upgrade both Spaces to the same ai-space version`);
          clearTimeout(timeout);
          channel = new PackageChannel((data) => { if (socket.bufferedAmount > 4 * 1024 ** 2) throw new Error("connection backpressure limit"); socket.send(data); }, (meta, body, signal) => this.handle(c.id, meta, body, signal), "a", () => socket.close(4002, "channel closed"), { classify: streamKind });
          live.channel = channel; this.errors.delete(c.id);
        } catch (err) { this.errors.set(c.id, (err as Error).message); socket.close(4003, "handshake refused"); }
      } else channel.receive(e.data);
    };
    socket.onclose = () => {
      clearTimeout(timeout); channel?.close();
      if (this.live.get(c.id) === live) this.live.delete(c.id);
    };
    // A refused upgrade (an acceptor of another protocol answers 426) reaches a WebSocket only as an error.
    socket.onerror = () => { if (!this.errors.has(c.id)) this.errors.set(c.id, "connection failed (an unreachable Space, a revoked credential, or one running another ai-space version)"); };
  }

  private async handle(id: string, meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Response> {
    const c = this.connections.get(id);
    if (!c?.enabled) return Response.json({ error: "connection revoked" }, { status: 403 });
    const m = mapping(meta, "request", ["operation", "app", "path", "method", "headers", "socket"]);
    // What this Space shares with the other: its apps, and what it lets the other do through `peer` (none, some scopes, or full trust).
    if (m.operation === "catalogue") return Response.json({ spaceId: this.connections.spaceId, ...(this.options.name ? { name: this.options.name } : {}), apps: this.options.apps().filter((a) => this.connections.allows(id, a.app)), peer: { scopes: grantedScopes(c), fullTrust: c.fullTrust } });
    if (m.operation === "peer") return this.peer ? this.peer(c, m, body, signal) : Response.json({ ok: false, error: "peer API not available" }, { status: 404 });
    if (typeof m.app !== "string" || !this.connections.allows(id, m.app)) return Response.json({ error: "application access denied" }, { status: 403 });
    if (m.operation !== "icon" && m.operation !== "fetch" && m.operation !== "socket") return Response.json({ error: "operation not allowed" }, { status: 403 });
    // Only locally owned apps are dispatched. No forwarding to another connection or admin API.
    const owned = this.options.apps().some((a) => a.app === m.app);
    if (m.operation === "icon") return (owned && await this.options.icon?.(m.app)) || Response.json({ error: "application has no icon" }, { status: 404 });
    if (!owned) return Response.json({ error: "application not found" }, { status: 404 });
    if (!this.options.handle) return Response.json({ error: "application gateway not available" }, { status: 503 });
    return this.options.handle(c, m, body, signal);
  }

  private disconnect(id: string): void { const live = this.live.get(id); this.live.delete(id); live?.close(); }
}

type Req = Request & { params: Record<string, string> };
type Handler = (req: Req, server: Server<WsData>) => Response | undefined | Promise<Response | undefined>;

export function createConnectionRoutes(opts: { links: PackageLinks; token: string }): Record<string, Record<string, Handler>> {
  const guard = (fn: (req: Req) => unknown): Handler => (req) => {
    if (!isOperator(req, opts.token)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    return Promise.resolve().then(() => fn(req)).then((value) => Response.json({ ok: true, ...value as object }), (e) => Response.json({ ok: false, error: (e as Error).message }, { status: 400 }));
  };
  return {
    "/api/connections": {
      GET: guard(() => ({ spaceId: opts.links.connections.spaceId, connections: opts.links.status() })),
      POST: guard(async (req) => opts.links.connections.create(await req.json())),
    },
    "/api/connections/:id": {
      PATCH: guard(async (req) => ({ connection: opts.links.connections.update(req.params.id!, await req.json()) })),
      DELETE: guard((req) => ({ connection: opts.links.connections.remove(req.params.id!) })),
    },
    "/api/connections/:id/rotate": { POST: guard((req) => ({ token: opts.links.connections.rotate(req.params.id!) })) },
    "/api/connections/channel": {
      GET: (req, server) => {
        const c = opts.links.connections.authenticate(bearer(req), req.headers.get("x-space-id") ?? "");
        if (!c) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        const protocol = req.headers.get(PROTOCOL_HEADER);
        if (protocol !== String(CHANNEL_PROTOCOL)) return opts.links.refuseProtocol(c, protocol);
        const authorized = () => opts.links.connections.authenticate(bearer(req), req.headers.get("x-space-id") ?? "")?.id === c.id;
        if (server.upgrade(req, { data: { attachment: opts.links.accept(c, authorized) } })) return undefined;
        return Response.json({ ok: false, error: "websocket upgrade failed" }, { status: 400 });
      },
    },
  };
}
