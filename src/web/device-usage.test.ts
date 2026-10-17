import { expect, test } from "bun:test";
import { startDeviceUsage } from "./device-usage.ts";

function browser(ua = "Browser", storage = new Map<string, string>()) {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const bodies: Blob[] = [];
  Object.assign(win, {
    navigator: { userAgent: ua, sendBeacon: (_: string, body: Blob) => { bodies.push(body); return true; } },
    localStorage: { getItem: (k: string) => storage.get(k), setItem: (k: string, v: string) => storage.set(k, v) },
  });
  return { win, doc, bodies, start: () => startDeviceUsage(win as Window, doc as unknown as Document) };
}

test("visibility, BFCache restore and cleanup delimit foreground visits, identity persists", async () => {
  const storage = new Map<string, string>();
  const b = browser("Browser", storage);
  const stop = b.start();
  b.doc.visibilityState = "hidden";
  b.doc.dispatchEvent(new Event("visibilitychange"));
  b.win.dispatchEvent(new Event("pagehide")); // No duplicate stop.
  b.doc.visibilityState = "visible";
  b.win.dispatchEvent(new Event("pageshow"));
  stop();
  b.doc.dispatchEvent(new Event("visibilitychange")); // Cleaned up.
  const sent = await Promise.all(b.bodies.map(async b => JSON.parse(await b.text())));
  expect(sent.map(b => b.active)).toEqual([true, false, true, false]);
  expect(new Set(sent.map(b => b.deviceId)).size).toBe(1);
  expect(sent[0].session).not.toBe(sent[2].session);
  const next = browser("Browser", storage);
  const close = next.start();
  close();
  expect(JSON.parse(await next.bodies[0]!.text()).deviceId).toBe(sent[0].deviceId);
});

test("native WebViews do not create duplicate web devices", () => {
  for (const ua of ["Safari AISpaceMobile/1.0", "Safari AISpaceDesktop/1.0"]) {
    const b = browser(ua);
    b.start()();
    expect(b.bodies).toHaveLength(0);
  }
});

test("denied storage and failed telemetry leave the page usable", () => {
  const b = browser();
  Object.assign(b.win, { localStorage: { getItem: () => { throw new Error("denied"); } } });
  expect(() => b.start()()).not.toThrow();
  expect(b.bodies).toHaveLength(0);
});
