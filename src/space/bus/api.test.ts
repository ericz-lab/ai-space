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
      ...createBusRoutes({ bus, store: busStore, events, token: "op", appForToken, keepaliveMs: 100, remote }),
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

/** A stand-in for the peer hub: one peer holding `thesis/summarize`, and an app two peers both claim. */
const forwarded: { path: string; caller: string | null; body: string }[] = [];
const fakePeer = (name: string) => ({
  name,
  forward: async (req: Request, path: string, o?: { headers?: Record<string, string> }) => {
    forwarded.push({ path, caller: o?.headers?.["x-space-caller"] ?? null, body: await req.text() });
    return Response.json({ from: name }, { headers: { "content-type": "application/json" } });
  },
});
const peersByName = { dailie: fakePeer("dailie"), david: fakePeer("david") };
const remote = {
  name: "seoul",
  capabilities: () => [{ app: "dailie/thesis", peer: "dailie", provides: [{ name: "summarize", method: "POST" as const, path: "/s", timeoutMs: 1000 }], publishes: [], consumes: [] }],
  providerOf: (app: string) => (app === "thesis" ? { peer: peersByName.dailie } : app === "twin" ? { ambiguous: ["dailie", "david"] } : undefined),
  get: (n: string) => peersByName[n as keyof typeof peersByName],
};

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

  test("a call to an app a peer provides is forwarded there; ambiguity and unknown peers are refused", async () => {
    const r = await fetch(`${base}/api/call/thesis/summarize`, { method: "POST", headers: { authorization: "Bearer portfolio-token", "content-type": "application/json" }, body: JSON.stringify({ text: "…" }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-space-call-peer")).toBe("dailie");
    expect(await r.json()).toEqual({ from: "dailie" });
    expect(forwarded.pop()).toEqual({ path: "/api/peer/call/thesis/summarize", caller: "seoul/portfolio", body: JSON.stringify({ text: "…" }) });
    expect((await call("/api/call/twin/x", { method: "POST", headers: { authorization: "Bearer portfolio-token" } })).status).toBe(409);
    expect((await call("/api/call/nowhere/thesis/summarize", { method: "POST", headers: { authorization: "Bearer portfolio-token" } })).status).toBe(404);
    const named = await fetch(`${base}/api/call/david/thesis/summarize`, { method: "POST", headers: { authorization: "Bearer portfolio-token" } });
    expect(await named.json()).toEqual({ from: "david" });
    expect((await call("/api/calls?app=dailie/thesis")).body.calls[0]).toMatchObject({ caller: "portfolio", app: "dailie/thesis", capability: "summarize", status: 200, ok: true });
    const cat = await call("/api/capabilities");
    expect(cat.body.apps.find((a: Body) => a.app === "dailie/thesis")).toMatchObject({ peer: "dailie" });
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
    expect(cat.body.apps.map((a: Body) => a.app)).toEqual(["cal", "insight", "dailie/thesis"]);
    expect(cat.body.apps[1]).toMatchObject({
      provides: [{ name: "research", method: "POST", path: "/api/research", timeoutMs: 5000, callers: ["portfolio"] }],
      publishes: [{ name: "report.ready", description: "A report is done." }],
      consumes: [{ event: "pulse/*", kind: "stream" }],
      stats: [{ capability: "research", calls: 1, failures: 0 }],
    });
  });
});

describe("voice routes", () => {
  /** A space whose transcriber is `at`: provided by a local app, by a peer, or by nobody. */
  const serveVoice = (at: "local" | "peer" | "none") => {
    const asr = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const form = await req.formData();
        const file = form.get("file") as File;
        return Response.json({ text: `heard ${await file.text()}`, caller: req.headers.get("x-space-caller") });
      },
    });
    const store = new BusStore(":memory:");
    const voiceBus = new Bus({ store, events: new Store(":memory:"), servicePort: (name) => (name === "voice-studio" ? asr.port : undefined), log: () => {} });
    if (at === "local") voiceBus.syncApp("voice-studio", { events: { publishes: [], consumes: [] }, provides: [{ name: "transcribe", method: "POST", path: "/api/asr", timeoutMs: 5000 }] });
    const transcriber = at === "peer" ? { app: "thesis", capability: "summarize" } : undefined;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createBusRoutes({ bus: voiceBus, store, events: new Store(":memory:"), token: "op", remote, ...(transcriber ? { transcriber } : {}) }) });
    const url = `http://127.0.0.1:${server.port}`;
    return { url, store, stop: () => (server.stop(true), asr.stop(true)) };
  };
  const audio = () => {
    const form = new FormData();
    form.append("file", new File(["hello"], "voice.webm", { type: "audio/webm" }));
    return form;
  };

  test("the panel transcribes without a token through the local voice-studio, as the operator", async () => {
    const s = serveVoice("local");
    try {
      expect(await fetch(`${s.url}/api/voice`).then((r) => r.json())).toEqual({ ok: true, transcribe: true });
      const r = await fetch(`${s.url}/api/voice/transcribe`, { method: "POST", body: audio() });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ text: "heard hello", caller: "space" });
      expect(s.store.listCalls({}).map((c) => [c.caller, c.app, c.capability, c.status])).toEqual([["space", "voice-studio", "transcribe", 200]]);
    } finally {
      s.stop();
    }
  });

  test("a transcriber on one peer is reached through it; none at all answers 503", async () => {
    const p = serveVoice("peer");
    const n = serveVoice("none");
    try {
      expect(await fetch(`${p.url}/api/voice`).then((r) => r.json())).toEqual({ ok: true, transcribe: true });
      const r = await fetch(`${p.url}/api/voice/transcribe`, { method: "POST", body: audio() });
      expect(await r.json()).toEqual({ from: "dailie" });
      expect(forwarded.pop()).toMatchObject({ path: "/api/peer/call/thesis/summarize", caller: "seoul/space" });
      expect(await fetch(`${n.url}/api/voice`).then((r) => r.json())).toEqual({ ok: true, transcribe: false });
      expect((await fetch(`${n.url}/api/voice/transcribe`, { method: "POST", body: audio() })).status).toBe(503);
    } finally {
      p.stop();
      n.stop();
    }
  });
});

describe("the panel's image capture", () => {
  const serveCapture = (at: "local" | "peer" | "none") => {
    const spark = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const form = await req.formData();
        const file = form.get("file") as File;
        return Response.json({ ok: true, bytes: file.size, type: file.type, via: form.get("via"), id: form.get("id"), caller: req.headers.get("x-space-caller") }, { status: 201 });
      },
    });
    const store = new BusStore(":memory:");
    const b = new Bus({ store, events: new Store(":memory:"), servicePort: (name) => (name === "ai-spark" ? spark.port : undefined), log: () => {} });
    if (at === "local") b.syncApp("ai-spark", { events: { publishes: [], consumes: [] }, provides: [{ name: "capture-image", method: "POST", path: "/api/ideas/image", timeoutMs: 5000 }] });
    const imageCapturer = at === "peer" ? { app: "thesis", capability: "summarize" } : undefined;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createBusRoutes({ bus: b, store, events: new Store(":memory:"), token: "op", remote, ...(imageCapturer ? { imageCapturer } : {}) }) });
    return { url: `http://127.0.0.1:${server.port}`, store, stop: () => (server.stop(true), spark.stop(true)) };
  };
  const shot = () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5])], "shot.png", { type: "image/png" }));
    form.append("via", "screenshot");
    form.append("id", "2f1c7a9e-4b3d-4c2a-9e8f-1a2b3c4d5e6f");
    return form;
  };

  test("a screenshot reaches the local ai-spark without a token, as the operator", async () => {
    const s = serveCapture("local");
    try {
      expect(await fetch(`${s.url}/api/capture`).then((r) => r.json())).toEqual({ ok: true, image: true, app: "ai-spark", capability: "capture-image" });
      const r = await fetch(`${s.url}/api/capture/image`, { method: "POST", body: shot() });
      expect(r.status).toBe(201);
      expect(await r.json()).toEqual({ ok: true, bytes: 9, type: "image/png", via: "screenshot", id: "2f1c7a9e-4b3d-4c2a-9e8f-1a2b3c4d5e6f", caller: "space" });
      expect(s.store.listCalls({}).map((c) => [c.caller, c.app, c.capability, c.status])).toEqual([["space", "ai-spark", "capture-image", 201]]);
    } finally {
      s.stop();
    }
  });

  test("a capturer on one peer is reached through it; none answers 503", async () => {
    const p = serveCapture("peer");
    const n = serveCapture("none");
    try {
      expect(await fetch(`${p.url}/api/capture`).then((r) => r.json())).toMatchObject({ image: true });
      expect(await fetch(`${p.url}/api/capture/image`, { method: "POST", body: shot() }).then((r) => r.json())).toEqual({ from: "dailie" });
      expect(forwarded.pop()).toMatchObject({ path: "/api/peer/call/thesis/summarize", caller: "seoul/space" });
      expect(await fetch(`${n.url}/api/capture`).then((r) => r.json())).toMatchObject({ image: false });
      expect((await fetch(`${n.url}/api/capture/image`, { method: "POST", body: shot() })).status).toBe(503);
    } finally {
      p.stop();
      n.stop();
    }
  });
});
