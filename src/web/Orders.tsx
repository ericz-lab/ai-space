import { useEffect, useRef, useState } from "react";
import type { DelegationView } from "../space/agents/delegation-view.ts";
import { parseResultHeader } from "../space/agents/delegation-view.ts";
import { stripStatus } from "../space/orders/status.ts";
import { type ChatImage, imageURL, readChatImages } from "./chat-images.ts";
import { mdHtml } from "./chat-markdown.ts";
import { historySteps, stepGroups, type HistoryStep } from "./chat-steps.ts";
import { Glyph, NoticeStep, ToolGroup, WorkStep } from "./ChatToolRow.tsx";
import { DelegationResult, DelegationStep, FullMark, RunSteps, useScrollToWaiting } from "./ChatWork.tsx";
import { type ModelChoice, dateTime, getJson, relTime, sendJson } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";
import { PAGE, chatHref } from "./panel-link.ts";
import { pollWhileVisible } from "./poll.ts";
import { postAnswer, stopRunAt, useLiveRun } from "./run-follow.ts";

// Orders window (docs/orders.md#the-page): every order the person gave, by topic.
// - A topic is one matter with its own Director conversation; its mark says when it needs the person or works.
// - Opening a topic shows its orders, the conversation (the status line taken out) and its delegations.
//   While the Director's turn runs it is followed here: its steps, approvals and questions are
//   answered on the page and Stop stops it. A delegation that runs is followed the same way, its
//   approvals answered on the delegate's own run.
// - The box on top takes a typed order (a pasted screenshot goes with it); inside a topic the box sends there.
// - Settings: how far back the sorting looks, where "needs you" goes, and the team (docs/orders.md#team).
// The list refreshes every 5 s while open; a deep link `#order=<id>` opens that order's topic on
// what waits for the person.

type TopicState = "working" | "needs-you" | "done" | "failed";
type TopicView = { id: number; title: string; sessionId: string | null; runId: string | null; state: TopicState; summary: string; createdAt: string; lastActiveAt: string; archived: boolean; orders?: number; asking?: string[]; delegations?: DelegationView[]; full?: boolean };
type OrderView = { id: number; label: string; topic: number | null; text: string; via: string | null; image?: { mime: string; bytes: number; url: string }; createdAt: string; routedBy: string | null; waiting: boolean };
type Settings = { topicDays: number; notify: string };
type ListView = { topics: TopicView[]; sorting: number; settings: Settings; channels: string[]; full: boolean };
type Permission = "ask" | "edit" | "full";
type Member = { role: string; title: string; i18n?: { zh?: { title?: string } }; agent: string; summary: string; model: string | null; permission: Permission; enabled: boolean; builtin: boolean; updatedAt: string };
/** An agent a member may be; a peer's carries its machine, whether it answers, why it cannot be used, and its machine's models. */
type TeamAgent = { id: string; title: string; description: string; builtin?: boolean; peer?: string; offline?: boolean; unavailable?: string; models?: ModelChoice[] };
type TeamView = { members: Member[]; options: ModelChoice[]; permissions: Permission[]; agents: TeamAgent[] };
type Message = { role: "user"; text: string } | { role: "ai"; text: string; steps?: HistoryStep[] };

const DOT: Record<TopicState, string> = { working: "ok", "needs-you": "paused", done: "", failed: "down" };
const STATE_KEY: Record<TopicState, Key> = { working: "orders.working", "needs-you": "orders.needsYou", done: "orders.done", failed: "orders.failed" };
const VIA_KEY: Record<string, Key> = { voice: "orders.viaVoice", type: "orders.viaType", screenshot: "orders.viaScreenshot", share: "orders.viaShare", pick: "orders.viaPick", paste: "orders.viaPaste" };
const PERM_KEY: Record<Permission, Key> = { ask: "orders.permAsk", edit: "orders.permEdit", full: "orders.permFull" };
const DIRECTOR = "space/director";
const DIRECTOR_BASE = "/api/agents/space/director";

/** The Director's words without the status line, also while it is still being written. */
export const liveWords = (text: string) => stripStatus(text).replace(/(^|\n)[ \t]*[〔【[][ \t]*(?:状态?|狀態?|s(?:t(?:a(?:t(?:u(?:s)?)?)?)?)?)?(?:[ \t]*[:：][^\n〕\]】]{0,20})?$/i, "");
/** A person's message without the order labels the turn message carries. */
export const personWords = (text: string) => text.replace(/^〔Order #\d+[^〕]*〕\n?/gm, "").trim();

export default function Orders({ open, onClose, focus }: { open: boolean; onClose: () => void; focus?: { order: number; at: number } | null }) {
  const { lang, t } = useLang();
  const [archived, setArchived] = useState(false);
  const [list, setList] = useState<ListView | null>(null);
  const [err, setErr] = useState("");
  const [openTopic, setOpenTopic] = useState<number | null>(null);
  // The topic a link opened, and when: its detail scrolls to what waits for the person.
  const [focused, setFocused] = useState<{ topic: number; at: number } | null>(null);
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
        setShowSettings(false);
        setArchived(d.topic.archived);
        setOpenTopic(d.topic.id);
        setFocused({ topic: d.topic.id, at: focus.at });
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
            <div key={tp.id} className={`taskrow orders-row${tp.state === "working" ? " running" : ""}${tp.state === "needs-you" ? " needs" : ""}${openTopic === tp.id ? " open" : ""}`}>
              <button className="task-main" aria-expanded={openTopic === tp.id} onClick={() => setOpenTopic(openTopic === tp.id ? null : tp.id)}>
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
                    {tp.state === "needs-you" ? <span className="orders-mark needs">{t("orders.needsYou")}</span>
                      : tp.state === "working" ? <span className="orders-mark working">{t("orders.working")}</span>
                      : <span className={tp.state === "failed" ? "orders-failed" : ""}>{t(STATE_KEY[tp.state])}</span>}
                    {tp.full && <FullMark />}
                    {(tp.delegations?.length ?? 0) > 0 && <span>{t("orders.delegationCount", { n: tp.delegations!.length })}</span>}
                    {(tp.asking?.[0] || tp.summary) && <span className="ev-data">{firstLine(tp.asking?.[0] || tp.summary)}</span>}
                  </span>
                </span>
              </button>
              {openTopic === tp.id && <TopicDetail topic={tp} focusAt={focused?.topic === tp.id ? focused.at : null} onChanged={load} />}
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

/** A restored message of the Director's conversation: the person's words, a delivered result, or the Director's steps. */
function HistoryMessageView({ m, known }: { m: Message; known: DelegationView[] }) {
  if (m.role === "user") return parseResultHeader(m.text) ? <div className="msg ai orders-ai"><DelegationResult text={m.text} /></div> : <div className="orders-msg person">{personWords(m.text)}</div>;
  if (!m.steps?.length) return <div className="msg ai orders-ai"><div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(stripStatus(m.text)) }} /></div>;
  return <div className="msg ai orders-ai">
    {stepGroups(historySteps(m.steps)).map((step) => Array.isArray(step) ?
      step.length > 1 ? <ToolGroup key={step[0]!.id} steps={step} folded /> : <div key={step[0]!.id} className="chat-tools">{step.map((tool) => <WorkStep key={tool.id} step={tool} />)}</div> :
      step.kind === "text" ? (stripStatus(step.text).trim() ? <div key={step.id} className="md" dangerouslySetInnerHTML={{ __html: mdHtml(stripStatus(step.text)) }} /> : null) :
      step.kind === "delegation" ? <DelegationStep key={step.id} id={step.delegationId} delegation={known.find((d) => d.id === step.delegationId)} /> :
      step.kind === "notice" ? <NoticeStep key={step.id} step={step} /> : null,
    )}
  </div>;
}

/** One topic opened: its orders, the Director's conversation and running turn, its delegations, and what can be done with it. */
function TopicDetail({ topic, focusAt, onChanged }: { topic: TopicView; focusAt: number | null; onChanged: () => void }) {
  const { lang, t } = useLang();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [delegations, setDelegations] = useState<DelegationView[] | null>(null);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [imported, setImported] = useState<ImportedTranscript | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [err, setErr] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const load = () => {
    getJson<{ orders: OrderView[]; topic?: TopicView; delegations?: DelegationView[]; transcript?: ImportedTranscript }>(`/api/orders/topics/${topic.id}`)
      .then((d) => { setOrders(d.orders); setDelegations(d.topic?.delegations ?? d.delegations ?? null); setImported(d.transcript ?? null); })
      .catch((e) => setErr(String((e as Error).message || e)));
    if (topic.sessionId)
      getJson<{ messages: Message[] }>(`${DIRECTOR_BASE}/sessions/${encodeURIComponent(topic.sessionId)}`)
        .then((d) => setMessages(d.messages))
        .catch(() => setMessages([]));
    else setMessages([]);
  };
  // Again whenever the topic changes: a turn ended, an order came in.
  useEffect(load, [topic.id, topic.lastActiveAt, topic.state, topic.sessionId]);
  // The Director's turn, followed while it runs; at its end the transcript holds it.
  const watching = !!topic.runId && (topic.state === "working" || topic.state === "needs-you");
  const run = useLiveRun(DIRECTOR_BASE, topic.runId, watching, () => { onChanged(); load(); });
  useEffect(() => setStopping(false), [topic.runId, run.live]);
  useScrollToWaiting(root, focusAt, topic.state === "needs-you" || !!topic.asking?.length || (topic.delegations ?? []).some((d) => d.state === "waiting"));
  const act = (p: Promise<unknown>) => p.then(() => { setErr(""); onChanged(); load(); }).catch((e) => setErr(String((e as Error).message || e)));
  const rename = () => {
    if (renaming?.trim() && renaming.trim() !== topic.title) act(sendJson("PATCH", `/api/orders/topics/${topic.id}`, { title: renaming.trim() }));
    setRenaming(null);
  };
  const stop = () => {
    if (!topic.runId) return;
    setStopping(true);
    stopRunAt(DIRECTOR_BASE, topic.runId).catch((e) => { setStopping(false); setErr(t("chat.stopFailed", { error: (e as Error).message })); });
  };
  // The transcript may already hold the running turn: cut it at the run's own message.
  let history = messages ?? [];
  if (run.live && run.message) {
    const at = history.findLastIndex((m) => m.role === "user" && m.text.trim() === run.message!.trim());
    if (at >= 0) history = history.slice(0, at);
  }
  const shownDelegations = topic.delegations ?? delegations ?? [];
  return (
    <div className="task-detail orders-detail" ref={root}>
      {err && <p className="orders-err">{err}</p>}
      {topic.asking?.length ? (
        <div className="orders-asking">
          {topic.asking.map((a, i) => (
            <p key={i}>{a}</p>
          ))}
        </div>
      ) : null}
      {imported && <ImportedView transcript={imported} />}
      {(orders ?? []).map((o) => (
        <div key={o.id} className={`orders-order${o.waiting ? " waiting" : ""}`}>
          <div className="task-meta">
            <span className="task-badge">{o.label}</span>
            <span title={dateTime(o.createdAt, lang)}>{relTime(o.createdAt, lang)}</span>
            {o.via && VIA_KEY[o.via] && <span>{t(VIA_KEY[o.via]!)}</span>}
            {o.waiting && <span className="task-on">{t("orders.waiting")}</span>}
            {o.routedBy === "import" && <span>{t("orders.importedOrder")}</span>}
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
      {(history.length > 0 || run.live) && (
        <div className="orders-convo">
          {history.map((m, i) => <HistoryMessageView key={i} m={m} known={shownDelegations} />)}
          {run.live && (
            <>
              {run.message && (parseResultHeader(run.message) ? <div className="msg ai orders-ai"><DelegationResult text={run.message} /></div> : <div className="orders-msg person">{personWords(run.message)}</div>)}
              <div className="msg ai orders-ai">
                <RunSteps steps={run.steps} live={run.live} text={liveWords} onAnswer={(rid, decision, answers) => postAnswer(DIRECTOR_BASE, topic.runId!, rid, decision, answers).then((e) => (e === null ? null : t("chat.approval.failed", { error: e })))} />
                <div className="orders-live-foot">
                  <span className="msg-status">{t(run.steps.some((s) => s.kind === "approval" && s.state === "waiting") ? "orders.directorWaits" : "orders.directorWorking")}</span>
                  <button className="inbox-pill" disabled={stopping} onClick={stop}>
                    <Glyph name="stop" size={11} /> {t(stopping ? "chat.stopping" : "orders.stop")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {!run.live && topic.state === "working" && <p className="task-desc">{run.error ? t("common.unavailable", { error: run.error }) : t("orders.directorWorking")}</p>}
      {shownDelegations.length > 0 && (
        <div className="orders-delegations">
          <p className="orders-head">{t("orders.delegations")}</p>
          <div className="msg ai orders-ai">
            {shownDelegations.map((d) => <DelegationStep key={d.id} delegation={d} follow onChanged={onChanged} />)}
          </div>
        </div>
      )}
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

/** An imported room's conversation (hive): read-only, folded; the first new turn in the topic was given it. */
type ImportedTranscript = { source: string; given: boolean; lines: { at: string; who: string; text: string }[] };

function ImportedView({ transcript: tr }: { transcript: ImportedTranscript }) {
  const { lang, t } = useLang();
  return (
    <details className="orders-imported">
      <summary>{t("orders.imported", { source: tr.source, n: tr.lines.length })}</summary>
      <p className="task-desc">{t(tr.given ? "orders.importedGiven" : "orders.importedNote")}</p>
      {tr.lines.map((l, i) => (
        <div key={i} className={`orders-msg${l.who === "person" ? " person" : ""}`}>
          <small title={dateTime(l.at, lang)}>{l.who === "person" ? t("orders.importedPerson") : l.who} · {relTime(l.at, lang)}</small>
          <div className="inbox-text">{l.text}</div>
        </div>
      ))}
    </details>
  );
}

/** The two settings, and the team. */
function OrdersSettings({ settings, channels, onSaved }: { settings: Settings; channels: string[]; onSaved: () => void }) {
  const { t } = useLang();
  const [err, setErr] = useState("");
  const save = (body: Partial<Settings>) => sendJson("PUT", "/api/orders/settings", body).then(() => { setErr(""); onSaved(); }).catch((e) => setErr(String((e as Error).message || e)));
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
      {err && <p className="orders-err">{err}</p>}
      <TeamSection onSaved={onSaved} />
    </div>
  );
}

type MemberChange = { role: string; title?: string; i18n?: Member["i18n"]; agent?: string; summary?: string; model?: string | null; permission?: Permission; enabled?: boolean };

/**
 * The team (docs/orders.md#team): every member with its title, what it is given, its model and
 * permission and whether the Director may use it; a member added from this Space's agents; one
 * the person added removed. Every change is one `PUT /api/team`; a refusal is shown as it came.
 */
function TeamSection({ onSaved }: { onSaved: () => void }) {
  const { t } = useLang();
  const [team, setTeam] = useState<TeamView | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<TeamView>("/api/team").then(setTeam).catch((e) => setErr(String((e as Error).message || e)));
  }, []);
  const put = (body: { members?: MemberChange[]; remove?: string[] }) =>
    sendJson<TeamView>("PUT", "/api/team", body)
      .then((d) => { setTeam(d); setErr(""); onSaved(); return true; })
      .catch((e) => { setErr(String((e as Error).message || e)); return false; });
  return (
    <section className="orders-team" aria-label={t("orders.team")}>
      <p className="orders-head">{t("orders.team")}</p>
      <p className="task-desc">{t("orders.team.blurb")}</p>
      {team === null && !err && <p className="task-desc">{t("common.loading")}</p>}
      {team?.members.map((m) => <MemberRow key={`${m.role}:${m.updatedAt}`} member={m} team={team} put={put} />)}
      {team && <AddMember team={team} put={put} />}
      <p className="task-desc">{t("orders.team.rulesNote")}</p>
      <p className="task-desc">{t("orders.modelNote")}</p>
      {err && <p className="orders-err" role="alert">{err}</p>}
    </section>
  );
}

function MemberRow({ member: m, team, put }: { member: Member; team: TeamView; put: (body: { members?: MemberChange[]; remove?: string[] }) => Promise<boolean> }) {
  const { lang, t } = useLang();
  const director = m.role === "director";
  // The title is edited in the panel's language: Chinese goes to `i18n.zh`, else the plain title.
  const shownTitle = (lang === "zh" && m.i18n?.zh?.title) || m.title;
  const [title, setTitle] = useState(shownTitle);
  const [summary, setSummary] = useState(m.summary);
  const change = (patch: Omit<MemberChange, "role">) => put({ members: [{ role: m.role, ...patch }] });
  const saveTitle = () => {
    const v = title.trim();
    if (!v || v === shownTitle) return setTitle(shownTitle);
    void change(lang === "zh" ? { i18n: { ...m.i18n, zh: { ...m.i18n?.zh, title: v } } } : { title: v });
  };
  const saveSummary = () => {
    if (summary.trim() !== m.summary.trim()) void change({ summary });
  };
  const info = team.agents.find((a) => a.id === m.agent);
  const agentTitle = info?.title;
  // A member on another machine takes that machine's models; its permission applies there.
  const machine = m.agent.split("/").length === 3 ? m.agent.split("/")[0]! : "";
  const options = machine ? (info?.models ?? []) : team.options;
  return (
    <div className={`orders-member${m.enabled ? "" : " off"}${m.permission === "full" ? " full" : ""}`}>
      <div className="orders-member-head">
        <input className="setselect orders-member-title" value={title} aria-label={t("orders.team.title")} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <span className="task-badge" title={m.agent}>{m.role}</span>
        {m.builtin && <span className="task-badge">{t("orders.team.builtin")}</span>}
        {m.permission === "full" && <FullMark />}
        {!m.builtin && (
          <button className="inbox-pill orders-member-remove" onClick={() => confirm(t("orders.team.removeConfirm", { name: shownTitle })) && void put({ remove: [m.role] })}>
            {t("orders.team.remove")}
          </button>
        )}
      </div>
      <small className="orders-member-agent">
        {agentTitle ? `${agentTitle} · ${m.agent}` : m.agent}
        {machine && ` · ${t("orders.team.onMachine", { machine })}`}
        {machine && info?.offline && ` · ${t("orders.team.offline")}`}
        {machine && !info && ` · ${t("orders.team.gone", { machine })}`}
      </small>
      {machine && info?.unavailable && <p className="orders-warn">{info.unavailable}</p>}
      <textarea className="orders-member-summary" rows={2} value={summary} placeholder={t("orders.team.summaryHint")} aria-label={t("orders.team.summary")} onChange={(e) => setSummary(e.target.value)} onBlur={saveSummary} />
      <div className="orders-member-opts">
        <label>
          <span>{t("orders.team.model")}</span>
          <select className="setselect" value={m.model ?? ""} onChange={(e) => void change({ model: e.target.value || null })}>
            <option value="">{t("orders.modelDefault")}</option>
            {m.model && !options.some((o) => o.value === m.model) && <option value={m.model}>{m.model}</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={!!o.unavailable && o.value !== m.model}>
                {o.value} · {o.model}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("orders.team.permission")}</span>
          <select className="setselect" value={m.permission} onChange={(e) => void change({ permission: e.target.value as Permission })}>
            {(team.permissions?.length ? team.permissions : (["ask", "edit", "full"] as Permission[])).map((p) => (
              <option key={p} value={p}>
                {t(PERM_KEY[p])}
              </option>
            ))}
          </select>
        </label>
        {director ? (
          <span className="task-desc orders-member-always">{t("orders.team.directorAlways")}</span>
        ) : (
          <label className="orders-member-enabled">
            <input type="checkbox" checked={m.enabled} onChange={(e) => void change({ enabled: e.target.checked })} />
            <span>{t("orders.team.enabled")}</span>
          </label>
        )}
      </div>
      {m.permission === "full" && <p className="orders-warn">{t("orders.team.fullWarning", { name: shownTitle })}</p>}
      {machine && m.permission !== "ask" && <p className="orders-warn">{t("orders.team.peerTrust", { name: shownTitle, machine })}</p>}
    </div>
  );
}

/** A short lowercase role from an agent's name: `ai-design/designer` → `designer`. */
const roleOf = (agent: string) => (agent.split("/").pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

function AddMember({ team, put }: { team: TeamView; put: (body: { members?: MemberChange[] }) => Promise<boolean> }) {
  const { t } = useLang();
  const [agent, setAgent] = useState("");
  const [role, setRole] = useState("");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const choices = team.agents.filter((a) => a.id !== DIRECTOR);
  const pick = (id: string) => {
    const a = choices.find((x) => x.id === id);
    setAgent(id);
    setRole(id ? roleOf(id) : "");
    setTitle(a?.title ?? "");
    setSummary(a?.description ?? "");
  };
  const add = async () => {
    if (!agent || !role.trim() || !title.trim() || busy) return;
    setBusy(true);
    const ok = await put({ members: [{ role: role.trim(), agent, title: title.trim(), summary }] });
    setBusy(false);
    if (ok) pick("");
  };
  return (
    <div className="orders-member orders-add">
      <label>
        <span>{t("orders.team.add")}</span>
        <select className="setselect" value={agent} onChange={(e) => pick(e.target.value)}>
          <option value="">{t("orders.team.pickAgent")}</option>
          {choices.filter((a) => !a.peer).map((a) => (
            <option key={a.id} value={a.id}>
              {a.title} · {a.id}
            </option>
          ))}
          {[...new Set(choices.filter((a) => a.peer).map((a) => a.peer!))].map((peer) => (
            <optgroup key={peer} label={t("orders.team.machineGroup", { machine: peer })}>
              {choices.filter((a) => a.peer === peer).map((a) => (
                <option key={a.id} value={a.id} disabled={!!a.offline || !!a.unavailable} title={a.unavailable}>
                  {a.title} · {a.id}{a.offline ? ` (${t("orders.team.offline")})` : a.unavailable ? ` (${t("orders.team.unavailable")})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {agent && (
        <>
          <div className="orders-member-opts">
            <label>
              <span>{t("orders.team.role")}</span>
              <input className="setselect orders-add-role" value={role} placeholder="designer" aria-describedby="orders-role-hint" onChange={(e) => setRole(e.target.value.toLowerCase())} />
            </label>
            <label>
              <span>{t("orders.team.title")}</span>
              <input className="setselect" value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
          </div>
          <small id="orders-role-hint" className="orders-member-agent">{t("orders.team.roleHint")}</small>
          <textarea className="orders-member-summary" rows={2} value={summary} placeholder={t("orders.team.summaryHint")} aria-label={t("orders.team.summary")} onChange={(e) => setSummary(e.target.value)} />
          <div className="orders-order-actions">
            <button className="inbox-pill on" disabled={busy || !role.trim() || !title.trim()} onClick={() => void add()}>
              {t("orders.team.addButton")}
            </button>
            <button className="inbox-pill" onClick={() => pick("")}>
              {t("common.cancel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
