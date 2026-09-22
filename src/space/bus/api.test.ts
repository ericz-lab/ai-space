import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRoutes } from "../scheduler/api.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { Store } from "../scheduler/store.ts";
import { createBusRoutes } from "./api.ts";
import { Bus } from "./bus.ts";
import { BusStore } from "./store.ts";

/**
 * The bus routes next to the scheduler's, against a fake app service on loopback:
 * publish → http delivery → the app's endpoint; a stream consumer over SSE with acks;
 * a call forwarded to the app and answered through.
 */

let space: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof Bun.serve>;
let base = "";
let bus: Bus;
let busStore: BusStore;
let events: Store;
let scheduler: Scheduler;
const received: { path: string; headers: Record<string, string>; body: unknown }[] = [];
let answerWith = 200;

const tokens: Record<string, string> = { "cal-token": "cal", "insight-token": "insight", "portfolio-token": "portfolio" };
const OPERATOR = { authorization: "Bearer op", "content-type": "application/json" };

beforeAll(() => {
  app = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        if (k.startsWith("x-space-") || k === "content-type") headers[k] = v;
      });
      const body = await req.json().catch(() => null);
      received.push({ path: url.pathname, headers, body });
      if (url.pathname === "/api/research") return Response.json({ verdict: "hold", caller: headers["x-space-caller"], got: body }, { status: answerWith });
      return new Response(answerWith >= 400 ? "nope" : "ok", { status: answerWith });
    },
  });
  events = new Store(":memory:");
  scheduler = new Scheduler({ store: events, log: () => {}, onPublish: (e) => bus.onEvent(e) });
  busStore = new BusStore(":memory:");
  bus = new Bus({ store: busStore, events, servicePort: (name) => (["cal", "insight"].includes(name) ? app.port : undefined), log: () => {} });
  bus.syncApp("cal", { events: { publishes: [], consumes: [{ event: "video-digest/digest.added", kind: "http", method: "POST", path: "/api/import" }] } });
  bus.syncApp("insight", {
    events: { publishes: [{ name: "report.ready", description: "A report is done." }], consumes: [{ event: "pulse/*", kind: "stream" }] },
    provides: [{ name: "research", method: "POST", path: "/api/research", timeoutMs: 5000, callers: ["portfolio"] }],
  });
  bus.start();
  const appForToken = async (t: string) => tokens[t];
  space = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    routes: {
      ...createRoutes({ scheduler, store: events, token: "op", appForToken }),
      ...createBusRoutes({ bus, store: busStore, events, token: "op", appForToken, keepaliveMs: 100 }),
    },
  });
  base = `http://127.0.0.1:${space.port}`;
});

afterAll(() => {
  bus.stop();
  scheduler.stop();
  space.stop(true);
  app.stop(true);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const call = (path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json()) as Body, headers: r.headers }));
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  expect(cond()).toBe(true);
};

describe("bus api", () => {
  test("a published event is delivered over http to the subscribed app, and shows with its deliveries", async () => {
    const published = await call("/api/events", { method: "POST", headers: OPERATOR, body: JSON.stringify({ app: "video-digest", name: "digest.added", data: { id: "v1", channel: "Weekly" } }) });
    expect(published.status).toBe(202);
    const eventId = published.body.event.id as number;
    await until(() => received.some((r) => r.path === "/api/import"));
    const hit = received.find((r) => r.path === "/api/import")!;
    expect(hit.headers["x-space-event"]).toBe("video-digest/digest.added");
    expect(hit.headers["x-space-event-id"]).toBe(String(eventId));
    expect(hit.body).toMatchObject({ event: { id: eventId, data: { id: "v1", channel: "Weekly" } }, delivery: { attempt: 1 } });
    await until(() => busStore.listDeliveries({ eventId })[0]?.status === "ok");

    const shown = await call(`/api/events/${eventId}`);
    expect(shown.status).toBe(200);
    expect(shown.body.event).toMatchObject({ id: eventId, name: "video-digest/digest.added" });
    expect(shown.body.deliveries).toEqual([expect.objectContaining({ app: "cal", kind: "http", status: "ok", attempts: 1, lastStatus: 200 })]);
    expect((await call("/api/events/999999")).status).toBe(404);
    expect((await call("/api/deliveries?app=cal&status=ok")).body.deliveries).toHaveLength(1);
    expect((await call("/api/deliveries?status=bogus")).status).toBe(400);
  });

  test("a delivery the app rejects is dead; the operator can retry it", async () => {
    answerWith = 400;
    const published = await call("/api/events", { method: "POST", headers: OPERATOR, body: JSON.stringify({ app: "video-digest", name: "digest.added", data: { id: "v2" } }) });
    const eventId = published.body.event.id as number;
    await until(() => busStore.listDeliveries({ eventId })[0]?.status === "dead");
    const id = busStore.listDeliveries({ eventId })[0]!.id;
    expect((await call(`/api/deliveries/${id}/retry`, { method: "POST" })).status).toBe(401);
    answerWith = 200;
    const retried = await call(`/api/deliveries/${id}/retry`, { method: "POST", headers: OPERATOR });
    expect(retried.status).toBe(202);
    expect(retried.body.retried).toBe(true);
    await until(() => busStore.getDelivery(id)?.status === "ok");
    expect((await call(`/api/deliveries/${id}/retry`, { method: "POST", headers: OPERATOR })).status).toBe(409);
    expect((await call("/api/deliveries/424242/retry", { method: "POST", headers: OPERATOR })).status).toBe(404);
  });

  test("the stream pushes deliveries as SSE and takes acks", async () => {
    expect((await call("/api/events/stream")).status).toBe(401);
    expect((await call("/api/events/stream", { headers: OPERATOR })).status).toBe(400);
    // One event before the app connects: pushed on connect.
    await call("/api/events", { method: "POST", headers: OPERATOR, body: JSON.stringify({ app: "pulse", name: "clue.found", data: { id: "c1" } }) });
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events/stream`, { headers: { authorization: "Bearer insight-token" }, signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<{ id: number; data: Body }> => {
      for (;;) {
        const m = buffer.match(/event: delivery\nid: (\d+)\ndata: (.*)\n\n/);
        if (m) {
          buffer = buffer.slice(m.index! + m[0].length);
          return { id: Number(m[1]), data: JSON.parse(m[2]!) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffer += decoder.decode(value);
      }
    };
    const first = await next();
    expect(first.data).toMatchObject({ delivery: { id: first.id, attempt: 1 }, event: { name: "pulse/clue.found", data: { id: "c1" } } });
    // One while connected: pushed live.
    await call("/api/events", { method: "POST", headers: OPERATOR, body: JSON.stringify({ app: "pulse", name: "clue.found", data: { id: "c2" } }) });
    const second = await next();
    expect(second.data.event.data).toEqual({ id: "c2" });

    const acked = await call("/api/events/ack", { method: "POST", headers: { authorization: "Bearer insight-token", "content-type": "application/json" }, body: JSON.stringify({ delivery: first.id }) });
    expect(acked.status).toBe(200);
    expect(acked.body.delivery.status).toBe("ok");
    expect((await call("/api/events/ack", { method: "POST", headers: { authorization: "Bearer cal-token", "content-type": "application/json" }, body: JSON.stringify({ delivery: second.id }) })).status).toBe(404);
    expect((await call("/api/events/ack", { method: "POST", headers: { authorization: "Bearer insight-token", "content-type": "application/json" }, body: "{}" })).status).toBe(400);
    controller.abort();
    await Bun.sleep(20);
    expect(busStore.getDelivery(second.id)?.status).toBe("sent");
  });

  test("calls are forwarded as the calling app and recorded; the catalogue lists it all", async () => {
    const r = await fetch(`${base}/api/call/insight/research`, { method: "POST", headers: { authorization: "Bearer portfolio-token", "content-type": "application/json" }, body: JSON.stringify({ symbol: "BTC" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-space-call-id")).toMatch(/^\d+$/);
    expect(await r.json()).toEqual({ verdict: "hold", caller: "portfolio", got: { symbol: "BTC" } });
    expect((await call("/api/call/insight/research", { method: "POST" })).status).toBe(401);
    expect((await call("/api/call/insight/research", { method: "POST", headers: { authorization: "Bearer cal-token" } })).status).toBe(403);
    expect((await call("/api/call/insight/nope", { method: "POST", headers: { authorization: "Bearer portfolio-token" } })).status).toBe(404);
    const calls = await call("/api/calls?app=insight");
    expect(calls.body.calls).toEqual([expect.objectContaining({ caller: "portfolio", capability: "research", status: 200, ok: true })]);
    const cat = await call("/api/capabilities");
    expect(cat.body.apps.map((a: Body) => a.app)).toEqual(["cal", "insight"]);
    expect(cat.body.apps[1]).toMatchObject({
      provides: [{ name: "research", method: "POST", path: "/api/research", timeoutMs: 5000, callers: ["portfolio"] }],
      publishes: [{ name: "report.ready", description: "A report is done." }],
      consumes: [{ event: "pulse/*", kind: "stream" }],
      stats: [{ capability: "research", calls: 1, failures: 0 }],
    });
  });
});
