import { eventPayload } from "../scheduler/events.ts";
import type { Store } from "../scheduler/store.ts";
import type { SpaceEvent } from "../scheduler/types.ts";
import { type Bus, CallError } from "./bus.ts";
import type { BusStore } from "./store.ts";
import { type CallRecord, type Delivery, type DeliveryStatus, MAX_CALL_BODY_BYTES } from "./types.ts";

/**
 * HTTP surface of the bus, next to the scheduler's `/api/events`.
 *
 *   GET  /api/events/stream                 the app's stream deliveries as server-sent events (app token)
 *   POST /api/events/ack                    { delivery } ack a pushed delivery (app token)
 *   GET  /api/events/:id                    one event with its deliveries
 *   GET  /api/deliveries?app&status&limit   deliveries, newest first
 *   POST /api/deliveries/:id/retry          queue a dead or skipped delivery again (operator token)
 *   GET  /api/capabilities                  what every app provides, publishes and consumes
 *   POST /api/call/:app/:capability         forward the request to the app's capability as the calling app
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
          apps: bus.capabilities().map((a) => ({
            app: a.app,
            provides: a.provides,
            publishes: a.publishes,
            consumes: a.consumes,
            stats: store.callStats(a.app),
          })),
        }),
    },

    "/api/call/:app/:capability": {
      POST: async (req) => {
        const caller = await identify(req);
        if (!caller) return error(401, "unauthorized");
        const app = req.params.app ?? "";
        const name = req.params.capability ?? "";
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
            headers: {
              ...(r.contentType ? { "content-type": r.contentType } : {}),
              "cache-control": "no-store",
              "x-space-call-id": String(r.record.id),
              "x-space-call-ms": String(r.record.durationMs),
            },
          });
        } catch (e) {
          if (e instanceof CallError) return error(e.status, e.message);
          return error(500, (e as Error).message ?? String(e));
        }
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
