import { afterEach, expect, setSystemTime, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { WidgetFeed } from "./widgets.ts";

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
