import { renderToStaticMarkup } from "react-dom/server";
import { Blocks } from "./WidgetBlocks.tsx";
import { LangContext, translate, type Lang } from "./i18n.ts";
import { previewCards } from "./widget-preview-fixtures.ts";

/** Local visual review only: fixed fixtures, no workspace, credentials or live services. */
export function previewOpacity(value: string | null): number {
  return value !== null && value.trim() && Number.isFinite(Number(value))
    ? Math.max(0, Math.min(100, Math.round(Number(value)))) : 76;
}

function Preview({ lang }: { lang: Lang }) {
  return <LangContext.Provider value={lang}>
    <main className="shell">
      <div className="preview-search">✦ <span>{translate(lang, "omni.placeholder")}</span><kbd>⌘ K</kbd></div>
      <div className="widgets">
        {previewCards.map((card) => <article key={card.title} className={`widget s${card.size ?? "1x1"}`}>
          <header className="widget-head">
            <span className="widget-ico" style={{ background: card.color, color: "#fff" }}>{card.icon}</span>
            <span className="widget-title">{card.title}</span>
            <span className="widget-asof">{translate(lang, "widget.previewSample")}</span>
          </header>
          <Blocks blocks={card.blocks} size={card.size ?? "1x1"} />
        </article>)}
      </div>
    </main>
  </LangContext.Provider>;
}

export function previewPage(url: URL): string {
  const opacity = previewOpacity(url.searchParams.get("opacity"));
  const scheme = url.searchParams.get("theme") === "light" ? "light" : "dark";
  const lang = url.searchParams.get("lang") === "zh" ? "zh" : "en";
  return `<!doctype html>
<html lang="${lang}" data-theme="${scheme}" data-backdrop="orbit">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ai-space widget preview</title>
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/preview.css">
  <style>:root { --widget-alpha: ${opacity / 100}; }</style>
</head>
<body>
  <div class="aurora" aria-hidden="true"><iframe title="Orbit" src="/orbit?theme=${scheme}"></iframe></div>
  ${renderToStaticMarkup(<Preview lang={lang} />)}
  <div class="opacity-controls">
    <label for="widget-opacity">${translate(lang, "appearance.opacity")}</label>
    <input id="widget-opacity" type="range" min="0" max="100" step="1" value="${opacity}" aria-valuetext="${opacity}%">
    <output for="widget-opacity" id="opacity-value">${opacity}%</output>
  </div>
  <script>
    const slider = document.getElementById('widget-opacity');
    slider.addEventListener('input', () => {
      const value = Number(slider.value);
      document.documentElement.style.setProperty('--widget-alpha', value / 100);
      document.getElementById('opacity-value').value = value + '%';
      slider.setAttribute('aria-valuetext', value + '%');
      const url = new URL(location.href);
      url.searchParams.set('opacity', String(value));
      history.replaceState(null, '', url);
    });
  </script>
</body>
</html>`;
}

if (import.meta.main) {
  const files: Record<string, string> = {
    "/styles.css": `${import.meta.dir}/styles.css`,
    "/preview.css": `${import.meta.dir}/widget-preview.css`,
    "/orbit": `${import.meta.dir}/public/backdrops/orbit.html`,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.WIDGET_PREVIEW_PORT ?? 18937),
    fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const file = files[url.pathname];
      if (file) return new Response(Bun.file(file));
      if (url.pathname !== "/") return new Response("Not found", { status: 404 });
      return new Response(previewPage(url), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    },
  });
  console.log(`Widget preview: ${server.url}`);
}
