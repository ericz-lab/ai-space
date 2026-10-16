import type { AgentIntentView } from "../space/shortcuts/agent-intents.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalcError, evaluate, format } from "../space/shortcuts/calc.ts";
import ActionRunner, { ValueCard } from "./ActionRunner.tsx";
import { getJson, recordOpen, sendJson } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Entry } from "./Library.tsx";
import { opensByDefault, rank } from "./omnibox.ts";
import { parseKey } from "./screens.ts";
import { type Intent, type RunResult, type RunView, actionText, browserZone, complete } from "./shortcuts.ts";
import { LiveVoice, type VoiceState } from "./voice.ts";
import { Icon } from "./Tiles.tsx";

// The home screen's command box (docs/panel.md#omnibox): one field that finds an app, agent, widget
// or built-in tile by name, and hands anything else to Space Assistant as a new conversation. Enter
// acts on the highlighted row: the first match when its name holds what was typed, the "ask" row
// otherwise; ⌘/Ctrl+Enter always asks. The microphone streams audio to voice-studio and updates
// the field with provisional and final text; it never sends by itself.
//
// It also runs actions (docs/shortcuts.md): arithmetic shows its value as it is typed, "100 USD to
// CNY" converts with the rates provider's quote, and an action's keyword ("新闻", "todo …") or a
// task's name offers that action. Enter on an action row opens its form under the field: a read
// with its inputs filled runs at once, a write or a task waits for Create / Run. The result stays
// in the box; a run keeps going when the box closes and is listed in the Shortcuts window.

/** The last focus signal acted on; the box remounts each time the home screen is shown. */
let takenSignal = 0;

/** Live conversions, by arguments: the rates are quoted once a minute at most from here. */
const previews = new Map<string, { at: number; result: RunResult | { error: string } }>();
const PREVIEW_TTL_MS = 60_000;
/** A row of the list: something to run, an entry to open, or the question for the assistant. */
type Row = { type: "agentIntent"; intent: AgentIntentView } | { type: "intent"; intent: Intent } | { type: "entry"; entry: Entry } | { type: "ask" };
/** How many loose action matches (names, tasks) follow the library's entries. */
const LOOSE = 3;

export default function Omnibox({ entries, onOpen, onAsk, focusSignal, onOpenShortcuts, onOpenTasks, onAgentIntent }: { entries: Entry[]; onOpen: (key: string) => void; onAsk: (text: string) => void; focusSignal: number; onOpenShortcuts: () => void; onOpenTasks: () => void; onAgentIntent: (intent: AgentIntentView, text: string) => Promise<void> }) {
  const { lang, t } = useLang();
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const [resolution, setResolution] = useState<{ query: string; intents: Intent[]; agentIntents: AgentIntentView[] } | null>(null);
  const agentStarting = useRef(false);
  const [agentError, setAgentError] = useState("");
  const [resolving, setResolving] = useState(false);
  const [panel, setPanel] = useState<{ intent: Intent; autoRun: boolean } | null>(null);
  const [running, setRunning] = useState(0);
  // Enter in the field while an action is open submits it, like its button.
  const [submitTick, setSubmitTick] = useState(0);
  const loadedAt = useRef(0);
  // Runs still going, refreshed when the box takes focus (at most once a minute).
  const refresh = () => {
    if (Date.now() - loadedAt.current < 60_000) return;
    loadedAt.current = Date.now();
    getJson<{ runs: RunView[] }>("/api/shortcuts/runs?limit=20")
      .then((d) => setRunning(d.runs.filter((r) => r.status === "running").length))
      .catch(() => {});
  };
  useEffect(refresh, []);
  // A signal is taken once: coming back to the home screen later does not focus the field again.
  useEffect(() => {
    if (focusSignal === takenSignal) return;
    takenSignal = focusSignal;
    field.current?.focus();
  }, [focusSignal]);

  const results = useMemo(() => rank(q, entries), [q, entries]);
  useEffect(() => {
    let active = true;
    setResolution(null);
    setResolving(!!q.trim());
    if (!q.trim()) return;
    const timer = setTimeout(() => {
      sendJson<{ intents: Intent[]; agentIntents: AgentIntentView[] }>("POST", "/api/shortcuts/resolve", { text: q, timezone: browserZone() })
        .then((r) => { if (active) { setResolution({ query: q, ...r }); setResolving(false); } })
        .catch((e) => { if (active) { setAgentError(String(e.message || e)); setResolving(false); } });
    }, 180);
    return () => { active = false; clearTimeout(timer); };
  }, [q]);
  const found = useMemo(() => resolution?.query === q ? resolution.intents : [], [resolution, q]);
  const agentMatches = useMemo(() => resolution?.query === q ? resolution.agentIntents : [], [resolution, q]);
  // Direct results and an action named at the start come first; loose matches after the entries.
  const rows = useMemo<Row[]>(() => {
    const first = found.filter((i) => i.kind !== "action" || i.strong);
    const loose = found.filter((i) => i.kind === "action" && !i.strong).slice(0, LOOSE);
    if (agentMatches.length) return [...agentMatches.map((intent): Row => ({ type: "agentIntent", intent })), { type: "ask" }];
    return [...first.map((intent): Row => ({ type: "intent", intent })), ...results.map((entry): Row => ({ type: "entry", entry })), ...loose.map((intent): Row => ({ type: "intent", intent })), { type: "ask" }];
  }, [found, results, agentMatches]);
  const askIndex = rows.length - 1;
  const ambiguous = agentMatches.length ? agentMatches.length > 1 : found.some((i) => i.kind === "action" && i.ambiguous);
  const direct = agentMatches.length > 0 || found.length > 0 && (found[0]!.kind !== "action" || found[0]!.strong);
  // A new query highlights the row Enter would pick.
  useEffect(() => setSel(ambiguous ? -1 : direct ? 0 : opensByDefault(q, results[0]) ? 0 : askIndex), [q, rows]);
  // Typing again leaves the action that was opened.
  useEffect(() => { setPanel(null); setAgentError(""); }, [q]);

  const reset = () => {
    setQ("");
    field.current?.blur();
  };
  const open = (e: Entry) => {
    const id = parseKey(e.key)!.id;
    if (e.kind === "agent" || e.kind === "builtin") {
      if (e.kind === "builtin") recordOpen("builtin", id, "panel");
      onOpen(e.key);
    } else if (e.href) {
      if (e.kind === "app") recordOpen("app", id, "panel");
      window.open(e.href, "_blank", "noopener,noreferrer");
    } else return;
    reset();
  };
  const ask = () => {
    if (recorder.current) return;
    const text = q.trim();
    if (!text) return;
    onAsk(text);
    reset();
  };
  const runIntent = (intent: Intent) => {
    if (intent.kind === "calc") {
      try {
        void navigator.clipboard?.writeText(format(evaluate(intent.expression)));
      } catch {
        // an expression that does not evaluate has nothing to copy
      }
      return;
    }
    setPanel({ intent, autoRun: intent.kind === "convert" || (intent.action.effect === "read" && complete(intent.action, intent.args)) });
  };
  const act = (i: number) => {
    if (recorder.current || agentStarting.current || i < 0) return;
    const row = rows[i];
    if (!row || row.type === "ask") ask();
    else if (row.type === "agentIntent") {
      if (!row.intent.available) return;
      agentStarting.current = true;
      setAgentError("");
      void onAgentIntent(row.intent, q).then(reset).catch((e) => setAgentError((e as Error).message)).finally(() => { agentStarting.current = false; });
    }
    else if (row.type === "entry") open(row.entry);
    else runIntent(row.intent);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (recorder.current) { if (e.key === "Escape") recorder.current.stop(); if (e.key === "Enter") e.preventDefault(); return; }
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) ask();
      else if (panel) setSubmitTick((n) => n + 1);
      else if (q.trim() && resolution?.query === q) act(sel);
      else if (!resolving && rows[sel]?.type === "entry") act(sel);
    } else if (e.key === "ArrowDown" && q) {
      e.preventDefault();
      setSel((i) => Math.min(askIndex, i + 1));
    } else if (e.key === "ArrowUp" && q) {
      e.preventDefault();
      setSel((i) => Math.max(0, i - 1));
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (panel) setPanel(null);
      else if (q) setQ("");
      else field.current?.blur();
    }
  };
  // The field grows with what is typed or dictated, up to a few lines.
  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [q]);

  const [voice, setVoice] = useState<VoiceState | "off">("off");
  const [voiceError, setVoiceError] = useState("");
  const recorder = useRef<LiveVoice | null>(null);
  const voiceBusy = voice !== "off" && voice !== "idle";
  useEffect(() => {
    let active = true;
    if (typeof AudioWorkletNode === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    getJson<{ transcribe?: boolean }>("/api/voice")
      .then((d) => { if (active && d.transcribe) setVoice("idle"); })
      .catch(() => {});
    return () => { active = false; recorder.current?.dispose(); recorder.current = null; };
  }, []);
  const toggleVoice = () => {
    if (recorder.current) { recorder.current.stop(); return; }
    if (voice !== "idle") return;
    setVoiceError("");
    const session = new LiveVoice(q, setQ, (state) => {
      setVoice(state);
      if (state === "idle") { recorder.current = null; field.current?.focus(); }
    }, (error) => setVoiceError(t("omni.voiceFailed", { error })));
    recorder.current = session;
    void session.start();
  };

  const showList = !voiceBusy && focused && q.trim().length > 0 && !panel;
  return (
    <div className={`omni${showList ? " open" : ""}`}>
      <div className="omni-bar">
        <span className="omni-glyph" aria-hidden="true">
          ✦
        </span>
        <textarea
          ref={field}
          rows={1}
          className="omni-field"
          value={q}
          readOnly={voiceBusy}
          aria-busy={voiceBusy || resolving}
          placeholder={voice === "connecting" ? t("omni.connecting") : voice === "recording" ? t("omni.recording") : voice === "transcribing" ? t("omni.transcribing") : t("omni.placeholder")}
          aria-label={t("omni.label")}
          aria-expanded={showList}
          aria-controls="omni-list"
          role="combobox"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          onFocus={() => {
            setFocused(true);
            refresh();
          }}
          // A click on a row lands before the blur hides the list.
          onBlur={() => setTimeout(() => setFocused(false), 150)}
        />
        {voice !== "off" && (
          <button className={`omni-mic ${voice}`} title={(voice === "recording" || voice === "connecting") ? t("omni.stop") : t("omni.voice")} aria-label={(voice === "recording" || voice === "connecting") ? t("omni.stop") : t("omni.voice")} disabled={voice === "transcribing"} onClick={toggleVoice}>
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              {voice === "transcribing" ? <circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="30 14" className="omni-spinner" /> : voice === "recording" || voice === "connecting" ? <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /> : <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="9" y="3" width="6" height="12" rx="3" /><path d="M6 11v1a6 6 0 0 0 12 0v-1M12 18v3M9 21h6" /></g>}
            </svg>
          </button>
        )}
      </div>
      {resolving && showList && <p className="sc-sub" role="status">{t("omni.resolving")}</p>}
      {agentError && <p className="omni-error" role="alert">{agentError}</p>}
      {voiceError && <p className="omni-error">{voiceError}</p>}
      {showList && ambiguous && <p className="sc-sub" role="status">{t("sc.pattern.choose")}</p>}
      {showList && (
        <ul className="omni-list" id="omni-list" role="listbox">
          {rows.map((row, i) => {
            if (row.type === "ask") return null;
            if (row.type === "agentIntent") return (
              <li key={`agent-intent:${row.intent.id}`} role="option" aria-selected={i === sel} aria-disabled={!row.intent.available} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => act(i)}>
                <span className="omni-icon" aria-hidden="true">✦</span>
                <span className="omni-title">{row.intent.title}{!row.intent.available && <em> · {row.intent.reason}</em>}</span>
                <span className="omni-kind">{t("omni.skillAgent")}</span>
                {i === sel && row.intent.available && <kbd>↵</kbd>}
              </li>
            );
            if (row.type === "intent") return <IntentRow key={row.intent.key} intent={row.intent} on={i === sel} onHover={() => setSel(i)} onPick={() => act(i)} />;
            const e = row.entry;
            return (
              <li key={e.key} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onMouseDown={(ev) => ev.preventDefault()} onClick={() => act(i)}>
                <span className="omni-icon">
                  <Icon icon={e.icon} fallback={e.fallback} />
                </span>
                <span className="omni-title">{e.title}</span>
                <span className="omni-kind">
                  {e.kindLabel}
                  {e.peer ? ` · ${e.peer}` : ""}
                </span>
                {i === sel && <kbd>↵</kbd>}
              </li>
            );
          })}
          <li role="option" aria-selected={sel === askIndex} className={`omni-ask${sel === askIndex ? " on" : ""}`} onMouseEnter={() => setSel(askIndex)} onMouseDown={(ev) => ev.preventDefault()} onClick={ask}>
            <span className="omni-icon">
              <img src="/assistant.svg" alt="" />
            </span>
            <span className="omni-title">
              {t("omni.ask")}: <em>{q.trim()}</em>
            </span>
            <kbd>{sel === askIndex ? "↵" : navigator.platform.startsWith("Mac") ? "⌘↵" : "Ctrl+↵"}</kbd>
          </li>
        </ul>
      )}
      {panel && (
        <div className="omni-panel" role="region" aria-label={panel.intent.kind === "calc" ? t("omni.result") : actionText(panel.intent.action, lang).title}>
          <div className="omni-panel-head">
            <b>{panel.intent.kind === "calc" ? t("omni.result") : actionText(panel.intent.action, lang).title}</b>
            <button className="chat-hbtn" title={t("omni.back")} onClick={() => (setPanel(null), field.current?.focus())}>
              ✕
            </button>
          </div>
          {panel.intent.kind !== "calc" && <ActionRunner action={panel.intent.action} args={panel.intent.args} autoRun={panel.autoRun} submitSignal={submitTick} onOpenTasks={onOpenTasks} compact />}
        </div>
      )}
      {focused && !q.trim() && running > 0 && (
        <button className="omni-running" onMouseDown={(ev) => ev.preventDefault()} onClick={onOpenShortcuts}>
          {t("omni.running", { n: running })} · {t("sc.title")}
        </button>
      )}
    </div>
  );
}

/** One action row: the value right away for arithmetic, the quoted conversion, or what Enter opens. */
function IntentRow({ intent, on, onHover, onPick }: { intent: Intent; on: boolean; onHover: () => void; onPick: () => void }) {
  const { lang, t } = useLang();
  const [preview, setPreview] = useState<RunResult | { error: string } | null>(null);
  const convertKey = intent.kind === "convert" ? JSON.stringify(intent.args) : "";
  // Conversions are quoted after a short pause in typing, and reused for a minute.
  useEffect(() => {
    if (intent.kind !== "convert") return;
    const hit = previews.get(convertKey);
    if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) {
      setPreview(hit.result);
      return;
    }
    setPreview(null);
    const timer = setTimeout(() => {
      sendJson<{ result: RunResult }>("POST", "/api/shortcuts/preview", { action: intent.action.id, args: intent.args, timezone: browserZone() })
        .then((d) => d.result)
        .catch((e): { error: string } => ({ error: String((e as Error).message || e) }))
        .then((r) => {
          previews.set(convertKey, { at: Date.now(), result: r });
          setPreview(r);
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [convertKey]);

  let title: React.ReactNode;
  let kind: string;
  if (intent.kind === "calc") {
    let value: string;
    try {
      value = format(evaluate(intent.expression));
    } catch (e) {
      value = e instanceof CalcError ? e.message : String(e);
    }
    title = <span className="omni-value">= {value}</span>;
    kind = on ? t("omni.copyHint") : t("omni.result");
  } else if (intent.kind === "convert") {
    title = preview && "kind" in preview && preview.kind === "value" ? <ValueCard result={preview} /> : preview && "error" in preview ? <span className="omni-error-inline">{preview.error}</span> : <span className="omni-value">…</span>;
    kind = t("omni.convert");
  } else {
    const text = actionText(intent.action, lang);
    const option = intent.action.id === "space/run-task" ? intent.action.inputs[0]?.options?.find((o) => o.value === intent.args.task)?.label : undefined;
    const arg = intent.action.inputs.find((i) => i.query);
    const filled = arg && typeof intent.args[arg.name] === "string" ? (intent.args[arg.name] as string) : "";
    title = (
      <>
        {option ? `${text.title}: ${option}` : text.title}
        {intent.pattern ? <em> · {Object.entries(intent.args).map(([name, value]) => `${text.input(intent.action.inputs.find((i) => i.name === name)!)}: ${value}`).join(" · ")}</em> : filled && <em> · {filled}</em>}
        {!intent.action.available && <span className="omni-kind"> · {intent.action.reason}</span>}
      </>
    );
    kind = intent.action.id === "space/run-task" ? t("omni.runTask") : `${t("omni.action")}${intent.action.peer ? ` · ${intent.action.peer}` : ""}`;
  }
  return (
    <li role="option" aria-selected={on} className={`omni-intent${on ? " on" : ""}`} onMouseEnter={onHover} onMouseDown={(ev) => ev.preventDefault()} onClick={onPick}>
      <span className="omni-icon omni-glyph-icon" aria-hidden="true">
        {intent.kind === "calc" ? "＝" : intent.kind === "convert" ? "¤" : intent.action.effect === "write" ? "＋" : intent.action.effect === "run" ? "▶" : "⌕"}
      </span>
      <span className="omni-title">{title}</span>
      <span className="omni-kind">{kind}</span>
      {on && <kbd>↵</kbd>}
    </li>
  );
}
