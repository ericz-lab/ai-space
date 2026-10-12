import type { Server } from "bun";
import { bearer, isOperator } from "../auth.ts";
import type { WsAttachment, WsData } from "../terminal/service.ts";
import { PackageChannel } from "./channel.ts";
import { Connections, type Connection } from "./connections.ts";
import { mapping } from "./contract.ts";

export type SharedApp = { app: string; title: string; version: string };
export type LinkHandler = (connection: Connection, meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>;
type Live = { channel?: PackageChannel; close: () => void };

/** Peer-initiated channels carry requests in both directions; each owner checks its own grant. */
export class PackageLinks {
  private readonly live = new Map<string, Live>();
  private readonly errors = new Map<string, string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private closed = false;
  constructor(readonly connections: Connections, private readonly options: {
    env: Record<string, string | undefined>;
    apps: () => SharedApp[];
    handle?: LinkHandler;
  }) {
    this.unsubscribe = connections.onChange((id) => {
      this.disconnect(id); // Revocation/rotation closes in-flight work, including streaming responses.
      this.refresh();
    });
    this.timer = setInterval(() => this.refresh(), 5000); this.timer.unref();
  }

  status() { return this.connections.list().map((c) => ({ ...c, connected: !!this.live.get(c.id)?.channel, error: this.errors.get(c.id) })); }

  async request(id: string, meta: unknown, body: ReadableStream<Uint8Array> | null = null, signal?: AbortSignal): Promise<Response> {
    const connection = this.connections.get(id);
    const channel = this.live.get(id)?.channel;
    if (!connection?.enabled || !channel) throw new Error("remote Space is offline");
    return channel.request(meta, body, signal);
  }

  refresh(): void {
    if (this.closed) return;
    for (const c of this.connections.list()) if (c.direction === "outgoing" && c.enabled && !this.live.has(c.id)) this.connect(c);
  }

  accept(c: Connection, authorized: () => boolean = () => true): WsAttachment {
    let live: Live | undefined;
    return {
      open: (ws) => {
        // Recheck after upgrade: a grant may have been revoked between authentication and open.
        if (!this.connections.get(c.id)?.enabled || !authorized()) { ws.close(4003, "connection revoked"); return; }
        this.disconnect(c.id);
        const channel = new PackageChannel((data) => { if (ws.getBufferedAmount() > 4 * 1024 ** 2) throw new Error("connection backpressure limit"); ws.send(data); }, (meta, body, signal) => this.handle(c.id, meta, body, signal), "b", () => ws.close(4002, "channel closed"));
        live = { channel, close: () => { channel.close(); ws.close(1000, "connection changed"); } };
        this.live.set(c.id, live); this.errors.delete(c.id);
        ws.send(JSON.stringify({ kind: "hello", spaceId: this.connections.spaceId, protocol: 1 }));
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
    try { socket = new WebSocket(c.url!.replace(/^http/, "ws") + "/api/connections/channel", { headers: { authorization: `Bearer ${token}`, "x-space-id": this.connections.spaceId } } as unknown as string[]); }
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
          if (hello.kind !== "hello" || hello.protocol !== 1 || hello.spaceId !== c.remoteSpaceId) throw new Error("remote Space identity mismatch");
          clearTimeout(timeout);
          channel = new PackageChannel((data) => { if (socket.bufferedAmount > 4 * 1024 ** 2) throw new Error("connection backpressure limit"); socket.send(data); }, (meta, body, signal) => this.handle(c.id, meta, body, signal), "a", () => socket.close(4002, "channel closed"));
          live.channel = channel; this.errors.delete(c.id);
        } catch { this.errors.set(c.id, "remote Space identity mismatch"); socket.close(4003, "identity mismatch"); }
      } else channel.receive(e.data);
    };
    socket.onclose = () => {
      clearTimeout(timeout); channel?.close();
      if (this.live.get(c.id) === live) this.live.delete(c.id);
    };
    socket.onerror = () => { this.errors.set(c.id, "connection failed"); };
  }

  private async handle(id: string, meta: unknown, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<Response> {
    const c = this.connections.get(id);
    if (!c?.enabled) return Response.json({ error: "connection revoked" }, { status: 403 });
    const m = mapping(meta, "request", ["operation", "app", "path", "method", "headers"]);
    if (m.operation === "catalogue") return Response.json({ spaceId: this.connections.spaceId, apps: this.options.apps().filter((a) => this.connections.allows(id, a.app)) });
    if (typeof m.app !== "string" || !this.connections.allows(id, m.app)) return Response.json({ error: "application access denied" }, { status: 403 });
    if (m.operation !== "fetch" && m.operation !== "socket") return Response.json({ error: "operation not allowed" }, { status: 403 });
    // Only locally owned apps are dispatched. No forwarding to another connection or admin API.
    if (!this.options.apps().some((a) => a.app === m.app)) return Response.json({ error: "application not found" }, { status: 404 });
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
      DELETE: guard((req) => ({ connection: opts.links.connections.update(req.params.id!, { enabled: false }) })),
    },
    "/api/connections/:id/rotate": { POST: guard((req) => ({ token: opts.links.connections.rotate(req.params.id!) })) },
    "/api/connections/channel": {
      GET: (req, server) => {
        const c = opts.links.connections.authenticate(bearer(req), req.headers.get("x-space-id") ?? "");
        if (!c) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
        const authorized = () => opts.links.connections.authenticate(bearer(req), req.headers.get("x-space-id") ?? "")?.id === c.id;
        if (server.upgrade(req, { data: { attachment: opts.links.accept(c, authorized) } })) return undefined;
        return Response.json({ ok: false, error: "websocket upgrade failed" }, { status: 400 });
      },
    },
  };
}
