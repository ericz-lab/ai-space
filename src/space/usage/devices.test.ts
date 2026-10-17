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

describe("device application breakdown", () => {
  test("switching apps attributes preceding time correctly and preserves device visit count", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.deviceOpen(device, "ios", "event-0001", "ai-todo", 1000);
    store.deviceOpen(device, "ios", "event-0001", "ai-todo", 2000); // retry
    store.deviceBeat(device, "ios", a, true, 1000, "ai-todo", 1);
    store.deviceBeat(device, "ios", a, true, 31_000, "ai-notes", 2);
    store.deviceOpen(device, "ios", "event-0002", "ai-notes", 31_000);
    store.deviceBeat(device, "ios", a, true, 35_000, "ai-todo", 1); // delayed old context
    store.deviceBeat(device, "ios", a, true, 51_000, null, 3); // launcher
    store.deviceBeat(device, "ios", a, false, 61_000, null, 4);
    expect(store.devices(0, 70_000)).toMatchObject([{ sessions: 1, activeMs: 60_000, apps: [
      { key: "ai-todo", opens: 1, activeMs: 30_000 },
      { key: "ai-notes", opens: 1, activeMs: 20_000 },
    ] }]);
    expect(store.devices(21_000, 41_000)[0]?.apps).toMatchObject([
      { key: "ai-notes", opens: 1, activeMs: 10_000 },
      { key: "ai-todo", opens: 0, activeMs: 10_000 },
    ]);
  });

  test("per-app intervals deduplicate windows and isolate devices and peer keys", () => {
    const store = new UsageStore(new Database(":memory:"));
    for (const id of [device, other]) {
      store.deviceBeat(id, "ios", a, true, 1000, "peer/ai-todo", 1);
      store.deviceBeat(id, "ios", a, true, 31_000, "peer/ai-todo", 2);
    }
    store.deviceBeat(device, "ios", b, true, 11_000, "peer/ai-todo", 1);
    store.deviceBeat(device, "ios", b, false, 41_000, "peer/ai-todo", 2);
    expect(store.devices(0, 50_000).map(r => r.apps[0]?.activeMs)).toEqual([40_000, 30_000]);
  });

  test("web opens do not invent app duration; device-only history stays unattributed", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.deviceBeat(device, "web", a, true, 1000);
    store.deviceBeat(device, "web", a, false, 31_000);
    store.deviceOpen(device, "web", "event-0001", "ai-todo", 1000);
    expect(store.devices(0, 40_000)).toMatchObject([{ activeMs: 30_000, apps: [{ key: "ai-todo", opens: 1, activeMs: null }] }]);
  });

  test("same-millisecond navigation and exit cannot leave a session open", () => {
    const store = new UsageStore(new Database(":memory:"));
    store.deviceBeat(device, "ios", a, true, 1000, "a", 1);
    store.deviceBeat(device, "ios", a, true, 1000, "b", 2);
    store.deviceBeat(device, "ios", a, false, 1000, "b", 3);
    store.deviceBeat(device, "ios", a, true, 31_000, "b", 4);
    expect(store.devices(0, 40_000)[0]?.activeMs).toBe(0);
  });

  test("rejects malformed app context and device opens", () => {
    const service = new UsageService(new UsageStore(new Database(":memory:")));
    const beat = { deviceId: device, client: "ios", session: a, active: true };
    expect(() => service.deviceBeat({ ...beat, app: "app:todo" })).toThrow();
    for (const sequence of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => service.deviceBeat({ ...beat, sequence })).toThrow();
    }
    for (const bad of [{ key: "../../x" }, { deviceId: "x" }, { client: "watch" }, { eventId: null }]) {
      expect(() => service.deviceOpen({ deviceId: device, client: "ios", eventId: "event-0001", key: "todo", ...bad })).toThrow();
    }
  });
});

test("migrating device-only history preserves time without invented app attribution", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE usage_device_segments (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL, client TEXT NOT NULL, session TEXT NOT NULL, started_at INTEGER NOT NULL, last_at INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0)");
  db.exec("INSERT INTO usage_device_segments VALUES (1, 'iphone-0001', 'ios', 'session-aaa', 1000, 31000, 1)");
  const store = new UsageStore(db);
  new UsageStore(db);
  expect(store.devices(0, 40_000)).toMatchObject([{ activeMs: 30_000, sessions: 1, apps: [] }]);
});
