import { useEffect, useState } from "react";
import { type CapabilityApp, type DeliveryInfo, type EventInfo, dateTime, getJson, relTime } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";

// Events window (a floating panel): a read-only view of the bus (docs/events.md).
// - The catalogue first: which apps provide capabilities and publish events, with call counts.
// - Then the recent events (`GET /api/events`, refreshed every 30 s while open); a row opens to its deliveries
//   (`GET /api/events/:id`): who got it by which method, and where each delivery stands.
// Nothing here mutates: retrying a dead delivery needs the operator token, which the browser never holds.

const STATUS: Record<DeliveryInfo["status"], { cls: string; key: Key }> = {
  pending: { cls: "paused", key: "events.pending" },
  sent: { cls: "running", key: "events.sent" },
  ok: { cls: "ok", key: "status.ok" },
  dead: { cls: "down", key: "events.dead" },
  skipped: { cls: "off", key: "events.skipped" },
};

function Deliveries({ id }: { id: number }) {
  const { lang, t } = useLang();
  const [rows, setRows] = useState<DeliveryInfo[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setRows(null);
    getJson<{ deliveries: DeliveryInfo[] }>(`/api/events/${id}`)
      .then((d) => setRows(d.deliveries || []))
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [id]);
  if (err) return <p className="task-note">{t("common.unavailable", { error: err })}</p>;
  if (rows === null) return <p className="task-note">{t("common.loading")}</p>;
  if (!rows.length) return <p className="task-note">{t("events.noDeliveries")}</p>;
  return (
    <div className="runs">
      {rows.map((d) => {
        const st = STATUS[d.status] ?? STATUS.pending;
        return (
          <div key={d.id} className="runrow">
            <div className="run-line">
              <span className={`status ${st.cls}`}>
                <i />
                {t(st.key)}
              </span>
              <span className="ev-target">
                {d.app} <span className="task-badge">{d.kind}</span>
                {d.path && <span className="ev-path">{d.path}</span>}
              </span>
              <span className="run-dur" title={d.nextAt ? dateTime(d.nextAt, lang) : undefined}>
                {t("events.attempts", { n: d.attempts })}
              </span>
            </div>
            {d.lastError && <div className="run-err">{d.lastError}</div>}
          </div>
        );
      })}
    </div>
  );
}

function Catalogue({ apps }: { apps: CapabilityApp[] }) {
  const { t } = useLang();
  const listed = apps.filter((a) => a.provides.length || a.publishes.length || a.consumes.length);
  if (!listed.length) return <p className="task-note">{t("events.noCatalogue")}</p>;
  return (
    <div className="ev-cat">
      {listed.map((a) => (
        <div key={a.app} className="ev-app">
          <div className="ev-app-name">
            {a.app}
            {a.peer && <span className="task-badge">{a.peer}</span>}
          </div>
          {a.provides.map((c) => {
            const s = a.stats?.find((x) => x.capability === c.name);
            return (
              <div key={c.name} className="ev-line" title={`${c.method} ${c.path}${c.callers ? ` · ${c.callers.join(", ")}` : ""}`}>
                <span className="task-badge ev-kind">{t("events.provides")}</span>
                <b>{c.name}</b>
                <span className="ev-desc">{c.description}</span>
                {s && <span className="ev-stat">{t("events.calls", { n: s.calls, failed: s.failures })}</span>}
              </div>
            );
          })}
          {a.publishes.map((p) => (
            <div key={p.name} className="ev-line">
              <span className="task-badge ev-kind">{t("events.publishes")}</span>
              <b>{p.name}</b>
              <span className="ev-desc">{p.description}</span>
            </div>
          ))}
          {a.consumes.map((c, i) => (
            <div key={i} className="ev-line">
              <span className="task-badge ev-kind">{t("events.consumes")}</span>
              <b>{c.event}</b>
              <span className="ev-desc">{c.kind === "task" ? t("events.viaTask", { task: c.task ?? "" }) : c.kind === "http" ? `${c.method} ${c.path}` : t("events.viaStream")}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Events({ open, onClose, onBack }: { open: boolean; onClose: () => void; onBack?: () => void }) {
  const { lang, t } = useLang();
  const [events, setEvents] = useState<EventInfo[] | null>(null);
  const [apps, setApps] = useState<CapabilityApp[]>([]);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [showCat, setShowCat] = useState(false);

  useEffect(() => {
    if (!open) return;
    const load = () =>
      getJson<{ events: EventInfo[] }>("/api/events?limit=100")
        .then((d) => {
          setEvents(d.events || []);
          setErr("");
        })
        .catch((e) => setErr(String((e as Error).message || e)));
    load();
    getJson<{ apps: CapabilityApp[] }>("/api/capabilities")
      .then((d) => setApps(d.apps || []))
      .catch(() => {});
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const providers = apps.filter((a) => a.provides.length).length;
  const publishers = apps.filter((a) => a.publishes.length).length;

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks" role="dialog" aria-label={t("events.title")}>
        <div className="task-head">
          {onBack && (
            <button className="chat-hbtn back" title={t("common.back")} onClick={onBack}>
              ‹
            </button>
          )}
          <b>{t("events.title")}</b>
          <span className="chat-sub">{events === null ? "" : t("events.summary", { n: events.length, providers, publishers })}</span>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="task-body">
          <section className="task-group">
            <button className="task-app ev-toggle" onClick={() => setShowCat(!showCat)}>
              <span className="svc-name">{t("events.catalogue")}</span>
              <span className="svc-port">{showCat ? "▾" : "▸"}</span>
            </button>
            {showCat && <Catalogue apps={apps} />}
          </section>
          <section className="task-group">
            <div className="task-app">
              <span className="svc-name">{t("events.recent")}</span>
            </div>
            {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
            {events === null && !err && <p className="task-note">{t("common.loading")}</p>}
            {events !== null && !events.length && <p className="task-note">{t("events.empty")}</p>}
            {(events || []).map((e) => (
              <div key={e.id} className={`taskrow ${openId === e.id ? "open" : ""}`}>
                <button className="task-main" onClick={() => setOpenId(openId === e.id ? null : e.id)} title={JSON.stringify(e.data)}>
                  <span className="task-text">
                    <span className="task-line">
                      <span className="task-name">{e.name}</span>
                      {e.peer && <span className="task-badge">{e.peer}</span>}
                      <span className="task-sched">
                        <span title={dateTime(e.at, lang)}>{relTime(e.at, lang)}</span>
                      </span>
                    </span>
                    <span className="task-meta">
                      <span className="ev-data">{previewData(e.data)}</span>
                    </span>
                  </span>
                </button>
                {openId === e.id && (
                  <div className="task-detail">
                    <Deliveries id={e.id} />
                  </div>
                )}
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  );
}

/** The first few fields of an event's data on one line. */
function previewData(data: Record<string, unknown>): string {
  const parts = Object.entries(data)
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const s = parts.join(" · ");
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}
