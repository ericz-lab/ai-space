import type { TranscriptMessage } from "../runtimes/types.ts";
import { CARD_LINE_MAX, CARD_LINE_PREFIX, CARDS_PER_REPLY } from "../runtimes/tool-text.ts";
import type { RunInfo, RunRegistry } from "./runs.ts";

/**
 * Chat cards (docs/chat-cards.md): what an app agent's tool did this turn, shown under the reply.
 * An app's CLI prints `::space-card {json}` on a line of its own after a write succeeded; ai-space
 * takes those lines out of the tool output, checks them and hands them to the panel as `cards`,
 * live as a `{"type":"cards","cards","token"}` run event after the tool result, and on an `ai`
 * message of a restored transcript (without a token). Nothing of a card is stored here: its state
 * is the app's, read through the card's `state` capability each time it is shown.
 *
 * A card may name capabilities of its own app only. Its actions run with a token that comes with
 * the live event, lives in memory and ends when the conversation's next turn starts; the request
 * to the app is built here from the card as extracted, so a client sends the token, the card's
 * index and the chosen item ids, never a body.
 */

export const CARD_KINDS = ["receipt", "list", "value"] as const;
export type CardKind = (typeof CARD_KINDS)[number];
/** v1 knows `undo`; another name (a later spec's `edit`) is left out of the card, not refused. */
export const CARD_ACTIONS = ["undo"] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];
export const MAX_CARD_ITEMS = 20;

export type CardItem = { id: string; title: string; detail?: string; url?: string; version?: number };
export type Card = {
  v: 1;
  kind: CardKind;
  title?: string;
  items: CardItem[];
  /** A `value` card's value as shown. */
  text?: string;
  /** The capability that answers the items' current state. */
  state?: string;
  actions?: Partial<Record<CardAction, string>>;
};

/** One item as a card's `state` or action capability answers it. */
export type CardItemState = { id: string; status: "active" | "done" | "removed"; title?: string; detail?: string; url?: string; version?: number; changed?: boolean };

const CAPABILITY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const ITEM_STATUSES = ["active", "done", "removed"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A one-line text of at most `max` characters, or undefined when absent; `false` when it is not one. */
const line = (v: unknown, max: number): string | undefined | false => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return false;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > max ? false : s || undefined;
};
/** A link the app gives: a path on its own page, or an http(s) URL. */
const linkOk = (v: string) => (v.startsWith("/") && !v.startsWith("//")) || /^https?:\/\//i.test(v);

function parseItem(raw: unknown): CardItem | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === "number" && Number.isInteger(raw.id) ? String(raw.id) : raw.id;
  if (typeof id !== "string" || !id.trim() || id.length > 100) return null;
  const title = line(raw.title, 300);
  const detail = line(raw.detail, 300);
  if (!title || detail === false) return null;
  if (raw.url !== undefined && (typeof raw.url !== "string" || raw.url.length > 2000 || !linkOk(raw.url))) return null;
  if (raw.version !== undefined && (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 0)) return null;
  return { id: id.trim(), title, ...(detail ? { detail } : {}), ...(typeof raw.url === "string" ? { url: raw.url } : {}), ...(raw.version !== undefined ? { version: raw.version as number } : {}) };
}

/** A card as the spec allows it, or null: a card that breaks a rule is dropped whole, never repaired. */
export function parseCard(raw: unknown): Card | null {
  if (!isRecord(raw) || raw.v !== 1 || !(CARD_KINDS as readonly unknown[]).includes(raw.kind)) return null;
  const kind = raw.kind as CardKind;
  const title = line(raw.title, 200);
  if (title === false) return null;
  const rawItems = raw.items ?? [];
  if (!Array.isArray(rawItems) || rawItems.length > MAX_CARD_ITEMS) return null;
  const items: CardItem[] = [];
  for (const r of rawItems) {
    const item = parseItem(r);
    if (!item) return null;
    items.push(item);
  }
  if (new Set(items.map((i) => i.id)).size !== items.length) return null;
  const text = line(raw.text, 200);
  if (text === false) return null;
  if (kind === "value" ? !text : !items.length) return null;
  if (raw.state !== undefined && (typeof raw.state !== "string" || !CAPABILITY_RE.test(raw.state))) return null;
  let actions: Card["actions"];
  if (raw.actions !== undefined) {
    if (!isRecord(raw.actions) || kind !== "receipt") return null;
    for (const [name, capability] of Object.entries(raw.actions)) {
      if (typeof capability !== "string" || !CAPABILITY_RE.test(capability)) return null;
      if ((CARD_ACTIONS as readonly string[]).includes(name)) (actions ??= {})[name as CardAction] = capability;
    }
  }
  return { v: 1, kind, ...(title ? { title } : {}), items, ...(text ? { text } : {}), ...(typeof raw.state === "string" ? { state: raw.state } : {}), ...(actions ? { actions } : {}) };
}

/** A tool output without its card lines, and the cards they held that pass (at most CARDS_PER_REPLY). */
export function extractCards(output: string): { text: string; cards: Card[] } {
  if (!output.includes(CARD_LINE_PREFIX)) return { text: output, cards: [] };
  const cards: Card[] = [];
  const kept: string[] = [];
  for (const l of output.split("\n")) {
    const bare = l.replace(/\r$/, "");
    if (!bare.startsWith(CARD_LINE_PREFIX)) {
      kept.push(l);
      continue;
    }
    if (bare.length > CARD_LINE_MAX || cards.length >= CARDS_PER_REPLY) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(bare.slice(CARD_LINE_PREFIX.length));
    } catch {
      continue;
    }
    const card = parseCard(raw);
    if (card) cards.push(card);
  }
  return { text: kept.join("\n"), cards };
}

/** The item links of a card resolved against the app's public URL; a link that does not resolve to http(s) is left out. */
export function resolveCard<T extends { items: { url?: string }[] }>(card: T, resolve: (url: string) => string): T {
  return { ...card, items: card.items.map((i) => withLink(i, resolve)) };
}

function withLink<T extends { url?: string }>(item: T, resolve: (url: string) => string): T {
  if (item.url === undefined) return item;
  const { url, ...rest } = item;
  const abs = resolve(url);
  return (/^https?:\/\//i.test(abs) ? { ...rest, url: abs } : rest) as T;
}

/** An app's answer of item states, checked: an item that breaks a rule is left out. */
export function parseItemStates(raw: unknown, resolve: (url: string) => string): CardItemState[] {
  if (!Array.isArray(raw)) return [];
  const out: CardItemState[] = [];
  for (const r of raw.slice(0, MAX_CARD_ITEMS * 2)) {
    if (!isRecord(r) || !(ITEM_STATUSES as readonly unknown[]).includes(r.status)) continue;
    const id = typeof r.id === "number" && Number.isInteger(r.id) ? String(r.id) : r.id;
    if (typeof id !== "string" || !id || id.length > 100) continue;
    const title = line(r.title, 300);
    const detail = line(r.detail, 300);
    const url = typeof r.url === "string" && r.url.length <= 2000 && linkOk(r.url) ? r.url : undefined;
    const version = typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 0 ? r.version : undefined;
    out.push(withLink({ id, status: r.status as CardItemState["status"], ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(url ? { url } : {}), ...(version !== undefined ? { version } : {}), ...(r.changed === true ? { changed: true } : {}) }, resolve));
  }
  return out;
}

/** Every text in a tool result's content (a string, or a list of text blocks), each through `fn`. */
function mapResultText(content: unknown, fn: (text: string) => string): unknown {
  if (typeof content === "string") return fn(content);
  if (Array.isArray(content)) return content.map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? { ...b, text: fn(b.text) } : b));
  return content;
}

/** Card lines out of every string of an event (the CLI's own `tool_use_result` copy of the output, an echo in a command). */
function stripDeep(v: unknown): unknown {
  if (typeof v === "string") return v.includes(CARD_LINE_PREFIX) ? extractCards(v).text : v;
  if (Array.isArray(v)) return v.map(stripDeep);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripDeep(x)]));
  return v;
}

/** Card lines out of a restored conversation: each `ai` message gets the cards of its tool outputs (no token). */
export function transcriptCards(messages: TranscriptMessage[], resolve: ((url: string) => string) | null): (TranscriptMessage & { cards?: Card[] })[] {
  return messages.map((m) => {
    if (m.role !== "ai" || !m.steps?.some((s) => s.kind === "tool" && s.output.includes(CARD_LINE_PREFIX))) return m;
    const cards: Card[] = [];
    const steps = m.steps.map((s) => {
      if (s.kind !== "tool" || !s.output.includes(CARD_LINE_PREFIX)) return s;
      const found = extractCards(s.output);
      if (resolve) cards.push(...found.cards.map((c) => resolveCard(c, resolve)));
      return { ...s, output: found.text };
    });
    return { ...m, steps, ...(cards.length ? { cards: cards.slice(0, CARDS_PER_REPLY) } : {}) };
  });
}

/** The first line of the person's message that tells the agent what the cards' actions changed (docs/chat-cards.md). */
export const CHANGES_NOTE_PREFIX = "[ai-space card changes] ";
const NOTE_RE = /^\[ai-space card changes\] [^\n]*\n\n/;

/** The person's message as they wrote it, without the note ai-space put before it. */
export function withoutChangesNote(text: string): string {
  return text.replace(NOTE_RE, "");
}

/** A card action's grant: what the live event's token allows, until the conversation's next turn. */
type Grant = {
  agent: string;
  app: string;
  runId: string;
  cards: Card[];
  at: number;
  /** Items an action removed, id → title, for the note on the next message. */
  removed: Map<string, string>;
};

export type CardBookOptions = {
  /** The app whose capabilities an agent's cards may name; null: the agent's cards are dropped (Space Assistant). */
  appOf: (agent: string) => string | null;
  /** An item link resolved against the app's public URL (panel/view.ts `resolveLink`). */
  resolve: (app: string, url: string) => string;
  /** A token is good for at most this long (default 12 hours), even when no turn follows. */
  ttlMs?: number;
  now?: () => number;
};

const MAX_GRANTS = 500;

/**
 * The run side of the cards: takes card lines out of a run's tool results, sends the cards as their
 * own event with a token when they have actions, and keeps the grants those tokens stand for.
 */
export class CardBook {
  private readonly grants = new Map<string, Grant>();
  /** Cards sent per run so far, against CARDS_PER_REPLY. */
  private readonly sent = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly runs: RunRegistry,
    private readonly opts: CardBookOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 12 * 60 * 60_000;
    runs.transform((run, l) => this.rewrite(run, l));
    runs.watch((news) => {
      if (news.type !== "run") return;
      if (news.run.status === "running") this.turnStarted(news.run);
      else this.sent.delete(news.run.id);
    });
  }

  /** One event line of a run: unchanged (null), or without its card lines and followed by the cards event. */
  rewrite(run: RunInfo, raw: string): string[] | null {
    if (!raw.includes(CARD_LINE_PREFIX)) return null;
    let ev: unknown;
    try {
      ev = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isRecord(ev)) return null;
    const found: Card[] = [];
    const content = isRecord(ev.message) ? ev.message.content : undefined;
    if (ev.type === "user" && Array.isArray(content)) {
      ev = {
        ...ev,
        message: {
          ...(ev.message as Record<string, unknown>),
          content: content.map((b) => {
            if (!isRecord(b) || b.type !== "tool_result" || b.is_error === true) return b;
            return {
              ...b,
              content: mapResultText(b.content, (text) => {
                const r = extractCards(text);
                found.push(...r.cards);
                return r.text;
              }),
            };
          }),
        },
      };
    }
    const out = [JSON.stringify(stripDeep(ev))];
    const app = this.opts.appOf(run.agent);
    const room = CARDS_PER_REPLY - (this.sent.get(run.id) ?? 0);
    const cards = app ? found.slice(0, Math.max(0, room)).map((c) => resolveCard(c, (url) => this.opts.resolve(app, url))) : [];
    if (!cards.length || !app) return out;
    this.sent.set(run.id, CARDS_PER_REPLY - room + cards.length);
    let token: string | undefined;
    if (cards.some((c) => c.actions && Object.keys(c.actions).length)) {
      token = crypto.randomUUID();
      this.grants.set(token, { agent: run.agent, app, runId: run.id, cards, at: this.now(), removed: new Map() });
      while (this.grants.size > MAX_GRANTS) this.grants.delete(this.grants.keys().next().value!);
    }
    out.push(JSON.stringify({ type: "cards", cards, ...(token ? { token } : {}) }));
    return out;
  }

  /** The grant a token stands for, while it is good. */
  grant(token: string): Grant | undefined {
    const g = this.grants.get(token);
    if (g && this.now() - g.at > this.ttlMs) {
      this.grants.delete(token);
      return undefined;
    }
    return g;
  }

  /** Items an action removed: kept for the note on the conversation's next message. */
  removed(token: string, ids: string[]): void {
    const g = this.grants.get(token);
    if (!g) return;
    for (const id of ids) {
      const item = g.cards.flatMap((c) => c.items).find((i) => i.id === id);
      if (item) g.removed.set(id, item.title);
    }
  }

  /**
   * What the person changed through the cards of the conversation's last turn, as the line put
   * before their next message (docs/chat-cards.md); undefined when nothing changed.
   */
  changesNote(agent: string, sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    const removed: string[] = [];
    for (const g of this.grants.values()) {
      if (g.agent !== agent || !g.removed.size || !this.ofConversation(g, sessionId)) continue;
      for (const [id, title] of g.removed) removed.push(`${title} (#${id})`);
    }
    return removed.length ? `${CHANGES_NOTE_PREFIX}Since your last reply the person undid these from the result cards: ${removed.join(", ")}.` : undefined;
  }

  /** A newer turn of a conversation: the cards of its earlier turns become read-only. */
  private turnStarted(run: RunInfo): void {
    if (!run.sessionId) return;
    for (const [token, g] of this.grants) {
      if (g.agent === run.agent && g.runId !== run.id && this.ofConversation(g, run.sessionId)) this.grants.delete(token);
    }
  }

  private ofConversation(g: Grant, sessionId: string): boolean {
    const r = this.runs.get(g.runId);
    return !!r && (r.sid === sessionId || r.sessionId === sessionId);
  }
}
