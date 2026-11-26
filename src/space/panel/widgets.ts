import type { Manifest, ManifestWidget } from "../scheduler/manifest.ts";
import { iconUrl, resolveLink, type ViewI18n, widgetI18n } from "./view.ts";
import type { AppRegistry } from "./registry.ts";
import { type CardAction, MAX_ACTION_VALUE, type WidgetBlock, type WidgetViewDef, declaredActions, dedupeActionIds, sanitizeActions, sanitizeBlocks, sanitizeViews } from "./blocks.ts";

/**
 * An embed widget's page is the app's HTML served from the panel's origin. The panel frames it with
 * `sandbox="allow-scripts"`; the same sandbox as a header keeps its scripts off the panel's origin when
 * the address is opened directly, or framed without the attribute.
 */
export const EMBED_HEADERS = { "content-security-policy": "sandbox allow-scripts", "x-content-type-options": "nosniff" } as const;

/**
 * Widget feed: fetches every declared `kind: items` widget (its list and, when sent, its blocks) through ai-space,
 * caches each for its `refresh`, and only ever calls URLs a manifest declares.
 * Sources may be loopback addresses; they never reach the browser. A failing
 * source is reported as `{ ok: false, error }` and shown as is, never invented.
 */

export type WidgetItem = { text: string; url: string; time: string };

/** A successful payload: the list, and the blocks of a state card when the app sends them. */
export type WidgetData = { ok: true; items: WidgetItem[]; blocks?: WidgetBlock[]; views?: WidgetViewDef[]; actions?: CardAction[]; asOf?: string; staleAfterMs?: number };
type WidgetResult = WidgetData | { ok: false; error: string };

/** What `act` and `refresh` answer: the fresh card, or the HTTP status and error the panel shows. */
export type WidgetActResult = { ok: true; widget: WidgetView; message?: unknown } | { ok: false; status: number; error: string };

/** The header ai-space sets on an action it forwards, so the app's source can tell it from a read. */
export const ACTION_HEADER = "x-space-widget-action";

export type WidgetView = {
  /** `<app>/<name>`, or `<peer>/<app>/<name>` for a widget on a peer. */
  id: string;
  peer?: string;
  /** True when the payload is the last one seen from a peer that is not answering. */
  stale?: boolean;
  app: string;
  name: string;
  title: string;
  i18n?: ViewI18n;
  icon: string;
  link: string;
  kind: "items" | "embed";
  size: ManifestWidget["size"];
  refreshMs: number;
} & WidgetResult;

const MAX_ITEMS = 20;
const ERROR_RETRY_MS = 30_000;

export class WidgetFeed {
  private readonly cache = new Map<string, { at: number; data: WidgetResult }>();

  constructor(
    private readonly registry: AppRegistry,
    private readonly opts: { fetch?: typeof fetch; timeoutMs?: number; appFetch?: (app: string, path: string, init: RequestInit) => Promise<Response> } = {},
  ) {}

  /** Every widget of every visible app, in registry order (the API applies the layout order). */
  async all(): Promise<WidgetView[]> {
    const out: Promise<WidgetView>[] = [];
    for (const { manifest } of this.registry.list()) {
      if (manifest.status === "archived") continue;
      for (const w of manifest.widgets) out.push(this.one(manifest, w));
    }
    return Promise.all(out);
  }

  async one(m: Manifest, w: ManifestWidget): Promise<WidgetView> {
    const id = `${m.app}/${w.name}`;
    const base = {
      id,
      app: m.app,
      name: w.name,
      title: w.title ?? m.title ?? m.app,
      ...widgetI18n(m, w),
      icon: iconUrl(m),
      link: resolveLink(m, w.link),
      kind: w.kind,
      size: w.size,
      refreshMs: w.refreshMs,
    };
    if (w.kind === "embed") return { ...base, ok: true, items: [] };
    const hit = this.cache.get(id);
    // A failure is retried sooner than a payload is refreshed: a source restarting for a deploy
    // should not leave the card on its error for a whole `refresh`.
    const ttl = hit?.data.ok === false ? Math.min(w.refreshMs, ERROR_RETRY_MS) : w.refreshMs;
    if (hit && Date.now() - hit.at < ttl) return { ...base, ...hit.data };
    const data = await this.fetchItems(m, w);
    this.cache.set(id, { at: Date.now(), data });
    return { ...base, ...data };
  }

  /** Forgets a widget's cached payload: the next read fetches the source. */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** The `items` widget of an active app, or undefined. */
  private find(app: string, name: string): { m: Manifest; w: ManifestWidget } | undefined {
    const m = this.registry.get(app)?.manifest;
    if (!m || m.status === "archived") return undefined;
    const w = m.widgets.find((x) => x.name === name && x.kind === "items");
    return w ? { m, w } : undefined;
  }

  /** Drops the cache entry and reads the source again (POST /api/widgets/:app/:name/refresh). */
  async refresh(app: string, name: string): Promise<WidgetActResult> {
    const f = this.find(app, name);
    if (!f) return { ok: false, status: 404, error: `unknown widget: ${app}/${name}` };
    this.invalidate(`${app}/${name}`);
    return { ok: true, widget: await this.one(f.m, f.w) };
  }

  /**
   * Sends an action back to the widget's own source (docs/app-spec.md#views-copy-and-actions).
   * Only an id the widget's latest payload declares is forwarded; on success the cache is dropped and
   * the card comes back fresh, with the app's `message`.
   */
  async act(app: string, name: string, req: { action?: unknown; value?: unknown }): Promise<WidgetActResult> {
    const f = this.find(app, name);
    if (!f) return { ok: false, status: 404, error: `unknown widget: ${app}/${name}` };
    const { m, w } = f;
    if (typeof req.action !== "string" || !req.action) return { ok: false, status: 400, error: "action must be a string" };
    const current = await this.one(m, w);
    if (!current.ok) return { ok: false, status: 502, error: current.error };
    const kind = declaredActions(current).get(req.action);
    if (!kind) return { ok: false, status: 400, error: "unknown action" };
    const body: { action: string; value?: string } = { action: req.action };
    if (kind === "input") {
      const value = typeof req.value === "string" ? req.value.trim() : "";
      if (!value || value.length > MAX_ACTION_VALUE) return { ok: false, status: 400, error: `value must be 1 to ${MAX_ACTION_VALUE} characters` };
      body.value = value;
    }
    let answer: { ok?: unknown; error?: unknown; message?: unknown };
    try {
      const r = await this.send(m, w, { method: "POST", headers: { "content-type": "application/json", [ACTION_HEADER]: "1" }, body: JSON.stringify(body) });
      const raw = await r.text();
      try {
        answer = JSON.parse(raw) as typeof answer;
      } catch {
        throw new Error(r.ok ? "response is not JSON" : `HTTP ${r.status}`);
      }
      if (!answer || typeof answer !== "object") throw new Error(r.ok ? "response is not { ok: true }" : `HTTP ${r.status}`);
    } catch (e) {
      return { ok: false, status: 502, error: String((e as Error).message ?? e).slice(0, 200) };
    }
    if (answer.ok !== true) return { ok: false, status: 502, error: typeof answer.error === "string" && answer.error ? answer.error.slice(0, 200) : "the app refused the action" };
    this.invalidate(current.id);
    const widget = await this.one(m, w);
    return { ok: true, widget, ...(answer.message !== undefined ? { message: answer.message } : {}) };
  }

  /** One request to the widget's declared source, with the feed's timeout; a spec 2 path goes through the app's own route. */
  private send(m: Manifest, w: ManifestWidget, init: RequestInit): Promise<Response> {
    const url = sourceUrl(m, w);
    const local = m.spec === 2 && w.source.startsWith("/") && this.opts.appFetch;
    if (!url && !local) return Promise.reject(new Error("source is a path but the app declares no service"));
    const req = { ...init, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8_000) };
    return local ? local(m.app, w.source, req) : (this.opts.fetch ?? fetch)(url!, req);
  }

  private async fetchItems(m: Manifest, w: ManifestWidget): Promise<WidgetResult> {
    try {
      const r = await this.send(m, w, {});
      // An unread body keeps a package app's lease, which blocks its upgrade.
      if (!r.ok) { await r.body?.cancel().catch(() => {}); throw new Error(`HTTP ${r.status}`); }
      const j = (await r.json()) as { ok?: unknown; items?: unknown; error?: unknown; blocks?: unknown; views?: unknown; actions?: unknown; asOf?: unknown; staleAfter?: unknown };
      if (j.ok !== true || !Array.isArray(j.items)) throw new Error(typeof j.error === "string" ? j.error : "response is not { ok: true, items: [] }");
      const items = j.items.slice(0, MAX_ITEMS).map((it: Record<string, unknown>) => ({
        text: String(it?.text ?? ""),
        url: typeof it?.url === "string" && it.url ? contentLink(m, it.url) : "",
        time: typeof it?.time === "string" ? it.time : "",
      }));
      const out: WidgetData = { ok: true, items };
      const blocks = sanitizeBlocks(j.blocks);
      if (blocks) out.blocks = blockLinks(m, blocks);
      const views = sanitizeViews(j.views);
      if (views) out.views = views.map((v) => ({ ...v, blocks: blockLinks(m, v.blocks) }));
      const actions = sanitizeActions(j.actions);
      if (actions) out.actions = actions;
      dedupeActionIds(out);
      if (typeof j.asOf === "string" && !Number.isNaN(Date.parse(j.asOf))) out.asOf = j.asOf;
      if (typeof j.staleAfter === "number" && j.staleAfter > 0) out.staleAfterMs = Math.round(j.staleAfter * 1000);
      return out;
    } catch (e) {
      return { ok: false, error: String((e as Error).message ?? e).slice(0, 200) };
    }
  }
}

/** Block links (and a tank's) resolved against the app's public URL like an item's; a link that does not pass is dropped. */
function blockLinks(m: Manifest, blocks: WidgetBlock[]): WidgetBlock[] {
  return blocks.map((block) => {
    let b = block;
    if (b.type === "tanks")
      b = { ...b, tanks: b.tanks.map((k) => {
        if (!k.url) return k;
        const { url, ...rest } = k;
        const abs = contentLink(m, url);
        return abs ? { ...rest, url: abs } : rest;
      }) };
    if (!b.url) return b;
    const { url, ...rest } = b;
    const abs = contentLink(m, url);
    return abs ? { ...rest, url: abs } : rest;
  });
}

/** An item's or block's link, relative to the app's public URL; only http(s) reaches the page. */
function contentLink(m: Manifest, url: string): string {
  const abs = resolveLink(m, url);
  return /^https?:\/\//.test(abs) || m.spec === 2 && abs.startsWith("/_space/apps/") ? abs : "";
}

/** Absolute URL of a widget source, or undefined when a path has no service to attach to. */
export function sourceUrl(m: Manifest, w: ManifestWidget): string | undefined {
  if (/^https?:\/\//.test(w.source)) return w.source;
  if (!m.service) return undefined;
  return `http://127.0.0.1:${m.service.port}${w.source}`;
}
