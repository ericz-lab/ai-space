import type { DelegationView } from "../agents/delegation-view.ts";
import type { TeamStore } from "../team/store.ts";
import type { OrdersService } from "./service.ts";
import type { OrdersStore } from "./store.ts";
import { MAX_IMAGE_BYTES, type Order, OrdersError, type Topic, orderLabel, orderUrl } from "./types.ts";

/**
 * HTTP surface of the orders (docs/orders.md), the owner's only: an app's token or any other
 * credential is refused (403), and so is a write from another site's page (`guardBrowserWrites`).
 *
 *   GET    /api/orders?archived=1          { topics, sorting, settings, channels, full }: topics most recently active first
 *   POST   /api/orders                     { text, id?, via?, topic?, image?: { mediaType, data } } a typed order (the page)
 *   GET    /api/orders/settings            { topicDays, notify } and the notify channels
 *   PUT    /api/orders/settings            { topicDays?, notify? }
 *   GET    /api/orders/topics/:id          one topic with its orders
 *   PATCH  /api/orders/topics/:id          { title?, archived? }
 *   GET    /api/orders/:id                 one order and its topic (a deep link's target)
 *   DELETE /api/orders/:id                 the order and its screenshot's file
 *   POST   /api/orders/:id/move            { topic } or { title } (a new topic); nothing is started
 *   POST   /api/orders/:id/resend          hand the order to its topic's Director again
 *   GET    /api/orders/:id/image           the screenshot, to the owner only, never cached
 *
 * The capture target `space/order` is not a route here: it is the bus's built-in capability
 * (`captureHandler`), reached through `POST /api/capture/text|image?to=space/order` like any target.
 */

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Routes = Record<string, Partial<Record<Method, Handler>>>;

export type OrdersApiOptions = {
  service: OrdersService;
  store: OrdersStore;
  team: TeamStore;
  /** `null` for the owner; anything else is refused. Absent: everyone is the owner. */
  callerApp?: (req: Request) => Promise<string | null>;
  /** The notify channels, for the setting's choices. */
  channels?: () => string[];
  /** The delegations of a Director session (docs/orders.md#delegation), oldest first. */
  delegations?: (session: string) => DelegationView[];
};

/** The page's typed order: words, and a pasted picture as base64 (about 4/3 of the picture's cap). */
const MAX_TYPED_BODY = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 * 1024;

export function topicView(t: Topic, extra: { orders?: number; asking?: string[]; delegations?: DelegationView[]; full?: boolean } = {}) {
  return {
    id: t.id,
    title: t.title,
    sessionId: t.sessionId,
    runId: t.runId,
    state: t.state,
    summary: t.summary,
    createdAt: new Date(t.createdAt).toISOString(),
    lastActiveAt: new Date(t.lastActiveAt).toISOString(),
    archived: t.archived,
    ...(extra.orders !== undefined ? { orders: extra.orders } : {}),
    ...(extra.asking?.length ? { asking: extra.asking } : {}),
    ...(extra.delegations?.length ? { delegations: extra.delegations } : {}),
    ...(extra.full ? { full: true } : {}),
  };
}

export function orderView(o: Order) {
  return {
    id: o.id,
    label: orderLabel(o.id),
    topic: o.topicId,
    text: o.text,
    via: o.via,
    ...(o.imageMime ? { image: { mime: o.imageMime, bytes: o.imageBytes, url: `/api/orders/${o.id}/image` } } : {}),
    createdAt: new Date(o.createdAt).toISOString(),
    runId: o.runId,
    routedBy: o.routedBy,
    url: orderUrl(o.id),
    /** Sorted, and no turn has taken it yet. */
    waiting: o.topicId !== null && o.runId === null,
  };
}

export function createOrdersRoutes(opts: OrdersApiOptions): Routes {
  const { service, store } = opts;
  const owner =
    (h: Handler): Handler =>
    async (req) => {
      if (opts.callerApp && (await opts.callerApp(req)) !== null) return error(403, "orders are the owner's");
      try {
        return await h(req);
      } catch (e) {
        if (e instanceof OrdersError) return error(e.status, e.message);
        return error(400, (e as Error).message ?? String(e));
      }
    };
  const idOf = (req: { params: Record<string, string> }) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new OrdersError(400, "the id must be a positive whole number");
    return id;
  };
  const settingsView = () => ({ ok: true, settings: service.settings(), channels: opts.channels?.() ?? [] });
  /** A topic as the page lists it: its orders' count, what it waits on, its delegations, whether full permission is in force. */
  const listed = (t: Topic, orders: number) => topicView(t, { orders, asking: service.asking(t), full: service.full(t), ...(t.sessionId && opts.delegations ? { delegations: opts.delegations(t.sessionId) } : {}) });

  return {
    "/api/orders": {
      GET: owner((req) => {
        const archived = new URL(req.url).searchParams.get("archived") === "1";
        const topics = store.topics({ archived }).map((t) => listed(t, store.ofTopic(t.id).length));
        return json({ ...settingsView(), topics, sorting: service.sortingCount(), full: opts.team.director().permission === "full" });
      }),
      POST: owner(async (req) => {
        if (Number(req.headers.get("content-length") ?? 0) > MAX_TYPED_BODY) return error(413, "the order is too large");
        const raw = await req.arrayBuffer();
        if (raw.byteLength > MAX_TYPED_BODY) return error(413, "the order is too large");
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
        } catch {
          return error(400, "the body must be JSON { text, id?, via?, topic?, image? }");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "the body must be JSON { text, id?, via?, topic?, image? }");
        let image: { bytes: Uint8Array } | undefined;
        if (body.image !== undefined) {
          const img = body.image as { data?: unknown } | null;
          if (!img || typeof img.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(img.data)) return error(400, "image must be { mediaType, data } with base64 data");
          image = { bytes: new Uint8Array(Buffer.from(img.data, "base64")) };
        }
        const topic = body.topic === undefined || body.topic === null ? undefined : Number(body.topic);
        if (topic !== undefined && !Number.isInteger(topic)) return error(400, "topic must be a topic id");
        const { order, created } = await service.submit({
          text: typeof body.text === "string" ? body.text : "",
          ...(typeof body.id === "string" ? { clientId: body.id } : {}),
          via: typeof body.via === "string" ? body.via : "type",
          ...(image ? { image } : {}),
          ...(topic !== undefined ? { topicId: topic } : {}),
        });
        return json({ ok: true, order: orderView(order), created, url: orderUrl(order.id), label: orderLabel(order.id) }, created ? 201 : 200);
      }),
    },

    "/api/orders/settings": {
      GET: owner(() => json(settingsView())),
      PUT: owner(async (req) => {
        service.setSettings(await req.json().catch(() => null));
        return json(settingsView());
      }),
    },

    "/api/orders/topics/:id": {
      GET: owner((req) => {
        const t = store.topic(idOf(req));
        if (!t) return error(404, `unknown topic ${req.params.id}`);
        const orders = store.ofTopic(t.id);
        return json({ ok: true, topic: listed(t, orders.length), orders: orders.map(orderView), delegations: t.sessionId && opts.delegations ? opts.delegations(t.sessionId) : [], full: service.full(t) });
      }),
      PATCH: owner(async (req) => {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object") return error(400, "the body must be JSON { title?, archived? }");
        return json({ ok: true, topic: topicView(service.renameTopic(idOf(req), body)) });
      }),
    },

    "/api/orders/:id": {
      GET: owner((req) => {
        const o = store.get(idOf(req));
        if (!o) return error(404, `unknown order ${req.params.id}`);
        const t = o.topicId === null ? undefined : store.topic(o.topicId);
        return json({ ok: true, order: orderView(o), topic: t ? topicView(t) : null });
      }),
      DELETE: owner(async (req) => {
        if (!(await store.remove(idOf(req)))) return error(404, `unknown order ${req.params.id}`);
        return json({ ok: true });
      }),
    },

    "/api/orders/:id/move": {
      POST: owner(async (req) => {
        const body = (await req.json().catch(() => null)) as { topic?: unknown; title?: unknown } | null;
        const topic = body?.topic === undefined || body.topic === null ? undefined : Number(body.topic);
        if (topic !== undefined && !Number.isInteger(topic)) return error(400, "topic must be a topic id");
        const order = service.move(idOf(req), { ...(topic !== undefined ? { topicId: topic } : {}), ...(typeof body?.title === "string" ? { title: body.title } : {}) });
        return json({ ok: true, order: orderView(order) });
      }),
    },

    "/api/orders/:id/resend": {
      POST: owner((req) => {
        service.resend(idOf(req));
        return json({ ok: true });
      }),
    },

    "/api/orders/:id/image": {
      GET: owner(async (req) => {
        const o = store.get(idOf(req));
        if (!o?.imagePath || !o.imageMime) return error(404, "no screenshot");
        const file = Bun.file(o.imagePath);
        if (!(await file.exists())) return error(404, "no screenshot");
        return new Response(file, { headers: { "content-type": o.imageMime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
      }),
    },
  };
}

/** The callers the built-in capture target accepts: the operator here, or a hub's operator forwarding. */
export const acceptsCaptureCaller = (caller: string) => caller === "space" || /^[a-z0-9][a-z0-9._-]*\/space$/i.test(caller);

/**
 * The built-in capture target `space/order` (docs/orders.md#the-capture-target), as the bus calls
 * it in process: JSON `{ text, via?, id }` from the text route, or multipart `file`, `text`, `via`,
 * `id` from the image route (a picture without words is refused). Answers `{ ok, url, label }`;
 * a repeated `id` answers the first order.
 */
export function captureHandler(service: OrdersService): (req: Request) => Promise<Response> {
  return async (req) => {
    const caller = req.headers.get("x-space-caller") ?? "";
    if (!acceptsCaptureCaller(caller)) return error(403, "space/order takes orders from the panel's clients only");
    const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    try {
      let input: Parameters<OrdersService["submit"]>[0];
      if (type === "multipart/form-data") {
        const form = await req.formData().catch(() => null);
        if (!form) return error(400, "the body must be multipart form data");
        const file = form.get("file");
        const text = form.get("text");
        const via = form.get("via");
        const id = form.get("id");
        if (!(file instanceof File)) return error(400, "file is required");
        if (typeof text !== "string" || !text.trim()) return error(400, "a picture needs the words of the order with it");
        if (file.size > MAX_IMAGE_BYTES) return error(413, `the picture is ${file.size} bytes; the limit is ${MAX_IMAGE_BYTES}`);
        if (typeof id !== "string") return error(400, "id must be a UUID, the same on every retry");
        input = { clientId: id, text, ...(typeof via === "string" && via ? { via } : {}), image: { bytes: new Uint8Array(await file.arrayBuffer()) } };
      } else if (type === "application/json") {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "the body must be JSON { text, via?, id }");
        if (typeof body.id !== "string") return error(400, "id must be a UUID, the same on every retry");
        input = { clientId: body.id, text: typeof body.text === "string" ? body.text : "", ...(typeof body.via === "string" ? { via: body.via } : {}) };
      } else return error(415, "send JSON (words) or multipart form data (a picture and words)");
      const { order } = await service.submit(input);
      return json({ ok: true, url: orderUrl(order.id), label: orderLabel(order.id) });
    } catch (e) {
      if (e instanceof OrdersError) return error(e.status, e.message);
      throw e;
    }
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
