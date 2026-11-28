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
import { USAGE_PATH, USAGE_SCRIPT } from "../usage/script.ts";

type Target = { app: string; spaceId: string; connectionId?: string };
type Entry = Target & { label: string; origin: string };
/**
 * `via` binds a ticket, and the session it becomes, to the connection a direct open came over (`openFor`):
 * it gets what that connection's grant gives, checked on every request, and ends with the grant.
 */
type Session = { entry: Entry; expires: number; path?: string; via?: string };
/** In-flight work of a `via` session: aborted when its connection or its app grant goes. */
type Work = { via: string; app: string; controller: AbortController };
const COOKIE = "__space_package_session";
const TICKET_PATH = "/_space/package-session";
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
/** How long a hub skips the direct open of a connection whose owner cannot do it (older, or no public gateway). */
export const NO_DIRECT_MS = 5 * 60_000;
const PRIVATE_HEADERS = new Set(["host", "origin", "connection", "upgrade", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "content-length", "forwarded"]);

/** An app-only virtual-host server, deliberately separate from the operator panel's routes. */
export class PackageGateway {
  private server?: Server<WsData>;
  private readonly tickets = new Map<string, Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly entries = new Map<string, Entry>();
  private readonly work = new Set<Work>();
  /** Connections whose owner answered that it cannot open directly, until when (`NO_DIRECT_MS`). */
  private readonly noDirect = new Map<string, number>();
  private base?: URL;
  /** Whether `base` is a public HTTPS origin (`SPACE_PACKAGE_BASE_URL`), the only one handed to another Space. */
  private publicBase = false;
  private readonly unsubscribe: () => void;
  /** Records a local app's usage heartbeat; set once the usage service exists. Unset, the paths are 404. */
  usageBeat?: (app: string, tab: unknown) => void;
  /** Answers a local app's `/_space/feedback*` (docs/feedback.md) as the router does for source apps; unset, they are 404. */
  feedback?: (app: string, req: Request) => Response | Promise<Response>;
  /** Answers `/_space/ui.css`, the built-in apps' stylesheet (docs/ui-kit.md): static, so a remote app gets this Space's too; unset, it is 404. */
  uiKit?: (req: Request) => Response | Promise<Response>;
  /**
   * The loopback port of a local spec-1 app's service (`service.port`), for a connection that shares it;
   * unset or undefined, the app is not served. Only its `/api/` paths: a spec-1 page is not built to run
   * on an isolated origin (docs/app-packages.md#source-apps-over-a-connection).
   */
  servicePort?: (app: string) => number | undefined;
  constructor(readonly runtime: PackageRuntime, readonly links: PackageLinks, readonly spaceId: string) {
    // A session opened directly over a connection ends with it, as the channel's streams do (links.ts).
    this.unsubscribe = links.connections.onChange((id, change) => {
      if (change.kind === "label") return;
      if (change.kind === "reset") this.noDirect.delete(id);
      const gone = change.kind === "grants" ? (app: string) => change.revoked.includes(app) : () => true;
      for (const w of this.work) if (w.via === id && gone(w.app)) { this.work.delete(w); w.controller.abort(); }
      for (const map of [this.tickets, this.sessions]) for (const [key, s] of map) if (s.via === id && gone(s.entry.app)) map.delete(key);
    });
  }

  start(port: number, publicBase?: string): number {
    const base = publicBase ? new URL(publicBase) : undefined;
    if (base && (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash)) throw new Error("package public base must be an HTTPS origin");
    if (this.server) throw new Error("package gateway already started");
    this.server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 255, websocket: terminalWebSocket, fetch: (req, server) => this.fetch(req, server) });
    this.base = base ?? new URL(`http://localhost:${this.server.port}`);
    this.publicBase = !!base;
    return this.server.port!;
  }

  close(): void {
    this.unsubscribe(); this.server?.stop(true);
    for (const w of this.work) w.controller.abort();
    this.work.clear(); this.tickets.clear(); this.sessions.clear(); this.entries.clear(); this.noDirect.clear();
  }

  async open(target: Target, path = "/"): Promise<{ url: string; spaceId: string; app: string; direct?: true }> {
    requestPath(path);
    if (!this.base) throw new Error("application gateway is disabled; configure SPACE_PACKAGE_PORT");
    installationKey(target.spaceId, target.app);
    if (target.spaceId === this.spaceId) {
      if (target.connectionId || !this.runtime.get(target.app)?.manifest.launch) throw new Error("local application has no page");
    } else {
      const c = target.connectionId ? this.links.connections.get(target.connectionId) : undefined;
      if (!c || c.remoteSpaceId !== target.spaceId) throw new Error("application connection does not match Space identity");
      // First ask the owner for a ticket on its own gateway: one round trip, then the browser talks to it directly.
      const direct = await this.direct(c.id, target, path);
      if (direct) return { url: direct, spaceId: target.spaceId, app: target.app, direct: true };
      const response = await this.links.request(c.id, { operation: "catalogue" });
      const catalogue = await response.json() as { spaceId: string; apps: { app: string; page?: boolean }[] };
      const shared = catalogue.spaceId === target.spaceId ? catalogue.apps.find((a) => a.app === target.app) : undefined;
      if (!shared) throw new Error("remote application is not shared");
      if (shared.page === false) throw new Error("remote application has no page");
    }
    return { url: this.ticket(target, path), spaceId: target.spaceId, app: target.app };
  }

  /**
   * A direct open asked over connection `via` (links.ts `open` operation, after its grant was checked): a ticket on
   * this Space's own origin of the local app, bound to that connection, as `{ url }`. Only an installed package's page
   * on a public gateway: the loopback default means nothing to another Space, and a spec-1 page is not shared.
   */
  async openFor(via: string, app: string, path: unknown = "/"): Promise<Response> {
    if (!this.base || !this.publicBase) return Response.json({ error: "direct open not available" }, { status: 404 });
    if (!this.runtime.get(app)?.manifest.launch) return Response.json({ error: "application has no page" }, { status: 404 });
    try { return Response.json({ url: this.ticket({ app, spaceId: this.spaceId }, requestPath(path), via) }); }
    catch (e) { return Response.json({ error: (e as Error).message }, { status: 400 }); }
  }

  private ticket(target: Target, path: string, via?: string): string {
    this.prune();
    if (this.tickets.size + this.sessions.size >= 1024) throw new Error("application session limit reached");
    const label = originLabel(target.spaceId, target.app);
    const origin = new URL(this.base!); origin.hostname = `${label}.${origin.hostname}`;
    const entry = { ...target, label, origin: origin.origin };
    this.entries.set(origin.host, entry);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, { entry, path, expires: Date.now() + 30_000, ...(via ? { via } : {}) });
    return `${origin.origin}${TICKET_PATH}?ticket=${ticket}`;
  }

  /**
   * The owner's ticket URL for a direct open, or undefined to proxy as before: an owner that is older (403), has no public
   * gateway (404) or is slow, or an answer that is not a ticket on that app's origin of that Space. Only an offline Space throws.
   */
  private async direct(id: string, target: Target, path: string): Promise<string | undefined> {
    if ((this.noDirect.get(id) ?? 0) > Date.now()) return undefined;
    let response: Response;
    try { response = await this.links.request(id, { operation: "open", app: target.app, path }, null, AbortSignal.timeout(5000)); }
    catch (e) { if ((e as Error).message === "remote Space is offline") throw e; return undefined; }
    let answer: { url?: unknown; error?: unknown } | undefined;
    try { answer = await response.json() as typeof answer; } catch { await response.body?.cancel().catch(() => {}); return undefined; }
    // Not this owner at all, for any app: skip it for a while. A refusal of one app is not cached.
    if (response.status === 403 && answer?.error === "operation not allowed" || response.status === 404 && answer?.error === "direct open not available") {
      this.noDirect.set(id, Date.now() + NO_DIRECT_MS); return undefined;
    }
    return response.status === 200 && typeof answer?.url === "string" ? directUrl(answer.url, originLabel(target.spaceId, target.app)) : undefined;
  }

  /** The owning Space calls this only after its connection's local app grant was checked. */
  async local(meta: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal, trustedHeaders = false): Promise<Response> {
    const m = mapping(meta, "app request", ["operation", "app", "path", "method", "headers"]);
    const app = text(m.app, "app", 64);
    const path = requestPath(m.path);
    const method = text(m.method ?? "GET", "method", 10);
    if (!METHODS.includes(method)) return new Response("Method not allowed", { status: 405 });
    const service = this.sourceService(app, path);
    if (service instanceof Response) return service;
    if (m.operation === "socket") return this.localSocket(app, path, m.headers, body, signal, service);
    if (m.operation !== "fetch") return new Response("Unknown operation", { status: 400 });
    const installed = this.runtime.get(app);
    if (!installed?.manifest.launch && !service) return new Response("Application not found", { status: 404 });
    if (installed?.manifest.launch?.kind === "static") {
      if (method !== "GET" && method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      const response = await this.runtime.staticResponse(app, new URL(path, "http://local").pathname);
      return method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
    }
    // A spec-1 app's service runs on its own (or under the supervisor): no lease, no activation.
    const lease = service ?? await this.runtime.acquire(app);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const release = () => { signal.removeEventListener("abort", abort); controller.abort(); lease.release(); };
    try {
      const origin = `http://127.0.0.1:${lease.port}`;
      const headers = trustedHeaders ? new Headers(m.headers as HeadersInit) : appHeaders(m.headers);
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

  /** Host-owned calls keep bus/task headers; this entry point is not exposed through peer metadata. */
  request(app: string, path: string, init: RequestInit = {}): Promise<Response> {
    const req = new Request("http://local" + requestPath(path), init);
    return this.local({ operation: "fetch", app, path, method: req.method, headers: [...req.headers] }, req.body, req.signal, true);
  }

  /**
   * A spec-1 app served through `servicePort`: its port with a no-op release, a 404 for a path outside
   * its `/api/`, or undefined for an installed package (or an app with no service), which keeps its own path.
   */
  private sourceService(app: string, path: string): { port: number; release: () => void } | Response | undefined {
    if (this.runtime.get(app)) return undefined;
    const port = this.servicePort?.(app);
    if (!port) return undefined;
    if (!new URL(path, "http://local").pathname.startsWith("/api/")) return new Response("Only the application's /api/ paths are shared", { status: 404 });
    return { port, release: () => {} };
  }

  private async localSocket(app: string, path: string, rawHeaders: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal, service?: { port: number; release: () => void }): Promise<Response> {
    if (!service && this.runtime.get(app)?.manifest.launch?.kind !== "process") return new Response("Application has no socket service", { status: 404 });
    const lease = service ?? await this.runtime.acquire(app);
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
      this.sessions.set(session, { entry, expires: Date.now() + 12 * 3600_000, ...(ticket.via ? { via: ticket.via } : {}) });
      // Commit a document on the app origin before navigating: Strict cookies are omitted in
      // a cross-site HTTP redirect chain, including a freshly issued cookie on its final hop.
      const path = (ticket.path ?? "/").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
      return new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${path}"><title>Opening application</title><a href="${path}">Open application</a>`, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/${entry.origin.startsWith("https:") ? "; Secure" : ""}` } });
    }
    const values = (req.headers.get("cookie") ?? "").split(";").map((p) => p.trim()).filter((p) => p.startsWith(`${COOKIE}=`)).map((p) => p.slice(COOKIE.length + 1));
    const session = values.length === 1 ? this.sessions.get(values[0]!) : undefined;
    if (!session || session.expires <= Date.now() || session.entry.origin !== entry.origin) return new Response("Open this application from Space", { status: 401 });
    // A direct open gets what its connection's grant gives now, no more.
    if (session.via && !this.links.connections.allows(session.via, entry.app)) { this.sessions.delete(values[0]!); return new Response("Open this application from Space", { status: 401 }); }
    const remote = !!(entry.connectionId || session.via);
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    if (origin && origin !== entry.origin || !origin && site && site !== "same-origin" && site !== "none" && req.headers.get("sec-fetch-mode") !== "navigate") return new Response("Cross-origin application request refused", { status: 403 });
    if (!origin && !["GET", "HEAD"].includes(req.method) && site !== "same-origin") return new Response("Application write requires same origin", { status: 403 });
    if (url.pathname === "/_space/ui.css") return this.uiKit ? this.uiKit(req) : new Response("Not found", { status: 404 });
    const usage = this.usageResponse(req, entry, url.pathname, remote);
    if (usage) return usage;
    if (url.pathname === "/_space/feedback.js" || url.pathname === "/_space/feedback" || url.pathname.startsWith("/_space/feedback/")) {
      // The app is the session's, never the page's; a remote app's feedback belongs to its own Space, and
      // another Space's operator opening this one's app directly does not file it here either.
      return remote || !this.feedback ? new Response("Not found", { status: 404 }) : this.feedback(entry.app, req);
    }
    const headers = appHeaders([...req.headers]);
    const cookie = (headers.get("cookie") ?? "").split(";").filter((p) => !p.trim().startsWith(`${COOKIE}=`)).join(";");
    if (cookie) headers.set("cookie", cookie); else headers.delete("cookie");
    const meta = { operation: "fetch", app: entry.app, path: url.pathname + url.search, method: req.method, headers: [...headers] };
    try {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") return await this.browserSocket(req, server, entry, { ...meta, operation: "socket" }, session.via);
      const work = session.via ? this.track(session.via, entry.app) : undefined;
      let upstream: Response;
      try { upstream = await this.dispatch(entry, meta, req.body, work ? AbortSignal.any([req.signal, work.signal]) : req.signal); }
      catch (e) { work?.done(); throw e; }
      const output = new Headers(upstream.headers);
      output.delete("set-cookie");
      for (const cookie of upstream.headers.getSetCookie()) {
        if (cookie.split("=", 1)[0]?.trim() === COOKIE) continue;
        // Apps cannot set the gateway's credential or broaden a server-set cookie to sibling origins.
        output.append("set-cookie", cookie.replace(/;\s*domain=[^;]*/ig, ""));
      }
      output.set("referrer-policy", "no-referrer"); output.set("origin-agent-cluster", "?1");
      output.set("x-content-type-options", "nosniff");
      const response = new Response(req.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: output });
      return work ? holdResponse(response, output, work.done) : response;
    } catch { return new Response("Application is unavailable", { status: 502 }); }
  }

  private browserSocket(req: Request, server: Server<WsData>, entry: Entry, meta: unknown, via?: string): Promise<Response | undefined> {
    if (req.headers.get("origin") !== entry.origin) return Promise.resolve(new Response("Socket origin refused", { status: 403 }));
    return upgradeToChannelSocket(req, server, (input, signal) => {
      if (!via) return this.dispatch(entry, meta, input, signal);
      const work = this.track(via, entry.app);
      signal.addEventListener("abort", work.done, { once: true });
      return this.dispatch(entry, meta, input, AbortSignal.any([signal, work.signal])).catch((e) => { work.done(); throw e; });
    });
  }

  /** One in-flight request or socket of a `via` session: `signal` aborts when the grant goes; `done` forgets it. */
  private track(via: string, app: string): { signal: AbortSignal; done: () => void } {
    const w = { via, app, controller: new AbortController() };
    this.work.add(w);
    return { signal: w.controller.signal, done: () => { this.work.delete(w); } };
  }

  /**
   * The usage heartbeat (docs/usage.md) on a local app's origin, as the router does for source apps.
   * The app is the session's, never the page's. A remote app's beat belongs to its own Space.
   */
  private usageResponse(req: Request, entry: Entry, path: string, remote: boolean): Response | Promise<Response> | undefined {
    if (path !== "/_space/usage.js" && path !== USAGE_PATH) return undefined;
    if (remote || !this.usageBeat) return new Response("Not found", { status: 404 });
    if (path === "/_space/usage.js") {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return new Response(req.method === "HEAD" ? null : USAGE_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" } });
    }
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const beat = this.usageBeat;
    return (async () => {
      let body: unknown;
      try { body = JSON.parse((await req.text()).slice(0, 4096)); } catch { return new Response("body must be JSON", { status: 400 }); }
      if (!body || typeof body !== "object") return new Response("body must be a JSON object", { status: 400 });
      try { beat(entry.app, (body as { tab?: unknown }).tab); } catch (e) { return new Response((e as Error).message, { status: 400 }); }
      return new Response(null, { status: 204 });
    })();
  }

  private dispatch(entry: Entry, meta: unknown, body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Response> {
    return entry.connectionId ? this.links.request(entry.connectionId, meta, body, signal) : this.local(meta, body, signal);
  }
  private prune(): void {
    for (const map of [this.tickets, this.sessions]) for (const [key, value] of map) if (value.expires <= Date.now()) map.delete(key);
  }
}

/**
 * The host label of an installation's origin: the app's name, so the address bar says which app
 * it is, then 16 hex digits of the installation key's hash, which keep the same app of two Spaces
 * (and two names that read alike) on separate origins. One DNS label: an app id's `.` and `_`
 * become `-`, runs of `-` collapse (no `xn--`), and the name part is cut to 40 characters.
 */
export function originLabel(spaceId: string, app: string): string {
  const hash = sha256(new TextEncoder().encode(installationKey(spaceId, app))).slice(0, 16);
  const name = app.replace(/[._-]+/g, "-").slice(0, 40).replace(/^-+|-+$/g, "");
  return `${name}-${hash}`;
}

/**
 * A direct open's ticket URL as the owner answered it, if it is one: HTTPS without credentials, exactly the ticket path
 * with only a ticket, on a host whose first label is `label`, the origin of that app of that Space. Else undefined.
 */
function directUrl(raw: string, label: string): string | undefined {
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== "https:" || u.username || u.password || u.hash || u.pathname !== TICKET_PATH || !u.hostname.startsWith(`${label}.`)) return undefined;
  if ([...u.searchParams.keys()].join() !== "ticket" || !u.searchParams.get("ticket")) return undefined;
  return u.href;
}

/**
 * Upgrade `req` to a WebSocket whose frames travel as a `socket` operation's framed duplex stream
 * (socket.ts): `dispatch` sends the operation and returns the owning side's answer. An answer that is
 * not a stream (a refusal, a 404) is returned as it is and nothing is upgraded. A dispatch failure throws.
 */
export async function upgradeToChannelSocket(req: Request, server: Server<WsData>, dispatch: (input: ReadableStream<Uint8Array>, signal: AbortSignal) => Promise<Response>): Promise<Response | undefined> {
  const input = socketQueue();
  const controller = new AbortController();
  const abort = () => { input.end(); controller.abort(); };
  req.signal.addEventListener("abort", abort, { once: true });
  let response: Response;
  try { response = await dispatch(input.stream, controller.signal); }
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

function appHeaders(raw: unknown): Headers {
  const input = new Headers(raw as HeadersInit | undefined);
  const headers = new Headers();
  const nominated = new Set((input.get("connection") ?? "").toLowerCase().split(",").map((v) => v.trim()));
  for (const [key, value] of input) {
    if (PRIVATE_HEADERS.has(key) || nominated.has(key) || key.startsWith("x-forwarded-") || key.startsWith("x-space-") || key.startsWith("sec-") && key !== "sec-websocket-protocol") continue;
    headers.set(key, value);
  }
  return headers;
}
function requestPath(raw: unknown): string {
  const path = text(raw, "path", 8192);
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#") || /[\x00-\x20\x7f]/.test(path)) throw new Error("application path must be local");
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
