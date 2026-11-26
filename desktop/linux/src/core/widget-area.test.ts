import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as web from "../../../../src/web/widget-layout.ts";
import { decodeCatalogue } from "./catalogue.ts";
import {
  type AreaCard,
  type Frame,
  GAP,
  arrange,
  canReset,
  handleAt,
  handleRects,
  layoutSaved,
  oneColumn,
  place,
  readoutOf,
  resizeTo,
  roomUnderHero,
  sizesOnly,
  startResize,
  toolbarWrite,
  tween,
} from "./widget-area.ts";

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("the layout maths is the panel's own", () => {
  test("the same functions and constants, not a copy (src/web/widget-layout.ts)", async () => {
    const mine = await import("./widget-area.ts");
    for (const name of ["alignTwelfths", "framesWrite", "keyStep", "nudge", "place", "resizeTo", "resolveFrames", "sizeClass", "splitEvenly", "startResize"] as const) expect(mine[name]).toBe(web[name]);
    // The brief's numbers, so a change to them is a change on every client.
    expect([web.GAP, web.MIN_W, web.MIN_H, web.MAX_H, web.ROW_H, web.WIDE_AT, web.TALL_AT, web.HYSTERESIS, web.SNAP_PX, web.ONE_COLUMN_BELOW]).toEqual([20, 200, 140, 900, 300, 560, 480, 16, 8, 700]);
    expect(web.defaultFrame("1x2", 1100).h).toBe(620);
  });

  test("what the client bundles of it uses no global GJS lacks", async () => {
    const banned = /\blocalStorage\b|\bsessionStorage\b|(?<![.\w])document\.|(?<![.\w])window\.|(?<![.\w])navigator\.|\bmatchMedia\(|\brequestAnimationFrame\(|\bResizeObserver\b|(?<![.\w])fetch\(|\bnew URL\(|\bURLSearchParams\b|\bAbortController\b|\bAbortSignal\b|\bstructuredClone\(|\bqueueMicrotask\(|(?<![.\w])setTimeout\(|(?<![.\w])setInterval\(|\bperformance\.now/;
    for (const entry of ["widget-area.ts", "widget-interact.ts"]) {
      const r = await Bun.build({ entrypoints: [join(import.meta.dir, entry)], target: "browser", format: "esm" });
      expect(r.success).toBe(true);
      const bad = (await r.outputs[0]!.text()).split("\n").filter((l) => banned.test(l));
      expect(bad).toEqual([]);
    }
  });
});

describe("the area", () => {
  test("one column below the panel's breakpoint, the page's margins counted", () => {
    expect(oneColumn(700 - 32)).toBe(true);
    expect(oneColumn(700 - 31)).toBe(false);
  });

  test("stepless boxes, or every card full width with its own height", () => {
    const frames: Frame[] = [{ w: 0.5, h: 300 }, { w: 0.5, h: 200 }];
    const wide = arrange(frames, 1000, "start", () => 999);
    expect(wide.free).toBe(true);
    expect(wide.boxes).toEqual(place(frames, 1000, "start").boxes);
    const narrow = arrange(frames, 500, "start", (i) => [120, 80.4][i]!);
    expect(narrow.free).toBe(false);
    expect(narrow.boxes.map((b) => [b.x, b.y, b.width, b.height])).toEqual([[0, 0, 500, 120], [0, 120 + GAP, 500, 80]]);
    expect(narrow.height).toBe(120 + GAP + 80);
  });

  test("the handle under the pointer: the corner wins where the edges meet", () => {
    const b = { x: 0, y: 0, width: 400, height: 300, row: 0 };
    const r = handleRects(b);
    expect(handleAt([b], r.x.x + 1, 100)).toEqual({ i: 0, edge: "x" });
    expect(handleAt([b], 100, r.y.y + 1)).toEqual({ i: 0, edge: "y" });
    expect(handleAt([b], 399, 299)).toEqual({ i: 0, edge: "xy" });
    expect(handleAt([b], 200, 150)).toBeNull();
    // The right handle reaches into the gap, where the next card's own handles are not.
    const next = { x: 420, y: 0, width: 400, height: 300, row: 0 };
    expect(handleAt([b, next], 404, 100)).toEqual({ i: 0, edge: "x" });
  });

  test("a drag from the area's press, through the shared maths", () => {
    const frames: Frame[] = [{ w: 0.5, h: 300 }, { w: 0.5, h: 300 }];
    const r = resizeTo(startResize(frames, 1000, "start", 0, "xy"), 40, 60, { free: true });
    near(r.frames[0]!.w + r.frames[1]!.w, 1);
    expect(r.frames[1]!.h).toBe(360);
    expect(readoutOf(place(r.frames, 1000, "start").boxes[0]!)).toBe("530 × 360");
  });
});

describe("the toolbar", () => {
  const cards: AreaCard[] = [
    { id: "a/x", size: "1x1", frame: { w: 0.41, h: 300 } },
    { id: "a/y", size: "1x1" },
  ];
  const W = 1100;
  const frames = web.resolveFrames(cards, W);

  test("Align and Split write only the frames that change, with their nearest sizes and the undo", () => {
    const a = toolbarWrite("align", cards, frames, W, "start")!;
    expect(a.write.frames!["a/x"]!.w).toBeCloseTo(5 / 12, 6);
    expect(a.write.sizes!["a/x"]).toBe("1x1");
    expect(a.undo.frames!["a/x"]).toEqual({ w: 0.41, h: 300 });
    const s = toolbarWrite("split", cards, frames, W, "start")!;
    expect(Object.keys(s.write.frames!)).toContain("a/x");
    expect(s.undo.frames!["a/y"]).toBeNull();
  });

  test("Center toggles the alignment; Reset removes the frames and gives back size and frame on undo", () => {
    expect(toolbarWrite("center", cards, frames, W, "start")).toEqual({ write: { widgetAlign: "center" }, undo: { widgetAlign: "start" } });
    expect(toolbarWrite("center", cards, frames, W, "center")!.write).toEqual({ widgetAlign: "start" });
    expect(toolbarWrite("reset", cards, frames, W, "start")).toEqual({ write: { frames: { "a/x": null } }, undo: { frames: { "a/x": { w: 0.41, h: 300 } }, sizes: { "a/x": "1x1" } } });
    expect(canReset(cards)).toBe(true);
    expect(toolbarWrite("reset", [cards[1]!], frames, W, "start")).toBeNull();
    expect(canReset([cards[1]!])).toBe(false);
  });
});

describe("saving", () => {
  test("the PUT's answer: taken, refused as a patch the Space does not know, or not reached", () => {
    expect(layoutSaved(200, '{"ok":true,"layout":{}}')).toEqual({ ok: true });
    expect(layoutSaved(400, '{"ok":false,"error":"unknown key frames"}')).toEqual({ ok: false, error: "unknown key frames", rejected: true });
    expect(layoutSaved(502, "bad gateway")).toEqual({ ok: false, error: "HTTP 502", rejected: false });
  });

  test("an older Space that turns frames down gets the sizes alone; a write with none has no fallback", () => {
    expect(sizesOnly({ frames: { "a/x": { w: 0.5, h: 300 } }, sizes: { "a/x": "1x1" } })).toEqual({ sizes: { "a/x": "1x1" } });
    expect(sizesOnly({ widgetAlign: "center" })).toBeNull();
    expect(sizesOnly({ frames: { "a/x": null } })).toBeNull();
  });

  test("a Space keeps frames when its layout says so; an older one draws its cards as before", () => {
    const base = { apps: { apps: [] }, agents: { agents: [] }, widgets: { widgets: [{ id: "a/x", app: "a", name: "x", title: "X", size: "1x1", frame: { w: 0.5, h: 300 } }, { id: "a/y", app: "a", name: "y", title: "Y", frame: { w: "wide" } }] } };
    const now = decodeCatalogue({ ...base, layout: { ok: true, layout: { frames: {}, widgetAlign: "center" } } });
    expect(now.stepless).toBe(true);
    expect(now.widgetAlign).toBe("center");
    expect(now.widgets[0]!.frame).toEqual({ w: 0.5, h: 300 });
    expect(now.widgets[1]!.frame).toBeUndefined();
    const old = decodeCatalogue({ ...base, layout: { ok: true, layout: { sizes: {} } } });
    expect(old.stepless).toBe(false);
    expect(old.widgetAlign).toBe("start");
  });
});

describe("inside a card", () => {
  test("the room under the hero, from the card's height and its parts", () => {
    expect(roomUnderHero(300, { padding: 22, spacing: 8, parts: [36, 0, 30], hero: 90, heroGap: 10 })).toBe(300 - 22 - 66 - 16 - 90 - 10);
    expect(roomUnderHero(100, { padding: 22, spacing: 8, parts: [36], hero: 90, heroGap: 10 })).toBe(0);
  });

  test("a move eases from the old box to the new one and ends on it", () => {
    const a = { x: 0, y: 0, width: 100, height: 100, row: 0 };
    const b = { x: 100, y: 50, width: 200, height: 100, row: 1 };
    expect(tween(a, b, 0)).toEqual({ ...a, row: 1 });
    expect(tween(a, b, 1)).toEqual(b);
    expect(tween(a, b, 0.5).x).toBeGreaterThan(50);
  });
});
