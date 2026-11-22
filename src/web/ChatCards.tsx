import { useEffect, useState } from "react";
import type { Card, CardItemState } from "../space/agents/cards.ts";
import { useLang } from "./i18n.ts";

/**
 * The cards under an agent's reply (docs/chat-cards.md): what its tools did this turn, drawn like
 * the Shortcuts results (`sc-*`). Each card reads its items' current state from the app when shown,
 * so an undone or finished item says so. Undo shows only while the card's token is good: the reply
 * is the conversation's latest and came live; ai-space refuses it otherwise anyway.
 */

/** A card as a message holds it: its index in its cards event (what an action names) and that event's token. */
export type ShownCard = { card: Card; index: number; token?: string };

export function ChatCards({ cards, apiBase, agent, actionable }: { cards: ShownCard[]; /** `/api`, or `/api/peers/<peer>` for a peer's agent. */ apiBase: string; /** `<app>/<agent>` on the machine `apiBase` reaches. */ agent: string; actionable: boolean }) {
  return (
    <div className="chat-cards">
      {cards.map((c, i) => (
        <ChatCard key={`${c.token ?? "h"}:${c.index}:${i}`} shown={c} apiBase={apiBase} agent={agent} actionable={actionable} />
      ))}
    </div>
  );
}

function ChatCard({ shown, apiBase, agent, actionable }: { shown: ShownCard; apiBase: string; agent: string; actionable: boolean }) {
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
  return (
    <div className={`chat-card sc-result ${card.kind}`}>
      {card.title && <b className="chat-card-title">{card.title}</b>}
      {card.kind === "value" && <span className="sc-big">{card.text}</span>}
      {card.items.length > 0 && (
        <div className={card.kind === "list" ? "sc-list" : "sc-receipt"}>
          {card.items.map((item) => {
            const s = states[item.id];
            const removed = s?.status === "removed";
            const title = (!removed && s?.title) || item.title;
            const detail = (!removed && s?.detail) || item.detail;
            const url = removed ? undefined : s?.url ?? item.url;
            return (
              <div key={item.id} className={`sc-item ${removed ? "removed" : ""}`}>
                {url ? (
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    {title}
                  </a>
                ) : (
                  <span>{title}</span>
                )}
                <span className="sc-sub">
                  #{item.id}
                  {detail ? ` · ${detail}` : ""}
                </span>
                {removed && <span className="sc-badge">{t("chat.card.undone")}</span>}
                {s?.status === "done" && <span className="sc-badge ok">{t("chat.card.done")}</span>}
                {s?.changed && <span className="sc-badge unknown">{t("chat.card.changed")}</span>}
                {undoable(item.id) && card.items.length > 1 && (
                  <button className="sc-link" disabled={busy} onClick={() => void undo([item.id])}>
                    {t("chat.card.undo")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {open.length > 0 && (
        <div className="chat-card-actions">
          <button className="sc-btn ghost" disabled={busy} onClick={() => void undo(open)}>
            {open.length > 1 ? t("chat.card.undoAll", { n: open.length }) : t("chat.card.undo")}
          </button>
        </div>
      )}
      {note && <p className="sc-error">{note}</p>}
    </div>
  );
}
