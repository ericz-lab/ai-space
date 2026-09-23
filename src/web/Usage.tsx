import { useEffect, useState } from "react";
import { type AppInfo, dateTime, fmtDuration, getJson, relTime } from "./api.ts";
import { type Lang, localized, useLang } from "./i18n.ts";

// Usage window (a floating panel): what the model service recorded, read-only.
// - Reads `GET /api/model/usage?window=…` when opened and every 30 s while open.
// - One window at a time (5h matches a subscription's rolling quota; 24h, 7d, 30d for trends).
// - Rows are app → tag → model, largest first; a model table and the last calls follow.
// Token figures are what the runtime reported; a call with none shows a dash, nothing is estimated.

type Totals = { calls: number; errors: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; tokens: number; costUsd: number; durationMs: number };
type UsageInfo = {
  window: string;
  since: string;
  backend: string;
  totals: Totals;
  byApp: (Totals & { app: string })[];
  byTag: (Totals & { app: string; tag: string; model: string })[];
  byModel: (Totals & { model: string })[];
  byBackend: (Totals & { backend: string; origin: string })[];
  history: { firstAt?: string; totals: Totals; days: (Totals & { day: string })[] };
};
type Metric = "tokens" | "costUsd" | "calls";
const METRICS: Metric[] = ["tokens", "costUsd", "calls"];
type CallInfo = {
  id: number;
  app: string;
  tag: string;
  model: string;
  backend: string;
  origin: string;
  status: "ok" | "error";
  error?: string;
  startedAt: string;
  durationMs: number;
  usage?: { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };
  costUsd?: number;
};

const WINDOWS = ["5h", "24h", "7d", "30d"] as const;

/** 1234 → 1.2K, 1234567 → 1.23M, 2689400000 → 2.69B; a missing figure is a dash. */
export const fmtTokens = (n: number | undefined): string => {
  if (n === undefined) return "–";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
};

export const fmtCost = (usd: number | undefined): string => {
  if (usd === undefined) return "–";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
};

const DAY = 86400_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Monday of the UTC week a day belongs to. */
const weekStart = (ms: number) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;
const fmtMetric = (m: Metric, v: number) => (m === "costUsd" ? fmtCost(v) : m === "tokens" ? fmtTokens(v) : v.toLocaleString());

/**
 * The history: lifetime cards, a day grid over the last 52 weeks (one column per
 * week, Monday at the top, shade by quartile of the chosen metric among days with
 * calls) and weekly bars. Weeks are UTC, Monday-based, like the ledger's days.
 */
function History({ h, metric, setMetric }: { h: UsageInfo["history"]; metric: Metric; setMetric: (m: Metric) => void }) {
  const { lang, t } = useLang();
  const byDay = new Map(h.days.map((d) => [d.day, d]));
  const today = weekStart(Date.now());
  const firstWeek = today - 51 * 7 * DAY;
  const weeks: number[] = [];
  for (let w = firstWeek; w <= today; w += 7 * DAY) weeks.push(w);
  const values = h.days.map((d) => d[metric]).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)];
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0]! ? 1 : v <= cuts[1]! ? 2 : v <= cuts[2]! ? 3 : 4);
  const daysRecorded = h.firstAt ? Math.max(1, Math.ceil((Date.now() - new Date(h.firstAt).getTime()) / DAY)) : 0;

  const weekly = new Map<number, number>();
  for (const d of h.days) {
    const w = weekStart(Date.parse(`${d.day}T00:00:00Z`));
    weekly.set(w, (weekly.get(w) ?? 0) + d[metric]);
  }
  const bars = [...weekly.entries()].sort(([a], [b]) => a - b).slice(-12);
  const max = Math.max(1, ...bars.map(([, v]) => v));
  const months: { col: number; label: string }[] = [];
  let lastMonth = -1;
  weeks.forEach((w, i) => {
    const m = new Date(w).getUTCMonth();
    if (m !== lastMonth) {
      months.push({ col: i, label: new Date(w).toLocaleDateString(lang === "zh" ? "zh-CN" : "en", { month: "short", timeZone: "UTC" }) });
      lastMonth = m;
    }
  });

  return (
    <section className="task-group">
      <div className="task-app">
        <span className="svc-name">{t("usage.history")}</span>
        <span className="usage-windows">
          {METRICS.map((m) => (
            <button key={m} className={`usage-win${m === metric ? " on" : ""}`} onClick={() => setMetric(m)}>
              {t(`usage.metric.${m}`)}
            </button>
          ))}
        </span>
      </div>
      <div className="usage-cards">
        <div className="usage-card">
          <b>{daysRecorded}</b>
          <span>{t("usage.daysRecorded")}</span>
        </div>
        <div className="usage-card">
          <b>{h.totals.calls.toLocaleString()}</b>
          <span>{t("usage.calls")}{h.totals.errors ? t("usage.errors", { n: h.totals.errors }) : ""}</span>
        </div>
        <div className="usage-card">
          <b>{fmtTokens(h.totals.tokens)}</b>
          <span>{t("usage.tokens")}</span>
        </div>
        <div className="usage-card">
          <b>{fmtCost(h.totals.costUsd)}</b>
          <span>{t("usage.costPerDay", { cost: fmtCost(daysRecorded ? h.totals.costUsd / daysRecorded : 0) })}</span>
        </div>
      </div>
      <div className="usage-scroll">
        <div className="usage-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, 11px)` }}>
          {months.map((m) => (
            <span key={m.col} className="usage-month" style={{ gridColumn: m.col + 1 }}>
              {m.label}
            </span>
          ))}
          {weeks.map((w, col) =>
            [0, 1, 2, 3, 4, 5, 6].map((row) => {
              const ms = w + row * DAY;
              const d = byDay.get(dayKey(ms));
              const v = d ? d[metric] : 0;
              const future = ms > Date.now();
              return <i key={`${col}-${row}`} className={`usage-day l${future ? "x" : level(v)}`} style={{ gridColumn: col + 1, gridRow: row + 2 }} title={`${dayKey(ms)} · ${d ? fmtMetric(metric, v) : t("usage.noCalls")}`} />;
            }),
          )}
        </div>
      </div>
      {bars.length > 0 && (
        <div className="usage-bars">
          {bars.map(([w, v]) => (
            <div key={w} className={`usage-bar${w === today ? " partial" : ""}`} title={`${dayKey(w)} · ${fmtMetric(metric, v)}`}>
              <span className="usage-bar-val">{fmtMetric(metric, v)}</span>
              <i style={{ height: `${Math.max(2, Math.round((v / max) * 100))}%` }} />
              <span className="usage-bar-lbl">{dayKey(w).slice(5).replace("-", "/")}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function TokenCells({ t }: { t: { inputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number; outputTokens?: number } | undefined }) {
  return (
    <>
      <td>{fmtTokens(t?.inputTokens)}</td>
      <td>{fmtTokens(t?.cacheWriteTokens)}</td>
      <td>{fmtTokens(t?.cacheReadTokens)}</td>
      <td>{fmtTokens(t?.outputTokens)}</td>
    </>
  );
}

export default function Usage({ open, onClose, onBack }: { open: boolean; onClose: () => void; onBack?: () => void }) {
  const { lang, t } = useLang();
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("24h");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [calls, setCalls] = useState<CallInfo[]>([]);
  const [apps, setApps] = useState<Record<string, { title: string; i18n?: AppInfo["i18n"] }>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    const load = () =>
      Promise.all([getJson<UsageInfo>(`/api/model/usage?window=${window}`), getJson<{ calls: CallInfo[] }>("/api/model/calls?limit=30")])
        .then(([u, c]) => {
          setUsage(u);
          setCalls(c.calls || []);
          setErr("");
        })
        .catch((e) => setErr(String((e as Error).message || e)));
    load();
    getJson<{ apps: AppInfo[] }>("/api/apps?all=1")
      .then((d) => setApps(Object.fromEntries((d.apps || []).map((a) => [a.name, { title: a.title, ...(a.i18n ? { i18n: a.i18n } : {}) }]))))
      .catch(() => {});
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [open, window]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const label = (app: string) => {
    const a = apps[app];
    return a ? localized(lang as Lang, a).title : app;
  };
  const tot = usage?.totals;

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks usage" role="dialog" aria-label={t("usage.title")}>
        <div className="task-head">
          {onBack && (
            <button className="chat-hbtn back" title={t("common.back")} onClick={onBack}>
              ‹
            </button>
          )}
          <b>{t("usage.title")}</b>
          <span className="chat-sub">{usage ? t("usage.backend", { backend: usage.backend }) : ""}</span>
          <span className="usage-windows">
            {WINDOWS.map((w) => (
              <button key={w} className={`usage-win${w === window ? " on" : ""}`} onClick={() => setWindow(w)}>
                {w}
              </button>
            ))}
          </span>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="task-body">
          <p className="task-note">{t("usage.costNote")}</p>
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {usage === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {tot && (
            <div className="usage-cards">
              <div className="usage-card">
                <b>{tot.calls.toLocaleString()}</b>
                <span>{t("usage.calls")}{tot.errors ? t("usage.errors", { n: tot.errors }) : ""}</span>
              </div>
              <div className="usage-card">
                <b>{fmtTokens(tot.tokens)}</b>
                <span>{t("usage.tokens")}</span>
              </div>
              <div className="usage-card">
                <b>{fmtCost(tot.costUsd)}</b>
                <span>{t("usage.cost")}</span>
              </div>
              <div className="usage-card">
                <b>{fmtDuration(tot.durationMs, lang)}</b>
                <span>{t("usage.time")}</span>
              </div>
            </div>
          )}
          {usage && !usage.totals.calls && <p className="task-note">{t("usage.empty")}</p>}
          {usage && usage.byTag.length > 0 && (
            <section className="task-group">
              <div className="task-app">
                <span className="svc-name">{t("usage.byTag")}</span>
              </div>
              <div className="usage-scroll">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("usage.app")}</th>
                      <th>{t("usage.tag")}</th>
                      <th>{t("usage.model")}</th>
                      <th>{t("usage.calls")}</th>
                      <th title={t("usage.inputHint")}>{t("usage.input")}</th>
                      <th title={t("usage.cacheWriteHint")}>{t("usage.cacheWrite")}</th>
                      <th title={t("usage.cacheReadHint")}>{t("usage.cacheRead")}</th>
                      <th>{t("usage.output")}</th>
                      <th>{t("usage.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byTag.map((r) => (
                      <tr key={`${r.app}/${r.tag}/${r.model}`} className={r.errors ? "has-errors" : ""}>
                        <td title={r.app}>{label(r.app)}</td>
                        <td>{r.tag}</td>
                        <td>{r.model}</td>
                        <td title={r.errors ? t("usage.errors", { n: r.errors }) : undefined}>
                          {r.calls}
                          {r.errors ? <i className="usage-err">{r.errors}</i> : null}
                        </td>
                        <TokenCells t={r} />
                        <td>{fmtCost(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {usage && usage.byModel.length > 0 && (
            <section className="task-group">
              <div className="task-app">
                <span className="svc-name">{t("usage.byModel")}</span>
              </div>
              <div className="usage-scroll">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>{t("usage.model")}</th>
                      <th>{t("usage.calls")}</th>
                      <th>{t("usage.input")}</th>
                      <th>{t("usage.cacheWrite")}</th>
                      <th>{t("usage.cacheRead")}</th>
                      <th>{t("usage.output")}</th>
                      <th>{t("usage.cost")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byModel.map((r) => (
                      <tr key={r.model}>
                        <td>{r.model}</td>
                        <td>{r.calls}</td>
                        <TokenCells t={r} />
                        <td>{fmtCost(r.costUsd)}</td>
                      </tr>
                    ))}
                    {usage.byBackend.map((r) => (
                      <tr key={`${r.backend}/${r.origin}`} className="usage-dim">
                        <td>
                          {r.backend} · {r.origin === "task" ? t("usage.originTask") : r.origin === "import" ? t("usage.originImport") : t("usage.originRun")}
                        </td>
                        <td>{r.calls}</td>
                        <TokenCells t={r} />
                        <td>{fmtCost(r.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {usage && usage.history.totals.calls > 0 && <History h={usage.history} metric={metric} setMetric={setMetric} />}
          {calls.length > 0 && (
            <section className="task-group">
              <div className="task-app">
                <span className="svc-name">{t("usage.recent")}</span>
              </div>
              <div className="runs">
                {calls.map((c) => (
                  <div key={c.id} className="runrow" title={c.error || `${c.app}/${c.tag} · ${c.backend}`}>
                    <div className="run-line">
                      <span className={`status ${c.status === "ok" ? "ok" : "down"}`}>
                        <i />
                        {c.model}
                      </span>
                      <span className="usage-call">
                        {label(c.app)} · {c.tag}
                      </span>
                      <span className="run-time" title={dateTime(c.startedAt, lang)}>
                        {relTime(c.startedAt, lang)}
                      </span>
                      <span className="run-dur">
                        {c.usage ? `${fmtTokens(c.usage.inputTokens + c.usage.cacheWriteTokens + c.usage.cacheReadTokens + c.usage.outputTokens)} · ` : ""}
                        {c.costUsd !== undefined ? `${fmtCost(c.costUsd)} · ` : ""}
                        {fmtDuration(c.durationMs, lang)}
                      </span>
                    </div>
                    {c.error && <div className="run-err">{c.error}</div>}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
