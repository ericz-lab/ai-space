import { useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson, untilTime, type BackupInfo, type MachineCell, type PeerInfo, type ServiceInfo, type SpeechCell, type SpeechStatus } from "./api.ts";
import { failureText } from "./call-trace.ts";
import { localized, useLang } from "./i18n.ts";
import type { Key } from "./messages.ts";
import { HEALTH, Icon, STATUS } from "./Tiles.tsx";
import { fmtCost } from "./Usage.tsx";

/**
 * The status part of the settings: peers, runtimes, speech providers, services and backups fold into one
 * summary line; the rows show when it is expanded. A problem is a service or peer that is down, a runtime
 * or speech provider something uses that cannot answer (docs/model-machines.md#status, docs/speech.md#status),
 * a speech configuration that does not load, or a backup that went stale.
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
  // Every machine's runtimes: installed, signed in, limited, last answer.
  const [machines, setMachines] = useState<{ cells: MachineCell[]; serves: string[]; fallback: Record<string, string[]> } | null>(null);
  useEffect(() => {
    getJson<{ machines?: MachineCell[]; servesPeers?: string[]; fallback?: Record<string, string[]> }>("/api/model/status")
      .then((d) => setMachines({ cells: d.machines || [], serves: d.servesPeers || [], fallback: d.fallback || {} }))
      .catch(() => setMachines({ cells: [], serves: [], fallback: {} }));
  }, []);
  // Speech providers (docs/speech.md#status): the same kind of cell, one per provider, beside the runtimes.
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  useEffect(() => {
    // An older Space has no /api/speech; the group then stays away.
    getJson<SpeechStatus>("/api/speech")
      .then((d) => setSpeech({ ...d, providers: d.providers || [], warnings: d.warnings || [] }))
      .catch(() => setSpeech(null));
  }, []);
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [backupsOn, setBackupsOn] = useState(true);
  useEffect(() => {
    getJson<{ enabled?: boolean; backups: BackupInfo[] }>("/api/backups")
      .then((d) => {
        setBackupsOn(d.enabled !== false);
        setBackups(d.backups || []);
      })
      .catch(() => setBackups([]));
  }, []);
  // The status section has a page of its own, so its rows start shown.
  const [statusOpen, setStatusOpen] = useState(true);
  const statusLoaded = services !== null && backups !== null;
  const problems = statusLoaded
    ? services.services.filter((s) => s.status === "active" && s.health === "down").length +
      services.peers.filter((p) => p.health !== "ok").length +
      (machines?.cells.filter((c) => c.problem).length ?? 0) +
      (speech?.providers.filter((c) => c.problem).length ?? 0) +
      (speech?.configError ? 1 : 0) +
      backups.filter((b) => b.stale && !b.retired).length
    : 0;
  const statusSummary = statusLoaded
    ? [
        t("settings.countServices", { n: services.services.length }),
        backupsOn || backups.length ? t("settings.countBackups", { n: backups.length }) : "",
        services.peers.length ? t("settings.countPeers", { n: services.peers.length }) : "",
        machines?.cells.length ? t("settings.countRuntimes", { n: machines.cells.length }) : "",
        speech?.providers.length ? t("settings.countSpeech", { n: speech.providers.length }) : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : t("common.loading");
  return (
    <>
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
              {p.via === "http" && <span className="svc-peer" title={t("settings.peerLegacyHint", { name: p.name })}>{t("settings.peerLegacy")}</span>}
              {p.health !== "ok" && p.asOf && <span className="svc-port">{relTime(p.asOf, lang)}</span>}
              <span className={`status ${p.health}`}>
                <i />
                {t(p.health === "ok" ? "status.up" : "status.down")}
              </span>
            </div>
          ))}
        </>
      )}
      {machines && machines.cells.length > 0 && (
        <>
          <p className="sethead sub">{t("settings.runtimes")}</p>
          {machines.cells.map((c) => {
            const state = runtimeState(c, lang);
            return (
              <div
                key={`${c.machine}|${c.runtime}`}
                className="svcrow"
                title={[
                  c.kind,
                  c.detail ?? "",
                  c.lastOkAt ? t("runtimes.lastOk", { time: relTime(c.lastOkAt, lang) }) : "",
                  c.limitedUntil
                    ? c.restKind
                      ? `${t("runtimes.restUntil", { time: untilTime(c.limitedUntil, lang), cause: failureText(c.restKind, lang) })}${c.restSaid ? ` (${t("runtimes.restSaid")})` : ""}`
                      : t("runtimes.limitedUntil", { time: untilTime(c.limitedUntil, lang) })
                    : "",
                  c.lastErrorKind ? t("runtimes.lastErrorKind", { kind: failureText(c.lastErrorKind, lang) }) : "",
                  c.lastError ?? "",
                  c.used ? "" : t("runtimes.unused"),
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                <span className="svc-ico">🧠</span>
                <span className="svc-name">{c.runtime}</span>
                <span className="svc-peer">{c.machine || t("runtimes.thisMachine")}</span>
                {c.lastOkAt && <span className="svc-port">{relTime(c.lastOkAt, lang)}</span>}
                <span className={`status ${state.cls}`}>
                  <i />
                  {state.text ?? t(state.key)}
                </span>
              </div>
            );
          })}
          {Object.keys(machines.fallback).length > 0 && (
            <p className="setnote">{t("runtimes.fallback", { list: Object.entries(machines.fallback).map(([key, list]) => `${key} → ${list.join(", ")}`).join("; ") })}</p>
          )}
          {machines.serves.length > 0 && <p className="setnote">{t("runtimes.serves", { list: machines.serves.join(", ") })}</p>}
        </>
      )}
      {speech && (speech.providers.length > 0 || speech.configError) && (
        <>
          <p className="sethead sub">{t("settings.speech")}</p>
          {speech.configError && <p className="setnote">{t("speech.configError", { error: speech.configError })}</p>}
          {speech.providers.map((c) => {
            const state = speechState(c, lang);
            return (
              <div
                key={c.provider}
                className="svcrow"
                title={[
                  `${c.kind} · ${t(c.selfHosted ? "speech.selfHosted" : "speech.api")}`,
                  t("speech.can", { list: c.capabilities.join(", ") }),
                  c.roles.length ? t("speech.roles", { list: c.roles.join(", ") }) : t("runtimes.unused"),
                  c.off ?? "",
                  c.detail ?? "",
                  c.lastOkAt ? t("runtimes.lastOk", { time: relTime(c.lastOkAt, lang) }) : "",
                  c.limitedUntil
                    ? c.restKind
                      ? `${t("runtimes.restUntil", { time: untilTime(c.limitedUntil, lang), cause: failureText(c.restKind, lang) })}${c.restSaid ? ` (${t("runtimes.restSaid")})` : ""}`
                      : t("runtimes.limitedUntil", { time: untilTime(c.limitedUntil, lang) })
                    : "",
                  c.lastErrorKind ? t("runtimes.lastErrorKind", { kind: failureText(c.lastErrorKind, lang) }) : "",
                  c.lastError ?? "",
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                <span className="svc-ico">🎙</span>
                <span className="svc-name">{c.provider}</span>
                <span className="svc-peer">{c.where || t("runtimes.thisMachine")}</span>
                {c.lastOkAt && <span className="svc-port">{relTime(c.lastOkAt, lang)}</span>}
                <span className={`status ${state.cls}`}>
                  <i />
                  {state.text ?? t(state.key)}
                </span>
              </div>
            );
          })}
          {speech.providers.length > 0 && (
            <p className="setnote">
              {t("speech.defaults", { list: (["asr", "tts", "live"] as const).filter((r) => speech.default[r]).map((r) => `${r} → ${speech.default[r]}`).join("; ") })}
            </p>
          )}
          {Object.values(speech.fallback).some((l) => l && l.length) && (
            <p className="setnote">{t("runtimes.fallback", { list: Object.entries(speech.fallback).filter(([, l]) => l && l.length).map(([role, l]) => `${role} → ${(l ?? []).join(", ")}`).join("; ") })}</p>
          )}
          {speech.usage24h.calls > 0 && (
            <p className="setnote">
              {t("speech.usage24h", {
                calls: speech.usage24h.calls.toLocaleString(),
                minutes: (speech.usage24h.audioSeconds / 60).toFixed(1),
                chars: speech.usage24h.chars.toLocaleString(),
                cost: fmtCost(speech.usage24h.costUsd),
              })}
            </p>
          )}
          {speech.warnings.map((w) => (
            <p key={w} className="setnote">{w}</p>
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
        <p className="setnote">{t(backupsOn ? "settings.noBackups" : "settings.backupsOff")}</p>
      )}
      </>
      )}
    </>
  );
}

/**
 * A speech provider's dot and word, read like a runtime's: red only for a provider the configuration uses
 * that cannot answer, amber while it rests, grey when nothing uses it.
 */
export function speechState(c: SpeechCell, lang: Parameters<typeof failureText>[1]): { cls: string; key: Key; text?: string } {
  const key: Key = c.off ? "speech.off" : !c.located ? "speech.notFound" : c.reachable === false ? "runtimes.unreachable" : c.signedIn === false ? "runtimes.notSignedIn" : c.limitedUntil ? "runtimes.limited" : "runtimes.ready";
  const text = key === "runtimes.limited" && c.restKind ? failureText(c.restKind, lang) : undefined;
  if (c.problem) return { cls: c.problem === "limited" ? "paused" : "down", key, ...(text ? { text } : {}) };
  return { cls: key === "runtimes.ready" ? "ok" : "archived", key, ...(text ? { text } : {}) };
}

/**
 * A cell's dot and word: red only for a used cell that cannot answer; an unused one is grey. A resting
 * cell says why it rests (out of credit, quota used up, rate limited, connection failing).
 */
function runtimeState(c: MachineCell, lang: Parameters<typeof failureText>[1]): { cls: string; key: Key; text?: string } {
  const key: Key = c.reachable === false ? "runtimes.unreachable" : c.installed === false ? "runtimes.notInstalled" : c.signedIn === false ? "runtimes.notSignedIn" : c.limitedUntil ? "runtimes.limited" : c.probeTimedOut ? "runtimes.probeTimedOut" : c.checkedAt || c.lastOkAt ? "runtimes.ready" : "runtimes.unchecked";
  const text = key === "runtimes.limited" && c.restKind ? failureText(c.restKind, lang) : undefined;
  if (c.problem) return { cls: c.problem === "limited" ? "paused" : "down", key, ...(text ? { text } : {}) };
  return { cls: key === "runtimes.ready" ? "ok" : "archived", key, ...(text ? { text } : {}) };
}
