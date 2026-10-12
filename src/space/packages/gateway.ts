import type { Server } from "bun";
import { randomBytes } from "node:crypto";
import { isOperator } from "../auth.ts";
import { terminalWebSocket } from "../terminal/api.ts";
import type { WsData } from "../terminal/service.ts";
import { installationKey, mapping, text } from "./contract.ts";
import type { PackageLinks } from "./links.ts";
import { sha256 } from "./pack.ts";
import type { PackageRuntime } from "./runtime.ts";
import { processSocket, safeCloseCode, socketFrames, socketMessage, socketQueue } from "./socket.ts";

type Target = { app: string; spaceId: string; connectionId?: string };
type Entry = Target & { label: string; origin: string };
type Session = { entry: Entry; expires: number };
const COOKIE = "__space_package_session";
const TICKET_PATH = "/_space/package-session";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const REQUEST_HEADERS = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since", "last-event-id", "authorization", "cookie", "sec-websocket-protocol"];

/** An app-only virtual-host server, deliberately separate from the operator panel's routes. */
export class PackageGateway {
  private server?: Server<WsData>;
  private readonly tickets = new Map<string, Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly entries = new Map<string, Entry>();
  private base?: URL;
  constructor(readonly runtime: PackageRuntime, readonly links: PackageLinks, readonly spaceId: string) {}

  start(port: number, publicBase?: string): number {
    const base = publicBase ? new URL(publicBase) : undefined;
    if (base && (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)) throw new Error("package public base must be an HTTPS origin");
    if (this.server) throw new Error("package gateway already started");
    this.server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, websocket: terminalWebSocket, fetch: (req, server) => this.fetch(req, server) });
    this.base = base ?? new URL(`http://localhost:${this.server.port}`);
    return this.server.port!;
  }

  close(): void { this.server?.stop(true); this.tickets.clear(); this.sessions.clear(); this.entries.clear(); }

  async open(target: Target): Promise<{ url: string; spaceId: string; app: string }> {
    if (!this.base) throw new Error("application gateway is disabled; configure SPACE_PACKAGE_PORT");
    installationKey(target.spaceId, target.app);
    if (target.spaceId === this.spaceId) {
      if (target.connectionId || !this.runtime.get(target.app)?.manifest.launch) throw new Error("local application has no page");
    } else {
      const c = target.connectionId ? this.links.connections.get(target.connectionId) : undefined;
      if (!c || c.remoteSpaceId !== target.spaceId) throw new Error("application connection does not match Space identity");
      const response = await this.links.request(c.id, { operation: "catalogue" });
      const catalogue = await response.json() as { spaceId: string; apps: { app: string }[] };
      if (catalogue.spaceId !== target.spaceId || !catalogue.apps.some((a) => a.app === target.app)) throw new Error("remote application is not shared");
    }
    this.prune();
    if (this.tickets.size + this.sessions.size >= 1024) throw new Error("application session limit reached");
    const label = sha256(new TextEncoder().encode(installationKey(target.spaceId, target.app))).slice(0, 40);
    const origin = new URL(this.base); origin.hostname = `${label}.${origin.hostname}`;
    const entry = { ...target, label, origin: origin.origin };
    this.entries.set(origin.host, entry);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { entry, expires: Date.now() + 30_000 });
    return { url: `${origin.origin}${TICKET_PATH}?ticket=${ticket}`, spaceId: target.spaceId, app: target.app };
  }

  /** The owning Space calls this only after its connection's local app grant was checked. */
  async local(meta: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response> {
    const m = mapping(meta, "app request", ["operation", "app", "path", "method", "headers"]);
    const app = text(m.app, "app", 64);
    const path = requestPath(m.path);
    const method = text(m.method ?? "GET", "method", 10);
    if (!METHODS.includes(method)) return new Response("Method not allowed", { status: 405 });
    if (m.operation === "socket") return this.localSocket(app, path, m.headers, body, signal);
    if (m.operation !== "fetch") return new Response("Unknown operation", { status: 400 });
    const installed = this.runtime.get(app);
    if (!installed?.manifest.launch) return new Response("Application not found", { status: 404 });
    if (installed.manifest.launch.kind === "static") {
      if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const response = await this.runtime.staticResponse(app, new URL(path, "http://local").pathname);
      return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    const lease = await this.runtime.acquire(app);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const release = () => { signal.removeEventListener("abort", abort); controller.abort(); lease.release(); };
    try {
      const origin = `http://127.0.0.1:${lease.port}`;
      const headers = appHeaders(m.headers);
      headers.set("origin", origin);
      const response = await fetch(origin + path, { method, headers, body: method === "GET" || method === "HEAD" ? null : body, redirect: "manual", signal: controller.signal, decompress: false });
      const output = new Headers(response.headers);
      // Relative redirects remain relative to the viewer's app origin. Internal absolute redirects do too.
      const location = output.get("location");
      if (location) {
        const target = new URL(location, origin);
        if (target.origin === origin) output.set("location", target.pathname + target.search + target.hash);
      }
      output.delete("transfer-encoding"); output.delete("connection");
      return holdResponse(response, output, release);
    } catch (e) { release(); throw e; }
  }

  private async localSocket(app: string, path: string, rawHeaders: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response> {
    if (this.runtime.get(app)?.manifest.launch?.kind !== "process") return new Response("Application has no socket service", { status: 404 });
    const lease = await this.runtime.acquire(app);
    const headers = appHeaders(rawHeaders); headers.set("origin", `http://127.0.0.1:${lease.port}`);
    return processSocket(`ws://127.0.0.1:${lease.port}${path}`, headers, body, signal, lease.release);
  }

  private async fetch(req: Request, server: Server<WsData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    const entry = this.entries.get(req.headers.get("host") ?? url.host);
    if (!entry) return new Response("Unknown application origin", { status: 404 });
    if (url.pathname === TICKET_PATH) {
      const token = url.searchParams.get("ticket") ?? "";
      const ticket = this.tickets.get(token); this.tickets.delete(token);
      if (req.method !== "GET" || !ticket || ticket.expires <= Date.now() || ticket.entry.origin !== entry.origin) return new Response("Invalid or expired application ticket", { status: 403 });
      const session = randomBytes(32).toString("base64url");
      this.sessions.set(session, { entry, expires: Date.now() + 12 * 3600_000 });
      return new Response(null, { status: 303, headers: { location: "/", "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/${entry.origin.startsWith("https:") ? "; Secure" : ""}` } });
    }
    const values = (req.headers.get("cookie") ?? "").split(";").map((p) => p.trim()).filter((p) => p.startsWith(`${COOKIE}=`)).map((p) => p.slice(COOKIE.length + 1));
    const session = values.length === 1 ? this.sessions.get(values[0]!) : undefined;
    if (!session || session.expires <= Date.now() || session.entry.origin !== entry.origin) return new Response("Open this application from Space", { status: 401 });
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    if (origin && origin !== entry.origin || !origin && site && site !== "same-origin" && site !== "none" && req.headers.get("sec-fetch-mode") !== "navigate") return new Response("Cross-origin application request refused", { status: 403 });
    if (!origin && !["GET", "HEAD"].includes(req.method) && site !== "same-origin") return new Response("Application write requires same origin", { status: 403 });
    const headers = appHeaders([...req.headers]);
    const cookie = (headers.get("cookie") ?? "").split(";").filter((p) => !p.trim().startsWith(`${COOKIE}=`)).join(";");
    if (cookie) headers.set("cookie", cookie); else headers.delete("cookie");
    const meta = { operation: "fetch", app: entry.app, path: url.pathname + url.search, method: req.method, headers: [...headers] };
    try {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return await this.browserSocket(req, server, entry, { ...meta, operation: "socket" });
      const upstream = await this.dispatch(entry, meta, req.body, req.signal);
      const output = new Headers(upstream.headers);
      output.delete("set-cookie");
      for (const cookie of upstream.headers.getSetCookie()) {
        if (cookie.split("=", 1)[0]?.trim() === COOKIE) continue;
        // Apps cannot set the gateway's credential or broaden a server-set cookie to sibling origins.
        output.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/ig, ""));
      }
      output.set("referrer-policy", "no-referrer"); output.set("origin-agent-cluster", "?1");
      output.set("x-content-type-options", "nosniff");
      return new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: output });
    } catch { return new Response("Application is unavailable", { status: 502 }); }
  }

  private async browserSocket(req: Request, server: Server<WsData>, entry: Entry, meta: unknown): Promise<Response | undefined> {
    if (req.headers.get("origin") !== entry.origin) return new Response("Socket origin refused", { status: 403 });
    const input = socketQueue();
    const controller = new AbortController();
    const abort = () => { input.end(); controller.abort(); };
    req.signal.addEventListener("abort", abort, { once: true });
    let response: Response;
    try { response = await this.dispatch(entry, meta, input.stream, controller.signal); }
    catch (e) { abort(); req.signal.removeEventListener("abort", abort); throw e; }
    if (!response.ok || !response.body) { abort(); req.signal.removeEventListener("abort", abort); return response; }
    const stream = response.body;
    const protocol = response.headers.get("x-space-socket-protocol");
    // Bun negotiates from the request; an explicit response header duplicates its automatic header.
    if (protocol) req.headers.set("sec-websocket-protocol", protocol);
    else req.headers.delete("sec-websocket-protocol");
    const upgraded = server.upgrade(req, { data: { attachment: {
      open(ws) {
        req.signal.removeEventListener("abort", abort);
        void (async () => {
          try {
            for await (const frame of socketFrames(stream)) {
              if (frame.kind === "close") { ws.close(safeCloseCode(frame.code), frame.reason.slice(0, 30)); return; }
              if (ws.getBufferedAmount() > 1024 * 1024) throw new Error("socket backpressure limit");
              const bytes = Buffer.from(frame.data, "base64"); ws.send(frame.binary ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes));
            }
            ws.close(1000, "application socket ended");
          } catch { ws.close(4002, "application socket failed"); }
          finally { abort(); }
        })();
      },
      message(ws, message) { try { input.push(socketMessage(message)); } catch { abort(); ws.close(4002, "socket input limit"); } },
      close() { abort(); },
    } } });
    if (!upgraded) { abort(); req.signal.removeEventListener("abort", abort); return new Response("Socket upgrade failed", { status: 400 }); }
    return undefined;
  }

  private dispatch(entry: Entry, meta: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response> {
    return entry.connectionId ? this.links.request(entry.connectionId, meta, body, signal) : this.local(meta, body, signal);
  }
  private prune(): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
}

function appHeaders(raw: unknown): Headers {
  const input = new Headers(raw as HeadersInit | undefined);
  const headers = new Headers();
  for (const key of REQUEST_HEADERS) { const value = input.get(key); if (value !== null) headers.set(key, value); }
  return headers;
}
function requestPath(raw: unknown): string {
  const path = text(raw, "path", 8192);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#")) throw new Error("application path must be local");
  return path;
}
function holdResponse(response: Response, headers: Headers, release: () => void): Response {
  if (!response.body) { release(); return new Response(null, { status: response.status, headers }); }
  const reader = response.body.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const { done, value } = await reader.read(); if (done) { controller.close(); release(); } else controller.enqueue(value); }
      catch (e) { controller.error(e); release(); }
    },
    async cancel() { try { await reader.cancel(); } finally { release(); } },
  }), { status: response.status, headers });
}

type RequestWithParams = Request & { params: Record<string, string> };
export function createPackageOpenRoutes(gateway: PackageGateway, token: string) {
  return {
    "/api/packages/open": { POST: async (req: RequestWithParams) => {
      if (!isOperator(req, token)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      try {
        const d = mapping(await req.json(), "application target", ["app", "spaceId", "connectionId"]);
        const target = { app: text(d.app, "app", 64), spaceId: text(d.spaceId, "spaceId", 36), ...(d.connectionId === undefined ? {} : { connectionId: text(d.connectionId, "connectionId", 36) }) };
        return Response.json({ ok: true, ...await gateway.open(target) });
      } catch (e) { return Response.json({ ok: false, error: (e as Error).message }, { status: 400 }); }
    } },
  };
}
