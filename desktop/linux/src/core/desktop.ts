import { pageUrl, type Entry } from "./catalogue.ts";
import { parseUrl, queryParams, sameOrigin } from "./url.ts";

/** One inbox thread (`GET /api/inbox`, src/space/notify/inbox.ts). */
export type InboxItem = { thread: string; app: string; level: string; title?: string; text: string; url?: string; count: number; lastAt: string; unread: boolean; done: boolean };
export type InboxSummary = { unread: number; open: number };

export function decodeInbox(body: unknown): { items: InboxItem[]; summary: InboxSummary } {
  const o = (body ?? {}) as { items?: unknown; summary?: { unread?: unknown; open?: unknown } };
  const items = Array.isArray(o.items)
    ? (o.items as Record<string, unknown>[]).filter((i) => i && typeof i.thread === "string" && typeof i.app === "string" && typeof i.text === "string" && typeof i.lastAt === "string").map((i) => ({
        thread: i.thread as string,
        app: i.app as string,
        level: typeof i.level === "string" ? i.level : "info",
        ...(typeof i.title === "string" ? { title: i.title } : {}),
        text: i.text as string,
        ...(typeof i.url === "string" ? { url: i.url } : {}),
        count: typeof i.count === "number" ? i.count : 1,
        lastAt: i.lastAt as string,
        unread: i.unread === true,
        done: i.done === true,
      }))
    : [];
  const unread = typeof o.summary?.unread === "number" ? o.summary.unread : items.filter((i) => i.unread && !i.done).length;
  const open = typeof o.summary?.open === "number" ? o.summary.open : items.filter((i) => !i.done).length;
  return { items, summary: { unread, open } };
}

/**
 * What the inbox page shows: the open threads, "Nothing new", or why the inbox could not be read.
 * Threads already known stay on show when a later look fails; with none known, the failure takes
 * the page, so a Space that did not answer never reads as an empty inbox.
 */
export type InboxShown = { kind: "list"; items: InboxItem[] } | { kind: "empty" } | { kind: "error"; message: string };

export function inboxShown(items: readonly InboxItem[], loadError: string | undefined): InboxShown {
  const open = items.filter((i) => !i.done);
  if (open.length) return { kind: "list", items: open };
  return loadError !== undefined ? { kind: "error", message: loadError } : { kind: "empty" };
}

/**
 * A click on an inbox row: a thread with a link opens it; one without unfolds to its whole text,
 * or folds back, one thread at a time (Windows' InboxPage). Either way an unread thread is marked
 * read when it is opened or unfolded.
 */
export function inboxClick(item: InboxItem, unfolded: string | undefined): { open?: string; unfolded: string | undefined; markRead: boolean } {
  if (item.url) return { open: item.url, unfolded, markRead: item.unread };
  const next = unfolded === item.thread ? undefined : item.thread;
  return { unfolded: next, markRead: item.unread && next !== undefined };
}

/**
 * Which inbox threads deserve a desktop notification: unread ones that are new or changed since
 * the last look. The first look at a connection only records what is there, so connecting never
 * floods the screen with old messages (the Mac's `InboxSeen`).
 */
export class InboxSeen {
  lastAt: Record<string, string> = {};
  seeded = false;

  fresh(items: InboxItem[]): InboxItem[] {
    const out: InboxItem[] = [];
    for (const item of items) {
      if (this.seeded && item.unread && !item.done && this.lastAt[item.thread] !== item.lastAt) out.push(item);
      this.lastAt[item.thread] = item.lastAt;
    }
    this.seeded = true;
    // Forget threads that are gone so the record does not grow without bound.
    if (Object.keys(this.lastAt).length > 2000) {
      const present = new Set(items.map((i) => i.thread));
      for (const k of Object.keys(this.lastAt)) if (!present.has(k)) delete this.lastAt[k];
    }
    return out;
  }
}

/**
 * `aispace://` links, for scripts, desktop shortcuts and other apps. A link may fill in a message
 * but never sends it: any web page can open such a link, so sending always waits for the person.
 */
export type DeepLink = { kind: "chat"; agent?: string; text?: string } | { kind: "open"; app: string } | { kind: "inbox" } | { kind: "show" };

export function parseDeepLink(link: string): DeepLink | undefined {
  const m = /^aispace:(?:\/\/)?([^/?#]*)/i.exec(link.trim());
  if (!m) return undefined;
  const q = queryParams(link);
  const value = (k: string) => (q[k] ? q[k] : undefined);
  switch ((m[1] ?? "").toLowerCase()) {
    case "chat": {
      const agent = value("agent");
      const text = value("text")?.slice(0, 20_000);
      return { kind: "chat", ...(agent ? { agent } : {}), ...(text ? { text } : {}) };
    }
    case "open": {
      const app = value("app");
      return app ? { kind: "open", app } : undefined;
    }
    case "inbox":
      return { kind: "inbox" };
    case "":
    case "show":
      return { kind: "show" };
    default:
      return undefined;
  }
}

/** Which app, if any, a link belongs to: such links open in that app's tab (the Mac's `AppRoutes`). */
export function appForUrl(url: string, apps: Entry[], space: string, lang: string): Entry | undefined {
  const u = parseUrl(url);
  if (!u || (u.scheme !== "http" && u.scheme !== "https")) return undefined;
  let best: { app: Entry; length: number } | undefined;
  for (const app of apps) {
    const page = pageUrl(app.link, space, lang);
    if (!page || !sameOrigin(page, url)) continue;
    let length = 0;
    if (sameOrigin(page, space)) {
      // An app served from the panel's own origin owns its path, never the panel's root.
      const prefix = (parseUrl(page)?.path ?? "").replace(/\/$/, "");
      if (!prefix || !(u.path === prefix || u.path.startsWith(`${prefix}/`))) continue;
      length = prefix.length;
    }
    if (!best || length > best.length) best = { app, length };
  }
  return best?.app;
}

/** Up to five tab shortcuts, keeping the active one visible (the Mac's `OpenTabLayout`). */
export function visibleTabs(ids: string[], selected?: string): string[] {
  const out = ids.slice(0, 5);
  if (selected && ids.includes(selected) && !out.includes(selected)) out[out.length - 1] = selected;
  return out;
}
