import type { Server, WebSocketHandler } from "bun";
import type { PeerHub } from "../peers/hub.ts";
import { type TerminalService, TooManySessions, type WsAttachment, type WsData } from "./service.ts";

/**
 * HTTP surface of the terminal, shaped as a Bun.serve `routes` table, plus
 * the one `websocket` handler the server needs.
 *
 *   GET    /api/terminal                       status, the machines a terminal can open on, open and recent sessions
 *   POST   /api/terminal/sessions              { cols, rows } → { id, ticket, expiresIn }; header x-terminal-passphrase when one is set
 *   DELETE /api/terminal/sessions/:id          end a session
 *   GET    /api/terminal/ws?ticket=            the session's socket: binary frames are keystrokes and output,
 *                                              text frames are JSON control ({type:"resize"}, {type:"exit"}, …)
 *
 *   GET    /api/peers/:peer/terminal           ┐ the same on a peer machine: forwarded to its /api/peer/terminal/…
 *   POST   /api/peers/:peer/terminal/sessions  │ with the hub's bearer token; the socket is bridged frame by frame
 *   DELETE /api/peers/:peer/terminal/sessions/:id │
 *   GET    /api/peers/:peer/terminal/ws        ┘
 *
 * Like the other panel routes these carry no bearer token (docs/panel.md);
 * what they add is a same-origin check on every request that opens or ends a
 * session, so a page on another site that a logged-in operator visits cannot
 * open a shell through their browser, and the one-time ticket, so the socket
 * carries no standing credential. docs/terminal.md has the whole boundary.
 */

export type TerminalApiOptions = {
  service: TerminalService;
  /** What this machine is called in the machine list (SPACE_NAME). */
  name: string;
  /** Peer machines whose terminals this panel can open. */
  hub?: PeerHub;
};

type Req = Request & { params: Record<string, string> };
type Handler = (req: Req, server: Server<WsData>) => Response | undefined | Promise<Response | undefined>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST" | "DELETE", Handler>>>;

export type MachineView = {
  name: string;
  /** Set for a peer machine; the routes are then under /api/peers/<peer>/terminal. */
  peer?: string;
  /** Whether that machine offers a terminal at all. */
  enabled: boolean;
  health: "ok" | "down";
};

const FORWARD_TIMEOUT_MS = 8_000;
export const PASSPHRASE_HEADER = "x-terminal-passphrase";
const MAX_QUEUE = 256;

export function createTerminalRoutes(opts: TerminalApiOptions): Routes {
  const { service, hub } = opts;

  const guarded =
    (h: Handler): Handler =>
    async (req, server) => {
      if (!sameOrigin(req)) return error(403, "cross-origin request refused");
      try {
        return await h(req, server);
      } catch (e) {
        if (e instanceof TooManySessions) return error(429, e.message);
        return error(400, (e as Error).message ?? String(e));
      }
    };

  const machines = (): MachineView[] => [
    { name: opts.name, enabled: service.enabled, health: "ok" },
    ...(hub?.status().map((s) => ({ name: s.name, peer: s.name, enabled: hub.get(s.name)?.snapshot?.terminal === true, health: s.health })) ?? []),
  ];

  const routes: Routes = {
    "/api/terminal": {
      GET: () => json({ ok: true, ...service.status(), machines: machines(), sessions: service.list(), recent: service.recent() }),
    },

    "/api/terminal/sessions": {
      POST: guarded(async (req) => {
        if (!service.enabled) return error(404, service.config.enabled ? "no pseudo-terminal available on this machine (needs Bun.Terminal or python3)" : "terminal is not enabled (SPACE_TERMINAL_ENABLED)");
        const pass = service.checkPassphrase(req.headers.get(PASSPHRASE_HEADER));
        if (pass === "required") return error(401, "passphrase required");
        if (pass === "wrong") return error(401, "passphrase wrong");
        if (pass === "locked") return error(429, "too many wrong passphrases; try again in a minute");
        const body = (await req.json().catch(() => ({}))) as { cols?: unknown; rows?: unknown };
        const t = service.create({
          cols: typeof body.cols === "number" ? body.cols : undefined,
          rows: typeof body.rows === "number" ? body.rows : undefined,
          agent: req.headers.get("user-agent") ?? "",
        });
        return json({ ok: true, ...t });
      }),
    },

    "/api/terminal/sessions/:id": {
      DELETE: guarded((req) => (service.kill(req.params.id ?? "") ? json({ ok: true }) : error(404, "no such session"))),
    },

    "/api/terminal/ws": {
      GET: guarded((req, server) => {
        const ticket = new URL(req.url).searchParams.get("ticket") ?? "";
        const s = ticket ? service.redeem(ticket) : undefined;
        if (!s) return error(401, "ticket is unknown, used or expired");
        const attachment = service.attachment(s.id);
        if (server.upgrade(req, { data: { attachment } })) return undefined;
        service.kill(s.id, "upgrade failed");
        return error(400, "expected a websocket upgrade");
      }),
    },
  };

  if (!hub) return routes;

  const clientOf = (name: string | undefined) => (name ? hub.get(name) : undefined);

  /** Forward to the same path on the peer with `/api/peers/<peer>` replaced by `/api/peer`, the passphrase header along. */
  const proxy =
    (timeoutMs?: number): Handler =>
    async (req) => {
      const client = clientOf(req.params.peer);
      if (!client) return error(404, `unknown peer: ${req.params.peer}`);
      const u = new URL(req.url);
      const path = u.pathname.replace(/^\/api\/peers\/[^/]+/, "/api/peer") + u.search;
      const pass = req.headers.get(PASSPHRASE_HEADER);
      try {
        return await client.forward(req, path, { ...(timeoutMs ? { timeoutMs } : {}), ...(pass ? { headers: { [PASSPHRASE_HEADER]: pass } } : {}) });
      } catch (e) {
        return error(502, `peer ${client.name} unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
      }
    };

  routes["/api/peers/:peer/terminal"] = { GET: proxy(FORWARD_TIMEOUT_MS) };
  routes["/api/peers/:peer/terminal/sessions"] = { POST: guarded(proxy(FORWARD_TIMEOUT_MS)) };
  routes["/api/peers/:peer/terminal/sessions/:id"] = { DELETE: guarded(proxy(FORWARD_TIMEOUT_MS)) };
  routes["/api/peers/:peer/terminal/ws"] = {
    GET: guarded((req, server) => {
      const client = clientOf(req.params.peer);
      if (!client) return error(404, `unknown peer: ${req.params.peer}`);
      const ticket = new URL(req.url).searchParams.get("ticket") ?? "";
      if (!ticket) return error(401, "ticket is required");
      const url = `${client.config.url.replace(/^http/, "ws")}/api/peer/terminal/ws?ticket=${encodeURIComponent(ticket)}`;
      const attachment = bridge(url, client.authHeaders(), client.name);
      if (server.upgrade(req, { data: { attachment } })) return undefined;
      return error(400, "expected a websocket upgrade");
    }),
  };
  return routes;
}

/** The server's `websocket` option: every terminal socket delegates to the attachment it was upgraded with. */
export const terminalWebSocket: WebSocketHandler<WsData> = {
  open: (ws) => ws.data.attachment.open(ws),
  message: (ws, m) => ws.data.attachment.message(ws, m),
  close: (ws, code, reason) => ws.data.attachment.close(ws, code, reason),
  drain: (ws) => ws.data.attachment.drain?.(ws),
  // Keystrokes are small; a paste is bounded so a client cannot hold megabytes in the server.
  maxPayloadLength: 1024 * 1024,
  idleTimeout: 0,
};

/**
 * A browser socket on the hub bridged to a session socket on the peer: frames
 * pass through unchanged in both directions, the peer's close code and reason
 * reach the browser, and the browser leaving closes the peer side.
 */
function bridge(url: string, headers: Record<string, string>, peer: string): WsAttachment {
  let up: WebSocket | undefined;
  let queue: (string | Uint8Array)[] = [];
  return {
    open(ws) {
      let opened = false;
      try {
        up = new WebSocket(url, { headers } as unknown as string[]);
      } catch (e) {
        ws.close(4002, `peer ${peer} unreachable: ${(e as Error).message}`.slice(0, 120));
        return;
      }
      up.binaryType = "arraybuffer";
      up.onopen = () => {
        opened = true;
        for (const m of queue) up!.send(m);
        queue = [];
      };
      up.onmessage = (e) => {
        if (ws.readyState !== 1) return;
        ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      };
      up.onclose = (e) => {
        if (ws.readyState !== 1) return;
        // Only 1000 and 3000-4999 may be sent; anything else (a dropped connection, a 401) becomes 4002 with the reason.
        const code = e.code === 1000 || (e.code >= 3000 && e.code <= 4999) ? e.code : 4002;
        const reason = opened ? e.reason || "peer closed" : `peer ${peer} refused the socket${e.reason ? ` (${e.reason})` : ""}`;
        ws.close(code, reason.slice(0, 120));
      };
      up.onerror = () => {
        /* onclose follows with the reason */
      };
    },
    message(_ws, m) {
      const frame = typeof m === "string" ? m : new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
      if (up?.readyState === 1) up.send(frame);
      else if (queue.length < MAX_QUEUE) queue.push(frame);
    },
    close() {
      queue = [];
      try {
        up?.close(1000, "browser left");
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * True when the request comes from the panel's own origin: `Origin` (sent on
 * every POST and socket upgrade) or, failing that, `Sec-Fetch-Site` matches
 * the host the request arrived at. A request with neither header (a script
 * on the machine, the hub's forward) passes: those are not browsers.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) {
    const site = req.headers.get("sec-fetch-site");
    return site === null || site === "same-origin" || site === "none";
  }
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  return host === req.headers.get("host") || (!!forwarded && host === forwarded);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
