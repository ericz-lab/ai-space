import { useEffect, useState } from "react";
import type { WidgetInfo } from "./api.ts";
import { LangContext, type Lang, translate } from "./i18n.ts";
import { Widget } from "./Tiles.tsx";
import { postWidget } from "./widget-interact.ts";

/** What the preview page hands its client: the language, the scheme and the cards as the feed made them. */
export type PreviewData = { lang: Lang; scheme: "light" | "dark"; widgets: WidgetInfo[]; autoRefresh: string[]; everyMs: number };

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
