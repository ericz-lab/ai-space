import { useEffect, useRef, useState } from "react";
import { stripStatus } from "../space/orders/status.ts";
import { type ChatImage, imageURL, readChatImages } from "./chat-images.ts";
import { mdHtml } from "./chat-markdown.ts";
import { type ModelChoice, dateTime, getJson, relTime, sendJson } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";
import { PAGE, chatHref } from "./panel-link.ts";
import { pollWhileVisible } from "./poll.ts";

// Orders window (docs/orders.md#the-page): every order the person gave, by topic.
// - A topic is one matter with its own Director conversation; its dot is its state.
// - Opening a topic shows its orders and the conversation (the status line taken out); a running
//   turn's approvals and questions are answered in the chat, which "Open in chat" opens on the topic's session.
// - The box on top takes a typed order (a pasted screenshot goes with it); inside a topic the box sends there.
// - Settings: how far back the sorting looks, where "needs you" goes, the Director's model and permission.
// The list refreshes every 5 s while open; a deep link `#order=<id>` opens that order's topic.

type TopicState = "working" | "needs-you" | "done" | "failed";
type TopicView = { id: number; title: string; sessionId: string | null; runId: string | null; state: TopicState; summary: string; createdAt: string; lastActiveAt: string; archived: boolean; orders?: number; asking?: string[] };
type OrderView = { id: number; label: string; topic: number | null; text: string; via: string | null; image?: { mime: string; bytes: number; url: string }; createdAt: string; routedBy: string | null; waiting: boolean };
type Settings = { topicDays: number; notify: string };
type ListView = { topics: TopicView[]; sorting: number; settings: Settings; channels: string[]; full: boolean };
type Member = { role: string; model: string | null; permission: "ask" | "edit" | "full" };
type TeamView = { members: Member[]; options: ModelChoice[] };
type Message = { role: string; text: string };

const DOT: Record<TopicState, string> = { working: "ok", "needs-you": "paused", done: "", failed: "down" };
const STATE_KEY: Record<TopicState, Key> = { working: "orders.working", "needs-you": "orders.needsYou", done: "orders.done", failed: "orders.failed" };
const VIA_KEY: Record<string, Key> = { voice: "orders.viaVoice", type: "orders.viaType", screenshot: "orders.viaScreenshot", share: "orders.viaShare", pick: "orders.viaPick", paste: "orders.viaPaste" };
const DIRECTOR = "space/director";

export default function Orders({ open, onClose, focus }: { open: boolean; onClose: () => void; focus?: { order: number; at: number } | null }) {
  const { lang, t } = useLang();
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<ListView | null>(null);
  const [err, setErr] = useState("");
  const [openTopic, setOpenTopic] = useState<number | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const request = useRef(0);

  const load = () => {
    const mine = ++request.current;
    return getJson<ListView>(`/api/orders${archived ? "?archived=1" : ""}`)
      .then((d) => {
        if (mine !== request.current) return;
        setList(d);
        setErr("");
      })
      .catch((e) => mine === request.current && setErr(String((e as Error).message || e)));
  };
  useEffect(() => {
    if (!open) return;
    setList(null);
    load();
    return pollWhileVisible(load, 5_000);
  }, [open, archived]);

  // A deep link names an order: open its topic (in the archive when it is archived).
  useEffect(() => {
    if (!open || !focus) return;
    getJson<{ order: OrderView; topic: TopicView | null }>(`/api/orders/${focus.order}`)
      .then((d) => {
        if (!d.topic) return;
        setArchived(d.topic.archived);
        setOpenTopic(d.topic.id);
      })
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [open, focus?.at]);

  useEffect(() => {
    if (!open || PAGE) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const topics = list?.topics ?? [];
  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks orders" role="dialog" aria-label={t("orders.title")}>
        <div className="task-head">
          <b>{t("orders.title")}</b>
          <span className="chat-sub">{list?.sorting ? t("orders.sorting", { n: list.sorting }) : ""}</span>
          <button className={`inbox-pill${showSettings ? " on" : ""}`} onClick={() => setShowSettings((s) => !s)}>
            {t("orders.settings")}
          </button>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        {showSettings && list && <OrdersSettings settings={list.settings} channels={list.channels} onSaved={load} />}
        {!showSettings && list?.full && <p className="orders-warn">{t("orders.fullWarning")}</p>}
        <OrderBox placeholder={t("orders.placeholder")} onSent={(topic) => { if (topic) setOpenTopic(topic); void load(); }} />
        <div className="inbox-filters">
          <button className={`inbox-pill${!archived ? " on" : ""}`} onClick={() => setArchived(false)}>
            {t("orders.open")}
          </button>
          <button className={`inbox-pill${archived ? " on" : ""}`} onClick={() => setArchived(true)}>
            {t("orders.archived")}
          </button>
        </div>
        <div className="task-body">
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {list === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {list !== null && !topics.length && <p className="task-note">{t(archived ? "orders.emptyArchived" : "orders.empty")}</p>}
          {topics.map((tp) => (
            <div key={tp.id} className={`taskrow orders-row${tp.state === "working" ? " running" : ""}${openTopic === tp.id ? " open" : ""}`}>
              <button className="task-main" onClick={() => setOpenTopic(openTopic === tp.id ? null : tp.id)}>
                <span className={`status ${DOT[tp.state]}`}>
                  <i />
                </span>
                <span className="task-text">
                  <span className="task-line">
                    <span className="task-name">{tp.title}</span>
                    {(tp.orders ?? 0) > 1 && <span className="task-badge">×{tp.orders}</span>}
                    <span className="task-sched">
                      <span title={dateTime(tp.lastActiveAt, lang)}>{relTime(tp.lastActiveAt, lang)}</span>
                    </span>
                  </span>
                  <span className="task-meta">
                    <span className={tp.state === "needs-you" ? "task-on" : tp.state === "failed" ? "orders-failed" : ""}>{t(STATE_KEY[tp.state])}</span>
                    {(tp.asking?.[0] || tp.summary) && <span className="ev-data">{firstLine(tp.asking?.[0] || tp.summary)}</span>}
                  </span>
                </span>
              </button>
              {openTopic === tp.id && <TopicDetail topic={tp} onChanged={load} />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The typed order: words, and a picture pasted or picked with it. Inside a topic it goes there. */
function OrderBox({ placeholder, topic, onSent }: { placeholder: string; topic?: number; onSent: (topic: number | null) => void }) {
  const { t } = useLang();
  const [text, setText] = useState("");
  const [image, setImage] = useState<ChatImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pick = useRef<HTMLInputElement>(null);
  const take = async (files: File[]) => {
    if (!files.length) return;
    try {
      setImage((await readChatImages(files.slice(0, 1), []))[0] ?? null);
      setErr("");
    } catch {
      setErr(t("orders.badImage"));
    }
  };
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const d = await sendJson<{ order: OrderView }>("POST", "/api/orders", { text, id: crypto.randomUUID(), ...(image ? { image: { mediaType: image.mediaType, data: image.data } } : {}), ...(topic ? { topic } : {}) });
      setText("");
      setImage(null);
      setErr("");
      onSent(d.order.topic);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`orders-box${topic ? " inside" : ""}`}>
      <div className="orders-input">
        <textarea
          rows={topic ? 1 : 2}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
            if (files.length) {
              e.preventDefault();
              void take(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="chat-hbtn" title={t("orders.attach")} onClick={() => pick.current?.click()}>
          📎
        </button>
        <button className="inbox-pill on" disabled={!text.trim() || busy} onClick={() => void send()}>
          {t("orders.send")}
        </button>
        <input ref={pick} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => { void take([...(e.target.files ?? [])]); e.target.value = ""; }} />
      </div>
      {image && (
        <div className="orders-thumb">
          <img src={imageURL(image)} alt="" />
          <button className="chat-hbtn" title={t("orders.removeImage")} onClick={() => setImage(null)}>
            ✕
          </button>
        </div>
      )}
      {err && <p className="orders-err">{err}</p>}
    </div>
  );
}

/** One topic opened: its orders, the Director's conversation, and what can be done with it. */
function TopicDetail({ topic, onChanged }: { topic: TopicView; onChanged: () => void }) {
  const { lang, t } = useLang();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const load = () => {
    getJson<{ orders: OrderView[] }>(`/api/orders/topics/${topic.id}`).then((d) => setOrders(d.orders)).catch((e) => setErr(String((e as Error).message || e)));
    if (topic.sessionId)
      getJson<{ messages: Message[] }>(`/api/agents/${DIRECTOR}/sessions/${encodeURIComponent(topic.sessionId)}`)
        .then((d) => setMessages(d.messages))
        .catch(() => setMessages([]));
    else setMessages([]);
  };
  // Again whenever the topic changes: a turn ended, an order came in.
  useEffect(load, [topic.id, topic.lastActiveAt, topic.state, topic.sessionId]);
  const act = (p: Promise<unknown>) => p.then(() => { setErr(""); onChanged(); load(); }).catch((e) => setErr(String((e as Error).message || e)));
  const rename = () => {
    if (renaming?.trim() && renaming.trim() !== topic.title) act(sendJson("PATCH", `/api/orders/topics/${topic.id}`, { title: renaming.trim() }));
    setRenaming(null);
  };
  return (
    <div className="task-detail orders-detail">
      {err && <p className="orders-err">{err}</p>}
      {topic.asking?.length ? (
        <div className="orders-asking">
          {topic.asking.map((a, i) => (
            <p key={i}>{a}</p>
          ))}
        </div>
      ) : null}
      {(orders ?? []).map((o) => (
        <div key={o.id} className={`orders-order${o.waiting ? " waiting" : ""}`}>
          <div className="task-meta">
            <span className="task-badge">{o.label}</span>
            <span title={dateTime(o.createdAt, lang)}>{relTime(o.createdAt, lang)}</span>
            {o.via && VIA_KEY[o.via] && <span>{t(VIA_KEY[o.via]!)}</span>}
            {o.waiting && <span className="task-on">{t("orders.waiting")}</span>}
          </div>
          <div className="inbox-text">{o.text}</div>
          {o.image && (
            <a href={o.image.url} target="_blank" rel="noopener noreferrer">
              <img className="orders-shot" src={o.image.url} alt={t("orders.screenshot")} loading="lazy" />
            </a>
          )}
          <div className="orders-order-actions">
            {o.waiting && topic.state === "failed" && (
              <button className="inbox-pill" onClick={() => act(sendJson("POST", `/api/orders/${o.id}/resend`))}>
                {t("orders.resend")}
              </button>
            )}
            <button className="inbox-pill" onClick={() => act(sendJson("POST", `/api/orders/${o.id}/move`, { title: firstLine(o.text).slice(0, 40) || t("orders.title") }))}>
              {t("orders.moveNew")}
            </button>
            <button className="inbox-pill" onClick={() => confirm(t("orders.deleteConfirm")) && act(sendJson("DELETE", `/api/orders/${o.id}`))}>
              {t("orders.delete")}
            </button>
          </div>
        </div>
      ))}
      {messages && messages.length > 0 && (
        <div className="orders-convo">
          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="orders-msg person">{m.text.replace(/^〔Order #\d+[^〕]*〕\n?/gm, "").trim()}</div>
            ) : (
              <div key={i} className="orders-msg director chat-md" dangerouslySetInnerHTML={{ __html: mdHtml(stripStatus(m.text)) }} />
            ),
          )}
        </div>
      )}
      {topic.state === "working" && <p className="task-desc">{t("orders.directorWorking")}</p>}
      <OrderBox placeholder={t("orders.followUp")} topic={topic.id} onSent={() => { onChanged(); load(); }} />
      <div className="inbox-actions">
        {topic.sessionId && (
          <a className="inbox-pill" href={chatHref(DIRECTOR, topic.sessionId)} target="_blank" rel="noopener noreferrer">
            {t("orders.openChat")} ↗
          </a>
        )}
        {renaming === null ? (
          <button className="inbox-pill" onClick={() => setRenaming(topic.title)}>
            {t("orders.rename")}
          </button>
        ) : (
          <input className="setselect orders-rename" autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === "Enter" && rename()} />
        )}
        <button className="inbox-pill" onClick={() => act(sendJson("PATCH", `/api/orders/topics/${topic.id}`, { archived: !topic.archived }))}>
          {t(topic.archived ? "orders.unarchive" : "orders.archive")}
        </button>
      </div>
    </div>
  );
}

/** The two settings, and the Director's row of the team: model and permission (Full warned about). */
function OrdersSettings({ settings, channels, onSaved }: { settings: Settings; channels: string[]; onSaved: () => void }) {
  const { t } = useLang();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<TeamView>("/api/team").then(setTeam).catch((e) => setErr(String((e as Error).message || e)));
  }, []);
  const director = team?.members.find((m) => m.role === "director");
  const save = (body: Partial<Settings>) => sendJson("PUT", "/api/orders/settings", body).then(() => { setErr(""); onSaved(); }).catch((e) => setErr(String((e as Error).message || e)));
  const saveDirector = (patch: Partial<Pick<Member, "model" | "permission">>) =>
    sendJson<TeamView>("PUT", "/api/team", { members: [{ role: "director", ...patch }] })
      .then((d) => { setTeam(d); setErr(""); onSaved(); })
      .catch((e) => setErr(String((e as Error).message || e)));
  return (
    <div className="orders-settings">
      <label>
        <span>{t("orders.topicDays")}</span>
        <select className="setselect" value={settings.topicDays} onChange={(e) => void save({ topicDays: Number(e.target.value) })}>
          {[1, 2, 3, 5, 7, 14, 30].map((d) => (
            <option key={d} value={d}>
              {t("orders.days", { n: d })}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{t("orders.notify")}</span>
        <select className="setselect" value={settings.notify} onChange={(e) => void save({ notify: e.target.value })}>
          <option value="default">{t("orders.notifyDefault")}</option>
          {channels.filter((c) => c !== "default").map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          <option value="off">{t("orders.notifyOff")}</option>
        </select>
      </label>
      {director && team && (
        <>
          <label>
            <span>{t("orders.directorModel")}</span>
            <select className="setselect" value={director.model ?? ""} onChange={(e) => void saveDirector({ model: e.target.value || null })}>
              <option value="">{t("orders.modelDefault")}</option>
              {team.options.map((o) => (
                <option key={o.value} value={o.value} disabled={!!o.unavailable && o.value !== director.model}>
                  {o.value} · {o.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("orders.permission")}</span>
            <select className="setselect" value={director.permission} onChange={(e) => void saveDirector({ permission: e.target.value as Member["permission"] })}>
              <option value="ask">{t("orders.permAsk")}</option>
              <option value="edit">{t("orders.permEdit")}</option>
              <option value="full">{t("orders.permFull")}</option>
            </select>
          </label>
          <p className={`task-desc${director.permission === "full" ? " orders-warn" : ""}`}>{t(director.permission === "full" ? "orders.fullWarning" : director.permission === "edit" ? "orders.permEditNote" : "orders.permAskNote")}</p>
          <p className="task-desc">{t("orders.modelNote")}</p>
        </>
      )}
      {err && <p className="orders-err">{err}</p>}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
