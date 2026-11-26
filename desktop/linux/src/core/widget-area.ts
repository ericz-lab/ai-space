import {
  type Align,
  type Box,
  type Edge,
  type Frame,
  type Guides,
  type LayoutWrite,
  GAP,
  ONE_COLUMN_BELOW,
  alignTwelfths,
  applyWrite,
  framesWrite,
  keyStep,
  nudge,
  place,
  resizeTo,
  resolveFrames,
  sizeClass,
  splitEvenly,
  startResize,
} from "../../../../src/web/widget-layout.ts";

/**
 * A screen's widget area on Linux, laid out as the web panel's (src/web/WidgetArea.tsx,
 * docs/panel.md#resize-a-widget). The maths is the panel's own module, src/web/widget-layout.ts,
 * imported as it is (it uses no browser global, so it runs under GJS too): this file adds only what
 * the GTK area needs around it, where its handles are, the toolbar's writes, the save's fallback.
 */

export type { Align, Box, Edge, Frame, Guides, LayoutWrite };
export { GAP, alignTwelfths, applyWrite, framesWrite, keyStep, nudge, place, resizeTo, resolveFrames, sizeClass, splitEvenly, startResize };

/** A card of the area as the layout knows it: its widget id, stored size and frame. */
export type AreaCard = { id: string; size: string; frame?: Frame };

/** Home's pages leave 16px on either side of the area (app/home.ts). */
export const PAGE_MARGIN = 16;

/**
 * Below the panel's 700px breakpoint the area is one column of cards sized by their content, as
 * before; it is a width of the window there, so an area this narrow stands for it here.
 */
export const oneColumn = (W: number) => W + 2 * PAGE_MARGIN <= ONE_COLUMN_BELOW;

/** How far a handle reaches each side of the edge it moves, and the corner's square. */
export const HANDLE = 6;
export const CORNER = 14;

/** Where card `b`'s three handles are, in the area's coordinates: the right edge, the bottom edge, the corner. */
export function handleRects(b: Box): Record<Edge, { x: number; y: number; width: number; height: number }> {
  return {
    x: { x: b.x + b.width - HANDLE, y: b.y, width: 2 * HANDLE, height: Math.max(0, b.height - CORNER) },
    y: { x: b.x, y: b.y + b.height - HANDLE, width: Math.max(0, b.width - CORNER), height: 2 * HANDLE },
    xy: { x: b.x + b.width - CORNER, y: b.y + b.height - CORNER, width: CORNER + HANDLE, height: CORNER + HANDLE },
  };
}

/** The handle under a point of the area, the corner first; null off every handle. */
export function handleAt(boxes: Box[], x: number, y: number): { i: number; edge: Edge } | null {
  const inside = (r: { x: number; y: number; width: number; height: number }) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
  for (const edge of ["xy", "x", "y"] as const) for (let i = 0; i < boxes.length; i++) if (inside(handleRects(boxes[i]!)[edge])) return { i, edge };
  return null;
}

/** The toolbar's operations (WidgetArea.tsx), each one write over the area's cards with the one that undoes it. */
export type ToolbarOp = "align" | "center" | "split" | "reset";

export function toolbarWrite(op: ToolbarOp, cards: AreaCard[], frames: Frame[], W: number, align: Align): { write: LayoutWrite; undo: LayoutWrite } | null {
  switch (op) {
    case "align":
      return framesWrite(cards, frames, alignTwelfths(frames, W));
    case "split":
      return framesWrite(cards, frames, splitEvenly(frames));
    case "center":
      return { write: { widgetAlign: align === "center" ? "start" : "center" }, undo: { widgetAlign: align } };
    case "reset": {
      const framed = cards.filter((c) => c.frame);
      if (!framed.length) return null;
      return {
        write: { frames: Object.fromEntries(framed.map((c) => [c.id, null])) },
        undo: { frames: Object.fromEntries(framed.map((c) => [c.id, c.frame!])), sizes: Object.fromEntries(framed.map((c) => [c.id, c.size])) },
      };
    }
  }
}

/** Reset is offered while a card of the area has a frame of its own. */
export const canReset = (cards: AreaCard[]) => cards.some((c) => c.frame);

/** How long the last action can be undone, and the save's error stays. */
export const UNDO_MS = 8000;
export const ERROR_MS = 6000;
/** A keyboard resize is saved once the keys rest this long (or the handle loses focus). */
export const KEYS_REST_MS = 700;
/** Toolbar actions and undos move the cards over this long (not under reduced motion). */
export const TWEEN_MS = 240;

/**
 * The same write for a Space that turned `frames` down (an older one, which rejects unknown keys):
 * only its classic sizes, which every Space keeps. Null when the write carries no size.
 */
export function sizesOnly(write: LayoutWrite): LayoutWrite | null {
  return write.sizes && Object.keys(write.sizes).length ? { sizes: write.sizes } : null;
}

/** Whether the layout's PUT was taken: a 2xx with `ok: true`; else the reason, for the log. */
export function layoutSaved(status: number, body: string): { ok: true } | { ok: false; error: string; rejected: boolean } {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    j = null;
  }
  const o = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  if (status >= 200 && status < 300 && o?.ok === true) return { ok: true };
  // A 400 names a patch the Space does not take (an older one's unknown keys), not a failure to reach it.
  return { ok: false, error: (o && typeof o.error === "string" && o.error) || `HTTP ${status}`, rejected: status === 400 };
}

/**
 * The rows a card of fixed height has under its hero: its height less the card's padding, the
 * parts above and below the blocks (head, views, footer: `parts`, their natural heights), the
 * card's spacing between them, the hero and the space under it.
 */
export function roomUnderHero(height: number, o: { padding: number; spacing: number; parts: number[]; hero: number; heroGap: number }): number {
  const parts = o.parts.filter((h) => h > 0);
  return Math.max(0, height - o.padding - parts.reduce((a, b) => a + b, 0) - o.spacing * parts.length - o.hero - o.heroGap);
}

/** A box `k` of the way (eased) from `a` to `b`. */
export function tween(a: Box, b: Box, k: number): Box {
  const e = 1 - (1 - Math.max(0, Math.min(1, k))) ** 3;
  const mix = (p: number, q: number) => Math.round(p + (q - p) * e);
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), width: mix(a.width, b.width), height: mix(a.height, b.height), row: b.row };
}

/**
 * Where every card goes in an area `W` wide: stepless boxes, or (one column) every card the full
 * width with its own height, `GAP` apart. `heightAt` gives a card's natural height at a width.
 */
export function arrange(frames: Frame[], W: number, align: Align, heightAt: (i: number, width: number) => number): { boxes: Box[]; height: number; free: boolean } {
  if (!oneColumn(W)) {
    const p = place(frames, W, align);
    return { boxes: p.boxes, height: p.height, free: true };
  }
  let y = 0;
  const boxes = frames.map((_, i) => {
    const height = Math.max(0, Math.round(heightAt(i, W)));
    const b = { x: 0, y, width: W, height, row: i };
    y += height + GAP;
    return b;
  });
  return { boxes, height: Math.max(0, y - GAP), free: false };
}

/** The size readout in a card's head while the layout is edited (`W × H`). */
export const readoutOf = (b: Box) => `${Math.round(b.width)} × ${Math.round(b.height)}`;
