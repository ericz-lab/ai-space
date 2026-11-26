import { useEffect, useState } from "react";
import type { WidgetInfo } from "./api.ts";
import { LangContext, type Lang, translate } from "./i18n.ts";
import { DEFAULT_THEME, defaultPreferences, PRESETS, resolveTokens, type Scheme, toHex } from "./theme.ts";
import { Widget } from "./Tiles.tsx";
import { postWidget } from "./widget-interact.ts";

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

/** What the preview page hands its client: the language, the scheme and the cards as the feed made them. */
export type PreviewData = { lang: Lang; scheme: "light" | "dark"; accent: string; widgets: WidgetInfo[]; autoRefresh: string[]; everyMs: number };

/**
 * The preview's grid: the production `Widget` card over each fixture, replaced in place when an
 * action or a refresh answers, as the panel does (App.tsx). Some cards refresh on a timer so the
 * value flash shows without touching anything.
 */
export function PreviewApp({ data }: { data: PreviewData }) {
  const [widgets, setWidgets] = useState(data.widgets);
  const replace = (next: WidgetInfo) => setWidgets((cur) => cur.map((x) => (x.id === next.id ? { ...next, size: x.size } : x)));
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
  return (
    <LangContext.Provider value={data.lang}>
      <main className="shell">
        <div className="preview-search">
          ✦ <span>{translate(data.lang, "omni.placeholder")}</span>
          <kbd>⌘ K</kbd>
        </div>
        <p className="preview-note">{translate(data.lang, "widget.previewSample")}</p>
        <div className="widgets">
          {widgets.map((w) => (
            <Widget key={w.id} w={w} theme={data.scheme} onUpdate={replace} />
          ))}
        </div>
      </main>
    </LangContext.Provider>
  );
}
