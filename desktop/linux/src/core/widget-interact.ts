import type { BlockAction, BlockText, CardAction, TrendBlock, WidgetBlock, WidgetViewDef } from "../../../../src/space/panel/blocks.ts";
import { type Change, blockChanges, nearestIndex, pagesOf } from "../../../../src/web/widget-rules.ts";
import { rowsThatFit } from "../../../../src/web/widget-layout.ts";
import { LOCALE } from "../../../../src/web/messages.ts";
import { type Widget, decodeWidget } from "./catalogue.ts";
import { escapeSegment } from "./url.ts";
import { fmt, rowsFor, txt } from "./widgets.ts";

/**
 * What a widget card does when it is touched (docs/app-spec.md#views-copy-and-actions), as the web
 * panel's card does (src/web/Tiles.tsx `Widget`, src/web/WidgetBlocks.tsx): views, copy, actions,
 * paging, the trend readout, the manual refresh, the value flash. The rules shared with the panel
 * come from src/web/widget-rules.ts and src/web/widget-layout.ts as they are; the GTK card
 * (app/widget-card.ts) draws what this decides.
 */

export { type Change, blockChanges, nearestIndex, pagesOf };

/**
 * Where a card is drawn. `live`: on a screen, its controls respond. `edit`: a screen in Edit
 * Layout, `preview`: the library or the matches; in both the controls are drawn and inert.
 */
export type CardMode = "live" | "edit" | "preview";

/**
 * `live`: the controls respond. `acts`: the write-back controls are drawn (a local widget: a
 * peer's has none, whatever its payload carries). `actLive`: they respond.
 */
export type Controls = { live: boolean; acts: boolean; actLive: boolean };

export function controlsOf(w: Pick<Widget, "peer">, mode: CardMode): Controls {
  const live = mode === "live";
  const acts = !w.peer;
  return { live, acts, actLive: live && acts };
}

/** The views a card switches between: only from a card that answered, and only two or more. */
export function viewsOf(w: Pick<Widget, "ok" | "views">): WidgetViewDef[] | undefined {
  return w.ok !== false && w.views && w.views.length > 1 ? w.views : undefined;
}

/** The view the reader last chose on this card, when it still has it; else its first (web `loadView`). */
export function chosenView(saved: Record<string, string> | undefined, widgetId: string, views: WidgetViewDef[] | undefined): WidgetViewDef | undefined {
  if (!views) return undefined;
  const id = saved?.[widgetId];
  return views.find((v) => v.id === id) ?? views[0];
}

/** The blocks the card shows: the chosen view's, else the payload's own. */
export function blocksOf(w: Pick<Widget, "ok" | "blocks" | "views">, view: WidgetViewDef | undefined): WidgetBlock[] | undefined {
  if (w.ok === false) return undefined;
  return view ? view.blocks : w.blocks;
}

/** The card's own controls: a local card that answered; at most one input, the buttons after it. */
export function cardActions(w: Pick<Widget, "ok" | "actions" | "peer">): { input?: CardAction; buttons: CardAction[] } {
  const all = w.ok !== false && !w.peer ? (w.actions ?? []) : [];
  const input = all.find((a) => a.kind === "input");
  return { ...(input ? { input } : {}), buttons: all.filter((a) => a.kind === "button") };
}

/** A block's write-back control, when the card draws one: a local card only. */
export function blockAction(b: WidgetBlock, c: Controls): BlockAction | undefined {
  return c.acts && b.action && (b.action.kind === "check" || b.action.kind === "button") ? b.action : undefined;
}

/** Whether the block draws a control of its own; such a block opens its link from a click, never from the control. */
export const hasControl = (b: WidgetBlock, c: Controls): boolean => !!b.copy || !!blockAction(b, c);

/** The text an input sends: trimmed, 1 to 2000 characters, else nothing. */
export function inputValue(text: string): string | undefined {
  const v = text.trim();
  return v && v.length <= 2000 ? v : undefined;
}

/** The confirmation an action asks for first, in the card; undefined when it asks none. */
export function confirmOf(a: BlockAction | CardAction, lang: string): { text: string; label: string } | undefined {
  const text = txt(a.confirm, lang);
  return text ? { text, label: txt(a.label, lang) } : undefined;
}

// ---------------------------------------------------------------- the two writes

export type WidgetAnswer = { ok: true; widget: Widget; message?: string } | { ok: false; error: string };

/** The path of a card's action or refresh (local widgets only: a peer's card never calls them). */
export const widgetPostPath = (w: Pick<Widget, "app" | "name">, what: "action" | "refresh") => `/api/widgets/${escapeSegment(w.app)}/${escapeSegment(w.name)}/${what}`;

/**
 * The Space's answer to an action or a refresh (web `postWidget`): the fresh card and its message
 * on success; any other answer, a 404 from an older Space without the route included, an error.
 */
export function decodeWidgetAnswer(status: number, body: string, lang: string): WidgetAnswer {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    j = null;
  }
  const o = j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  const widget = o && o.ok === true ? decodeWidget(o.widget) : undefined;
  if (!o || !widget) return { ok: false, error: (o && typeof o.error === "string" && o.error) || `HTTP ${status}` };
  const message = messageText(o.message, lang);
  return { ok: true, widget, ...(message ? { message } : {}) };
}

/** An action's message as the card shows it: block text in the reader's language, at most 200 characters. */
export function messageText(m: unknown, lang: string): string {
  if (typeof m === "string") return m.slice(0, 200);
  if (m && typeof m === "object" && !Array.isArray(m)) {
    const text: Record<string, string> = {};
    for (const [k, v] of Object.entries(m)) if (typeof v === "string") text[k] = v;
    return txt(text as BlockText, lang).slice(0, 200);
  }
  return "";
}

/** How long a message stays in the card: an error longer. */
export const messageMs = (kind: "error" | "info") => (kind === "error" ? 6000 : 4000);
/** How long Copied stays on a copy control. */
export const COPIED_MS = 1500;
/** How long a changed value stays marked. */
export const FLASH_MS = 1200;
/** The entrance of bars, a gauge, tanks and a counted number. */
export const ENTER_MS = 600;

// ---------------------------------------------------------------- the trend readout

type Point = { t: string; v: number | null };

/** A point's date, with the time when the series is finer than a day (WidgetBlocks.tsx `pointDate`). */
export function pointDate(t: string, lang: string): string {
  const d = new Date(t);
  const timed = t.length > 10 && !/T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/.test(t);
  const loc = LOCALE[lang as keyof typeof LOCALE] ?? LOCALE.en;
  return timed ? d.toLocaleString(loc, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(loc);
}

/** The value and date a trend shows in place of its latest while the pointer is over point `i`. */
export function readout(b: TrendBlock, i: number, lang: string): { value: string | undefined; date: string } | undefined {
  const p: Point | undefined = b.points[i];
  if (!p) return undefined;
  return { value: p.v === null ? undefined : fmt(p.v, b, lang, !!b.signed), date: pointDate(p.t, lang) };
}

// ---------------------------------------------------------------- paging

/**
 * The compact rows per page. A card in the stepless area has a fixed height: as many rows as fit
 * under its hero (`rowsThatFit`, one column on this client), the pager's room kept free when they
 * need pages. Anywhere else, and until measured, the size's table.
 */
export function rowsPerPage(size: string, fit?: { avail: number; heights: number[]; gap: number; pagerH: number }): number {
  if (!fit || !fit.heights.length) return rowsFor(size);
  return rowsThatFit(fit.avail, fit.heights, fit.gap, 1, fit.pagerH);
}

/** The page shown after a change of the rows: the same one while it still exists. */
export const clampPage = (page: number, pages: number) => Math.max(0, Math.min(page, pages - 1));

/** The page after Left or Right on the pager; it does not wrap. */
export const stepPage = (page: number, pages: number, by: number) => clampPage(page + by, pages);

// ---------------------------------------------------------------- motion

/** The ease of the entrance (ease-out cubic), 0…1. */
export const easeOut = (k: number) => 1 - (1 - Math.max(0, Math.min(1, k))) ** 3;

/** A counted number at `k` of its entrance: whole numbers count in whole steps, and it ends on the value. */
export function countUp(target: number, k: number): number {
  if (k >= 1) return target;
  const x = target * easeOut(k);
  return Number.isInteger(target) ? Math.round(x) : x;
}

/**
 * The marks a new payload of the same view puts on its blocks (`blockChanges`); none on the first
 * payload, after a view change, or when nothing measured changed.
 */
export function flashMarks(prev: { view: string; blocks?: WidgetBlock[] } | undefined, view: string, blocks: WidgetBlock[] | undefined): (Change | undefined)[] | undefined {
  if (!prev || prev.view !== view || !prev.blocks || !blocks) return undefined;
  const marks = blockChanges(prev.blocks, blocks);
  return marks.some(Boolean) ? marks : undefined;
}
