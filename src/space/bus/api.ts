import { eventPayload } from "../scheduler/events.ts";
import type { Store } from "../scheduler/store.ts";
import type { SpaceEvent } from "../scheduler/types.ts";
import { type AppCapabilities, type Bus, CallError } from "./bus.ts";
import type { BusStore } from "./store.ts";
import { type CallRecord, type Delivery, type DeliveryStatus, MAX_CALL_BODY_BYTES, MAX_CALL_TIMEOUT_MS } from "./types.ts";

/**
 * HTTP surface of the bus, next to the scheduler's `/api/events`.
 *
 *   GET  /api/events/stream                 the app's stream deliveries as server-sent events (app token)
 *   POST /api/events/ack                    { delivery } ack a pushed delivery (app token)
 *   GET  /api/events/:id                    one event with its deliveries
 *   GET  /api/deliveries?app&status&limit   deliveries, newest first
 *   POST /api/deliveries/:id/retry          queue a dead or skipped delivery again (operator token)
 *   GET  /api/capabilities                  what every app provides, publishes and consumes
 *   POST /api/call/:app/:capability         forward the request to the app's capability as the calling app; an app
 *                                           that is not here but on exactly one peer is reached through that peer
 *   POST /api/call/:peer/:app/:capability   the same, naming the peer
 *   GET  /api/calls?app&caller&limit        call history, newest first
 *
 * `stream`, `ack` and `call` identify the app by its `SPACE_APP_TOKEN`; the operator token
 * is accepted too and then calls as `space`. Reads are open like the rest of the API.
 */

export type BusApiOptions = {
  bus: Bus;
  store: BusStore;
  /** The scheduler's store, for the events themselves. */
  events: Store;
  /** Operator bearer token; empty disables the check (rely on 127.0.0.1). */
  token?: string;
  appForToken?: (token: string) => Promise<string | undefined>;
  /** Comment lines keeping a stream open through proxies; tests shorten it. */
  keepaliveMs?: number;
  /** The peers (docs/peers.md): their catalogues join `/api/capabilities`, and a call to an app they hold is forwarded. */
  remote?: RemoteBus;
};

/** What the bus routes need from the peer hub; `name` is this space's own name, prefixed onto forwarded callers. */
export type RemoteBus = {
  name: string;
  capabilities(): (AppCapabilities & { peer: string })[];
  providerOf(app: string, capability?: string): { peer: RemotePeer } | { ambiguous: string[] } | undefined;
  get(name: string): RemotePeer | undefined;
};

export type RemotePeer = {
  name: string;
  forward(req: Request, path: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<Response>;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

/** The operator, when a call comes with the operator token. */
export const OPERATOR = "space";
const KEEPALIVE_MS = 20_000;

export function createBusRoutes(opts: BusApiOptions): Routes {
  const { bus, store, events } = opts;
  const token = opts.token?.trim() ?? "";
  const keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;

  const bearer = (req: Request): string => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";

  /** The app behind the token, or OPERATOR for the operator token; undefined = not authorized. */
  const identify = async (req: Request): Promise<string | undefined> => {
    const presented = bearer(req);
    if (token && presented === token) return OPERATOR;
    if (presented && opts.appForToken) {
      const app = await opts.appForToken(presented);
      if (app) return app;
    }
    if (!token && !presented) return OPERATOR;
    return undefined;
  };

  const guard =
    (h: Handler): Handler =>
    async (req) => {
      if (token && req.headers.get("authorization") !== `Bearer ${token}`) return error(401, "unauthorized");
      try {
        return await h(req);
      } catch (e) {
        return error(400, (e as Error).message ?? String(e));
      }
    };

  const callLocal = async (req: Request, caller: string, app: string, name: string): Promise<Response> => {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_CALL_BODY_BYTES) return error(413, `body is ${length} bytes; the limit is ${MAX_CALL_BODY_BYTES}`);
    const body = await req.arrayBuffer();
    if (body.byteLength > MAX_CALL_BODY_BYTES) return error(413, `body is ${body.byteLength} bytes; the limit is ${MAX_CALL_BODY_BYTES}`);
    try {
      const r = await bus.call(caller, app, name, {
        body: body.byteLength ? body : null,
        contentType: req.headers.get("content-type") ?? undefined,
        accept: req.headers.get("accept") ?? undefined,
        signal: req.signal,
      });
      return new Response(r.body, {
        status: r.status,
        headers: { ...(r.contentType ? { "content-type": r.contentType } : {}), "cache-control": "no-store", "x-space-call-id": String(r.record.id), "x-space-call-ms": String(r.record.durationMs) },
      });
    } catch (e) {
      if (e instanceof CallError) return error(e.status, e.message);
      return error(500, (e as Error).message ?? String(e));
    }
  };

  /** Forward to the peer's `/api/peer/call/...` as `<this space>/<caller>`; recorded here under `<peer>/<app>` too. */
  const callRemote = async (req: Request, caller: string, peer: RemotePeer, app: string, name: string): Promise<Response> => {
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_CALL_BODY_BYTES) return error(413, `body is ${length} bytes; the limit is ${MAX_CALL_BODY_BYTES}`);
    const startedAt = Date.now();
    const record = (status: number, ok: boolean, err?: string) => store.addCall({ caller, app: `${peer.name}/${app}`, capability: name, status, ok, durationMs: Date.now() - startedAt, ...(err ? { error: err } : {}), at: startedAt });
    let res: Response;
    try {
      res = await peer.forward(req, `/api/peer/call/${encodeURIComponent(app)}/${encodeURIComponent(name)}`, { timeoutMs: MAX_CALL_TIMEOUT_MS, headers: { "x-space-caller": `${opts.remote!.name}/${caller}`, ...(req.headers.get("accept") ? { accept: req.headers.get("accept")! } : {}) } });
    } catch (e) {
      const rec = record(0, false, `peer ${peer.name} unreachable: ${(e as Error).message ?? String(e)}`);
      return error(502, rec.error ?? "peer unreachable");
    }
    const rec = record(res.status, res.ok, res.ok ? undefined : `${res.status}`);
    const headers = new Headers(res.headers);
    headers.set("x-space-call-id", String(rec.id));
    headers.set("x-space-call-ms", String(rec.durationMs));
    headers.set("x-space-call-peer", peer.name);
    return new Response(res.body, { status: res.status, headers });
  };

  return {
    "/api/events/stream": {
      GET: async (req) => {
        const app = await identify(req);
        if (!app) return error(401, "unauthorized");
        if (app === OPERATOR) return error(400, "the stream is per app: use the app's SPACE_APP_TOKEN");
        return streamResponse(bus, app, keepaliveMs, req.signal);
      },
    },

    "/api/events/ack": {
      POST: async (req) => {
        const app = await identify(req);
        if (!app) return error(401, "unauthorized");
        if (app === OPERATOR) return error(400, "acks come from the app that received the delivery");
        const body = (await req.json().catch(() => null)) as { delivery?: unknown } | null;
        const id = Number(body?.delivery);
        if (!Number.isInteger(id) || id <= 0) return error(400, "delivery must be a delivery id");
        const d = bus.ack(app, id);
        if (!d) return error(404, `no sent delivery #${id} for ${app}`);
        return json({ ok: true, delivery: deliveryView(d) });
      },
    },

    "/api/events/:id": {
      GET: (req) => {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return error(400, "event id must be a positive integer");
        const event = events.getEvent(id);
        if (!event) return error(404, `unknown event: ${id} (pruned, or never published)`);
        return json({ ok: true, event: eventView(event), deliveries: store.listDeliveries({ eventId: id, limit: 1000 }).map(deliveryView) });
      },
    },

    "/api/deliveries": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const status = q.get("status") ?? undefined;
        if (status !== undefined && !["pending", "sent", "ok", "dead", "skipped"].includes(status)) return error(400, "status must be pending, sent, ok, dead or skipped");
        const limit = Number(q.get("limit") ?? 50);
        return json({ ok: true, deliveries: store.listDeliveries({ app: q.get("app") ?? undefined, status: status as DeliveryStatus | undefined, limit: Number.isFinite(limit) ? limit : 50 }).map(deliveryView) });
      },
    },

    "/api/deliveries/:id/retry": {
      POST: guard((req) => {
        const id = Number(req.params.id);
        const d = store.getDelivery(id);
        if (!d) return error(404, `unknown delivery: ${req.params.id}`);
        if (d.status !== "dead" && d.status !== "skipped") return json({ ok: true, delivery: deliveryView(d), retried: false }, 409);
        const fresh = bus.retry(id);
        return json({ ok: true, delivery: deliveryView(fresh ?? d), retried: true }, 202);
      }),
    },

    "/api/capabilities": {
      GET: () =>
        json({
          ok: true,
          apps: [
            ...bus.capabilities().map((a) => ({ app: a.app, provides: a.provides, publishes: a.publishes, consumes: a.consumes, stats: store.callStats(a.app) })),
            ...(opts.remote?.capabilities() ?? []).map((a) => ({ app: a.app, peer: a.peer, provides: a.provides, publishes: a.publishes, consumes: a.consumes, stats: store.callStats(a.app) })),
          ],
        }),
    },

    "/api/call/:app/:capability": {
      POST: async (req) => {
        const caller = await identify(req);
        if (!caller) return error(401, "unauthorized");
        const app = req.params.app ?? "";
        const name = req.params.capability ?? "";
        // Not provided here but on exactly one peer: the peer answers. Anything else is the local bus's answer.
        if (opts.remote && !bus.capability(app, name)) {
          const where = opts.remote.providerOf(app, name);
          if (where && "ambiguous" in where) return error(409, `${app}/${name} is provided on several peers (${where.ambiguous.join(", ")}); call /api/call/<peer>/${app}/${name}`);
          if (where) return callRemote(req, caller, where.peer, app, name);
        }
        return callLocal(req, caller, app, name);
      },
    },

    "/api/call/:peer/:app/:capability": {
      POST: async (req) => {
        const caller = await identify(req);
        if (!caller) return error(401, "unauthorized");
        const peer = opts.remote?.get(req.params.peer ?? "");
        if (!peer) return error(404, `unknown peer: ${req.params.peer ?? ""}`);
        return callRemote(req, caller, peer, req.params.app ?? "", req.params.capability ?? "");
      },
    },

    "/api/calls": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const limit = Number(q.get("limit") ?? 50);
        return json({ ok: true, calls: store.listCalls({ app: q.get("app") ?? undefined, caller: q.get("caller") ?? undefined, limit: Number.isFinite(limit) ? limit : 50 }).map(callView) });
      },
    },
  };
}

// ---------------------------------------------------------------- stream

function streamResponse(bus: Bus, app: string, keepaliveMs: number, abort: AbortSignal): Response {
  const encoder = new TextEncoder();
  let detach: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // closed by the client; the cancel hook detaches
        }
      };
      send(`: stream for ${app}\n\n`);
      detach = bus.subscribe(app, (payload) => send(`event: delivery\nid: ${payload.delivery.id}\ndata: ${JSON.stringify(payload)}\n\n`));
      keepalive = setInterval(() => send(": keepalive\n\n"), keepaliveMs);
      abort.addEventListener("abort", () => {
        detach?.();
        if (keepalive) clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      detach?.();
      if (keepalive) clearInterval(keepalive);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" } });
}

// ---------------------------------------------------------------- views and helpers

export function deliveryView(d: Delivery) {
  return {
    id: d.id,
    eventId: d.eventId,
    event: d.event,
    app: d.app,
    kind: d.kind,
    method: d.method,
    path: d.path,
    status: d.status,
    attempts: d.attempts,
    nextAt: iso(d.nextAt),
    lastError: d.lastError,
    lastStatus: d.lastStatus,
    sentAt: iso(d.sentAt),
    endedAt: iso(d.endedAt),
    createdAt: iso(d.createdAt),
  };
}

export function callView(c: CallRecord) {
  return { id: c.id, caller: c.caller, app: c.app, capability: c.capability, status: c.status, ok: c.ok, durationMs: c.durationMs, error: c.error, at: iso(c.at) };
}

function eventView(e: SpaceEvent) {
  return { id: e.id, ...eventPayload(e) };
}

function iso(ms?: number): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
