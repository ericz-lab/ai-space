import type { DeviceUsageRow } from "../space/usage/types.ts";
import { Fragment, useEffect, useState } from "react";
import { activityBars, activityRange, type UsageWindow } from "./activity-range.ts";
import { dateTime, fmtDuration, getJson, relTime, type UsageKind, type UsageRow } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";

// App usage window (a floating panel, docs/usage.md): how often each app, agent and panel window
// was opened and for how long, read-only, in the Model usage window's style.
// - Reads the selected window on open, on filter changes and every 60 s.
// - Rows by time in use, then opens. An app without the heartbeat script has no time: a dash.

const WINDOWS = ["7d", "30d", "90d", "all"] as const;
type Win = UsageWindow;
const KINDS: { value: UsageKind | "all"; label: Key }[] = [
  { value: "all", label: "activity.kindAll" },
  { value: "app", label: "activity.kindApp" },
  { value: "agent", label: "activity.kindAgent" },
  { value: "builtin", label: "activity.kindBuiltin" },
];
/** Every row uses the same UTC range and bucket widths. */
function Spark({ row, range }: { row: UsageRow; range: ReturnType<typeof activityRange> }) {
  const values = activityBars(row, range);
  const max = Math.max(1, ...values);
  return (
    <svg className="act-spark" viewBox={`0 0 ${values.length * 3} 20`} preserveAspectRatio="none" aria-hidden="true">
      {values.map((v, i) => (v > 0 ? <rect key={i} x={i * 3} y={20 - Math.max(1.5, (v / max) * 20)} width="2" height={Math.max(1.5, (v / max) * 20)} rx="0.5" /> : <rect key={i} className="zero" x={i * 3} y="19" width="2" height="1" />))}
    </svg>
  );
}

export default function Activity({ open, onClose, onBack, nameOf }: { open: boolean; onClose: () => void; onBack?: () => void; nameOf: (kind: UsageKind, key: string) => string }) {
  const { lang, t } = useLang();
  const [window, setWindow] = useState<Win>("30d");
  const [kind, setKind] = useState<UsageKind | "all">("all");
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [expandedDevice, setExpandedDevice] = useState<string | null>(null);
  const [devices, setDevices] = useState<DeviceUsageRow[] | null>(null);
  const [loadedAt, setLoadedAt] = useState(Date.now);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    let active = true;
    let request = 0;
    setRows(null);
    setDevices(null);
    setErr("");
    const q = kind === "all" ? "" : `&kind=${kind}`;
    const load = async () => {
      const current = ++request;
      try {
        const result = await getJson<{ usage: UsageRow[] }>(`/api/usage?window=${window}${q}`);
        if (!active || current !== request) return;
        setRows(result.usage);
        // A device report failure must not hide the existing application report.
        try {
          const d = await getJson<{ devices: DeviceUsageRow[] }>(`/api/usage/devices?window=${window}`);
          if (!active || current !== request) return;
          setDevices(d.devices);
        } catch { if (active && current === request) setDevices(null); }
        if (!active || current !== request) return;
        setLoadedAt(Date.now());
        setErr("");
      } catch (e) {
        if (active && current === request) setErr(String((e as Error).message || e));
      }
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
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
  const range = activityRange(rows ?? [], window, loadedAt);
  const utcDate = (at: number) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(at);
  const windowLabel = window === "all" ? t("activity.all") : t("activity.days", { days: Number.parseInt(window) });
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
              <button key={w} className={`usage-win${w === window ? " on" : ""}`} aria-pressed={w === window} onClick={() => { if (w !== window) { setRows(null); setWindow(w); } }}>
                {w === "all" ? t("activity.all") : w}
              </button>
            ))}
          </span>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="task-body">
          <section className="task-group">
            <h3>{t("activity.devices")}</h3>
            <p className="task-note">{t("activity.devicesNote")}</p>
            {devices === null ? <p className="task-note">{t("activity.devicesUnavailable")}</p> : devices.length === 0 ? <p className="task-note">{t("activity.devicesEmpty")}</p> : (
              <div className="usage-scroll"><table className="usage-table device-usage-table">
                <thead><tr><th>{t("activity.device")}</th><th>{t("activity.sessions")}</th><th>{t("activity.foreground")}</th><th>{t("activity.last")}</th></tr></thead>
                <tbody>{devices.map(d => <Fragment key={`${d.client}:${d.deviceId}`}><tr>
                  <td title={d.deviceId}><button className="lib-chip" aria-expanded={expandedDevice === `${d.client}:${d.deviceId}`} onClick={() => setExpandedDevice(expandedDevice === `${d.client}:${d.deviceId}` ? null : `${d.client}:${d.deviceId}`)}>{({ web: "Web", ios: "iOS", macos: "macOS", android: "Android" })[d.client]} · {d.deviceId.slice(-8)} ▾</button></td>
                  <td>{d.sessions}</td><td>{fmtDuration(d.activeMs, lang)}</td>
                  <td title={dateTime(d.lastAt, lang)}>{relTime(d.lastAt, lang)}</td>
                </tr>{expandedDevice === `${d.client}:${d.deviceId}` && <tr><td colSpan={4}>
                  <p className="task-note">{t("activity.deviceAppsNote")}</p>
                  {!d.apps ? <p>{t("activity.deviceAppsUnavailable")}</p> : d.apps.length === 0 ? <p>{t("activity.deviceAppsEmpty")}</p> :
                    <table className="usage-table"><thead><tr><th>{t("activity.name")}</th><th>{t("activity.opens")}</th><th>{t("activity.foreground")}</th></tr></thead>
                      <tbody>{d.apps.map(app => <tr key={app.key}>
                        <td>{nameOf("app", app.key)}</td><td>{app.opens}</td>
                        <td>{app.activeMs === null ? t("activity.timeUnmeasured") : fmtDuration(app.activeMs, lang)}</td>
                      </tr>)}</tbody>
                    </table>}
                </td></tr>}</Fragment>)}</tbody>
              </table></div>
            )}
          </section>
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
          {rows && <p className="task-note" role="status">
            {t("activity.range", { window: windowLabel, start: utcDate(range.start), end: utcDate(range.end) })}
            {range.first && <> {t("activity.first", { date: utcDate(Date.parse(range.first + "T00:00:00Z")) })}</>}
          </p>}
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
                      <th>{t("activity.trend", { window: windowLabel })}</th>
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
                          <Spark row={r} range={range} />
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
