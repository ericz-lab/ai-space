import { describe, expect, test } from "bun:test";
import { Store } from "../scheduler/store.ts";
import { Bus, CallError, type Fetch } from "./bus.ts";
import { BusStore } from "./store.ts";
import { ACK_TIMEOUT_MS, type DeliveryPayload, MAX_ATTEMPTS, RETRY_DELAYS_MS } from "./types.ts";

/** Fake clock, scripted fetch (one answer per call, in order), no timers: ticks are driven by hand. */
function harness(answers: (number | Error | ((url: string, init: RequestInit) => Response))[] = []) {
  let t = Date.parse("2026-09-22T00:00:00Z");
  // Bodies are asserted inline, so they stay untyped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: { url: string; init: RequestInit; body?: any }[] = [];
  const dead: string[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const a = answers.shift() ?? 200;
    if (a instanceof Error) throw a;
    if (typeof a === "function") return a(url, init);
    return new Response(a >= 400 ? "nope" : "ok", { status: a });
  };
  const events = new Store(":memory:");
  const store = new BusStore(":memory:");
  const ports = new Map<string, number>([["cal", 8820], ["whymove", 8830], ["insight", 8985]]);
  const bus = new Bus({ store, events, servicePort: (app) => ports.get(app), fetch, now: () => t, log: () => {}, onDead: (d) => dead.push(`${d.app}#${d.id}`) });
  return {
    bus,
    store,
    events,
    calls,
    dead,
    ports,
    advance: (ms: number) => {
      t += ms;
    },
    /** Time from the first attempt to the (n+1)th: the sum of the first n retry delays. */
    elapsed: (n: number) => RETRY_DELAYS_MS.slice(0, n - 1).reduce((a, b) => a + b, 0),
    publish: (app: string, name: string, data: Record<string, unknown> = {}) => {
      const e = events.addEvent({ app, name, data }, t);
      return { event: e, deliveries: bus.onEvent(e) };
    },
  };
}

describe("bus deliveries", () => {
  test("one http delivery per matching subscription, filters applied, duplicates by target collapsed", async () => {
    const h = harness([200, 200]);
    h.bus.syncApp("cal", { events: { publishes: [], consumes: [{ event: "video-digest/digest.added", filter: { channel: "Weekly" }, kind: "http", method: "POST", path: "/api/import" }] } });
    h.bus.syncApp("whymove", {
      events: {
        publishes: [],
        consumes: [
          { event: "video-digest/*", kind: "http", method: "POST", path: "/api/videos" },
          { event: "video-digest/digest.added", kind: "http", method: "POST", path: "/api/videos" },
          { event: "video-digest/digest.added", kind: "task", task: "curate" },
        ],
      },
    });
    const { event, deliveries } = h.publish("video-digest", "digest.added", { id: "v1", channel: "Other" });
    expect(deliveries.map((d) => `${d.app}:${d.kind}`)).toEqual(["whymove:http"]);
    await h.bus.tick();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.url).toBe("http://127.0.0.1:8830/api/videos");
    expect(h.calls[0]?.body).toMatchObject({ delivery: { id: deliveries[0]?.id, attempt: 1 }, event: { id: event.id, name: "video-digest/digest.added", data: { id: "v1" } } });
    expect(new Headers(h.calls[0]?.init.headers).get("x-space-delivery-attempt")).toBe("1");
    expect(h.store.getDelivery(deliveries[0]!.id)).toMatchObject({ status: "ok", attempts: 1, lastStatus: 200 });

    const second = h.publish("video-digest", "digest.added", { id: "v2", channel: "Weekly" });
    expect(second.deliveries.map((d) => d.app).sort()).toEqual(["cal", "whymove"]);
  });

  test("retries transient failures with the delay table, then dies and notifies once", async () => {
    const answers: (number | Error)[] = [503, new Error("connect ECONNREFUSED"), 429, 500, 500, 500, 500, 500];
    const h = harness(answers);
    h.bus.syncApp("cal", { events: { publishes: [], consumes: [{ event: "a/b", kind: "http", method: "POST", path: "/x" }] } });
    const { deliveries } = h.publish("a", "b");
    const id = deliveries[0]!.id;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
      await h.bus.tick();
      const d = h.store.getDelivery(id)!;
      expect(d).toMatchObject({ status: "pending", attempts: attempt });
      expect(d.nextAt).toBe(Date.parse("2026-09-22T00:00:00Z") + h.elapsed(attempt) + RETRY_DELAYS_MS[attempt - 1]!);
      // Not due yet: a tick now does nothing.
      await h.bus.tick();
      expect(h.calls).toHaveLength(attempt);
      h.advance(RETRY_DELAYS_MS[attempt - 1]!);
    }
    await h.bus.tick();
    expect(h.store.getDelivery(id)).toMatchObject({ status: "dead", attempts: MAX_ATTEMPTS, lastError: expect.stringContaining("500") });
    expect(h.dead).toEqual([`cal#${id}`]);
    expect(h.store.nextDueAt()).toBeUndefined();
  });

  test("a 4xx other than 408/425/429 is final at once; retry queues it again from zero", async () => {
    const h = harness([400, 200]);
    h.bus.syncApp("cal", { events: { publishes: [], consumes: [{ event: "a/b", kind: "http", method: "POST", path: "/x" }] } });
    const id = h.publish("a", "b").deliveries[0]!.id;
    await h.bus.tick();
    expect(h.store.getDelivery(id)).toMatchObject({ status: "dead", attempts: 1, lastStatus: 400 });
    expect(h.dead).toEqual([`cal#${id}`]);
    expect(h.bus.retry(id)).toMatchObject({ status: "pending", attempts: 0 });
    await h.bus.tick();
    expect(h.store.getDelivery(id)).toMatchObject({ status: "ok", attempts: 1 });
  });

  test("skips when the app left, has no port, or the event was pruned", async () => {
    const h = harness();
    h.bus.syncApp("cal", { events: { publishes: [], consumes: [{ event: "a/b", kind: "http", method: "POST", path: "/x" }] } });
    h.bus.syncApp("ghost", { events: { publishes: [], consumes: [{ event: "a/b", kind: "http", method: "POST", path: "/x" }] } });
    const { deliveries } = h.publish("a", "b");
    const cal = deliveries.find((d) => d.app === "cal")!;
    const ghost = deliveries.find((d) => d.app === "ghost")!;
    h.bus.forget("cal");
    await h.bus.tick();
    expect(h.store.getDelivery(cal.id)).toMatchObject({ status: "skipped", lastError: "app left the space" });
    expect(h.store.getDelivery(ghost.id)).toMatchObject({ status: "skipped", lastError: "app has no service port" });
    expect(h.calls).toHaveLength(0);
  });

  test("deliveries to one app go in order, different apps in parallel", async () => {
    const order: string[] = [];
    const h = harness(
      Array.from({ length: 4 }, () => (url: string) => {
        order.push(url);
        return new Response("ok");
      }),
    );
    h.bus.syncApp("cal", { events: { publishes: [], consumes: [{ event: "a/*", kind: "http", method: "POST", path: "/cal" }] } });
    h.bus.syncApp("whymove", { events: { publishes: [], consumes: [{ event: "a/*", kind: "http", method: "POST", path: "/wm" }] } });
    h.publish("a", "one");
    h.publish("a", "two");
    await h.bus.tick();
    expect(order.filter((u) => u.endsWith("/cal"))).toHaveLength(2);
    expect(h.calls.map((c) => c.body?.event.name)).toEqual(expect.arrayContaining(["a/one", "a/two"]));
    const calBodies = h.calls.filter((c) => c.url.endsWith("/cal")).map((c) => c.body?.event.name);
    expect(calBodies).toEqual(["a/one", "a/two"]);
  });
});

describe("bus streams", () => {
  test("pending stream deliveries are pushed on connect, acked, and re-pushed when not acked in time", async () => {
    const h = harness();
    h.bus.syncApp("insight", { events: { publishes: [], consumes: [{ event: "pulse/*", kind: "stream" }] } });
    const first = h.publish("pulse", "clue.found", { id: "c1" }).deliveries[0]!;
    expect(h.store.getDelivery(first.id)?.status).toBe("pending");

    const got: DeliveryPayload[] = [];
    const detach = h.bus.subscribe("insight", (p) => got.push(p));
    expect(got.map((p) => p.delivery.id)).toEqual([first.id]);
    expect(h.store.getDelivery(first.id)).toMatchObject({ status: "sent", attempts: 1 });

    // Live push while connected.
    const second = h.publish("pulse", "clue.found", { id: "c2" }).deliveries[0]!;
    expect(got.map((p) => p.delivery.id)).toEqual([first.id, second.id]);

    // Ack the first; the wrong app or a pending one is refused.
    expect(h.bus.ack("insight", first.id)?.status).toBe("ok");
    expect(h.bus.ack("cal", second.id)).toBeUndefined();
    expect(h.bus.ack("insight", 999)).toBeUndefined();

    // The second is never acked: after the timeout it goes back to pending and is pushed again.
    h.advance(ACK_TIMEOUT_MS + 1);
    await h.bus.tick();
    expect(got.map((p) => p.delivery.id)).toEqual([first.id, second.id, second.id]);
    expect(got[2]?.delivery.attempt).toBe(2);
    expect(h.store.getDelivery(second.id)).toMatchObject({ status: "sent", attempts: 2 });

    // Disconnected: the next round waits as pending instead of being pushed.
    detach();
    h.advance(ACK_TIMEOUT_MS + 1);
    await h.bus.tick();
    expect(h.store.getDelivery(second.id)).toMatchObject({ status: "pending", attempts: 2, lastError: "not acked in time" });
    expect(h.store.pendingStream("insight").map((d) => d.id)).toEqual([second.id]);
  });

  test("a stream delivery whose event was pruned is skipped on push", () => {
    const h = harness();
    h.bus.syncApp("insight", { events: { publishes: [], consumes: [{ event: "pulse/*", kind: "stream" }] } });
    const d = h.publish("pulse", "x").deliveries[0]!;
    h.events.db.exec("DELETE FROM events");
    h.bus.subscribe("insight", () => {});
    expect(h.store.getDelivery(d.id)).toMatchObject({ status: "skipped", lastError: "event pruned before delivery" });
  });
});

describe("bus calls", () => {
  test("forwards to the capability with the caller's name and records the call", async () => {
    const h = harness([
      (url, init) => {
        expect(url).toBe("http://127.0.0.1:8985/api/research");
        expect(init.method).toBe("POST");
        const headers = new Headers(init.headers);
        expect(headers.get("x-space-caller")).toBe("portfolio");
        expect(headers.get("x-space-capability")).toBe("research");
        expect(headers.get("content-type")).toBe("application/json");
        return new Response(JSON.stringify({ verdict: "hold" }), { headers: { "content-type": "application/json" } });
      },
    ]);
    h.bus.syncApp("insight", { provides: [{ name: "research", method: "POST", path: "/api/research", timeoutMs: 5000, callers: ["portfolio"] }] });
    const r = await h.bus.call("portfolio", "insight", "research", { body: JSON.stringify({ symbol: "BTC" }), contentType: "application/json" });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ verdict: "hold" });
    expect(h.store.listCalls()).toEqual([expect.objectContaining({ caller: "portfolio", app: "insight", capability: "research", status: 200, ok: true })]);
    expect(h.store.callStats("insight")).toEqual([{ capability: "research", calls: 1, failures: 0, meanMs: 0 }]);
  });

  test("refuses unknown, disallowed and serviceless targets; passes the provider's errors through; records unreachable", async () => {
    const h = harness([new Error("connect ECONNREFUSED"), 500]);
    h.bus.syncApp("insight", { provides: [{ name: "research", method: "POST", path: "/api/research", timeoutMs: 5000, callers: ["portfolio"] }] });
    h.bus.syncApp("silent", { provides: [{ name: "x", method: "GET", path: "/x", timeoutMs: 5000 }] });
    await expect(h.bus.call("portfolio", "nobody", "x")).rejects.toMatchObject({ status: 404 });
    await expect(h.bus.call("portfolio", "insight", "nope")).rejects.toMatchObject({ status: 404 });
    await expect(h.bus.call("thesis", "insight", "research")).rejects.toMatchObject({ status: 403 });
    await expect(h.bus.call("portfolio", "silent", "x")).rejects.toMatchObject({ status: 503 });
    const err = await h.bus.call("portfolio", "insight", "research").catch((e) => e as CallError);
    expect(err).toBeInstanceOf(CallError);
    expect(err).toMatchObject({ status: 502 });
    const r = await h.bus.call("portfolio", "insight", "research");
    expect(r.status).toBe(500);
    expect(h.store.listCalls().map((c) => [c.status, c.ok])).toEqual([
      [500, false],
      [0, false],
    ]);
  });

  test("the catalogue lists what every app provides, publishes and consumes", () => {
    const h = harness();
    h.bus.syncApp("b", { events: { publishes: [{ name: "x" }], consumes: [{ event: "a/y", kind: "stream" }] } });
    h.bus.syncApp("a", { provides: [{ name: "y", method: "POST", path: "/y", timeoutMs: 1000 }] });
    expect(h.bus.capabilities()).toEqual([
      { app: "a", provides: [{ name: "y", method: "POST", path: "/y", timeoutMs: 1000 }], publishes: [], consumes: [] },
      { app: "b", provides: [], publishes: [{ name: "x" }], consumes: [{ event: "a/y", kind: "stream" }] },
    ]);
  });
});
