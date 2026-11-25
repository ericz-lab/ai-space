/**
 * Chat cards (docs/chat-cards.md, and the second version's styles and item fields): what an app
 * agent's tools did this turn, drawn under the reply. ai-space extracts and checks the cards and
 * hands them over as a run event `{"type":"cards","cards":[...],"token":"..."}` or, without a
 * token, as `cards` on an `ai` message of a restored session; this client only decodes, draws and
 * calls the two card routes. The rules here are the web panel's (`src/web/ChatCards.tsx`,
 * `src/web/Chat.tsx`): undo only on the conversation's latest reply that came live with a token,
 * the header button's words, the request bodies, a 409 `{ readOnly: true }` once the token is gone.
 *
 * Decoding is lenient: ai-space already dropped every card that breaks the contract, so a field
 * this client does not know, or one of the wrong type, is ignored rather than dropping the card. A
 * `style` it does not know is `rows`; so is a style whose required field is missing on any item.
 */

export const CARD_KINDS = ["receipt", "list", "value"] as const;
export type CardKind = (typeof CARD_KINDS)[number];

export const CARD_STYLES = ["rows", "compact", "gallery", "agenda", "stat"] as const;
export type CardStyle = (typeof CARD_STYLES)[number];

export const TAG_TONES = ["neutral", "accent", "positive", "warning", "negative"] as const;
export type TagTone = (typeof TAG_TONES)[number];

/** The item icons a card may name (v2 section 11.2); another name is as if none was given. */
export const CARD_ICONS = ["check", "note", "link", "calendar", "image", "file", "person", "chart", "clock", "flag", "bell", "folder"] as const;
export type CardIcon = (typeof CARD_ICONS)[number];

export type CardTag = { text: string; tone: TagTone };

/** The fields of an item the second version adds; a state or undo answer may bring them too. */
type ItemFields = {
  /** The app's own words for a time ("后天 周四 08:00"), first on the secondary line. */
  when?: string;
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` in the app's zone: the agenda's day block and time. */
  date?: string;
  tags?: CardTag[];
  /** An absolute http(s) URL (ai-space resolves it against the app's public URL). */
  image?: string;
  icon?: CardIcon;
  /** A short value: the stat's big number, the compact row's right side. */
  value?: string;
  /** 0 to 1: a bar under the secondary line of a `rows` item. */
  progress?: number;
};

export type CardItem = ItemFields & { id: string; title: string; detail?: string; url?: string; version?: number };

export type Card = {
  v: 1;
  kind: CardKind;
  title?: string;
  items: CardItem[];
  /** A `value` card's value as shown. */
  text?: string;
  /** The capability that answers the items' current state; without it the card shows what was printed. */
  state?: string;
  actions?: { undo?: string };
  /** The style as the card named it; `cardStyle` says how it is drawn. */
  style?: string;
};

export type ItemStatus = "active" | "done" | "removed";

/** One item as the card's `state` or `undo` capability answers it. */
export type CardItemState = ItemFields & { id: string; status: ItemStatus; title?: string; detail?: string; url?: string; version?: number; changed?: boolean };

/**
 * A card as a message holds it: its index in its cards event (what an action names), that event's
 * token (memory only, never stored) and what this client learned since it was shown.
 */
export type ShownCard = {
  card: Card;
  /** The card exactly as ai-space sent it: what the state call sends back to be checked again. */
  raw: unknown;
  index: number;
  token?: string;
  /** The items' current state by id, from the state call and the undo answers. */
  states: Record<string, CardItemState>;
  busy: boolean;
  /** The token was refused (409 `readOnly`): no undo controls any more. */
  readOnly: boolean;
  /** The last action's problem, or the read-only notice. */
  note?: string;
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : undefined);
const idOf = (v: unknown): string | undefined => (typeof v === "number" && Number.isInteger(v) ? String(v) : typeof v === "string" && v.trim() ? v.trim() : undefined);
const httpUrl = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined);
const version = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export type CardDate = { year: number; month: number; day: number; time?: string };

/** A `date` field read: a real calendar day, with `HH:MM` when it has a time; undefined otherwise. */
export function parseCardDate(v: unknown): CardDate | undefined {
  if (typeof v !== "string") return undefined;
  const m = DATE_RE.exec(v);
  if (!m) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return undefined;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59)) return undefined;
  return { year, month, day, ...(m[4] !== undefined ? { time: `${m[4]}:${m[5]}` } : {}) };
}

function itemFields(raw: Obj): ItemFields {
  const f: ItemFields = {};
  const when = text(raw.when);
  if (when) f.when = when;
  if (parseCardDate(raw.date)) f.date = raw.date as string;
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags.flatMap((t): CardTag[] => {
      const s = isObj(t) ? text(t.text) : undefined;
      if (!s) return [];
      const tone = (TAG_TONES as readonly unknown[]).includes((t as Obj).tone) ? ((t as Obj).tone as TagTone) : "neutral";
      return [{ text: s, tone }];
    });
    if (tags.length) f.tags = tags.slice(0, 4);
  }
  const image = httpUrl(raw.image);
  if (image) f.image = image;
  if ((CARD_ICONS as readonly unknown[]).includes(raw.icon)) f.icon = raw.icon as CardIcon;
  const value = text(raw.value);
  if (value) f.value = value;
  if (typeof raw.progress === "number" && raw.progress >= 0 && raw.progress <= 1) f.progress = raw.progress;
  return f;
}

function decodeItem(raw: unknown): CardItem | undefined {
  if (!isObj(raw)) return undefined;
  const id = idOf(raw.id);
  const title = text(raw.title);
  if (!id || !title) return undefined;
  const detail = text(raw.detail);
  const url = httpUrl(raw.url);
  const v = version(raw.version);
  return { id, title, ...(detail ? { detail } : {}), ...(url ? { url } : {}), ...(v !== undefined ? { version: v } : {}), ...itemFields(raw) };
}

/** One card as ai-space sent it, or undefined when it is not one this client can draw. */
export function decodeCard(raw: unknown): Card | undefined {
  if (!isObj(raw) || raw.v !== 1 || !(CARD_KINDS as readonly unknown[]).includes(raw.kind)) return undefined;
  const kind = raw.kind as CardKind;
  const items = Array.isArray(raw.items) ? raw.items.map(decodeItem).filter((i): i is CardItem => i !== undefined) : [];
  const title = text(raw.title);
  const value = text(raw.text);
  if (kind === "value" ? !value : !items.length) return undefined;
  const state = text(raw.state);
  const undo = kind === "receipt" && isObj(raw.actions) ? text(raw.actions.undo) : undefined;
  return {
    v: 1,
    kind,
    ...(title ? { title } : {}),
    items,
    ...(value ? { text: value } : {}),
    ...(state ? { state } : {}),
    ...(undo ? { actions: { undo } } : {}),
    ...(typeof raw.style === "string" ? { style: raw.style } : {}),
  };
}

/** Cards in the order sent, each with its index in that list: what an action names, even when one before it could not be read. */
export type ReceivedCard = { card: Card; raw: unknown; index: number; token?: string };

export function decodeCards(raw: unknown): ReceivedCard[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r, index) => {
    const card = decodeCard(r);
    return card ? [{ card, raw: r, index }] : [];
  });
}

/** A live `cards` run event: its cards with the token that lets them act (a token only when one of them has actions). */
export function cardsEvent(ev: unknown): ReceivedCard[] {
  if (!isObj(ev) || ev.type !== "cards") return [];
  const token = typeof ev.token === "string" && ev.token ? ev.token : undefined;
  return decodeCards(ev.cards).map((c) => ({ ...c, ...(token ? { token } : {}) }));
}

/** The items of a state or undo answer; an item this client cannot read is left out. */
export function decodeItemStates(raw: unknown): CardItemState[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): CardItemState[] => {
    if (!isObj(r) || !["active", "done", "removed"].includes(r.status as string)) return [];
    const id = idOf(r.id);
    if (!id) return [];
    const title = text(r.title);
    const detail = text(r.detail);
    const url = httpUrl(r.url);
    const v = version(r.version);
    return [{ id, status: r.status as ItemStatus, ...(title ? { title } : {}), ...(detail ? { detail } : {}), ...(url ? { url } : {}), ...(v !== undefined ? { version: v } : {}), ...(r.changed === true ? { changed: true } : {}), ...itemFields(r) }];
  });
}

export function shownCard(c: ReceivedCard): ShownCard {
  return { card: c.card, raw: c.raw, index: c.index, ...(c.token ? { token: c.token } : {}), states: {}, busy: false, readOnly: false };
}

export function mergeStates(shown: ShownCard, items: CardItemState[]): void {
  shown.states = { ...shown.states, ...Object.fromEntries(items.map((i) => [i.id, i])) };
}

/**
 * How the card is drawn: its `style` when this client knows it and every item has what the style
 * needs (`gallery` an image, `agenda` a date, `stat` a value), else `rows`. `stat` is for `list`
 * and `value` cards; a `receipt` that names it is drawn as rows. Decided on the card as printed,
 * so a state answer arriving later never changes the layout.
 */
export function cardStyle(card: Card): CardStyle {
  const s = card.style;
  if (!(CARD_STYLES as readonly unknown[]).includes(s)) return "rows";
  const every = (has: (i: CardItem) => boolean) => card.items.every(has);
  switch (s as CardStyle) {
    case "gallery":
      return every((i) => Boolean(i.image)) ? "gallery" : "rows";
    case "agenda":
      return every((i) => parseCardDate(i.date) !== undefined) ? "agenda" : "rows";
    case "stat":
      return card.kind !== "receipt" && every((i) => Boolean(i.value)) ? "stat" : "rows";
    default:
      return s as CardStyle;
  }
}

/** The card can act: the reply is the conversation's latest, it came live with a token, the card has an undo, and ai-space has not refused the token. */
export function canUndo(shown: ShownCard, actionable: boolean): boolean {
  return actionable && !shown.readOnly && Boolean(shown.token) && Boolean(shown.card.actions?.undo);
}

/** An item that can still be undone: the card can act, and the item was neither undone nor changed elsewhere. */
export function undoable(shown: ShownCard, actionable: boolean, id: string): boolean {
  const s = shown.states[id];
  return canUndo(shown, actionable) && s?.status !== "removed" && !s?.changed;
}

/** The ids the header's Undo takes back. */
export function openIds(shown: ShownCard, actionable: boolean): string[] {
  return shown.card.items.filter((i) => undoable(shown, actionable, i.id)).map((i) => i.id);
}

/** The header button's words (web `undoLabel`): one item, all of several, or what is left of several once some were undone or changed. */
export function undoLabel<K extends string>(t: (key: K, vars?: Record<string, string | number>) => string, total: number, open: number): string {
  const tr = t as unknown as (key: string, vars?: Record<string, string | number>) => string;
  return total <= 1 ? tr("chat.card.undo") : open === total ? tr("chat.card.undoAll") : tr("chat.card.undoRest", { n: open });
}

/** Styles whose items have their own Undo; `compact` and `stat` only have the header's. */
export const rowUndoStyle = (style: CardStyle) => style !== "compact" && style !== "stat";

/** An item as drawn: the card's fields under the app's current answer; an undone one keeps only its title, id, picture and value. */
export type ShownItem = ItemFields & {
  id: string;
  title: string;
  detail: string[];
  url?: string;
  status: ItemStatus;
  changed: boolean;
};

export function shownItem(item: CardItem, s: CardItemState | undefined): ShownItem {
  const removed = s?.status === "removed";
  // The answer's fields over the card's (web `itemView`); an undone item then keeps its title, picture and value only.
  const fields: ItemFields = { ...pickFields(item), ...(s ? pickFields(s) : {}) };
  const detail = removed ? undefined : s?.detail || item.detail;
  const url = removed ? undefined : (s?.url ?? item.url);
  if (removed) {
    delete fields.when;
    delete fields.tags;
    delete fields.progress;
  }
  return {
    ...fields,
    id: item.id,
    title: (!removed && s?.title) || item.title,
    detail: detail ? detail.split(" · ").filter(Boolean) : [],
    ...(url ? { url } : {}),
    status: s?.status ?? "active",
    changed: s?.changed === true,
  };
}

function pickFields(f: ItemFields): ItemFields {
  const out: ItemFields = {};
  for (const k of ["when", "date", "tags", "image", "icon", "value", "progress"] as const) if (f[k] !== undefined) (out as Record<string, unknown>)[k] = f[k];
  return out;
}

/** The pill an item carries: Undone, Changed elsewhere or Done (web order). */
export function pillOf(i: Pick<ShownItem, "status" | "changed">): "undone" | "changed" | "done" | undefined {
  return i.status === "removed" ? "undone" : i.changed ? "changed" : i.status === "done" ? "done" : undefined;
}

/** What a `rows` or `agenda` item shows on the left: its picture, its icon while active, or the state circle. */
export function leadOf(i: Pick<ShownItem, "image" | "icon" | "status">, style: CardStyle): "image" | "icon" | "mark" {
  if (style === "rows" && i.image) return "image";
  return i.icon && i.status === "active" ? "icon" : "mark";
}

/** The compact row's right side: the value, else the time words, else the first part of the detail. */
export const compactValue = (i: ShownItem) => i.value ?? i.when ?? i.detail[0];
/** The gallery cell's second line: the time words, else the first part of the detail. */
export const galleryLine = (i: ShownItem) => i.when ?? i.detail[0];

const WEEKDAYS: Record<"en" | "zh", string[]> = {
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  zh: ["周日", "周一", "周二", "周三", "周四", "周五", "周六"],
};
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** One agenda row's day block: blank for the next items of the same day; the month under it when the month or year is not today's. */
export type AgendaDay = { day?: string; weekday?: string; month?: string; time?: string };

export function agendaDays(dates: (string | undefined)[], lang: "en" | "zh", today: { year: number; month: number }): AgendaDay[] {
  let prev = "";
  return dates.map((raw) => {
    const d = parseCardDate(raw);
    if (!d) return {};
    const key = `${d.year}-${d.month}-${d.day}`;
    const first = key !== prev;
    prev = key;
    const time = d.time ? { time: d.time } : {};
    if (!first) return time;
    const weekday = WEEKDAYS[lang][new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]!;
    const other = d.year !== today.year || d.month !== today.month;
    return { day: String(d.day), weekday, ...(other ? { month: lang === "zh" ? `${d.month}月` : MONTHS_EN[d.month - 1]! } : {}), ...time };
  });
}

/** The card routes beside an agent's chat routes: `/api/agents/cards`, or `/api/peers/<peer>/agents/cards` for a peer's agent. */
export function cardsBase(agentBase: string): string {
  return agentBase.replace(/\/agents\/[^/]+\/[^/]+$/, "/agents/cards");
}

/** `POST …/agents/cards/state`: the agent (`<app>/<agent>` on the machine the route reaches) and the card as received. */
export const stateBody = (agent: string, shown: Pick<ShownCard, "raw">) => ({ agent, card: shown.raw });

/** `POST …/agents/cards/action`: the token, the card's index in its event and the chosen ids; ai-space builds the app's request. */
export const actionBody = (token: string, index: number, ids: string[]) => ({ token, card: index, action: "undo", items: ids });

/** An action's answer, as the web reads it: read-only (409 `readOnly`), a problem to show, or the items' new state. */
export type ActionOutcome = { kind: "readOnly" } | { kind: "error"; note: string } | { kind: "ok"; items: CardItemState[] };

export function actionOutcome(status: number, body: string): ActionOutcome {
  let j: Obj = {};
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isObj(parsed)) j = parsed;
  } catch {}
  if (j.readOnly === true) return { kind: "readOnly" };
  if (status < 200 || status >= 300 || j.ok !== true) return { kind: "error", note: typeof j.error === "string" && j.error ? j.error : `HTTP ${status}` };
  return { kind: "ok", items: decodeItemStates(j.items) };
}

/** A state answer's items, or none when it failed (the card then shows what was printed). */
export function stateItems(body: unknown): CardItemState[] {
  return isObj(body) && body.ok === true ? decodeItemStates(body.items) : [];
}
