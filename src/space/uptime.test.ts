import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { UptimeStore, createUptimeRoutes } from "./uptime.ts";

const meta = { version: "1.0.0", edition: "server" };
const T0 = Date.parse("2026-10-01T00:00:00.000Z");

function clock(start = T0) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v), add: (ms: number) => (t += ms) };
}

describe("UptimeStore", () => {
  test("nothing to say before this run starts", () => {
    expect(new UptimeStore(new Database(":memory:")).summary()).toBeUndefined();
  });

  test("adds every run up across restarts; a crash keeps the run up to its last tick", () => {
    const db = new Database(":memory:");
    const c = clock();
    // First run: 3 hours, ended cleanly.
    const a = new UptimeStore(db, c);
    a.start(meta, null);
    c.add(3 * 3_600_000);
    a.stop();
    // Second run: ticked at 30 min, then the machine lost power at 30 min 50 s.
    c.add(10 * 60_000);
    const b = new UptimeStore(db, c);
    b.start(meta, null);
    c.add(30 * 60_000);
    b.tick();
    c.add(50_000);
    // Third run, after the power cut.
    c.add(60 * 60_000);
    const d = new UptimeStore(db, c);
    const started = c.now();
    d.start({ version: "1.1.0", edition: "server" }, null);
    c.add(5 * 60_000);
    expect(d.summary()).toEqual({
      startedAt: new Date(started).toISOString(),
      currentMs: 5 * 60_000,
      totalMs: 3 * 3_600_000 + 30 * 60_000 + 5 * 60_000,
      firstStartedAt: new Date(T0).toISOString(),
      restarts: 2,
    });
    expect(db.query("SELECT version FROM uptime_segments ORDER BY id").all()).toEqual([{ version: "1.0.0" }, { version: "1.0.0" }, { version: "1.1.0" }]);
  });

  test("a clock set back neither shortens a recorded run nor counts below zero", () => {
    const db = new Database(":memory:");
    const c = clock();
    const a = new UptimeStore(db, c);
    a.start(meta, null);
    c.add(60_000);
    a.tick();
    c.set(T0 - 3_600_000);
    a.stop();
    const b = new UptimeStore(db, c);
    b.start(meta, null);
    expect(b.summary()).toMatchObject({ currentMs: 0, totalMs: 60_000, restarts: 1, firstStartedAt: new Date(T0 - 3_600_000).toISOString() });
  });

  test("starting twice opens one segment", () => {
    const db = new Database(":memory:");
    const s = new UptimeStore(db, clock());
    s.start(meta, null);
    s.start(meta, null);
    expect(db.query("SELECT COUNT(*) AS n FROM uptime_segments").get()).toEqual({ n: 1 });
  });

  test("the timer moves the end forward on its own", async () => {
    const db = new Database(":memory:");
    const s = new UptimeStore(db);
    s.start(meta, 5);
    const first = (db.query("SELECT last_at FROM uptime_segments").get() as { last_at: number }).last_at;
    await Bun.sleep(30);
    const later = (db.query("SELECT last_at FROM uptime_segments").get() as { last_at: number }).last_at;
    s.stop();
    expect(later).toBeGreaterThan(first);
  });
});

describe("GET /api/space/uptime", () => {
  test("the operator gets the summary, uncached; anyone else a 401", async () => {
    const c = clock();
    const store = new UptimeStore(new Database(":memory:"), c);
    const routes = createUptimeRoutes({ uptime: store, token: "op" });
    const get = (auth?: string) => routes["/api/space/uptime"].GET(new Request("http://x/api/space/uptime", auth ? { headers: { authorization: auth } } : {}));
    expect((await get()).status).toBe(401);
    expect((await get("Bearer nope")).status).toBe(401);
    expect((await get("Bearer op")).status).toBe(503);
    store.start(meta, null);
    c.add(90_000);
    const res = await get("Bearer op");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, uptime: { startedAt: new Date(T0).toISOString(), currentMs: 90_000, totalMs: 90_000, firstStartedAt: new Date(T0).toISOString(), restarts: 0 } });
  });
});
