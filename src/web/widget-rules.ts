import type { WidgetBlock } from "../space/panel/blocks.ts";

// The pure rules of a widget card's interactions (docs/app-spec.md#views-copy-and-actions): no DOM,
// no browser globals, so the panel (widget-interact.ts re-exports them) and the Linux client
// (desktop/linux/src/core/widget-interact.ts, run by GJS) share one copy.

/** The point of a spark under the pointer: each point owns a slot of equal width, as the svg draws it. */
export function nearestIndex(x: number, width: number, n: number): number {
  if (n <= 0 || width <= 0) return -1;
  // The svg is at least two slots wide (one point alone sits in the first slot).
  const slots = Math.max(n, 2);
  return Math.max(0, Math.min(n - 1, Math.floor((x / width) * slots)));
}

/** Rows split into pages of `per`; a single page when they fit. */
export function pagesOf<T>(rows: T[], per: number): T[][] {
  if (per <= 0 || rows.length <= per) return [rows];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += per) out.push(rows.slice(i, i + per));
  return out;
}

export type Change = "up" | "down" | "text";

/** The value a block's change is measured on: a number, else its text (status), else nothing. */
function valueOf(b: WidgetBlock): number | string | null | undefined {
  switch (b.type) {
    case "metric":
    case "progress":
    case "gauge":
      return b.value;
    case "trend":
      return b.points.findLast((p) => p.v !== null)?.v ?? null;
    case "status":
      return JSON.stringify(b.value);
    case "tanks":
      return undefined;
  }
}

/**
 * How each block of `next` changed from the block at the same place in `prev`, when both have the
 * same type and label (the same thing measured): up or down for a number, `text` for anything else.
 */
export function blockChanges(prev: WidgetBlock[] | undefined, next: WidgetBlock[]): (Change | undefined)[] {
  return next.map((b, i) => {
    const a = prev?.[i];
    if (!a || a.type !== b.type || JSON.stringify(a.label) !== JSON.stringify(b.label)) return undefined;
    const x = valueOf(a);
    const y = valueOf(b);
    if (x === undefined || y === undefined || x === y) return undefined;
    if (typeof x === "number" && typeof y === "number") return y > x ? "up" : "down";
    return "text";
  });
}

/** The page to show after a horizontal swipe of `dx` pixels (`dy` vertical), or the same page. */
export function swipePage(page: number, pages: number, dx: number, dy: number): number {
  if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return page;
  return Math.max(0, Math.min(pages - 1, page + (dx < 0 ? 1 : -1)));
}
