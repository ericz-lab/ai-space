import { type ReactNode, useEffect, useState } from "react";
import type { Card, CardIcon, CardItem, CardItemState, CardStyle, CardTag } from "../space/agents/cards.ts";
import { type AgentInfo, type AppInfo, isImgIcon } from "./api.ts";
import { type Key, type Lang, localized, useLang, type Vars } from "./i18n.ts";

/**
 * The cards under an agent's reply (docs/chat-cards.md): what its tools did this turn, in a narrow
 * card headed by the app that did it. Each card reads its items' current state from the app when
 * shown, so an undone or finished item says so. Undo shows only while the card's token is good: the
 * reply is the conversation's latest and came live; ai-space refuses it otherwise anyway.
 */

/** A card as a message holds it: its index in its cards event (what an action names) and that event's token. */
export type ShownCard = { card: Card; index: number; token?: string };
/** The app of the agent, as the panel knows it: its icon (emoji or image URL) and display name. Either may be missing. */
export type CardApp = { icon?: string; name?: string };

/**
 * The icon and name heading an agent's cards: the agent's `appIcon` (the icon pack's over the
 * manifest's), and the title of its app on the same machine from the panel's app list. An app the
 * panel has no entry for (a peer's it has no snapshot of, the Space's own agents) gets no name.
 */
export function cardApp(agent: Pick<AgentInfo, "app" | "peer" | "appIcon">, apps: Pick<AppInfo, "name" | "peer" | "title" | "i18n" | "icon">[], lang: Lang): CardApp {
  const info = apps.find((a) => a.name === agent.app && (a.peer ?? "") === (agent.peer ?? ""));
  const icon = agent.appIcon || info?.icon;
  return { ...(icon ? { icon } : {}), ...(info ? { name: localized(lang, info).title } : {}) };
}

export function ChatCards({ cards, apiBase, agent, actionable, app }: { cards: ShownCard[]; /** `/api`, or `/api/peers/<peer>` for a peer's agent. */ apiBase: string; /** `<app>/<agent>` on the machine `apiBase` reaches. */ agent: string; actionable: boolean; app?: CardApp }) {
  return (
    <div className="chat-cards">
      {cards.map((c, i) => (
        <ChatCard key={`${c.token ?? "h"}:${c.index}:${i}`} shown={c} apiBase={apiBase} agent={agent} actionable={actionable} app={app} />
      ))}
    </div>
  );
}

/** The header button's words: one item, all of several, or what is left of several once some were undone or changed. */
export function undoLabel(t: (key: Key, vars?: Vars) => string, total: number, open: number): string {
  return total <= 1 ? t("chat.card.undo") : open === total ? t("chat.card.undoAll") : t("chat.card.undoRest", { n: open });
}

const UndoIcon = ({ size }: { size: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></svg>
);
const Chevron = () => (
  <svg className="chat-card-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
);

/** The app's icon on a 20px plate; nothing when there is none or its image does not load. */
function AppMark({ icon }: { icon?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [icon]);
  if (!icon || broken) return null;
  if (isImgIcon(icon)) return <span className="chat-card-app-icon"><img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} /></span>;
  return <span className="chat-card-app-icon solid" aria-hidden="true">{icon}</span>;
}

/** Stroke glyphs for an item's `icon` (24-unit grid, drawn like the undo arrow). */
const GLYPHS: Record<CardIcon, ReactNode> = {
  check: <path d="M20 6 9 17l-5-5" />,
  note: <><path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z" /><path d="M15 3v6h6" /></>,
  link: <><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3.3-3.3a4.5 4.5 0 0 0-6.4-6.4L12 5.6" /><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3.3 3.3a4.5 4.5 0 0 0 6.4 6.4l1.3-1.3" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4-4L6 21" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  chart: <><path d="M4 4v16h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  flag: <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 6 3 8 3 8H3s3-2 3-8" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
};
function Glyph({ name, size, className }: { name: CardIcon; size: number; className?: string }) {
  return <svg className={className} aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{GLYPHS[name]}</svg>;
}

/** What each style needs on every item; one item without it draws the whole card as `rows`. */
const NEEDS: Partial<Record<CardStyle, keyof CardItem>> = { gallery: "image", agenda: "date", stat: "value" };

/**
 * The style a card is drawn in: its `style`, unless an item lacks what that style needs, or it is a
 * `stat` receipt (stat is for `list` and `value` cards): then `rows`. Judged on the items as printed,
 * so the layout does not jump when the state answer arrives.
 */
export function drawnStyle(card: Pick<Card, "kind" | "style" | "items">): CardStyle {
  const style = card.style ?? "rows";
  if (style === "stat" && card.kind === "receipt") return "rows";
  const need = NEEDS[style];
  return need && card.items.some((i) => !i[need]) ? "rows" : style;
}

/** An `agenda` date block: the day, the weekday in the page language, and the month when it is not this month of this year. */
export function agendaDate(date: string, lang: Lang, today: Date = new Date()): { key: string; day: number; weekday: string; month?: string; time?: string } {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  const at = new Date(Date.UTC(y, m - 1, d));
  const locale = lang === "zh" ? "zh-CN" : "en";
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(at);
  const other = y !== today.getFullYear() || m !== today.getMonth() + 1;
  return { key: date.slice(0, 10), day: d, weekday, ...(other ? { month: new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" }).format(at) } : {}), ...(date.length > 10 ? { time: date.slice(11, 16) } : {}) };
}

type ItemState = "active" | "done" | "removed";
/** An item as shown: the card's item with the state answer laid over it. A removed item keeps its title, image and value only. */
export type ItemView = CardItem & { state: ItemState; changed: boolean };
const OVERRIDES = ["when", "date", "tags", "image", "icon", "value", "progress"] as const;
export function itemView(item: CardItem, s: CardItemState | undefined): ItemView {
  const removed = s?.status === "removed";
  const v: ItemView = { ...item, state: removed ? "removed" : s?.status === "done" ? "done" : "active", changed: !!s?.changed };
  for (const k of OVERRIDES) if (s?.[k] !== undefined) (v as Record<string, unknown>)[k] = s[k];
  v.title = (!removed && s?.title) || item.title;
  if (removed) {
    for (const k of ["detail", "url", "when", "tags", "progress"] as const) delete v[k];
  } else {
    v.detail = s?.detail || item.detail;
    v.url = s?.url ?? item.url;
  }
  return v;
}

const segments = (detail?: string) => detail?.split(" · ").filter(Boolean) ?? [];

function Tags({ tags }: { tags?: CardTag[] }) {
  return <>{tags?.map((tag, i) => <span key={i} className={`chat-card-tag ${tag.tone ?? "neutral"}`}>{tag.text}</span>)}</>;
}

/** An app's image: the placeholder (hairline ground, image glyph) shows until it loads, and stays when it does not. */
function Pic({ src, className }: { src?: string; className: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  return (
    <span className={`chat-card-pic ${className}`}>
      <Glyph name="image" size={className === "thumb" ? 16 : 22} className="chat-card-pic-ph" />
      {src && !broken && <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} />}
    </span>
  );
}

/** A link or a plain block, by whether there is somewhere to go. */
function Hit({ url, className, children }: { url?: string; className: string; children: ReactNode }) {
  return url ? <a className={className} href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <div className={className}>{children}</div>;
}

function ChatCard({ shown, apiBase, agent, actionable, app }: { shown: ShownCard; apiBase: string; agent: string; actionable: boolean; app?: CardApp }) {
  const { t, lang } = useLang();
  const { card, token, index } = shown;
  const [states, setStates] = useState<Record<string, CardItemState>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const merge = (items: CardItemState[]) => setStates((cur) => ({ ...cur, ...Object.fromEntries(items.map((i) => [i.id, i])) }));

  useEffect(() => {
    if (!card.state) return;
    let gone = false;
    fetch(`${apiBase}/agents/cards/state`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent, card }) })
      .then((r) => r.json() as Promise<{ ok: boolean; items?: CardItemState[] }>)
      .then((j) => { if (!gone && j.ok && j.items) merge(j.items); })
      .catch(() => {});
    return () => { gone = true; };
  }, [apiBase, agent, card]);

  const canUndo = actionable && !readOnly && !!token && !!card.actions?.undo;
  const undoable = (id: string) => canUndo && states[id]?.status !== "removed" && !states[id]?.changed;
  const undo = async (ids: string[]) => {
    setBusy(true);
    setNote("");
    try {
      const r = await fetch(`${apiBase}/agents/cards/action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, card: index, action: "undo", items: ids }) });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; items?: CardItemState[]; error?: string; readOnly?: boolean };
      if (j.readOnly) {
        setReadOnly(true);
        setNote(t("chat.card.readOnly"));
      } else if (!r.ok || !j.ok) setNote(j.error || `HTTP ${r.status}`);
      else if (j.items) merge(j.items);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = card.items.filter((i) => undoable(i.id)).map((i) => i.id);
  const many = card.items.length > 1;
  const name = app?.name;
  const style = drawnStyle(card);
  const views = card.items.map((i) => itemView(i, states[i.id]));
  const rowUndoButton = (v: ItemView, size: number, className: string) => (
    <button type="button" className={className} aria-label={t("chat.card.undoItem", { title: v.title })} title={t("chat.card.undo")} disabled={busy} onClick={() => void undo([v.id])}>
      <UndoIcon size={size} />
    </button>
  );
  const pillOf = (v: ItemView) => v.state === "removed" ? <span className="chat-card-pill">{t("chat.card.undone")}</span>
    : v.changed ? <span className="chat-card-pill warn">{t("chat.card.changed")}</span>
    : v.state === "done" ? <span className="chat-card-pill ok">{t("chat.card.done")}</span>
    : null;
  const mark = (v: ItemView) => v.state === "active" && v.icon ? <Glyph name={v.icon} size={18} className="chat-card-icon" /> : (
    <span className={`chat-card-mark ${v.state}`} aria-hidden="true">
      {v.state === "done" && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
    </span>
  );

  /** A two-line row (`rows`, and `agenda` with its date block before it). */
  const row = (v: ItemView, agenda?: { block: ReturnType<typeof agendaDate>; first: boolean }) => {
    const pill = pillOf(v);
    const rowUndo = many && undoable(v.id);
    // Read-only, the whole row opens the item; while the card can act, the title is the link.
    const rowLink = !canUndo && !!v.url;
    const lead = !agenda && v.image ? <Pic src={v.image} className="thumb" /> : mark(v);
    const body = (
      <>
        {agenda && (
          <span className="chat-card-day" aria-hidden={!agenda.first || undefined}>
            {agenda.first && <><b>{agenda.block.day}</b><small>{agenda.block.weekday}</small>{agenda.block.month && <small>{agenda.block.month}</small>}</>}
          </span>
        )}
        {lead}
        <span className="chat-card-text">
          {v.url && !rowLink ? (
            <a className="chat-card-name" href={v.url} target="_blank" rel="noopener noreferrer">{v.title}</a>
          ) : (
            <span className="chat-card-name">{v.title}</span>
          )}
          <span className="chat-card-meta">
            {agenda ? agenda.block.time && v.state !== "removed" && <span className="chat-card-time">{agenda.block.time}</span>
              : v.when && <span className="chat-card-when"><Glyph name="calendar" size={12} />{v.when}</span>}
            {segments(v.detail).map((seg, i) => <span key={i}>{seg}</span>)}
            <Tags tags={v.tags} />
            <span className="chat-card-id">#{v.id}</span>
          </span>
          {!agenda && v.progress !== undefined && (
            <span className="chat-card-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v.progress * 100)}><span style={{ width: `${v.progress * 100}%` }} /></span>
          )}
        </span>
        {pill}
        {rowUndo && rowUndoButton(v, 16, "chat-card-row-undo")}
        {rowLink && !pill && <Chevron />}
      </>
    );
    const cls = ["chat-card-row", v.state, rowUndo && "acts", !many && "single", agenda && "agenda", agenda && !agenda.first && "same-day"].filter(Boolean).join(" ");
    return rowLink ? (
      <a key={v.id} className={cls} href={v.url} target="_blank" rel="noopener noreferrer">{body}</a>
    ) : (
      <div key={v.id} className={cls}>{body}</div>
    );
  };

  let items: ReactNode;
  if (style === "compact") {
    items = views.map((v) => (
      <Hit key={v.id} url={v.url} className={`chat-card-line ${v.state}`}>
        <span className={`chat-card-dot ${v.state}`} aria-hidden="true" />
        <span className="chat-card-line-name">{v.title}</span>
        {(v.value || v.when || segments(v.detail)[0]) && <span className="chat-card-line-value">{v.value || v.when || segments(v.detail)[0]}</span>}
      </Hit>
    ));
  } else if (style === "gallery") {
    items = (
      <div className="chat-card-gallery">
        {views.map((v) => {
          const sub = v.when || segments(v.detail)[0];
          return (
            <div key={v.id} className={`chat-card-tile ${v.state}`}>
              <Hit url={v.url} className="chat-card-tile-hit">
                <Pic src={v.image} className="shot" />
                <span className="chat-card-tile-name">{v.title}</span>
                {sub && <span className="chat-card-tile-sub">{sub}</span>}
              </Hit>
              {v.state === "removed" && <span className="chat-card-pill chat-card-tile-pill">{t("chat.card.undone")}</span>}
              {many && undoable(v.id) && rowUndoButton(v, 14, "chat-card-tile-undo")}
            </div>
          );
        })}
      </div>
    );
  } else if (style === "agenda") {
    items = views.map((v, i) => {
      const block = agendaDate(v.date!, lang);
      return row(v, { block, first: i === 0 || views[i - 1]!.date!.slice(0, 10) !== block.key });
    });
  } else if (style === "stat") {
    items = (
      <div className="chat-card-stats">
        {views.map((v) => (
          <Hit key={v.id} url={v.url} className={`chat-card-stat ${v.state}`}>
            <span className="chat-card-stat-value">{v.value}</span>
            <span className="chat-card-stat-label"><span className="chat-card-stat-name">{v.title}</span><Tags tags={v.tags?.slice(0, 1)} /></span>
          </Hit>
        ))}
      </div>
    );
  } else items = views.map((v) => row(v));

  return (
    <section className={["chat-card", card.kind, style, canUndo && "live"].filter(Boolean).join(" ")} aria-label={[name, card.title].filter(Boolean).join(": ") || undefined}>
      <header className="chat-card-head">
        <AppMark icon={app?.icon} />
        {name && <b className="chat-card-app">{name}</b>}
        {card.title && <span className="chat-card-title" title={card.title}>{card.title}</span>}
        {open.length > 0 && (
          <button type="button" className="chat-card-undo" disabled={busy} onClick={() => void undo(open)}>
            <UndoIcon size={14} />
            {undoLabel(t, card.items.length, open.length)}
          </button>
        )}
      </header>
      {card.kind === "value" && <div className="chat-card-value">{card.text}</div>}
      {items}
      {note && <p className={readOnly ? "chat-card-note" : "chat-card-note error"} role="status">{note}</p>}
    </section>
  );
}
