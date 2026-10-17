import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { UsageStore } from "./store.ts";
import { UsageService } from "./service.ts";

const device = "iphone-0001";
const other = "iphone-0002";
const a = "session-aaa";
const b = "session-bbb";

describe("device foreground usage", () => {
  test("separate iOS installations and clients never share a session", () => {
    const store = new UsageStore(new Database(":memory:"));
    for (const [id, client] of [[device, "ios"], [other, "ios"], [device, "web"]] as const) {
      store.deviceBeat(id, client, a, true, 1000);
      store.deviceBeat(id, client, a, true, 31_000);
    }
    expect(store.devices(0, 40_000)).toHaveLength(3);
    expect(store.devices(0, 40_000).every(r => r.activeMs === 30_000 && r.sessions === 1)).toBe(true);
  });

  test("overlapping windows are unioned, and report boundaries clip intervals", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.deviceBeat(device, "macos", a, true, 1000);
    store.deviceBeat(device, "macos", b, true, 11_000);
    store.deviceBeat(device, "macos", a, false, 31_000);
    store.deviceBeat(device, "macos", b, false, 41_000);
    expect(store.devices(0, 50_000)).toMatchObject([{ activeMs: 40_000, sessions: 2, lastAt: new Date(41_000).toISOString() }]);
    expect(store.devices(21_000, 36_000)[0]?.activeMs).toBe(15_000);
    expect(store.devices(41_001, 50_000)).toEqual([]);
  });

  test("background, missing packets and late packets do not inflate duration", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.deviceBeat(device, "ios", a, true, 1000);
    store.deviceBeat(device, "ios", a, true, 31_000);
    store.deviceBeat(device, "ios", a, false, 36_000);
    store.deviceBeat(device, "ios", a, true, 40_000); // arrived after stop
    store.deviceBeat(device, "ios", b, true, 100_000);
    store.deviceBeat(device, "ios", b, true, 160_000); // offline gap
    store.deviceBeat(device, "ios", b, true, 190_000);
    expect(store.devices(0, 200_000)).toMatchObject([{ activeMs: 65_000, sessions: 2 }]);
    store.deviceBeat(device, "ios", b, true, 190_000); // duplicate
    store.deviceBeat(device, "ios", b, true, 180_000); // clock moved backward
    expect(store.devices(0, 200_000)[0]?.activeMs).toBe(65_000);
  });

  test("stop received before start leaves a tombstone", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.deviceBeat(device, "android", a, false, 1000);
    store.deviceBeat(device, "android", a, true, 31_000);
    expect(store.devices(0, 100_000)).toMatchObject([{ activeMs: 0 }]);
  });

  test("existing databases and app reports survive; retention prunes devices", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE usage_opens (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("INSERT INTO usage_opens VALUES (1, 'app', 'todo', 'panel', 1000)");
    const store = new UsageStore(db, { retentionDays: 1 });
    expect(store.summary(0)).toMatchObject([{ key: "todo", opens: 1, activeMs: null }]);
    expect(store.devices(0, 100_000)).toEqual([]); // No invented identity for historical events.
    store.deviceBeat(device, "ios", a, true, 1000);
    store.deviceBeat(other, "ios", b, true, 2 * 86400_000);
    expect(store.devices(0, 3 * 86400_000)).toHaveLength(1);
    new UsageStore(db); // Reopening is idempotent.
  });

  test("untrusted identity, session, client and state values are rejected", () => {
    let now = 1000;
    const service = new UsageService(new UsageStore(new Database(":memory:")), { now: () => now });
    const valid = { deviceId: device, client: "ios", session: a, active: true };
    for (const bad of [{ deviceId: "x" }, { deviceId: "a".repeat(65) }, { client: "server" }, { session: null }, { active: "true" }]) {
      expect(() => service.deviceBeat({ ...valid, ...bad })).toThrow();
    }
    service.deviceBeat(valid);
    now += 30_000;
    service.deviceBeat(valid);
    now++;
    expect(service.devices("7d")).toMatchObject([{ deviceId: device, client: "ios", activeMs: 30_000 }]);
  });
});
