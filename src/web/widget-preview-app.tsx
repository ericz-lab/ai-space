import { useEffect, useState } from "react";
import type { WidgetInfo } from "./api.ts";
import { LangContext, type Lang, translate } from "./i18n.ts";
import { DEFAULT_THEME, defaultPreferences, PRESETS, resolveTokens, type Scheme, toHex } from "./theme.ts";
import { WidgetArea } from "./WidgetArea.tsx";
import { postWidget } from "./widget-interact.ts";
import { type Align, type LayoutWrite, applyWrite } from "./widget-layout.ts";

/** The preview's accent: `accent=<hex>` (with or without `#`), else the default preset's (Aurora). */
export function previewAccent(value: string | null, scheme: Scheme): string {
  const v = value?.trim().replace(/^#?/, "#");
  return v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : toHex(DEFAULT_THEME[scheme].accent);
}

/** The variables the panel paints for an accent: theme.ts resolves its companions (on-accent, link, focus) as for an operator's override. */
export function accentVars(accent: string, scheme: Scheme): Record<string, string> {
  const t = resolveTokens({ ...defaultPreferences(scheme), overrides: { light: { accent }, dark: { accent } } }, scheme);
  return { "--accent": t.accent, "--on-accent": t.onAccent, "--link": t.link, "--focus": t.focus };
}

/** Each built-in preset's accent in this scheme, for the picker's swatches. */
export const presetAccents = (scheme: Scheme) =>
  PRESETS.map((p) => ({ name: p.name, accent: toHex(resolveTokens({ ...defaultPreferences(scheme), presetId: p.id }, scheme).accent) }));

/** What the preview page hands its client: the language, the scheme, the accent, the cards as the feed made them and the area's alignment. */
export type PreviewData = { lang: Lang; scheme: "light" | "dark"; accent: string; widgets: WidgetInfo[]; align?: Align; autoRefresh: string[]; everyMs: number };

/** The preview's layout write: the panel's route, answered from the preview server's memory. */
async function putLayout(body: unknown): Promise<boolean> {
  try {
    const r = await fetch("/api/panel/layout", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * The preview's widget area: the panel's own `WidgetArea` over the production `Widget` cards,
 * replaced in place when an action or a refresh answers, as the panel does (App.tsx). The Edit
 * toggle in the control bar turns on the area's edit mode (resize handles, reorder, the toolbar);
 * the layout is kept in the preview server's memory. Some cards refresh on a timer so the value
 * flash shows without touching anything.
 */
export function PreviewApp({ data }: { data: PreviewData }) {
  const [widgets, setWidgets] = useState(data.widgets);
  const [align, setAlign] = useState<Align>(data.align ?? "start");
  const [editing, setEditing] = useState(false);
  const replace = (next: WidgetInfo) => setWidgets((cur) => cur.map((x) => (x.id === next.id ? { ...next, size: x.size, ...(x.frame ? { frame: x.frame } : {}) } : x)));
  useEffect(() => {
    if (!data.autoRefresh.length) return;
    const h = setInterval(() => {
      if (document.hidden) return;
      for (const id of data.autoRefresh) {
        const [app, name] = id.split("/") as [string, string];
        void postWidget({ app, name }, "refresh").then((r) => r.ok && replace(r.widget));
      }
    }, data.everyMs);
    return () => clearInterval(h);
  }, [data]);
  // The control bar's Edit toggle is outside this tree (widget-preview.tsx); Escape leaves edit mode.
  useEffect(() => {
    const btn = typeof document !== "undefined" ? document.getElementById("edit-toggle") : null;
    const toggle = () => setEditing((e) => !e);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setEditing(false);
    btn?.addEventListener("click", toggle);
    document.addEventListener("keydown", esc);
    return () => {
      btn?.removeEventListener("click", toggle);
      document.removeEventListener("keydown", esc);
    };
  }, []);
  useEffect(() => {
    document.getElementById("edit-toggle")?.setAttribute("aria-pressed", String(editing));
  }, [editing]);
  const apply = (write: LayoutWrite) => {
    setWidgets((cur) => applyWrite(cur, write));
    if (write.widgetAlign) setAlign(write.widgetAlign);
  };
  const reorder = (from: number, to: number) =>
    setWidgets((cur) => {
      const next = cur.slice();
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x!);
      void putLayout({ order: { widgets: next.map((w) => w.id) } });
      return next;
    });
  return (
    <LangContext.Provider value={data.lang}>
      <main className="shell">
        <div className="preview-search">
          ✦ <span>{translate(data.lang, "omni.placeholder")}</span>
          <kbd>⌘ K</kbd>
        </div>
        <p className="preview-note">{translate(data.lang, "widget.previewSample")}</p>
        <WidgetArea
          cards={widgets.map((w) => ({ key: `widget:${w.id}`, w }))}
          align={align}
          editing={editing}
          theme={data.scheme}
          onUpdate={replace}
          onReorder={reorder}
          apply={apply}
          save={putLayout}
        />
      </main>
    </LangContext.Provider>
  );
}
