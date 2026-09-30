import { useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson, untilTime, type BackupInfo, type PeerInfo, type ServiceInfo } from "./api.ts";
import { localized, useLang } from "./i18n.ts";
import { HEALTH, Icon, STATUS } from "./Tiles.tsx";

/**
 * The status part of the settings: peers, services and backups fold into one summary line; the rows
 * show when it is expanded. A problem is a service or peer that is down, or a backup that went stale.
 * Loaded each time the settings open so the health dots are fresh (the server caches probes for 15 s
 * and peer snapshots for their refresh period).
 */
export default function SettingsStatus() {
  const { lang, t } = useLang();
  // Services: every app that runs a process, with or without a page, plus the peer machines whose panels this one merges.
  const [services, setServices] = useState<{ services: ServiceInfo[]; peers: PeerInfo[] } | null>(null);
  const loadServices = useCallback(() => {
    getJson<{ services: ServiceInfo[]; peers: PeerInfo[] }>("/api/services")
      .then((d) => setServices({ services: d.services || [], peers: d.peers || [] }))
      .catch(() => setServices({ services: [], peers: [] }));
  }, []);
  useEffect(loadServices, [loadServices]);
  // Start / stop / restart of a unit the space supervises (docs/supervision.md); one at a time per row.
  const [svcBusy, setSvcBusy] = useState<string | null>(null);
  const [svcError, setSvcError] = useState<string | null>(null);
  const controlService = async (app: string, action: "start" | "stop" | "restart") => {
    setSvcBusy(app);
    setSvcError(null);
    try {
      await sendJson("POST", `/api/apps/${encodeURIComponent(app)}/service`, { action });
    } catch (e) {
      setSvcError(`${app}: ${(e as Error).message}`);
    } finally {
      setSvcBusy(null);
      loadServices();
    }
  };
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  useEffect(() => {
    getJson<{ backups: BackupInfo[] }>("/api/backups")
      .then((d) => setBackups(d.backups || []))
      .catch(() => setBackups([]));
  }, []);
  const [statusOpen, setStatusOpen] = useState(false);
  const statusLoaded = services !== null && backups !== null;
  const problems = statusLoaded
    ? services.services.filter((s) => s.status === "active" && s.health === "down").length +
      services.peers.filter((p) => p.health !== "ok").length +
      backups.filter((b) => b.stale && !b.retired).length
    : 0;
  const statusSummary = statusLoaded
    ? [
        t("settings.countServices", { n: services.services.length }),
        t("settings.countBackups", { n: backups.length }),
        services.peers.length ? t("settings.countPeers", { n: services.peers.length }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : t("common.loading");
  return (
    <>
      <p className="sethead">{t("settings.status")}</p>
      <button className="setrow setlink" aria-expanded={statusOpen} onClick={() => setStatusOpen((o) => !o)}>
        <span className="svc-name">{statusSummary}</span>
        {statusLoaded && (
          <span className={`status ${problems ? "down" : "ok"}`}>
            <i />
            {problems ? t("status.issues", { n: problems }) : t("status.allOk")}
          </span>
        )}
        <span className={`setchev${statusOpen ? " open" : ""}`}>›</span>
      </button>
      {statusOpen && (
      <>
      {services && services.peers.length > 0 && (
        <>
          <p className="sethead sub">{t("settings.peers")}</p>
          {services.peers.map((p) => (
            <div key={p.name} className="svcrow" title={`${p.url}\n${t("settings.peerCounts", { apps: p.apps, agents: p.agents, widgets: p.widgets, services: p.services })}${p.asOf ? `\n${t("settings.snapshot", { time: relTime(p.asOf, lang) })}` : ""}${p.error ? `\n${p.error}` : ""}`}>
              <span className="svc-ico">🛰</span>
              <span className="svc-name">{p.name}</span>
              {p.health !== "ok" && p.asOf && <span className="svc-port">{relTime(p.asOf, lang)}</span>}
              <span className={`status ${p.health}`}>
                <i />
                {t(p.health === "ok" ? "status.up" : "status.down")}
              </span>
            </div>
          ))}
        </>
      )}
      <p className="sethead sub">{t("settings.services")}</p>
      {services === null ? (
        <p className="setnote">{t("common.loading")}</p>
      ) : services.services.length ? (
        services.services.map((s) => {
          const unitProblem = s.supervision?.action === "conflict" || s.supervision?.action === "failed";
          const statusKey = unitProblem ? "services.unitProblem" : s.status === "active" ? HEALTH[s.health] : STATUS[s.status];
          const supervised = !s.peer && s.supervisor === "space" && s.status === "active";
          return (
          <div key={`${s.peer ?? ""}/${s.app}`} className="svcrow" title={`${s.peer ? `${s.peer}/` : ""}${s.app} · 127.0.0.1:${s.port}${s.supervisor ? ` · ${t(s.supervisor === "space" ? "services.bySpace" : "services.byOperator")}` : ""}${s.supervision ? ` · ${s.supervision.action}` : ""}${s.supervision?.error ? `\n${s.supervision.error}` : ""}${s.hidden ? ` · ${t("status.hidden")}` : ""}`}>
            <span className="svc-ico">
              <Icon icon={s.icon} fallback="📦" />
            </span>
            <span className="svc-name">{localized(lang, s).title}</span>
            {s.peer && <span className="svc-peer">{s.peer}</span>}
            <span className="svc-port">:{s.port}</span>
            {supervised && (
              <span className="svc-ctl">
                {(["start", "stop", "restart"] as const).map((a) => (
                  <button key={a} type="button" disabled={svcBusy === s.app} title={t(`services.${a}`)} aria-label={t(`services.${a}`)} onClick={() => void controlService(s.app, a)}>
                    {a === "start" ? "▶" : a === "stop" ? "■" : "↻"}
                  </button>
                ))}
              </span>
            )}
            <span className={`status ${unitProblem ? "down" : s.status === "active" ? s.health : s.status}`}>
              <i />
              {statusKey ? t(statusKey) : "?"}
            </span>
          </div>
          );
        })
      ) : (
        <p className="setnote">{t("settings.noServices")}</p>
      )}
      {svcError && <p className="setnote">{svcError}</p>}
      <p className="sethead sub">{t("settings.backups")}</p>
      {backups === null ? (
        <p className="setnote">{t("common.loading")}</p>
      ) : backups.length ? (
        backups.map((b) => (
          <div
            key={b.app}
            className="svcrow"
            title={[
              b.lastOkKey ?? "",
              b.lastStatus === "error" && b.lastError ? t("backup.lastError", { error: b.lastError }) : "",
              b.lastVerifiedAt !== undefined ? (b.lastVerifyOk ? t("backup.verified", { time: relTime(b.lastVerifiedAt, lang) }) : t("backup.verifyFailed", { error: b.lastVerifyError ?? "" })) : "",
              b.nextRunAt && !b.retired ? t("backup.nextRun", { time: untilTime(new Date(b.nextRunAt).toISOString(), lang) }) : "",
              b.retired ? t("backup.retiredHint") : "",
            ]
              .filter(Boolean)
              .join("\n")}
          >
            <span className="svc-ico">🗄</span>
            <span className="svc-name">{b.app}</span>
            <span className="svc-port">{b.lastOkAt ? relTime(b.lastOkAt, lang) : t("backup.never")}</span>
            <span className={`status ${b.retired ? "archived" : b.stale ? "down" : "ok"}`}>
              <i />
              {t(b.retired ? "backup.retired" : b.stale ? "backup.stale" : "backup.fresh")}
            </span>
          </div>
        ))
      ) : (
        <p className="setnote">{t("settings.noBackups")}</p>
      )}
      </>
      )}
    </>
  );
}
