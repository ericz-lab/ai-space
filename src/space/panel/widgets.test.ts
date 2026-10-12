import { afterEach, expect, setSystemTime, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { WidgetFeed } from "./widgets.ts";
import { parsePackageManifest } from "../packages/manifest.ts";

test("package item widgets use dynamic services and isolated application deep links", async () => {
  const parsed = parsePackageManifest("spec: 2\nname: n\nversion: 1.0.0\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: app.ts, health: /healthz }\nwidgets:\n  - { name: w, source: /api/widget }\n");
  const m = { ...parsed, url: "/_space/apps/n" };
  const feed = new WidgetFeed({ list: () => [{ manifest: m }] } as never, { appFetch: async (app, path) => {
    expect([app, path]).toEqual(["n", "/api/widget"]);
    return Response.json({ ok: true, items: [{ text: "note", url: "/notes?id=1" }] });
  } });
  expect(await feed.one(m, m.widgets[0]!)).toMatchObject({ ok: true, items: [{ url: "/_space/apps/n?path=%2Fnotes%3Fid%3D1" }] });
});

afterEach(() => setSystemTime());

test("a failed source is retried after 30s, a payload is kept for its refresh", async () => {
  const m = parseManifest("name: n\nservice: { command: x, port: 9 }\nwidgets:\n  - { name: w, source: /api/widget, refresh: 5m }\n", "n");
  let calls = 0;
  let up = false;
  const fetch = (async () => {
    calls++;
    if (!up) throw new Error("socket closed");
    return Response.json({ ok: true, items: [{ text: "x" }] });
  }) as unknown as typeof globalThis.fetch;
  const feed = new WidgetFeed({ list: () => [{ manifest: m }] } as never, { fetch });
  const t0 = new Date("2026-10-08T01:00:00Z").getTime();
  setSystemTime(t0);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(false);
  up = true;
  setSystemTime(t0 + 10_000);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(false);
  setSystemTime(t0 + 31_000);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(true);
  up = false;
  setSystemTime(t0 + 120_000);
  expect((await feed.one(m, m.widgets[0]!)).ok).toBe(true);
  expect(calls).toBe(2);
});
