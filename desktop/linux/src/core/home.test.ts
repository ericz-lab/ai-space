import { expect, test } from "bun:test";
import type { GaugeBlock, TrendBlock, WidgetBlock } from "../../../../src/space/panel/blocks.ts";
import { fmt as webFmt, isOutdated as webOutdated, txt as webTxt } from "../../../../src/web/WidgetBlocks.tsx";
import { decodeCatalogue } from "./catalogue.ts";
import { HOME, copyPanel, decodeScreenFile, edit, forget, move, newScreen, pin, rename, reset, screenTitle, screensOf, seed, unpin } from "./screens.ts";
import { cardBody, deltaText, embedPath, fmt, fraction, gaugeSegments, isOutdated, itemsFor, position, rowsFor, shown, spark, toneOf, txt } from "./widgets.ts";

test("numbers and texts read as the panel writes them", () => {
  const cases: [number, Parameters<typeof fmt>[1], boolean][] = [
    [1234.567, {}, false],
    [0.5, { decimals: 3 }, false],
    [42.3, { format: "percent" }, false],
    [12.5, { format: "currency", currency: "EUR" }, false],
    [250000, { format: "currency" }, false],
    [1234567, { format: "compact" }, true],
    [-3, { unit: { en: "items", zh: "项" } }, true],
  ];
  for (const lang of ["en", "zh"] as const) for (const [v, n, s] of cases) expect(fmt(v, n, lang, s)).toBe(webFmt(v, n, lang, s));
  const texts: (string | Record<string, string>)[] = ["plain", { en: "Hi", zh: "你好" }, { "zh-CN": "简体" }, { fr: "Salut" }];
  for (const t of texts) for (const lang of ["en", "zh"] as const) expect(txt(t, lang)).toBe(webTxt(t, lang));
  expect(isOutdated("2026-01-01T00:00:00Z", 60_000, Date.parse("2026-01-01T00:02:00Z"))).toBe(webOutdated("2026-01-01T00:00:00Z", 60_000, Date.parse("2026-01-01T00:02:00Z")));
  expect(isOutdated(undefined, 60_000)).toBe(false);
});

test("block values, tones and shapes", () => {
  const metric: WidgetBlock = { type: "metric", label: "Revenue", value: 1200, format: "currency", currency: "USD", delta: { value: -5, format: "percent", label: "vs last week", tone: "negative" } };
  expect(shown(metric, "en")).toBe("$1,200.00");
  expect(deltaText(metric, "en", true)).toEqual({ text: "▼ 5% vs last week", tone: "negative" });
  expect(deltaText(metric, "en", false)?.text).toBe("▼ 5%");
  expect(shown({ type: "metric", label: "x", value: null }, "en")).toBeUndefined();
  expect(shown({ type: "status", label: "s", value: { en: "All good" } }, "en")).toBe("All good");
  expect(fraction({ type: "progress", label: "p", value: 3, max: 4 })).toBe(0.75);
  expect(fraction({ type: "progress", label: "p", value: 9, max: 4 })).toBe(1);
  const gauge: GaugeBlock = { type: "gauge", label: "g", value: 70, min: 0, max: 100, zones: [{ to: 50, tone: "positive" }, { to: 80, tone: "warning" }, { to: 100, tone: "negative" }] };
  expect(toneOf(gauge)).toBe("warning");
  expect(position(gauge, 70)).toBe(0.7);
  expect(gaugeSegments(gauge)).toEqual([{ start: 0, end: 0.5, tone: "positive" }, { start: 0.5, end: 0.8, tone: "warning" }, { start: 0.8, end: 1, tone: "negative" }]);
  const line: TrendBlock = { type: "trend", label: "t", style: "line", points: [{ t: "a", v: 1 }, { t: "b", v: null }, { t: "c", v: 3 }, { t: "d", v: 2 }] };
  expect(shown(line, "en")).toBe("2");
  const s = spark(line);
  expect(s?.kind).toBe("line");
  if (s?.kind === "line") {
    expect(s.runs.map((r) => r.length)).toEqual([1, 2]);
    expect(s.runs[1]![0]!.y).toBe(0);
  }
  const bars = spark({ type: "trend", label: "t", style: "bar", signed: true, points: [{ t: "a", v: -2 }, { t: "b", v: 2 }, { t: "c", v: null }] });
  expect(bars?.kind).toBe("bars");
  if (bars?.kind === "bars") {
    expect(bars.zero).toBe(0.5);
    expect(bars.bars.map((b) => [b.negative, b.latest])).toEqual([[true, false], [false, true]]);
  }
  expect(spark({ type: "trend", label: "t", style: "line", points: [{ t: "a", v: null }] })).toBeUndefined();
  expect([rowsFor("1x1"), rowsFor("2x2"), rowsFor(undefined), itemsFor("1x2"), itemsFor("2x1")]).toEqual([2, 10, 2, 8, 4]);
});

test("a widget's card and its embed page", () => {
  const c = decodeCatalogue({
    apps: { apps: [] },
    agents: { agents: [] },
    widgets: {
      widgets: [
        { id: "a/w", app: "a", name: "w", title: "W", kind: "embed", size: "2x2" },
        { id: "b/w", app: "b", name: "w", title: "B", kind: "items", items: [{ text: "x" }], staleAfterMs: 5000 },
        { id: "c/w", app: "c", name: "w", title: "C", ok: false, error: "down" },
        { id: "seoul/d/w", app: "d", name: "w", title: "D", peer: "seoul", blocks: [{ type: "status", label: "s", value: "ok" }] },
      ],
    },
  });
  expect(c.widgets.map(cardBody)).toEqual(["embed", "items", "error", "blocks"]);
  expect(c.widgets[1]!.staleAfterMs).toBe(5000);
  expect(embedPath(c.widgets[0]!, true, "zh")).toBe("/api/widgets/a/w/embed?theme=dark&lang=zh");
  expect(embedPath(c.widgets[3]!, false, "en")).toBe("/api/peers/seoul/widgets/d/w/embed?theme=light&lang=en");
});

test("screens: copied from the panel once, then this computer's own", () => {
  const panel = [
    { id: "s1", name: "Work", items: ["app:x", "builtin:pet", "app:x", "widget:a/w"] },
    { id: HOME, name: "", items: ["app:a", "builtin:inbox", "agent:a/b"] },
  ];
  expect(copyPanel(panel)).toEqual([
    { id: HOME, name: "", items: ["app:a", "builtin:inbox", "agent:a/b"] },
    { id: "s1", name: "Work", items: ["app:x", "widget:a/w"] },
  ]);
  expect(screensOf({}, "c")).toEqual([{ id: HOME, name: "", items: [] }]);
  expect(seed({}, "c", [{ id: HOME, name: "", items: [] }])).toBeUndefined();
  const f1 = seed({}, "c", panel)!;
  expect(f1.c!.seeded).toBe(true);
  expect(seed(f1, "c", [{ id: HOME, name: "", items: ["app:z"] }])).toBeUndefined();
  const f2 = edit(f1, "c", (s) => unpin(pin(s, HOME, "app:new"), HOME, "app:a"));
  expect(screensOf(f2, "c")[0]!.items).toEqual(["builtin:inbox", "agent:a/b", "app:new"]);
  const tiles = screensOf(f2, "c")[0]!.items;
  expect(screensOf(edit(f2, "c", (s) => move(s, HOME, tiles, 0, 2)), "c")[0]!.items).toEqual(["agent:a/b", "app:new", "builtin:inbox"]);
  const added = newScreen(screensOf(f2, "c"))!;
  expect(added.screens).toHaveLength(3);
  expect(screenTitle(rename(added.screens, added.id, "  Mine "), 2, { main: "Main", numbered: (n) => `Screen ${n}` })).toBe("Mine");
  expect(screenTitle(added.screens, 2, { main: "Main", numbered: (n) => `Screen ${n}` })).toBe("Screen 3");
  expect(screenTitle(added.screens, 0, { main: "Main", numbered: (n) => `Screen ${n}` })).toBe("Main");
  expect(screensOf(reset(f2, "c", panel), "c")).toEqual(copyPanel(panel));
  expect(forget(f2, "c")).toEqual({});
  expect(decodeScreenFile({ c: { screens: [{ id: "x", items: ["app:a", 3] }, "bad"], seeded: true }, d: "bad" })).toEqual({ c: { screens: [{ id: HOME, name: "", items: [] }, { id: "x", name: "", items: ["app:a"] }], seeded: true } });
});
