import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoutes } from "../scheduler/api.ts";
import { Scheduler } from "../scheduler/scheduler.ts";
import { Store } from "../scheduler/store.ts";
import { createBusRoutes } from "./api.ts";
import { Bus } from "./bus.ts";
import { ConsumerError, Consumers, hashToken, parseConsumerInput } from "./consumers.ts";
import { BusStore } from "./store.ts";
import { ACK_TIMEOUT_MS, type DeliveryPayload, MAX_CONSUMER_BACKLOG } from "./types.ts";

/**
 * External consumers: the operator-made credential, its subscriptions and
 * call allowlist, delivery through the bus's stream rows, and revocation.
 */

const GROUP_CHANGED = { name: "hub-sync", subscriptions: [{ event: "asset-center/group.changed", filter: { groupId: ["g1", "g2"] } }], calls: [{ capability: "asset-center/group-members", filter: { groupId: ["g1", "g2"] } }] };

function harness(dbPath = ":memory:", eventsPath = ":memory:") {
  let t = Date.parse("2026-10-01T00:00:00Z");
  const events = new Store(eventsPath);
  const store = new BusStore(dbPath);
  const bus = new Bus({ store, events, servicePort: () => undefined, now: () => t, log: () => {} });
  const consumers = new Consumers({ store, bus, now: () => t, log: () => {} });
  return {
    bus,
    store,
    events,
    consumers,
    advance: (ms: number) => {
      t += ms;
    },
    publish: (app: string, name: string, data: Record<string, unknown> = {}) => {
      const e = events.addEvent({ app, name, data }, t);
      return { event: e, deliveries: bus.onEvent(e) };
    },
    close: () => {
      bus.stop();
      store.close();
      events.close();
    },
  };
}

describe("consumer input", () => {
  test("accepts names, subscriptions with filters and call entries", () => {
    const c = parseConsumerInput({ ...GROUP_CHANGED, calls: ["asset-center/groups", ...GROUP_CHANGED.calls] });
    expect(c.subscriptions).toEqual([{ event: "asset-center/group.changed", filter: { groupId: ["g1", "g2"] } }]);
    expect(c.calls).toEqual([{ app: "asset-center", capability: "groups" }, { app: "asset-center", capability: "group-members", filter: { groupId: ["g1", "g2"] } }]);
  });

  test("refuses bad shapes", () => {
    const bad = [null, { name: "x" }, { name: "bad name", subscriptions: ["a/b"] }, { name: "x", subscriptions: ["nope"] }, { name: "x", subscriptions: [{ event: "a/b", debounce: "5m" }] }, { name: "x", subscriptions: ["a/b"], calls: ["nocap"] }, { name: "x", subscriptions: ["a/b"], calls: [{ capability: "a/b", filter: { k: { deep: 1 } } }] }, { name: "x", subscriptions: ["a/b"], extra: 1 }];
    for (const b of bad) expect(() => parseConsumerInput(b)).toThrow(ConsumerError);
  });
});

describe("consumers on the bus", () => {
  test("only the credential's hash is stored; the token authenticates its consumer", () => {
    const h = harness();
    const { consumer, token } = h.consumers.create(parseConsumerInput(GROUP_CHANGED));
    expect(token).toMatch(/^sec_/);
    expect(consumer.tokenHint).toBe(`${token.slice(0, 10)}…`);
    const row = h.store.db.query<{ token_hash: string }, []>("SELECT token_hash FROM bus_consumers").get();
    expect(row?.token_hash).toBe(hashToken(token));
    expect(JSON.stringify(h.store.db.query("SELECT * FROM bus_consumers").all())).not.toContain(token);
    expect(h.consumers.authenticate(token)?.name).toBe("hub-sync");
    expect(h.consumers.authenticate(`${token}x`)).toBeUndefined();
    expect(h.consumers.authenticate("sat_app-token")).toBeUndefined();
    expect(() => h.consumers.create(parseConsumerInput(GROUP_CHANGED))).toThrow("exists");
    h.close();
  });

  test("a matching event is delivered, a filtered-out one is not", () => {
    const h = harness();
    h.consumers.create(parseConsumerInput(GROUP_CHANGED));
    expect(h.publish("asset-center", "group.changed", { groupId: "g1" }).deliveries.map((d) => d.app)).toEqual(["consumer:hub-sync"]);
    expect(h.publish("asset-center", "group.changed", { groupId: "g9" }).deliveries).toEqual([]);
    expect(h.publish("asset-center", "asset.added", { groupId: "g1" }).deliveries).toEqual([]);
    expect(h.store.countDeliveries("consumer:hub-sync").pending).toBe(1);
    h.close();
  });

  test("stream and ack; an unacked delivery is pushed again", async () => {
    const h = harness();
    h.consumers.create(parseConsumerInput(GROUP_CHANGED));
    const got: DeliveryPayload[] = [];
    const detach = h.bus.subscribe("consumer:hub-sync", (p) => got.push(p));
    h.publish("asset-center", "group.changed", { groupId: "g1" });
    h.publish("asset-center", "group.changed", { groupId: "g2" });
    expect(got.map((p) => [p.event.data.groupId, p.delivery.attempt])).toEqual([["g1", 1], ["g2", 1]]);
    expect(h.bus.ack("consumer:hub-sync", got[0]!.delivery.id)?.status).toBe("ok");
    // Another consumer's (or an app's) ack does not count.
    expect(h.bus.ack("consumer:other", got[1]!.delivery.id)).toBeUndefined();
    h.advance(ACK_TIMEOUT_MS + 1);
    await h.bus.tick();
    expect(got.slice(2).map((p) => [p.event.data.groupId, p.delivery.attempt, p.delivery.id])).toEqual([["g2", 2, got[1]!.delivery.id]]);
    detach();
    h.close();
  });

  test("consumers and their deliveries survive a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "space-consumers-"));
    try {
      const a = harness(join(dir, "space.db"), join(dir, "events.db"));
      const { token } = a.consumers.create(parseConsumerInput(GROUP_CHANGED));
      a.publish("asset-center", "group.changed", { groupId: "g2" });
      a.close();

      const b = harness(join(dir, "space.db"), join(dir, "events.db"));
      expect(b.consumers.authenticate(token)?.name).toBe("hub-sync");
      const got: DeliveryPayload[] = [];
      b.bus.subscribe("consumer:hub-sync", (p) => got.push(p));
      expect(got.map((p) => p.event.data)).toEqual([{ groupId: "g2" }]);
      // The subscription itself came back too.
      expect(b.publish("asset-center", "group.changed", { groupId: "g1" }).deliveries).toHaveLength(1);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("revoking ends the credential, the open streams and the waiting deliveries at once", () => {
    const h = harness();
    const { token } = h.consumers.create(parseConsumerInput(GROUP_CHANGED));
    let closed = 0;
    h.bus.subscribe("consumer:hub-sync", () => {}, () => closed++);
    const { deliveries } = h.publish("asset-center", "group.changed", { groupId: "g1" });
    expect(h.consumers.remove("hub-sync")).toBe(true);
    expect(closed).toBe(1);
    expect(h.bus.streams("consumer:hub-sync")).toBe(0);
    expect(h.consumers.authenticate(token)).toBeUndefined();
    expect(h.store.getDelivery(deliveries[0]!.id)).toMatchObject({ status: "skipped", lastError: "consumer removed" });
    expect(h.bus.retry(deliveries[0]!.id)?.status).toBe("skipped");
    expect(h.publish("asset-center", "group.changed", { groupId: "g1" }).deliveries).toEqual([]);
    expect(h.consumers.remove("hub-sync")).toBe(false);
    h.close();
  });

  test("rotating replaces the credential and closes the streams that used the old one", () => {
    const h = harness();
    const { token } = h.consumers.create(parseConsumerInput(GROUP_CHANGED));
    let closed = 0;
    h.bus.subscribe("consumer:hub-sync", () => {}, () => closed++);
    const fresh = h.consumers.rotate("hub-sync");
    expect(closed).toBe(1);
    expect(h.consumers.authenticate(token)).toBeUndefined();
    expect(h.consumers.authenticate(fresh.token)?.name).toBe("hub-sync");
    expect(fresh.consumer.rotatedAt).toBeDefined();
    expect(() => h.consumers.rotate("nobody")).toThrow("unknown consumer");
    h.close();
  });

  test("an abandoned consumer's backlog is capped", () => {
    const h = harness();
    h.consumers.create(parseConsumerInput({ name: "idle", subscriptions: ["asset-center/*"] }));
    for (let i = 0; i < MAX_CONSUMER_BACKLOG + 3; i++) h.publish("asset-center", "tick", { i });
    const counts = h.store.countDeliveries("consumer:idle");
    expect(counts.pending).toBe(MAX_CONSUMER_BACKLOG);
    expect(counts.skipped).toBe(3);
    h.close();
  });

  test("calls: only listed capabilities, only bodies the filter accepts", () => {
    const h = harness();
    const { consumer } = h.consumers.create(parseConsumerInput({ ...GROUP_CHANGED, calls: [...GROUP_CHANGED.calls, "asset-center/stats"] }));
    const body = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer;
    expect(() => h.consumers.checkCall(consumer, "asset-center", "group-members", body({ groupId: "g1", detail: true }))).not.toThrow();
    expect(() => h.consumers.checkCall(consumer, "asset-center", "group-members", body({ groupId: "g3" }))).toThrow("only with");
    expect(() => h.consumers.checkCall(consumer, "asset-center", "group-members", body({ detail: true }))).toThrow("only with");
    expect(() => h.consumers.checkCall(consumer, "asset-center", "group-members", new TextEncoder().encode("nope").buffer as ArrayBuffer)).toThrow("JSON object");
    expect(() => h.consumers.checkCall(consumer, "asset-center", "stats", new ArrayBuffer(0))).not.toThrow();
    expect(() => h.consumers.checkCall(consumer, "asset-center", "delete-group", body({ groupId: "g1" }))).toThrow("may not call");
    h.close();
  });
});

// ---------------------------------------------------------------- over HTTP

let space: ReturnType<typeof Bun.serve>;
let provider: ReturnType<typeof Bun.serve>;
let base = "";
let api: { bus: Bus; busStore: BusStore; events: Store; scheduler: Scheduler; consumers: Consumers };
const providerSaw: { path: string; caller: string | null; body: unknown }[] = [];
const OPERATOR = { authorization: "Bearer op", "content-type": "application/json" };

beforeAll(() => {
  provider = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = await req.json().catch(() => null);
      providerSaw.push({ path: new URL(req.url).pathname, caller: req.headers.get("x-space-caller"), body });
      return Response.json({ members: ["a", "b"], got: body });
    },
  });
  const events = new Store(":memory:");
  const busStore = new BusStore(":memory:");
  let bus!: Bus;
  const scheduler = new Scheduler({ store: events, log: () => {}, onPublish: (e) => bus.onEvent(e) });
  bus = new Bus({ store: busStore, events, servicePort: (app) => (app === "asset-center" ? provider.port : undefined), log: () => {} });
  bus.syncApp("asset-center", {
    events: { publishes: [{ name: "group.changed" }], consumes: [] },
    provides: [
      { name: "group-members", method: "POST", path: "/api/group-members", timeoutMs: 5000 },
      { name: "delete-group", method: "POST", path: "/api/delete-group", timeoutMs: 5000 },
    ],
  });
  bus.start();
  const consumers = new Consumers({ store: busStore, bus, log: () => {} });
  const appForToken = async (t: string) => (t === "asset-token" ? "asset-center" : undefined);
  space = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    routes: { ...createRoutes({ scheduler, store: events, token: "op", appForToken }), ...createBusRoutes({ bus, store: busStore, events, token: "op", appForToken, keepaliveMs: 100, consumers }) },
  });
  base = `http://127.0.0.1:${space.port}`;
  api = { bus, busStore, events, scheduler, consumers };
});

afterAll(() => {
  api.bus.stop();
  api.scheduler.stop();
  space.stop(true);
  provider.stop(true);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const call = (path: string, init?: RequestInit) => fetch(base + path, init).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => null)) as Body }));
const as = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function sse(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    next: async (): Promise<{ id: number; data: Body } | "closed"> => {
      for (;;) {
        const m = buffer.match(/event: delivery\nid: (\d+)\ndata: (.*)\n\n/);
        if (m) {
          buffer = buffer.slice(m.index! + m[0].length);
          return { id: Number(m[1]), data: JSON.parse(m[2]!) };
        }
        const { value, done } = await reader.read();
        if (done) return "closed";
        buffer += decoder.decode(value);
      }
    },
  };
}

describe("consumer api", () => {
  test("an allowed capability cannot silently move to a peer", async () => {
    const created = api.consumers.create(parseConsumerInput({ name: "local-only", subscriptions: ["remote-app/changed"], calls: ["remote-app/read"] }));
    let forwarded = false;
    const peer = { name: "remote", forward: async () => { forwarded = true; return Response.json({ ok: true }); } };
    const routes = createBusRoutes({ bus: api.bus, store: api.busStore, events: api.events, token: "op", consumers: api.consumers,
      remote: { name: "local", capabilities: () => [], providerOf: () => ({ peer }), get: () => peer } });
    const route = routes["/api/call/:app/:capability"];
    if (typeof route === "function" || !route?.POST) throw new Error("missing call route");
    const request = (token: string) => Object.assign(new Request("http://localhost/api/call/remote-app/read", { method: "POST", headers: as(token), body: "{}" }), { params: { app: "remote-app", capability: "read" } });
    expect((await route.POST(request(created.token))).status).toBe(403);
    expect(forwarded).toBe(false);
    expect((await route.POST(request("op"))).status).toBe(200);
    expect(forwarded).toBe(true);
    api.consumers.remove("local-only");
  });

  test("only the operator manages consumers; the token is shown once", async () => {
    expect((await call("/api/consumers")).status).toBe(401);
    expect((await call("/api/consumers", { method: "POST", headers: as("asset-token"), body: JSON.stringify(GROUP_CHANGED) })).status).toBe(401);
    const created = await call("/api/consumers", { method: "POST", headers: OPERATOR, body: JSON.stringify(GROUP_CHANGED) });
    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^sec_/);
    expect((await call("/api/consumers", { method: "POST", headers: OPERATOR, body: JSON.stringify(GROUP_CHANGED) })).status).toBe(409);
    expect((await call("/api/consumers", { method: "POST", headers: OPERATOR, body: JSON.stringify({ name: "x" }) })).status).toBe(400);
    const listed = await call("/api/consumers", { headers: OPERATOR });
    expect(listed.body.consumers).toEqual([expect.objectContaining({ name: "hub-sync", calls: [{ capability: "asset-center/group-members", filter: { groupId: ["g1", "g2"] } }] })]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);
    expect((await call("/api/consumers/hub-sync", { headers: as(created.body.token) })).status).toBe(401);
    await call("/api/consumers/hub-sync", { method: "DELETE", headers: OPERATOR });
  });

  test("stream, ack, allowed and refused calls, then revocation closes the stream", async () => {
    const created = await call("/api/consumers", { method: "POST", headers: OPERATOR, body: JSON.stringify(GROUP_CHANGED) });
    const token = created.body.token as string;
    const publish = (groupId: string) => call("/api/events", { method: "POST", headers: as("asset-token"), body: JSON.stringify({ name: "group.changed", data: { groupId } }) });

    // Published before the consumer connects: waits, then is pushed on connect.
    await publish("g1");
    await publish("g9");
    const res = await fetch(`${base}/api/events/stream`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const stream = sse(res);
    const first = await stream.next();
    if (first === "closed") throw new Error("closed");
    expect(first.data).toMatchObject({ delivery: { id: first.id, attempt: 1 }, event: { name: "asset-center/group.changed", data: { groupId: "g1" } } });
    await publish("g2");
    const second = await stream.next();
    if (second === "closed") throw new Error("closed");
    expect(second.data.event.data).toEqual({ groupId: "g2" });

    const acked = await call("/api/events/ack", { method: "POST", headers: as(token), body: JSON.stringify({ delivery: first.id }) });
    expect(acked.status).toBe(200);
    expect(acked.body.delivery).toMatchObject({ status: "ok", app: "consumer:hub-sync" });
    // The app's token cannot ack the consumer's delivery, nor the consumer an app's.
    expect((await call("/api/events/ack", { method: "POST", headers: as("asset-token"), body: JSON.stringify({ delivery: second.id }) })).status).toBe(404);

    // The allowed call, for a group in its filter, reaches the provider as the consumer.
    const ok = await call("/api/call/asset-center/group-members", { method: "POST", headers: as(token), body: JSON.stringify({ groupId: "g2", detail: true }) });
    expect(ok.status).toBe(200);
    expect(ok.body.got).toEqual({ groupId: "g2", detail: true });
    expect(providerSaw.at(-1)).toMatchObject({ path: "/api/group-members", caller: "consumer:hub-sync" });
    // Another group, another capability, a peer-named call: refused before the provider sees them.
    const seen = providerSaw.length;
    expect((await call("/api/call/asset-center/group-members", { method: "POST", headers: as(token), body: JSON.stringify({ groupId: "g3", detail: true }) })).status).toBe(403);
    expect((await call("/api/call/asset-center/delete-group", { method: "POST", headers: as(token), body: JSON.stringify({ groupId: "g1" }) })).status).toBe(403);
    expect((await call("/api/call/somepeer/asset-center/group-members", { method: "POST", headers: as(token), body: JSON.stringify({ groupId: "g1" }) })).status).toBe(403);
    expect(providerSaw.length).toBe(seen);
    // Everything else the token might try: no publishing, no operator routes, no consumer management.
    expect((await publishAs(token)).status).toBe(401);
    expect((await call(`/api/deliveries/${second.id}/retry`, { method: "POST", headers: as(token) })).status).toBe(401);
    expect((await call("/api/consumers", { headers: as(token) })).status).toBe(401);
    expect((await call("/api/consumers/hub-sync/rotate", { method: "POST", headers: as(token) })).status).toBe(401);

    // Revoke: the open stream ends, the token is dead everywhere, the waiting delivery is skipped.
    expect((await call("/api/consumers/hub-sync", { method: "DELETE", headers: OPERATOR })).status).toBe(200);
    expect(await stream.next()).toBe("closed");
    expect((await call("/api/events/stream", { headers: as(token) })).status).toBe(401);
    expect((await call("/api/events/ack", { method: "POST", headers: as(token), body: JSON.stringify({ delivery: second.id }) })).status).toBe(401);
    expect((await call("/api/call/asset-center/group-members", { method: "POST", headers: as(token), body: JSON.stringify({ groupId: "g1" }) })).status).toBe(401);
    expect(api.busStore.getDelivery(second.id)?.status).toBe("skipped");
    expect((await call("/api/consumers/hub-sync", { method: "DELETE", headers: OPERATOR })).status).toBe(404);
  });

  test("rotation closes the open stream and the old token stops working", async () => {
    const created = await call("/api/consumers", { method: "POST", headers: OPERATOR, body: JSON.stringify({ ...GROUP_CHANGED, name: "rotating" }) });
    const old = created.body.token as string;
    const res = await fetch(`${base}/api/events/stream`, { headers: { authorization: `Bearer ${old}` } });
    const stream = sse(res);
    const rotated = await call("/api/consumers/rotating/rotate", { method: "POST", headers: OPERATOR });
    expect(rotated.status).toBe(200);
    expect(await stream.next()).toBe("closed");
    expect((await call("/api/events/stream", { headers: as(old) })).status).toBe(401);
    const fresh = await fetch(`${base}/api/events/stream`, { headers: { authorization: `Bearer ${rotated.body.token}` } });
    expect(fresh.status).toBe(200);
    await fresh.body?.cancel();
    const shown = await call("/api/consumers/rotating", { headers: OPERATOR });
    expect(shown.body.consumer.lastSeenAt).toBeDefined();
    await call("/api/consumers/rotating", { method: "DELETE", headers: OPERATOR });
  });
});

function publishAs(token: string) {
  return call("/api/events", { method: "POST", headers: as(token), body: JSON.stringify({ app: "asset-center", name: "group.changed", data: { groupId: "g1" } }) });
}
