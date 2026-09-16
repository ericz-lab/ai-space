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
  days: (Totals & { day: string })[];
};
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

/** 1234 → 1.2K, 1234567 → 1.23M; a missing figure is a dash. */
export const fmtTokens = (n: number | undefined): string => {
  if (n === undefined) return "–";
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

export default function Usage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, t } = useLang();
  const [window, setWindow] = useState<(typeof WINDOWS)[number]>("24h");
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
                          {r.backend} · {r.origin === "task" ? t("usage.originTask") : t("usage.originRun")}
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
