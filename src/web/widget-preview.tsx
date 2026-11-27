import { Database } from "bun:sqlite";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { parseManifest } from "../space/scheduler/manifest.ts";
import type { AppRegistry } from "../space/panel/registry.ts";
import { WidgetFeed, type WidgetView } from "../space/panel/widgets.ts";
import { LayoutStore, orderBy, withLayout } from "../space/panel/layout.ts";
import type { WidgetInfo } from "./api.ts";
import { translate } from "./i18n.ts";
import { REL_COLOR_MATH_ATTR, REL_COLOR_MATH_TEST } from "./mono-accent.ts";
import { PreviewSources, liveCards, previewCards } from "./widget-preview-fixtures.ts";
import { accentVars, type PreviewData, PreviewApp, presetAccents, previewAccent } from "./widget-preview-app.tsx";

/**
 * Local visual review only: fixed fixtures, no workspace, credentials or live services. The cards
 * are the production `Widget` component, fed by the real `WidgetFeed` (sanitizing, actions,
 * refresh) over in-memory sources, so what responds here is what responds on the panel.
 *
 *   bun src/web/widget-preview.tsx          http://127.0.0.1:18937/?theme=dark|light&lang=en|zh&opacity=0-100&style=mono|default&accent=<hex>
 *
 * The cards sit in the panel's widget area (WidgetArea.tsx); the control bar's Edit button turns on
 * its edit mode. The layout (frames, alignment, order) lives in this process's memory behind the
 * panel's own `GET`/`PUT /api/panel/layout`, validated by the real `LayoutStore`, so it survives a
 * reload and not a restart.
 */
export function previewOpacity(value: string | null): number {
  return value !== null && value.trim() && Number.isFinite(Number(value))
    ? Math.max(0, Math.min(100, Math.round(Number(value)))) : 76;
}

/** The card style the preview opens in: `data-widget-style` on <html> (styles.css, "Mono widget style"); mono unless asked otherwise. */
export function previewStyle(value: string | null): "mono" | "default" {
  return value === "default" ? "default" : "mono";
}

const HOST = "http://preview.invalid";
/** The market board refreshes itself every 5 s, so its values change and flash. */
const AUTO_REFRESH = ["market/watchlist"];
const AUTO_EVERY_MS = 5_000;
/** One static card stands for a peer's: plain as-of text, no write-back controls. */
const PEER_CARD = "news-radar-topics";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

type Icon = { text: string; color: string };

/** The preview's apps, their widget feed and the icons the cards show. */
export function previewFeed(sources = new PreviewSources()): { feed: WidgetFeed; icons: Map<string, Icon>; peerOf: Map<string, string> } {
  const icons = new Map<string, Icon>();
  const statics = new Map<string, unknown>();
  const manifests = [];
  const asOf = new Date(Date.now() - 7 * 60_000).toISOString();
  for (const c of liveCards) {
    icons.set(c.app, { text: c.icon, color: c.color });
    manifests.push(parseManifest(`name: ${c.app}\nicon: icon.svg\nwidgets:\n  - { name: ${c.name}, title: "${c.title}", source: "${HOST}/${c.app}/${c.name}", size: ${c.size} }\n`, `/preview/${c.app}`));
  }
  for (const c of previewCards) {
    const app = slug(c.title);
    icons.set(app, { text: c.icon, color: c.color });
    statics.set(app, { ok: true, items: [], blocks: c.blocks, asOf });
    manifests.push(parseManifest(`name: ${app}\nicon: icon.svg\nwidgets:\n  - { name: card, title: "${c.title}", source: "${HOST}/${app}/card", size: ${c.size ?? "1x1"} }\n`, `/preview/${app}`));
  }
  const entries = manifests.map((manifest) => ({ manifest, manifestOnly: false, registeredAt: 0 }));
  const registry = { list: () => entries, get: (app: string) => entries.find((e) => e.manifest.app === app) } as unknown as AppRegistry;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const [, app = "", name = ""] = new URL(String(input)).pathname.split("/");
    const fixed = statics.get(app);
    if (fixed) return init?.method === "POST" ? Response.json({ ok: false, error: "unknown action" }) : Response.json(fixed);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    return Response.json(sources.handle(app, name, init?.method ?? "GET", body));
  }) as typeof globalThis.fetch;
  return { feed: new WidgetFeed(registry, { fetch }), icons, peerOf: new Map([[PEER_CARD, "david"]]) };
}

/**
 * The feed's cards as the panel lists them: the peer card gets its peer's id and loses any action, as
 * merge.ts does; the layout's order, sizes and frames apply as in GET /api/widgets.
 */
async function previewWidgets(p: ReturnType<typeof previewFeed>, layout?: LayoutStore): Promise<WidgetInfo[]> {
  const all = (await p.feed.all()).map((w) => asPeer(w, p.peerOf.get(w.app)));
  if (!layout) return all as unknown as WidgetInfo[];
  const lay = layout.read();
  const shown = all.map((w) => withLayout(lay, w));
  // Until a card is moved the feed's order stands (orderBy alone would sort the rest by name).
  return (lay.order.widgets.length ? orderBy(shown, lay.order.widgets, (w) => w.id) : shown) as unknown as WidgetInfo[];
}

function asPeer(w: WidgetView, peer: string | undefined): WidgetView {
  if (!peer) return w;
  const { actions: _, ...rest } = w as WidgetView & { actions?: unknown };
  return { ...(rest as WidgetView), id: `${peer}/${w.id}`, peer };
}

export async function previewPage(url: URL, preview = previewFeed(), layout?: LayoutStore): Promise<string> {
  const opacity = previewOpacity(url.searchParams.get("opacity"));
  const scheme = url.searchParams.get("theme") === "light" ? "light" : "dark";
  const lang = url.searchParams.get("lang") === "zh" ? "zh" : "en";
  const style = previewStyle(url.searchParams.get("style"));
  const accent = previewAccent(url.searchParams.get("accent"), scheme);
  // Painted inline on <html> from the start, as the panel's boot script does, so nothing flashes.
  const accentStyle = Object.entries(accentVars(accent, scheme)).map(([k, v]) => `${k}: ${v}`).join("; ");
  const swatches = presetAccents(scheme)
    .map((p) => `<button type="button" data-accent="${p.accent}" aria-pressed="${p.accent === accent}" aria-label="${p.name}" title="${p.name} ${p.accent}" style="--swatch: ${p.accent}"></button>`)
    .join("");
  const data: PreviewData = { lang, scheme, accent, widgets: await previewWidgets(preview, layout), align: layout?.read().widgetAlign ?? "start", autoRefresh: AUTO_REFRESH, everyMs: AUTO_EVERY_MS };
  // JSON inside a script element: `<` is escaped so no text can close the element.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="${lang}" data-theme="${scheme}" data-backdrop="orbit" data-preview="${url.searchParams.get("appearance") === "production" ? "production" : "custom"}"${style === "mono" ? ' data-widget-style="mono"' : ""} style="${accentStyle}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ai-space widget preview</title>
  <script>${relColorMathScript()}</script>
  <link rel="stylesheet" href="/styles.css">
  <link rel="stylesheet" href="/preview.css">
  <style>:root { --widget-alpha: ${opacity / 100}; }</style>
</head>
<body>
  <div class="aurora" aria-hidden="true"><iframe title="Orbit" src="/orbit?theme=${scheme}"></iframe></div>
  <div id="preview-root">${renderToStaticMarkup(<PreviewApp data={data} />)}</div>
  <div class="opacity-controls">
    <div class="style-switch" role="group" aria-label="Card style">
      <button type="button" data-style="mono" aria-pressed="${style === "mono"}">Mono</button>
      <button type="button" data-style="default" aria-pressed="${style === "default"}">Default</button>
    </div>
    <div class="accent-pick" role="group" aria-label="Accent">${swatches}<input type="color" value="${accent}" aria-label="Custom accent" title="Custom accent"></div>
    <span class="opacity-group">
      <label for="widget-opacity">${translate(lang, "appearance.opacity")}</label>
      <input id="widget-opacity" type="range" min="0" max="100" step="1" value="${opacity}" aria-valuetext="${opacity}%">
      <output for="widget-opacity" id="opacity-value">${opacity}%</output>
    </span>
    <button type="button" id="edit-toggle" aria-pressed="false">${translate(lang, "layout.edit")}</button>
  </div>
  <script type="application/json" id="preview-data">${json}</script>
  <script type="module" src="/preview.js"></script>
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
    // The card style flips live: mono cards are opaque on a flat board, so the opacity slider is off there.
    const syncStyle = () => {
      const mono = document.documentElement.dataset.widgetStyle === 'mono';
      for (const b of document.querySelectorAll('.style-switch button')) b.setAttribute('aria-pressed', String((b.dataset.style === 'mono') === mono));
      slider.disabled = mono;
    };
    for (const b of document.querySelectorAll('.style-switch button')) b.addEventListener('click', () => {
      if (b.dataset.style === 'mono') document.documentElement.dataset.widgetStyle = 'mono';
      else delete document.documentElement.dataset.widgetStyle;
      syncStyle();
      const url = new URL(location.href);
      url.searchParams.set('style', b.dataset.style);
      history.replaceState(null, '', url);
    });
    syncStyle();
  </script>
</body>
</html>`;
}

/**
 * markRelColorMath (mono-accent.ts) as an inline script, run in <head> before the stylesheets so
 * the mark on a mono accent fill never flashes; the same attribute and test string.
 */
export function relColorMathScript(): string {
  const { property, value } = REL_COLOR_MATH_TEST;
  return `if (window.CSS && CSS.supports && CSS.supports(${JSON.stringify(property)}, ${JSON.stringify(value)})) document.documentElement.setAttribute(${JSON.stringify(REL_COLOR_MATH_ATTR)}, '');`;
}

/** A rounded square in the card's colour with its short text, as the preview's app icons. */
function iconSvg(icon: Icon): string {
  const esc = icon.text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const size = [...icon.text].length > 1 ? 26 : 36;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${icon.color}"/><text x="32" y="33" font-family="system-ui,sans-serif" font-size="${size}" font-weight="600" fill="#fff" text-anchor="middle" dominant-baseline="central">${esc}</text></svg>`;
}

/** The preview's client script, bundled once at start. */
async function bundleClient(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "widget-preview-client.tsx")],
    target: "browser",
    format: "esm",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!result.success) throw new Error(`preview client build failed: ${result.logs.map((l) => l.message).join("; ")}`);
  return result.outputs[0]!.text();
}

if (import.meta.main) {
  const files: Record<string, string> = {
    "/styles.css": `${import.meta.dir}/styles.css`,
    "/preview.css": `${import.meta.dir}/widget-preview.css`,
    "/orbit": `${import.meta.dir}/public/backdrops/orbit.html`,
  };
  const js = await bundleClient();
  const preview = previewFeed();
  const layout = new LayoutStore(new Database(":memory:"));
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  // The answers of the panel's routes (src/space/panel/api.ts), over the same feed.
  const answer = (r: Awaited<ReturnType<WidgetFeed["act"]>>, lay: LayoutStore) => (r.ok ? json({ ok: true, widget: withLayout(lay.read(), r.widget), ...(r.message !== undefined ? { message: r.message } : {}) }) : json({ ok: false, error: r.error }, r.status));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env.WIDGET_PREVIEW_PORT ?? 18937),
    routes: {
      "/api/widgets": { GET: async () => json({ ok: true, widgets: await previewWidgets(preview, layout) }) },
      "/api/panel/layout": {
        GET: () => json({ ok: true, layout: layout.read() }),
        PUT: async (req) => {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object") return json({ ok: false, error: "body must be a JSON object" }, 400);
          try {
            return json({ ok: true, layout: layout.update(body) });
          } catch (e) {
            return json({ ok: false, error: (e as Error).message }, 400);
          }
        },
      },
      "/api/widgets/:app/:name/action": {
        POST: async (req) => {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!body || typeof body !== "object") return json({ ok: false, error: "body must be { action, value? }" }, 400);
          // A slow app, so the sending state can be seen.
          await Bun.sleep(350);
          return answer(await preview.feed.act(req.params.app, req.params.name, body), layout);
        },
      },
      "/api/widgets/:app/:name/refresh": {
        POST: async (req) => {
          await Bun.sleep(250);
          return answer(await preview.feed.refresh(req.params.app, req.params.name), layout);
        },
      },
      "/api/apps/:app/icon": (req) => {
        const icon = preview.icons.get(req.params.app);
        return icon ? new Response(iconSvg(icon), { headers: { "content-type": "image/svg+xml" } }) : new Response("Not found", { status: 404 });
      },
      "/preview.js": () => new Response(js, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } }),
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const file = files[url.pathname];
      if (file) return new Response(Bun.file(file));
      if (url.pathname !== "/") return new Response("Not found", { status: 404 });
      return new Response(await previewPage(url, preview, layout), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    },
  });
  console.log(`Widget preview: ${server.url}`);
}
