import { useEffect, useState } from "react";
import type { Card, CardItemState } from "../space/agents/cards.ts";
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

function ChatCard({ shown, apiBase, agent, actionable, app }: { shown: ShownCard; apiBase: string; agent: string; actionable: boolean; app?: CardApp }) {
  const { t } = useLang();
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
  return (
    <section className={["chat-card", card.kind, canUndo && "live"].filter(Boolean).join(" ")} aria-label={[name, card.title].filter(Boolean).join(": ") || undefined}>
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
      {card.items.map((item) => {
        const s = states[item.id];
        const removed = s?.status === "removed";
        const done = s?.status === "done";
        const title = (!removed && s?.title) || item.title;
        const detail = removed ? undefined : s?.detail || item.detail;
        const url = removed ? undefined : s?.url ?? item.url;
        const pill = removed ? <span className="chat-card-pill">{t("chat.card.undone")}</span>
          : s?.changed ? <span className="chat-card-pill warn">{t("chat.card.changed")}</span>
          : done ? <span className="chat-card-pill ok">{t("chat.card.done")}</span>
          : null;
        const rowUndo = many && undoable(item.id);
        // Read-only, the whole row opens the item; while the card can act, the title is the link.
        const rowLink = !canUndo && !!url;
        const state = removed ? "removed" : done ? "done" : "active";
        const body = (
          <>
            <span className={`chat-card-mark ${state}`} aria-hidden="true">
              {done && <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>}
            </span>
            <span className="chat-card-text">
              {url && !rowLink ? (
                <a className="chat-card-name" href={url} target="_blank" rel="noopener noreferrer">{title}</a>
              ) : (
                <span className="chat-card-name">{title}</span>
              )}
              <span className="chat-card-meta">
                {detail?.split(" · ").filter(Boolean).map((seg, i) => <span key={i}>{seg}</span>)}
                <span className="chat-card-id">#{item.id}</span>
              </span>
            </span>
            {pill}
            {rowUndo && (
              <button type="button" className="chat-card-row-undo" aria-label={t("chat.card.undoItem", { title })} title={t("chat.card.undo")} disabled={busy} onClick={() => void undo([item.id])}>
                <UndoIcon size={16} />
              </button>
            )}
            {rowLink && !pill && <Chevron />}
          </>
        );
        const cls = ["chat-card-row", state, rowUndo && "acts", !many && "single"].filter(Boolean).join(" ");
        return rowLink ? (
          <a key={item.id} className={cls} href={url} target="_blank" rel="noopener noreferrer">{body}</a>
        ) : (
          <div key={item.id} className={cls}>{body}</div>
        );
      })}
      {note && <p className={readOnly ? "chat-card-note" : "chat-card-note error"} role="status">{note}</p>}
    </section>
  );
}
