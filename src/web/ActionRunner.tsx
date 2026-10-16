import { useEffect, useMemo, useRef, useState } from "react";
import { format as formatNumber } from "../space/shortcuts/calc.ts";
import { dateIn, resolveDate, resolvePeriod } from "../space/shortcuts/time.ts";
import { PERIODS } from "../space/shortcuts/types.ts";
import { getJson, sendJson } from "./api.ts";
import { type Key, LOCALE, type Lang, useLang } from "./i18n.ts";
import { type Action, type ActionInput, type RunResult, type RunView, actionText, browserZone, requestId } from "./shortcuts.ts";

// One action's form, its run and its result (docs/shortcuts.md): shared by the command box and the
// Shortcuts window, so both validate, preview and show results the same way. The form shows how
// relative dates read in the operator's zone and where a write goes before anything is submitted;
// a read runs on its button (or Enter), a write on Create, a task on Run, with no second prompt.
// The submit carries a request id, so a double click answers the first run instead of running twice.

const POLL_MS = 1_500;

export function useRun(initial?: RunView) {
  const [run, setRun] = useState<RunView | null>(initial ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const rid = useRef(requestId());
  // Follow a running run until it ends; the server keeps it if the window closes.
  useEffect(() => {
    if (run?.status !== "running") return;
    const timer = setTimeout(() => {
      getJson<{ run: RunView }>(`/api/shortcuts/runs/${run.id}`)
        .then((d) => setRun(d.run))
        .catch((e) => setError(String((e as Error).message || e)));
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [run]);
  const submit = async (action: Action, args: Record<string, unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const d = await sendJson<{ run: RunView }>("POST", "/api/shortcuts/runs", { action: action.id, ...(action.peer ? { peer: action.peer } : {}), args, timezone: browserZone(), requestId: rid.current });
      setRun(d.run);
      // The next submission is a new one.
      rid.current = requestId();
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    if (!run || busy) return;
    setBusy(true);
    try {
      setRun((await sendJson<{ run: RunView }>("POST", `/api/shortcuts/runs/${run.id}/retry`)).run);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  const reset = () => {
    setRun(null);
    setError("");
  };
  return { run, error, busy, submit, retry, reset };
}

/** The value an input opens with: the given argument, else its default. */
function initialArgs(action: Action, args: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of action.inputs) {
    const v = args[i.name] ?? i.default ?? (i.type === "task" || i.type === "choice" ? (i.options?.[0]?.value ?? "") : "");
    out[i.name] = String(v);
  }
  return out;
}

export default function ActionRunner({ action, args, autoRun, submitSignal, onOpenTasks, compact }: { action: Action; args: Record<string, unknown>; autoRun?: boolean; submitSignal?: number; onOpenTasks?: () => void; compact?: boolean }) {
  const { lang, t } = useLang();
  const text = actionText(action, lang);
  const [values, setValues] = useState(() => initialArgs(action, args));
  const { run, error, busy, submit, retry, reset } = useRun();
  const tz = browserZone();
  const payload = () => Object.fromEntries(Object.entries(values).filter(([, v]) => v !== "").map(([k, v]) => [k, action.inputs.find((i) => i.name === k)?.type === "number" ? Number(v.replace(/,/g, "")) : v]));
  const missing = action.inputs.filter((i) => i.required && !values[i.name]?.trim());
  const go = () => {
    if (!action.available || missing.length || busy) return;
    void submit(action, payload());
  };
  // A read whose required inputs are filled runs at once when the command box asked for it.
  const started = useRef(false);
  useEffect(() => {
    if (autoRun && !started.current && action.effect === "read" && !missing.length) {
      started.current = true;
      go();
    }
  }, []);
  // The command box's Enter, for the action it opened; a finished run is not submitted again.
  const lastSignal = useRef(submitSignal);
  useEffect(() => {
    if (submitSignal === lastSignal.current) return;
    lastSignal.current = submitSignal;
    if (!run || run.status === "error" || action.effect === "read") go();
  }, [submitSignal]);

  const button = action.effect === "write" ? t("sc.create") : action.effect === "run" ? t("sc.run") : t("sc.show");
  const zoned = action.inputs.some((i) => i.type === "date" || i.type === "time" || i.type === "period");

  return (
    <div className={`sc-runner${compact ? " compact" : ""}`}>
      {!action.available && <p className="sc-missing">{t("sc.unavailable", { reason: action.reason ?? "" })}</p>}
      {action.inputs.length > 0 && (
        <form
          className="sc-form"
          // Enter that ends an IME composition picks the candidate; it does not submit.
          onKeyDown={(e) => e.key === "Enter" && (e.nativeEvent.isComposing || e.keyCode === 229) && e.preventDefault()}
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          {action.inputs.map((i) => (
            <label key={i.name} className="sc-field">
              <span>
                {text.input(i)}
                {i.required ? " *" : ""}
              </span>
              <Field input={i} value={values[i.name] ?? ""} onChange={(v) => setValues((cur) => ({ ...cur, [i.name]: v }))} action={action} lang={lang} />
              <Resolved input={i} value={values[i.name] ?? ""} tz={tz} />
            </label>
          ))}
          <button type="submit" hidden />
        </form>
      )}
      <div className="sc-actions">
        <span className="sc-meta">
          {[action.effect === "write" ? t("sc.destination", { app: action.peer ? `${action.app} · ${action.peer}` : action.app }) : "", zoned ? t("sc.timezone", { tz }) : ""].filter(Boolean).join(" · ")}
        </span>
        {run && run.status !== "running" && (
          <button className="sc-btn ghost" onClick={reset}>
            {t("sc.again")}
          </button>
        )}
        {/* A write or a task that went through is not offered again from the same form: "New" starts over. */}
        {!(run && run.status !== "error" && action.effect !== "read") && (
          <button className="sc-btn" disabled={!action.available || missing.length > 0 || busy || run?.status === "running"} onClick={go}>
            {busy || run?.status === "running" ? t("sc.running") : button}
          </button>
        )}
      </div>
      {error && <p className="sc-error" role="alert">{error}</p>}
      {run && <RunCard run={run} action={action} onRetry={retry} busy={busy} onOpenTasks={onOpenTasks} />}
    </div>
  );
}

function Field({ input, value, onChange, action, lang }: { input: ActionInput; value: string; onChange: (v: string) => void; action: Action; lang: Lang }) {
  const { t } = useLang();
  const text = actionText(action, lang);
  switch (input.type) {
    case "number":
      return <input className="sc-input" inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "time":
      return <input className="sc-input" type="time" value={value} onChange={(e) => onChange(e.target.value)} />;
    case "date":
      return (
        <>
          <input className="sc-input" list="sc-dates" placeholder={t("sc.dateHint")} value={value} onChange={(e) => onChange(e.target.value.trim())} />
          <datalist id="sc-dates">
            <option value="today" />
            <option value="tomorrow" />
          </datalist>
        </>
      );
    case "period":
      return (
        <select className="setselect sc-input" value={value} onChange={(e) => onChange(e.target.value)}>
          {!input.required && <option value="">—</option>}
          {PERIODS.map((p) => (
            <option key={p} value={p}>
              {t(`sc.period.${p}` as Key)}
            </option>
          ))}
        </select>
      );
    case "choice":
    case "task":
      return (
        <select className="setselect sc-input" value={value} onChange={(e) => onChange(e.target.value)}>
          {!input.required && <option value="">—</option>}
          {(input.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {text.option(o.value, o.label)}
            </option>
          ))}
        </select>
      );
    default:
      return <input className="sc-input" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** How a relative date or period reads in the operator's zone, shown before the run. */
function Resolved({ input, value, tz }: { input: ActionInput; value: string; tz: string }) {
  const shown = useMemo(() => {
    if (!value) return "";
    try {
      if (input.type === "date" && value !== dateIn(Date.now(), tz) && !/^\d{4}-/.test(value)) return resolveDate(value, tz, Date.now());
      if (input.type === "period") {
        const p = resolvePeriod(value, tz, Date.now());
        return p.from === p.to ? p.from : `${p.from} – ${p.to}`;
      }
    } catch {
      return "";
    }
    return "";
  }, [input.type, value, tz]);
  return shown ? <em className="sc-resolved">{shown}</em> : null;
}

export function RunCard({ run, action, onRetry, busy, onOpenTasks }: { run: RunView; action?: Action; onRetry?: () => void; busy?: boolean; onOpenTasks?: () => void }) {
  const { t } = useLang();
  const retryable = run.status === "error" ? run.effect !== "run" : run.status === "unknown" && !!action?.idempotent;
  return (
    <div className={`sc-result ${run.status}`}>
      {run.status === "running" && !run.result && <p className="sc-note">{t("sc.status.running")}</p>}
      {run.result && <Result result={run.result} tz={run.timezone} onOpenTasks={onOpenTasks} />}
      {run.status === "error" && !(run.result?.kind === "task" && run.result.error) && <p className="sc-error">{run.error}</p>}
      {run.status === "unknown" && (
        <p className="sc-error">
          {t("sc.unknown", { app: action?.app ?? run.action.split("/")[0]! })} {action?.idempotent ? t("sc.unknownSafe") : ""}
          <br />
          <small>{run.error}</small>
        </p>
      )}
      {retryable && onRetry && (
        <button className="sc-btn ghost" disabled={busy} onClick={onRetry}>
          {t("sc.retry")}
        </button>
      )}
    </div>
  );
}

function Result({ result, tz, onOpenTasks }: { result: RunResult; tz?: string; onOpenTasks?: () => void }) {
  const { lang, t } = useLang();
  const zone = tz ?? browserZone();
  const when = (iso: string) => new Intl.DateTimeFormat(LOCALE[lang], { timeZone: zone, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  switch (result.kind) {
    case "value":
      return <ValueCard result={result} when={when} />;
    case "receipt":
      return (
        <div className="sc-receipt">
          <b>{t("sc.created")}</b>
          {result.items.map((i) => (
            <div key={i.id} className="sc-item">
              {i.url ? (
                <a href={i.url} target="_blank" rel="noopener noreferrer">
                  {i.title}
                </a>
              ) : (
                <span>{i.title}</span>
              )}
              <span className="sc-sub">
                #{i.id}
                {i.detail ? ` · ${i.detail}` : ""}
              </span>
            </div>
          ))}
        </div>
      );
    case "list":
      return (
        <div className="sc-list">
          {!result.items.length && <p className="sc-note">{t("sc.noItems")}</p>}
          {result.items.map((i, n) => (
            <div key={n} className="sc-item">
              {/* A wall clock from another zone says which; an all-day date has none. */}
              <span className="sc-when">{i.at ? when(i.at) : [i.date, i.time, i.time && i.timezone && i.timezone !== zone ? i.timezone : ""].filter(Boolean).join(" ")}</span>
              {i.url ? (
                <a href={i.url} target="_blank" rel="noopener noreferrer">
                  {i.title}
                </a>
              ) : (
                <span>{i.title}</span>
              )}
              {(i.source || i.tag) && <span className="sc-sub">{[i.tag, i.source].filter(Boolean).join(" · ")}</span>}
              {i.detail && <p className="sc-detail">{i.detail}</p>}
            </div>
          ))}
          {result.asOf && <p className="sc-sub">{t("sc.asOf", { time: when(result.asOf) })}</p>}
        </div>
      );
    case "task":
      return (
        <div className="sc-task">
          <b>{result.task}</b>
          <span className={`sc-badge ${result.status}`}>{t(`sc.status.${result.status}` as Key)}</span>
          <span className="sc-sub">{when(result.startedAt)}</span>
          {result.runId !== undefined && <span className="sc-sub">{t("sc.taskRun", { id: result.runId })}</span>}
          {onOpenTasks && (
            <button className="sc-link" onClick={onOpenTasks}>
              {t("sc.openTasks")}
            </button>
          )}
          {result.error && <p className="sc-error">{result.error}</p>}
          {result.output && <pre className="run-out">{result.output}</pre>}
        </div>
      );
  }
}

export function ValueCard({ result, when }: { result: Extract<RunResult, { kind: "value" }>; when?: (iso: string) => string }) {
  const { t } = useLang();
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(typeof result.value === "number" ? formatNumber(result.value) : String(result.value)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="sc-value">
      <span className="sc-big">{result.text}</span>
      <button className="sc-link" onClick={copy}>
        {copied ? t("sc.copied") : t("sc.copy")}
      </button>
      {result.detail && <span className="sc-sub">{result.detail}</span>}
      {(result.source || result.asOf) && (
        <span className="sc-sub">
          {result.source ? t("sc.source", { source: result.source }) : ""}
          {result.asOf && when ? ` · ${t("sc.asOf", { time: when(result.asOf) })}` : ""}
          {result.stale ? ` · ${t("sc.stale")}` : ""}
        </span>
      )}
    </div>
  );
}
