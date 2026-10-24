import { rank, opensByDefault, type Candidate } from "../../../../src/space/shortcuts/ranking.ts";
import type { WidgetBlock } from "../../../../src/space/panel/blocks.ts";
import type { Screen } from "../../../../src/space/panel/layout.ts";
import { seedScreens } from "../../../../src/web/screens.ts";
import { escapeSegment, resolveUrl } from "./url.ts";

/**
 * The Space's catalogue as the Linux client reads it: `GET /api/apps`, `/api/agents`,
 * `/api/widgets`, `/api/peers`, `/api/panel/layout` and `/api/router`, decoded as the iPhone and
 * Mac clients do (mobile/ios/AISpace/Core/Catalogue.swift). Every field the client can live
 * without is optional and a malformed row is skipped, so an older or newer server still decodes.
 */

export type I18n = Record<string, { title?: string; description?: string }>;

/** Manifest text in the given language: the exact tag, then its primary subtag, then the base. */
export function pickText(base: string, i18n: I18n | undefined, key: "title" | "description", lang: string): string {
  if (!i18n) return base;
  const exact = i18n[lang]?.[key];
  if (exact) return exact;
  for (const [tag, text] of Object.entries(i18n)) if (tag.split("-")[0] === lang && text?.[key]) return text[key]!;
  return base;
}

export type EntryKind = "app" | "agent" | "widget";

/** Whether an entry can be expected to answer (the iPhone's `Reach`). */
export type Reach = "up" | "down" | "unknown" | "link" | "peer-offline" | "paused";

export type Agent = { id: string; app: string; name: string; title: string; description?: string; i18n?: I18n; avatar?: string; peer?: string; runtime?: string };

export type Widget = {
  id: string;
  app: string;
  name: string;
  title: string;
  i18n?: I18n;
  icon?: string;
  link?: string;
  peer?: string;
  stale?: boolean;
  size?: string;
  /** `items` (the default: a list, maybe blocks) or `embed` (the app's own page). */
  kind?: "items" | "embed";
  ok?: boolean;
  items?: { text: string; url?: string; time?: string }[];
  blocks?: WidgetBlock[];
  asOf?: string;
  staleAfterMs?: number;
  error?: string;
};

export type Peer = { name: string; health?: string; asOf?: string; error?: string; stale?: boolean };

/** One app, agent or widget, keyed as the panel keys it (`app:<id>`, `agent:<id>`, `widget:<id>`). */
export type Entry = {
  kind: EntryKind;
  ref: string;
  title: string;
  detail?: string;
  i18n?: I18n;
  /** An emoji, an http(s) URL, or a path on the Space. */
  icon?: string;
  peer?: string;
  /** The page to open: the app's `url` or the widget's `link`, `{lang}` not filled in yet. */
  link?: string;
  reach: Reach;
};

export const entryKey = (e: Pick<Entry, "kind" | "ref">) => `${e.kind}:${e.ref}`;

export type Catalogue = {
  apps: Entry[];
  agents: Entry[];
  widgets: Widget[];
  agentInfo: Agent[];
  peers: Peer[];
  /** The panel's screens, home first; absent while the Space has stored none. */
  screens?: Screen[];
  domain?: string;
  /** Icons of the panel's own tiles (inbox, terminal, settings, ...). */
  builtinIcons: Record<string, string>;
};

export class NotASpaceError extends Error {
  constructor(readonly route: string) {
    super(`${route} did not answer as ai-space does`);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const i18nOf = (v: unknown): I18n | undefined => (isObj(v) ? (v as I18n) : undefined);

function rows(body: unknown, key: string, route: string): Obj[] {
  if (!isObj(body) || !Array.isArray(body[key])) throw new NotASpaceError(route);
  return (body[key] as unknown[]).filter(isObj);
}

const isOffline = (p: Peer) => p.stale === true || (p.health !== undefined && p.health !== "ok");

export function decodeCatalogue(raw: { apps: unknown; agents: unknown; widgets: unknown; peers?: unknown; layout?: unknown; router?: unknown }): Catalogue {
  const peers: Peer[] = [];
  if (isObj(raw.peers) && Array.isArray(raw.peers.peers)) {
    for (const p of raw.peers.peers) if (isObj(p) && typeof p.name === "string") peers.push({ name: p.name, health: str(p.health), asOf: str(p.asOf), error: str(p.error), stale: p.stale === true });
  }
  const offline = new Set(peers.filter(isOffline).map((p) => p.name));

  const apps: Entry[] = [];
  for (const a of rows(raw.apps, "apps", "/api/apps")) {
    const id = str(a.id), title = str(a.title), url = str(a.url);
    if (!id || title === undefined || a.hidden === true || a.status === "archived" || !url) continue;
    const peer = str(a.peer);
    const service = isObj(a.service) ? a.service : undefined;
    const reach: Reach =
      a.stale === true || (peer && offline.has(peer)) ? "peer-offline"
      : a.status === "paused" ? "paused"
      : service ? (service.health === "ok" ? "up" : service.health === "down" ? "down" : "unknown")
      : "link";
    apps.push({ kind: "app", ref: id, title, detail: str(a.description), i18n: i18nOf(a.i18n), icon: str(a.icon), peer, link: url, reach });
  }

  const agentInfo: Agent[] = [];
  const agents: Entry[] = [];
  for (const a of rows(raw.agents, "agents", "/api/agents")) {
    const id = str(a.id), app = str(a.app), name = str(a.name), title = str(a.title);
    if (!id || !app || !name || title === undefined) continue;
    const peer = str(a.peer);
    agentInfo.push({ id, app, name, title, description: str(a.description), i18n: i18nOf(a.i18n), avatar: str(a.avatar), peer, runtime: str(a.runtime) });
    agents.push({ kind: "agent", ref: id, title, detail: str(a.description), i18n: i18nOf(a.i18n), icon: str(a.avatar), peer, reach: peer && offline.has(peer) ? "peer-offline" : "unknown" });
  }

  const widgets: Widget[] = [];
  for (const w of rows(raw.widgets, "widgets", "/api/widgets")) {
    const id = str(w.id), app = str(w.app), name = str(w.name), title = str(w.title);
    if (!id || !app || !name || title === undefined) continue;
    const items = Array.isArray(w.items) ? w.items.filter(isObj).filter((i) => typeof i.text === "string").map((i) => ({ text: i.text as string, url: str(i.url), time: str(i.time) })) : undefined;
    const blocks = Array.isArray(w.blocks) ? (w.blocks.filter((b) => isObj(b) && typeof b.type === "string") as WidgetBlock[]) : undefined;
    widgets.push({ id, app, name, title, i18n: i18nOf(w.i18n), icon: str(w.icon), link: str(w.link), peer: str(w.peer), stale: w.stale === true, size: str(w.size), ...(w.kind === "embed" || w.kind === "items" ? { kind: w.kind } : {}), ...(typeof w.staleAfterMs === "number" ? { staleAfterMs: w.staleAfterMs } : {}), ok: typeof w.ok === "boolean" ? w.ok : undefined, items, blocks, asOf: str(w.asOf), error: str(w.error) });
  }

  let screens: Screen[] | undefined;
  if (isObj(raw.layout) && isObj(raw.layout.layout) && Array.isArray(raw.layout.layout.screens)) {
    screens = raw.layout.layout.screens.filter((s): s is Screen => isObj(s) && typeof s.id === "string" && typeof s.name === "string" && Array.isArray(s.items)).map((s) => ({ id: s.id, name: s.name, items: s.items.filter((k): k is string => typeof k === "string") }));
  }
  const domain = isObj(raw.router) && typeof raw.router.domain === "string" && raw.router.domain ? raw.router.domain.toLowerCase() : undefined;
  const builtinIcons: Record<string, string> = {};
  if (isObj(raw.apps) && isObj(raw.apps.builtins)) for (const [k, v] of Object.entries(raw.apps.builtins)) if (typeof v === "string") builtinIcons[k] = v;

  return { apps, agents, widgets, agentInfo, peers, ...(screens ? { screens } : {}), ...(domain ? { domain } : {}), builtinIcons };
}

export function widgetEntry(w: Widget): Entry {
  return { kind: "widget", ref: w.id, title: w.title, i18n: w.i18n, icon: w.icon, peer: w.peer, link: w.link, reach: w.stale ? "peer-offline" : w.ok === false ? "down" : "unknown" };
}

export const allEntries = (c: Catalogue): Entry[] => [...c.apps, ...c.agents, ...c.widgets.map(widgetEntry)];

/** The panel's screens as a browser shows them: the stored ones, or the home screen it would seed. */
export function panelScreens(c: Catalogue): Screen[] {
  return c.screens ?? seedScreens(c.apps.map((a) => a.ref), c.agents.map((a) => a.ref), c.widgets.map((w) => w.id));
}

/** The page of an app or widget with `{lang}` filled in, resolved against the Space; http(s) only. */
export function pageUrl(link: string | undefined, space: string, lang: string): string | undefined {
  if (!link) return undefined;
  const url = resolveUrl(link.replace(/\{lang\}/g, lang), space);
  return url && /^https?:\/\//i.test(url) ? url : undefined;
}

/** The route base of an agent's chat: local, or forwarded to the peer that owns it. */
export function agentBase(a: Pick<Agent, "app" | "name" | "peer">): string {
  const prefix = a.peer ? `/api/peers/${escapeSegment(a.peer)}` : "/api";
  return `${prefix}/agents/${escapeSegment(a.app)}/${escapeSegment(a.name)}`;
}

// Search: every word of the query in the title, description or id, in every language of the entry
// (CatalogueSearch.swift), and the command box's ranking shared with the web panel (ranking.ts).

export function fold(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
}

function candidate(e: Entry): Candidate & { entry: Entry } {
  const names = [e.title, ...Object.values(e.i18n ?? {}).map((t) => t?.title ?? "").filter(Boolean), e.ref].map(fold);
  const text = fold([e.detail ?? "", ...Object.values(e.i18n ?? {}).map((t) => t?.description ?? "")].join("\n"));
  return { names, text, ...(e.peer ? { peer: e.peer } : {}), entry: e };
}

/** The matching entries, best names first (the web panel's and the Mac's omnibox rules). */
export function search(query: string, entries: Entry[], limit = 50): Entry[] {
  return rank(fold(query), entries.map(candidate), limit).map((c) => c.entry);
}

/** Return opens the best match when its name holds the whole query; anything else asks the assistant. */
export function opensFirst(query: string, first: Entry | undefined): boolean {
  return Boolean(first) && opensByDefault(fold(query), candidate(first!));
}

/** A widget's state in a few short lines: its blocks' values, else the first items of its list. */
export function widgetLines(w: Widget, lang: string, max = 4): string[] {
  if (w.error) return [w.error];
  const text = (t: unknown): string => (typeof t === "string" ? t : isObj(t) ? (str(t[lang]) ?? str(Object.values(t)[0]) ?? "") : "");
  if (w.blocks?.length) {
    return w.blocks.slice(0, max).map((b) => {
      const label = text(b.label);
      let value = "";
      switch (b.type) {
        case "metric":
          value = text(b.display) || formatNumber(b.value, b.format, b.decimals, b.currency, lang) + (b.unit ? ` ${text(b.unit)}` : "");
          break;
        case "progress":
          value = text(b.display) || (b.value === null ? "—" : `${formatNumber(b.value, b.format, b.decimals, b.currency, lang)} / ${formatNumber(b.max, b.format, b.decimals, b.currency, lang)}`);
          break;
        case "gauge":
          value = text(b.display) || formatNumber(b.value, undefined, undefined, undefined, lang);
          break;
        case "status":
          value = text(b.value);
          break;
        case "trend": {
          const last = [...b.points].reverse().find((p) => p.v !== null);
          value = last ? formatNumber(last.v, b.format, b.decimals, b.currency, lang) : "—";
          break;
        }
      }
      return label ? `${label}: ${value}` : value;
    });
  }
  return (w.items ?? []).slice(0, max).map((i) => i.text);
}

export function formatNumber(v: number | null | undefined, format?: string, decimals?: number, currency?: string, lang = "en"): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const locale = lang === "zh" ? "zh-CN" : "en";
  const opts: Intl.NumberFormatOptions = decimals !== undefined ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : { maximumFractionDigits: 2 };
  try {
    if (format === "percent") return new Intl.NumberFormat(locale, { ...opts, style: "percent" }).format(v);
    if (format === "currency" && currency) return new Intl.NumberFormat(locale, { ...opts, style: "currency", currency }).format(v);
    if (format === "compact") return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(v);
    return new Intl.NumberFormat(locale, opts).format(v);
  } catch {
    return String(v);
  }
}
