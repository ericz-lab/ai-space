import { useEffect, useState } from "react";
import { dateTime, fmtDuration, getJson, relTime, type UsageKind, type UsageRow } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";

// App usage window (a floating panel, docs/usage.md): how often each app, agent and panel window
// was opened and for how long, read-only, in the Model usage window's style.
// - Reads `GET /api/usage?window=…&kind=…` when opened and every 60 s while open; the 30-day
//   sparkline reads the 30-day window whatever the chosen one.
// - Rows by time in use, then opens. An app without the heartbeat script has no time: a dash.

const WINDOWS = ["7d", "30d", "90d", "all"] as const;
type Win = (typeof WINDOWS)[number];
const KINDS: { value: UsageKind | "all"; label: Key }[] = [
  { value: "all", label: "activity.kindAll" },
  { value: "app", label: "activity.kindApp" },
  { value: "agent", label: "activity.kindAgent" },
  { value: "builtin", label: "activity.kindBuiltin" },
];
const DAY = 86400_000;

/** The last 30 UTC days as bars: time in use when the entry measures it, else opens. */
function Spark({ row }: { row: UsageRow | undefined }) {
  const byDay = new Map((row?.daily ?? []).map((d) => [d.day, d]));
  const timed = row?.activeMs !== null && row?.activeMs !== undefined;
  const today = Date.now();
  const values = Array.from({ length: 30 }, (_, i) => {
    const d = byDay.get(new Date(today - (29 - i) * DAY).toISOString().slice(0, 10));
    return d ? (timed ? d.activeMs : d.opens) : 0;
  });
  const max = Math.max(1, ...values);
  return (
    <svg className="act-spark" viewBox="0 0 90 20" preserveAspectRatio="none" aria-hidden="true">
      {values.map((v, i) => (v > 0 ? <rect key={i} x={i * 3} y={20 - Math.max(1.5, (v / max) * 20)} width="2" height={Math.max(1.5, (v / max) * 20)} rx="0.5" /> : <rect key={i} className="zero" x={i * 3} y="19" width="2" height="1" />))}
    </svg>
  );
}

export default function Activity({ open, onClose, onBack, nameOf }: { open: boolean; onClose: () => void; onBack?: () => void; nameOf: (kind: UsageKind, key: string) => string }) {
  const { lang, t } = useLang();
  const [window, setWindow] = useState<Win>("30d");
  const [kind, setKind] = useState<UsageKind | "all">("all");
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [month, setMonth] = useState<UsageRow[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    const q = kind === "all" ? "" : `&kind=${kind}`;
    const load = () =>
      Promise.all([getJson<{ usage: UsageRow[] }>(`/api/usage?window=${window}${q}`), window === "30d" ? null : getJson<{ usage: UsageRow[] }>(`/api/usage?window=30d${q}`)])
        .then(([w, m]) => {
          setRows(w.usage);
          setMonth((m ?? w).usage);
          setErr("");
        })
        .catch((e) => setErr(String((e as Error).message || e)));
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [open, window, kind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const opens = rows?.reduce((n, r) => n + r.opens, 0) ?? 0;
  const timeMs = rows?.reduce((n, r) => n + (r.activeMs ?? 0), 0) ?? 0;
  const top = rows?.[0];
  const monthOf = new Map(month.map((r) => [`${r.kind}:${r.key}`, r]));
  const dash = "—";

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks usage" role="dialog" aria-label={t("activity.title")}>
        <div className="task-head">
          {onBack && (
            <button className="chat-hbtn back" title={t("common.back")} onClick={onBack}>
              ‹
            </button>
          )}
          <b>{t("activity.title")}</b>
          <span className="usage-windows">
            {WINDOWS.map((w) => (
              <button key={w} className={`usage-win${w === window ? " on" : ""}`} onClick={() => setWindow(w)}>
                {w === "all" ? t("activity.all") : w}
              </button>
            ))}
          </span>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="task-body">
          <p className="task-note">{t("activity.note")}</p>
          <div className="lib-filters act-kinds" role="tablist">
            {KINDS.map((k) => (
              <button key={k.value} role="tab" aria-selected={kind === k.value} className={`lib-chip${kind === k.value ? " on" : ""}`} onClick={() => setKind(k.value)}>
                {t(k.label)}
              </button>
            ))}
          </div>
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {rows === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {rows && (
            <div className="usage-cards act-cards">
              <div className="usage-card">
                <b>{opens.toLocaleString()}</b>
                <span>{t("activity.opens")}</span>
              </div>
              <div className="usage-card">
                <b>{timeMs ? fmtDuration(timeMs, lang) : dash}</b>
                <span>{t("activity.time")}</span>
              </div>
              <div className="usage-card">
                <b className="act-top" title={top ? nameOf(top.kind, top.key) : undefined}>
                  {top ? nameOf(top.kind, top.key) : dash}
                </b>
                <span>{t("activity.top")}</span>
              </div>
            </div>
          )}
          {rows && !rows.length && <p className="task-note">{t("activity.empty")}</p>}
          {rows && rows.length > 0 && (
            <section className="task-group">
              <div className="usage-scroll">
                <table className="usage-table act-table">
                  <thead>
                    <tr>
                      <th>{t("activity.name")}</th>
                      <th>{t("activity.opens")}</th>
                      <th>{t("activity.time")}</th>
                      <th>{t("activity.avg")}</th>
                      <th>{t("activity.last")}</th>
                      <th>{t("activity.trend")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.kind}:${r.key}`}>
                        <td title={`${r.kind} · ${r.key}`}>{nameOf(r.kind, r.key)}</td>
                        <td>{r.opens}</td>
                        <td title={r.activeMs === null ? t("activity.untracked") : undefined}>{r.activeMs === null ? dash : fmtDuration(r.activeMs, lang)}</td>
                        <td>{r.activeMs !== null && r.sessions ? fmtDuration(r.activeMs / r.sessions, lang) : dash}</td>
                        <td title={r.lastAt ? dateTime(r.lastAt, lang) : undefined}>{r.lastAt ? relTime(r.lastAt, lang) : dash}</td>
                        <td>
                          <Spark row={monthOf.get(`${r.kind}:${r.key}`)} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
