import type { WidgetInfo } from "./api.ts";

// What a widget card does when it is touched (docs/app-spec.md#views-copy-and-actions). The rules
// that need no browser live in widget-rules.ts, shared with the Linux client; the rest is here.

export { type Change, blockChanges, nearestIndex, pagesOf, swipePage } from "./widget-rules.ts";

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
