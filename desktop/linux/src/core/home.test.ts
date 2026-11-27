import { expect, test } from "bun:test";
import type { GaugeBlock, TrendBlock, WidgetBlock } from "../../../../src/space/panel/blocks.ts";
import { fmt as webFmt, isOutdated as webOutdated, txt as webTxt } from "../../../../src/web/WidgetBlocks.tsx";
import { decodeCatalogue, panelScreens, seededScreens } from "./catalogue.ts";
import { BUILTIN_ICONS } from "../../../../src/space/panel/icons.ts";
import { BUILTINS } from "../../../../src/web/screens.ts";
import { BUILTIN_ART, BUILTIN_NAMES, LIBRARY, builtinArt, builtinPage, openingPage, pageAfter, pagesOf } from "./screens.ts";
import { adopt } from "./screens.ts";
import { HOME, copyPanel, decodeScreenFile, edit, forget, move, newScreen, pin, rename, reset, screenTitle, screensOf, seed, unpin } from "./screens.ts";
import { cardBody, deltaText, embedPath, fmt, fraction, gaugeSegments, isOutdated, itemsFor, position, rowsFor, shown, spark, tankLevel, tankValue, toneOf, txt } from "./widgets.ts";

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
  const tanks: WidgetBlock = { type: "tanks", label: "Nearest 10 GB", tanks: [{ label: "a", value: 7.5, max: 10, display: "7.5 GB" }, { label: "b", value: 12, max: 10 }, { label: "c", value: null, max: 10 }] };
  expect(shown(tanks, "en")).toBeUndefined();
  if (tanks.type === "tanks") {
    expect(tanks.tanks.map((k) => tankValue(k, "en"))).toEqual(["7.5 GB", "120%", undefined]);
    expect(tanks.tanks.map(tankLevel)).toEqual([0.75, 1.2, 0]);
  }
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

test("the panel's own tiles: every one of them, with the panel's pictures and pages", async () => {
  // Every tile the panel has is one this client draws, in the panel's order; the web panel's is its own.
  expect(BUILTIN_NAMES.filter((n) => n !== "panel")).toEqual([...BUILTINS]);
  // The picture shipped for a tile is the file the Space serves for it by default.
  expect(Object.fromEntries(Object.entries(BUILTIN_ART).map(([name, file]) => [name, `/${file}`]))).toEqual({ ...BUILTIN_ICONS });
  for (const file of Object.values(BUILTIN_ART)) expect(await Bun.file(`${import.meta.dir}/../../../../src/web/public/${file}`).exists()).toBe(true);
  expect(BUILTIN_NAMES.map(builtinArt)).toEqual(["store.svg", "orders.svg", "inbox.svg", "shortcuts.svg", "terminal.svg", undefined, "settings.svg"]);
  // Inbox, Terminal and Settings are this client's own views; the others are pages of the panel.
  expect(BUILTIN_NAMES.map(builtinPage)).toEqual(["/?page=store", "/?page=orders", undefined, "/?page=shortcuts", undefined, "/", undefined]);
  // A screen copied from the panel keeps its App Store tile.
  expect(copyPanel([{ id: HOME, name: "", items: BUILTINS.map((b) => `builtin:${b}`) }])[0]!.items).toEqual(BUILTINS.map((b) => `builtin:${b}`));
});

/** A Space as a first look finds it: what `/api/apps`, `/api/agents` and `/api/panel/layout` answer. */
const spaceWith = (apps: string[], screens: unknown) =>
  decodeCatalogue({
    apps: { apps: apps.map((name) => ({ id: name, name, title: name, url: `http://${name}.localhost` })) },
    agents: { agents: [{ id: "space/assistant", app: "space", name: "assistant", title: "Space Assistant" }] },
    widgets: { widgets: [] },
    layout: { ok: true, layout: { screens } },
  });

test("first run: the window opens on the home screen, and it holds tiles", () => {
  const builtins = BUILTINS.map((b) => `builtin:${b}`);
  // A Space just installed: no app yet and no screens stored (`screens: null`). The home screen
  // is what a new panel seeds, the App Store among its tiles.
  const fresh = spaceWith([], null);
  const f = seed({}, "c", panelScreens(fresh), seededScreens(fresh))!;
  expect(screensOf(f, "c")).toEqual([{ id: HOME, name: "", items: [...builtins, "agent:space/assistant"] }]);
  // Home's pages are the library, then the screens; the window opens on the home screen, the second page.
  expect(pagesOf(screensOf(f, "c"))).toEqual([LIBRARY, HOME]);
  expect(openingPage(screensOf(f, "c"))).toBe(HOME);
  expect(pagesOf(screensOf(f, "c")).indexOf(openingPage(screensOf(f, "c")))).toBe(1);
  // Before the Space has answered there are no screens of its own yet: still the home screen.
  expect(openingPage(screensOf({}, "c"))).toBe(HOME);
  expect(pagesOf(screensOf({}, "c"))).toEqual([LIBRARY, HOME]);

  // A panel that keeps its tiles on a later screen and none on home: the window still opens on
  // the home screen, not on that one, and home starts with the tiles a new panel would have.
  const later = spaceWith(["todo", "notes"], [{ id: HOME, name: "", items: [] }, { id: "s1", name: "Work", items: ["app:todo"] }]);
  const g = seed({}, "c", panelScreens(later), seededScreens(later))!;
  expect(screensOf(g, "c")).toEqual([
    { id: HOME, name: "", items: ["app:todo", "app:notes", ...builtins, "agent:space/assistant"] },
    { id: "s1", name: "Work", items: ["app:todo"] },
  ]);
  expect(openingPage(screensOf(g, "c"))).toBe(HOME);
  // A panel emptied altogether gets the same home screen instead of an empty one.
  const emptied = spaceWith(["todo"], [{ id: HOME, name: "", items: [] }]);
  expect(screensOf(seed({}, "c", panelScreens(emptied), seededScreens(emptied))!, "c")[0]!.items).toEqual(["app:todo", ...builtins, "agent:space/assistant"]);
  // A home screen the panel filled is taken as it is, and a layout made here is never filled again.
  const pinned = spaceWith(["todo", "notes"], [{ id: HOME, name: "", items: ["app:notes"] }]);
  expect(screensOf(seed({}, "c", panelScreens(pinned), seededScreens(pinned))!, "c")[0]!.items).toEqual(["app:notes"]);
  const cleared = edit(f, "c", (s) => s.map((x) => ({ ...x, items: [] })));
  expect(seed(cleared, "c", panelScreens(fresh), seededScreens(fresh))).toBeUndefined();
  expect(openingPage(screensOf(cleared, "c"))).toBe(HOME);

  // The page on show stays while its screen is there; when it goes, the home screen, never the library.
  const three = [{ id: HOME, name: "", items: [] }, { id: "s1", name: "", items: [] }, { id: "s2", name: "", items: [] }];
  expect(pageAfter("s2", three)).toBe("s2");
  expect(pageAfter(LIBRARY, three)).toBe(LIBRARY);
  expect(pageAfter("s2", three.slice(0, 2))).toBe(HOME);
});

test("apps installed from the App Store land on this computer's home screen", () => {
  const keys = (c: ReturnType<typeof spaceWith>) => c.apps.map((a) => `app:${a.ref}`);
  const look = (file: Parameters<typeof adopt>[0], c: ReturnType<typeof spaceWith>) => adopt(file, "c", keys(c), panelScreens(c));
  const home = (file: Parameters<typeof adopt>[0]) => screensOf(file, "c")[0]!.items;
  const builtins = BUILTINS.map((b) => `builtin:${b}`);

  // First install: no app yet. The layout is made, and the first look notes the apps it was made with.
  const fresh = spaceWith([], null);
  expect(look({}, fresh)).toBeUndefined();
  let f = seed({}, "c", panelScreens(fresh), seededScreens(fresh))!;
  f = look(f, fresh)!;
  expect(f.c).toEqual({ screens: [{ id: HOME, name: "", items: [...builtins, "agent:space/assistant"] }], seeded: true, apps: [] });
  expect(look(f, fresh)).toBeUndefined();

  // The first-use choice: the App Store installs todo and notes and pins both to the panel's home
  // screen (the page stores the screens it seeded, then each pin). They follow here, in that order.
  const panelHome = [...builtins, "agent:space/assistant", "app:todo", "app:notes"];
  const chosen = spaceWith(["notes", "todo"], [{ id: HOME, name: "", items: panelHome }]);
  f = look(f, chosen)!;
  expect(home(f)).toEqual(panelHome);
  expect(f.c!.apps).toEqual(["app:notes", "app:todo"]);
  expect(f.c!.awaiting).toBeUndefined();
  expect(look(f, chosen)).toBeUndefined();

  // One at a time, and a look that falls between the install and the page saving its pin: the app
  // waits, and lands with the pin.
  const installed = spaceWith(["notes", "todo", "keep"], [{ id: HOME, name: "", items: panelHome }]);
  f = look(f, installed)!;
  expect(home(f)).toEqual(panelHome);
  expect(f.c!.awaiting).toEqual(["app:keep"]);
  expect(look(f, installed)).toBeUndefined();
  const pinnedKeep = spaceWith(["notes", "todo", "keep"], [{ id: HOME, name: "", items: [...panelHome, "app:keep"] }]);
  f = look(f, pinnedKeep)!;
  expect(home(f)).toEqual([...panelHome, "app:keep"]);
  expect(f.c!.awaiting).toBeUndefined();

  // Taken off the home screen here, it stays off: an app is new once, even after it left and came back.
  f = edit(f, "c", (s) => unpin(s, HOME, "app:keep"));
  expect(f.c!.apps).toEqual(["app:notes", "app:todo", "app:keep"]);
  expect(look(f, pinnedKeep)).toBeUndefined();
  expect(look(f, chosen)).toBeUndefined();
  expect(look(f, pinnedKeep)).toBeUndefined();
  expect(home(f)).toEqual(panelHome);

  // An app installed another way, which the panel does not pin, stays in the library; so does one
  // that left the Space while it waited.
  const viaCli = spaceWith(["notes", "todo", "keep", "cli"], [{ id: HOME, name: "", items: [...panelHome, "app:keep"] }]);
  f = look(f, viaCli)!;
  expect(home(f)).toEqual(panelHome);
  expect(f.c!.awaiting).toEqual(["app:cli"]);
  f = look(f, pinnedKeep)!;
  expect(f.c!.awaiting).toBeUndefined();
  expect(home(look(f, spaceWith(["notes", "todo", "keep", "cli"], [{ id: HOME, name: "", items: [...panelHome, "app:cli"] }])) ?? f)).toEqual(panelHome);

  // What the panel's owner pins there later of apps this computer already knew changes nothing here.
  const repinned = edit(f, "c", (s) => unpin(s, HOME, "app:todo"));
  expect(look(repinned, pinnedKeep)).toBeUndefined();
  // A new app already put on another screen here stays where it was put.
  const placed = edit(f, "c", (s) => pin(newScreen(s)!.screens, "s1", "app:late"));
  const late = look(placed, spaceWith(["notes", "todo", "keep", "late"], [{ id: HOME, name: "", items: [...panelHome, "app:late"] }]))!;
  expect(screensOf(late, "c").map((s) => s.items.includes("app:late"))).toEqual([false, true]);

  // A panel with no screens stored shows a new app on the home screen it would seed: here too.
  let g = seed({}, "c", panelScreens(fresh), seededScreens(fresh))!;
  g = look(g, fresh)!;
  g = look(g, spaceWith(["todo"], null))!;
  expect(home(g)).toEqual([...builtins, "agent:space/assistant", "app:todo"]);

  // A layout from before the client kept the apps: the first look notes them and pins nothing.
  const old = { c: { screens: [{ id: HOME, name: "", items: ["builtin:inbox"] }], seeded: true } };
  const noted = look(old, pinnedKeep)!;
  expect(noted.c).toEqual({ ...old.c, apps: ["app:notes", "app:todo", "app:keep"] });
  // The file keeps what was noted, and Copy the Panel's Layout does not forget it.
  expect(decodeScreenFile(JSON.parse(JSON.stringify({ c: { ...f.c, awaiting: ["app:x"] } }))).c).toEqual({ ...f.c!, awaiting: ["app:x"] });
  expect(reset(f, "c", panelScreens(pinnedKeep)).c!.apps).toEqual(f.c!.apps);
});
