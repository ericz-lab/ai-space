import { useEffect, useRef, useState, type RefObject } from "react";
import { ENDED_STATES, parseResultHeader, type DelegationNoteView, type DelegationView } from "../space/agents/delegation-view.ts";
import { dateTime, getJson, relTime, sendJson } from "./api.ts";
import { mdHtml } from "./chat-markdown.ts";
import { stepGroups, type ChatQuestion, type ChatStep } from "./chat-steps.ts";
import { Glyph, NoticeStep, WorkStep } from "./ChatToolRow.tsx";
import { useLang } from "./i18n.ts";
import { chatHref } from "./panel-link.ts";
import { agentPath, postAnswer, useLiveRun } from "./run-follow.ts";

/**
 * The work steps of a turn that the person acts on, shared by the chat window and the Orders page:
 * an approval, a question, a delegation (docs/orders.md#in-the-chat-view) and a delegation's result
 * delivered into the delegator's conversation. `RunSteps` draws a followed run's steps the way the
 * chat draws a live reply.
 */

/** An action the agent waits on: what it wants to do, and the person's answer while the turn runs. */
export function ApprovalStep({ step, onAnswer }: { step: ChatStep; onAnswer?: (decision: "allow" | "deny") => Promise<string | null> }) {
  const { t } = useLang();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const reply = async (decision: "allow" | "deny") => {
    setSending(true);
    setError("");
    const failed = await onAnswer!(decision);
    setSending(false);
    if (failed) setError(failed);
  };
  const waiting = step.state === "waiting" && !!onAnswer;
  return <section className={`chat-work chat-approval ${step.state}`} aria-label={step.name}>
    <div className="chat-work-head"><span className="chat-work-icon" aria-hidden="true"><Glyph name="shield" /></span><strong>{step.name}</strong><span className="chat-work-state">{t(`chat.step.${step.state}`)}</span></div>
    {step.text && <pre className="chat-work-input">{step.text}</pre>}
    {step.output && <p className="chat-approval-why">{step.output}</p>}
    {waiting && <div className="chat-approval-actions">
      <button className="primary" disabled={sending} onClick={() => void reply("allow")}>{t("chat.approval.allow")}</button>
      <button disabled={sending} onClick={() => void reply("deny")}>{t("chat.approval.deny")}</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </section>;
}

/**
 * A question the agent asks while its turn runs: pick an option or type an answer. One question
 * with one choice goes back on the click; otherwise the answers go back with Send. Skip answers
 * nothing and the agent goes on without it.
 */
export function QuestionStep({ step, onAnswer }: { step: ChatStep; onAnswer?: (answers: Record<string, string[]> | null) => Promise<string | null> }) {
  const { t } = useLang();
  const questions = step.questions ?? [];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const waiting = step.state === "waiting" && !!onAnswer;
  const answerOf = (q: ChatQuestion, p = picked, ty = typed): string[] => {
    const own = (ty[q.id] ?? "").trim();
    if (!q.multiSelect) return own ? [own] : p[q.id] ?? [];
    return [...(p[q.id] ?? []), ...(own ? [own] : [])];
  };
  const reply = async (answers: Record<string, string[]> | null) => {
    setSending(true);
    setError("");
    const failed = await onAnswer!(answers);
    setSending(false);
    if (failed) setError(failed);
  };
  const all = (p: Record<string, string[]>, ty: Record<string, string>) => Object.fromEntries(questions.map((q) => [q.id, answerOf(q, p, ty)]));
  const choose = (q: ChatQuestion, label: string) => {
    const current = picked[q.id] ?? [];
    const next = { ...picked, [q.id]: q.multiSelect ? (current.includes(label) ? current.filter((l) => l !== label) : [...current, label]) : [label] };
    const nextTyped = q.multiSelect ? typed : { ...typed, [q.id]: "" };
    setPicked(next);
    setTyped(nextTyped);
    if (questions.length === 1 && !q.multiSelect) void reply(all(next, nextTyped));
  };
  const ready = questions.every((q) => answerOf(q).length > 0);
  const shown = step.answers ?? {};
  return <section className={`chat-work chat-approval chat-question ${step.state}`} aria-label={t("chat.question.label")}>
    <div className="chat-work-head"><span className="chat-work-icon" aria-hidden="true"><Glyph name="question" /></span><strong>{t("chat.question.label")}</strong><span className="chat-work-state">{t(step.state === "allowed" ? "chat.question.answered" : step.state === "denied" ? "chat.question.skipped" : `chat.step.${step.state}`)}</span></div>
    {questions.map((q) => <div key={q.id} className="chat-question-item">
      {q.header && <small className="chat-question-header">{q.header}</small>}
      <p>{q.question}</p>
      {waiting ? <>
        {q.options.length > 0 && <div className="chat-question-options" role={q.multiSelect ? "group" : "radiogroup"}>
          {q.options.map((o) => {
            const on = (picked[q.id] ?? []).includes(o.label) && !(!q.multiSelect && (typed[q.id] ?? "").trim());
            return <button key={o.label} type="button" className={on ? "on" : ""} role={q.multiSelect ? "checkbox" : "radio"} aria-checked={on} disabled={sending} onClick={() => choose(q, o.label)}>
              <b>{o.label}</b>{o.description && <small>{o.description}</small>}
            </button>;
          })}
        </div>}
        <input className="chat-question-own" value={typed[q.id] ?? ""} disabled={sending} placeholder={t(q.options.length ? "chat.question.other" : "chat.question.type")} aria-label={t("chat.question.type")}
          onChange={(e) => setTyped({ ...typed, [q.id]: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && ready) { e.preventDefault(); void reply(all(picked, typed)); } }} />
      </> : shown[q.id]?.length ? <p className="chat-question-answer">→ {shown[q.id]!.join(", ")}</p> : null}
    </div>)}
    {waiting && <div className="chat-approval-actions">
      {(questions.length > 1 || questions.some((q) => q.multiSelect) || questions.some((q) => (typed[q.id] ?? "").trim())) && <button className="primary" disabled={sending || !ready} onClick={() => void reply(all(picked, typed))}>{t("chat.question.send")}</button>}
      <button disabled={sending} onClick={() => void reply(null)}>{t("chat.question.skip")}</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </section>;
}

/** Full permission in force (docs/orders.md#permission): no approval stands between the agent and a command. */
export function FullMark() {
  const { t } = useLang();
  return <span className="full-mark" title={t("full.title")}>{t("full.mark")}</span>;
}

/** Who a delegation went to, in words. */
const delegateName = (d: DelegationView) => d.to.title || d.to.role || d.to.agent;
const isEnded = (d: DelegationView) => (ENDED_STATES as readonly string[]).includes(d.state);

/** How an added message fared: read, taken but not read yet, or not taken and why. */
function SayFate({ note }: { note: DelegationNoteView }) {
  const { lang, t } = useLang();
  if (note.taken === false) return <small className="chat-dlg-fate refused">{t(note.reason === "ended" ? "dlg.notTaken.ended" : note.reason === "unsupported" ? "dlg.notTaken.unsupported" : note.reason === "unreachable" ? "dlg.notTaken.unreachable" : "dlg.notTaken")}</small>;
  if (note.readAt) return <small className="chat-dlg-fate read" title={dateTime(note.readAt, lang)}>{t("dlg.read", { time: relTime(note.readAt, lang) })}</small>;
  return <small className="chat-dlg-fate">{t("dlg.taken")}</small>;
}

/** A long text one click away: its first line as the summary. */
function Fold({ label, text, markdown, open: initial = false }: { label: string; text: string; markdown?: boolean; open?: boolean }) {
  const first = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  return <details className="chat-dlg-fold" open={initial}>
    <summary><b>{label}</b>{first && <span>{first}</span>}</summary>
    {markdown ? <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(text) }} /> : <pre>{text}</pre>}
  </details>;
}

/**
 * One delegation: who it went to, its state, the brief, each added message and how it fared, the
 * stop, the result, and the delegate's conversation. Without `delegation` it is read by `id`
 * (a restored transcript). With `follow`, while it runs, the delegate's own steps, approvals and
 * questions are drawn under it and answered on the delegate's run, and Stop stops the delegation.
 */
export function DelegationStep({ delegation, id, follow, onChanged }: { delegation?: DelegationView; id?: number; follow?: boolean; onChanged?: () => void }) {
  const { lang, t } = useLang();
  const [fetched, setFetched] = useState<DelegationView | null>(null);
  const [err, setErr] = useState("");
  const [stopping, setStopping] = useState(false);
  const wanted = delegation ? undefined : id;
  useEffect(() => {
    if (wanted === undefined) return;
    let live = true;
    getJson<{ delegation: DelegationView; notes?: DelegationNoteView[] }>(`/api/delegations/${wanted}`)
      .then((j) => { if (live) setFetched({ ...j.delegation, notes: j.delegation.notes?.length ? j.delegation.notes : j.notes ?? [] }); })
      .catch((e) => { if (live) setErr(t("dlg.unavailable", { error: (e as Error).message })); });
    return () => { live = false; };
  }, [wanted]);
  const d = delegation ?? fetched;
  const running = !!d && !isEnded(d);
  const base = d ? agentPath(d.to.agent, d.to.machine) : null;
  const run = useLiveRun(base, d?.to.runId ?? null, !!follow && running, onChanged);
  if (!d) return <section className="chat-work chat-delegation"><div className="chat-work-head"><span className="chat-work-icon" aria-hidden="true"><Glyph name="task" /></span><strong>{t("dlg.label", { id: id ?? "?" })}</strong></div><small>{err || t("dlg.loading")}</small></section>;
  const brief = d.notes.find((n) => n.kind === "brief");
  const says = d.notes.filter((n) => n.kind === "say");
  const stop = d.notes.find((n) => n.kind === "stop");
  const result = d.notes.findLast((n) => n.kind === "result");
  const stopIt = () => {
    setStopping(true);
    setErr("");
    sendJson("POST", `/api/delegations/${d.id}/stop`)
      .then(() => onChanged?.())
      .catch((e) => { setStopping(false); setErr(t("dlg.stopFailed", { error: (e as Error).message })); });
  };
  return <section className={`chat-work chat-delegation ${d.state}`} aria-label={t("dlg.label", { id: d.id })}>
    <div className="chat-work-head">
      <span className="chat-work-icon" aria-hidden="true"><Glyph name="task" /></span>
      <strong>{t("dlg.to", { who: delegateName(d) })}</strong>
      {d.to.machine && <small className="chat-dlg-id">{t("dlg.onMachine", { machine: d.to.machine })}</small>}
      <small className="chat-dlg-id" title={dateTime(d.createdAt, lang)}>#{d.id}{d.continued ? ` · ${t("dlg.continued", { id: d.continued })}` : ""}</small>
      {d.permission === "full" && <FullMark />}
      <span className="chat-work-state">{t(`dlg.state.${d.state}`)}</span>
    </div>
    {brief && <Fold label={t("dlg.brief")} text={brief.text} />}
    {says.map((n) => <div key={n.seq} className="chat-steer chat-dlg-say"><b>↳ {t("dlg.added")}</b> {n.text} <SayFate note={n} /></div>)}
    {running && d.unreachableSince && <p className="chat-dlg-note" role="status" title={dateTime(d.unreachableSince, lang)}>{t("dlg.unreachable", { machine: d.to.machine, time: relTime(d.unreachableSince, lang) })}</p>}
    {d.asking.length > 0 && <div className="chat-dlg-asking">{d.asking.map((a, i) => <p key={i}>{a}</p>)}</div>}
    {follow && run.steps.length > 0 && <div className="chat-dlg-run"><RunSteps steps={run.steps} live={run.live} steerBy={d.from.agent === "space/director" ? t("dlg.director") : d.from.agent} onAnswer={(rid, decision, answers) => postAnswer(base!, d.to.runId!, rid, decision, answers).then((e) => (e === null ? null : t("chat.approval.failed", { error: e })))} /></div>}
    {stop && <p className="chat-dlg-note">{t(stop.reason === "person" ? "dlg.stoppedByYou" : stop.reason === "delegator" ? "dlg.stoppedByDelegator" : "dlg.stopNote")}{stop.text ? ` · ${stop.text}` : ""}</p>}
    {result && <Fold label={t("dlg.result")} text={result.text} markdown />}
    {d.delivered === "held" && <p className="chat-dlg-note">{t("dlg.held")}</p>}
    <div className="chat-dlg-actions">
      {d.to.session && <a className="inbox-pill" href={chatHref(d.to.machine ? `${d.to.machine}/${d.to.agent}` : d.to.agent, d.to.session)} target="_blank" rel="noopener noreferrer">{t("dlg.open")} ↗</a>}
      {follow && running && <button className="inbox-pill" disabled={stopping} onClick={stopIt}>{t(stopping ? "dlg.stopping" : "dlg.stop")}</button>}
    </div>
    {(err || run.error) && <small role="alert">{err || run.error}</small>}
  </section>;
}

/**
 * A delegation's result as the delegator's conversation received it (a message starting with
 * `resultHeader`): folded to its header, the delegate's reply one click away.
 */
export function DelegationResult({ text }: { text: string }) {
  const { t } = useLang();
  const head = parseResultHeader(text);
  const body = text.trimStart().replace(/^〔[^〕]*〕\s*/, "");
  const state = head && (["done", "error", "stopped", "timeout", "interrupted", "running", "waiting"] as const).find((s) => s === head.state);
  return <details className={`chat-work chat-dlg-result ${head?.state ?? ""}`}>
    <summary className="chat-work-head">
      <span className="chat-work-icon" aria-hidden="true"><Glyph name="task" /></span>
      <strong>{t("dlg.resultOf", { id: head?.id ?? "?", who: head?.role ?? "" })}</strong>
      <span className="chat-work-state">{state ? t(`dlg.state.${state}`) : head?.state}</span>
    </summary>
    <div className="md" dangerouslySetInnerHTML={{ __html: mdHtml(body) }} />
  </details>;
}

/**
 * A followed run's steps drawn as the chat draws a live reply: tool calls stacked, text as
 * Markdown (through `text` when the caller hides part of it), approvals and questions answered
 * through `onAnswer` while it runs, notices, added messages, delegations. An added message is the
 * person's ("You") unless `steerBy` names who added it (a delegate's run: its delegator).
 */
export function RunSteps({ steps, live, onAnswer, text = (s) => s, steerBy }: { steps: ChatStep[]; live: boolean; onAnswer?: (requestId: string, decision: "allow" | "deny", answers?: Record<string, string[]>) => Promise<string | null>; text?: (s: string) => string; steerBy?: string }) {
  const { t } = useLang();
  const answer = live && onAnswer ? onAnswer : undefined;
  return <>{stepGroups(steps).map((step) => Array.isArray(step) ?
    <div key={step[0]!.id} className="chat-tools">{step.map((tool) => <WorkStep key={tool.id} step={tool} />)}</div> :
    step.kind === "text" ? (text(step.text).trim() ? <div key={step.id} className={`md ${step.state === "running" ? "live" : ""}`} dangerouslySetInnerHTML={{ __html: mdHtml(text(step.text)) }} /> : null) :
    step.kind === "approval" && step.questions ? <QuestionStep key={step.id} step={step} onAnswer={answer ? (answers) => answer(step.id.slice("approval:".length), answers ? "allow" : "deny", answers ?? undefined) : undefined} /> :
    step.kind === "approval" ? <ApprovalStep key={step.id} step={step} onAnswer={answer ? (decision) => answer(step.id.slice("approval:".length), decision) : undefined} /> :
    step.kind === "notice" ? <NoticeStep key={step.id} step={step} /> :
    step.kind === "delegation" ? <DelegationStep key={step.id} delegation={step.delegation} id={step.delegationId} /> :
    parseResultHeader(step.text) ? <DelegationResult key={step.id} text={step.text} /> :
    <div key={step.id} className="chat-steer"><b>↳ {steerBy ?? t("chat.steerYou")}</b> {step.text}</div>,
  )}</>;
}

/**
 * Scroll the first approval or question waiting in `root` into view once it shows; when nothing is
 * expected to wait (`waits` false), or nothing shows within `ms`, `root` itself. Once per `when`.
 */
export function useScrollToWaiting(root: RefObject<HTMLElement | null>, when: number | null | undefined, waits: boolean, ms = 15_000) {
  const done = useRef<number | null>(null);
  useEffect(() => {
    if (!when || done.current === when) return;
    const started = Date.now();
    const look = () => {
      const el = root.current?.querySelector<HTMLElement>(".chat-approval.waiting");
      if (!el && waits && Date.now() - started < ms) return false;
      done.current = when;
      (el ?? root.current)?.scrollIntoView({ block: el ? "center" : "start", behavior: "smooth" });
      el?.querySelector<HTMLElement>("button, input")?.focus({ preventScroll: true });
      return true;
    };
    const timer = setInterval(() => { if (look()) clearInterval(timer); }, 300);
    return () => clearInterval(timer);
  }, [when, waits]);
}
