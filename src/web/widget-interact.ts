import type { WidgetBlock } from "../space/panel/blocks.ts";
import type { WidgetInfo } from "./api.ts";

// What a widget card does when it is touched (docs/app-spec.md#views-copy-and-actions): the pure
// parts are here so they can be tested without a browser.

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

// ---------------------------------------------------------------- the chosen view, per widget

const VIEWS_KEY = "panel-widget-views";

function readViews(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The view the reader last chose on this widget, when it still has it; else its first. */
export function loadView(widgetId: string, ids: string[]): string | undefined {
  const saved = readViews()[widgetId];
  return saved && ids.includes(saved) ? saved : ids[0];
}

export function saveView(widgetId: string, viewId: string): void {
  try {
    localStorage.setItem(VIEWS_KEY, JSON.stringify({ ...readViews(), [widgetId]: viewId }));
  } catch {
    /* no storage: the first view on the next load */
  }
}

// ---------------------------------------------------------------- copy

/**
 * Copies text: the clipboard API where the page may use it (https, localhost), else a hidden
 * textarea and `execCommand`, which also works on a plain-http LAN address.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back below */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  ta.remove();
  active?.focus?.();
  return ok;
}

// ---------------------------------------------------------------- the two writes

export type WidgetAnswer = { ok: true; widget: WidgetInfo; message?: unknown } | { ok: false; error: string };

/** POST /api/widgets/:app/:name/action or /refresh; a network or HTTP failure is an `{ ok: false }`. */
export async function postWidget(w: Pick<WidgetInfo, "app" | "name">, what: "action" | "refresh", body?: { action: string; value?: string }): Promise<WidgetAnswer> {
  try {
    const r = await fetch(`/api/widgets/${encodeURIComponent(w.app)}/${encodeURIComponent(w.name)}/${what}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; widget?: WidgetInfo; message?: unknown } | null;
    if (!j || j.ok !== true || !j.widget) return { ok: false, error: j?.error || `HTTP ${r.status}` };
    return { ok: true, widget: j.widget, ...(j.message !== undefined ? { message: j.message } : {}) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message ?? e) };
  }
}
