import { useCallback, useEffect, useRef, useState } from "react";
import { getJson, relTime, sendJson } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Key } from "./i18n.ts";

/**
 * Settings → Feedback (docs/feedback.md): the button app pages show, what happens to what is sent
 * with it, where the Fix Engineer runs and on which model, which apps show the button, and the
 * feedback sent lately with a way to start the waiting ones. On a space with peers, each peer's apps
 * follow these settings too (the server sends them on), and their feedback shows here as well.
 */

type Status = "later" | "queued" | "fixing" | "review" | "failed" | "skipped" | "recorded";
type AppRow = { app: string; title: string; zh?: string; status: string; enabled: boolean };
export type PeerView = { name: string; ok: boolean; error?: string; synced: boolean; apps: AppRow[]; counts: Partial<Record<Status, number>> };
export type Settings = { enabled: boolean; appsDefault: boolean; apps: Record<string, "on" | "off">; mode: "auto" | "later"; machine: string; model: string; effort: "high" | "xhigh" | "max"; errors: boolean };
export type View = {
  settings: Settings;
  apps: AppRow[];
  /** Each peer's apps, which follow these settings; absent from an older space. */
  peers?: PeerView[];
  machines: { value: string; label: string }[];
  models: { value: string; runtime: string; tier: string; model: string }[];
  counts: Record<Status, number>;
  shortcut: string;
};
type Item = { id: number; peer?: string; app: string; text: string; status: Status; path: string; todoId: number | null; todoPeer: string; todoUrl: string | null; runId: string | null; runMachine: string; note: string | null; createdAt: number };

/**
 * The view with a settings patch applied the way the server applies it (`mergeSettings`): an app
 * set to "default" loses its own value, and each app's shown/hidden follows. The page shows a
 * choice with this at once and saves in the background.
 */
export function withPatch(view: View, patch: Partial<Settings>): View {
  const apps = { ...view.settings.apps };
  for (const [app, v] of Object.entries((patch.apps ?? {}) as Record<string, string>)) {
    if (v === "default") delete apps[app];
    else apps[app] = v as "on" | "off";
  }
  const settings = { ...view.settings, ...patch, apps };
  const shown = (app: string) => settings.enabled && (apps[app] ? apps[app] === "on" : settings.appsDefault);
  const follow = (rows: AppRow[]) => rows.map((a) => ({ ...a, enabled: shown(a.app) }));
  return { ...view, settings, apps: follow(view.apps), ...(view.peers ? { peers: view.peers.map((p) => (p.ok ? { ...p, apps: follow(p.apps) } : p)) } : {}) };
}

export default function FeedbackSettings() {
  const { lang, t } = useLang();
  const [view, setView] = useState<View | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(() => {
    getJson<View>("/api/panel/feedback/settings").then(setView).catch((e) => setError((e as Error).message));
    getJson<{ items: Item[] }>("/api/panel/feedback?limit=20").then((d) => setItems(d.items)).catch(() => {});
  }, []);
  useEffect(load, [load]);
  // While something is being fixed, the list follows it.
  useEffect(() => {
    if (!items.some((i) => i.status === "fixing" || i.status === "queued")) return;
    const id = setInterval(load, 10_000);
    return () => clearInterval(id);
  }, [items, load]);

  // A switch or menu shows its new value at once and stays usable while the change is saved; only
  // the answer to the newest save is shown, so a slower earlier one cannot undo a later choice.
  const saves = useRef(0);
  const save = async (patch: Partial<Settings>) => {
    const n = ++saves.current;
    setError("");
    setView((v) => (v ? withPatch(v, patch) : v));
    try {
      const next = await sendJson<View>("PUT", "/api/panel/feedback/settings", patch);
      if (n === saves.current) setView(next);
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  };
  const fix = async (body: { peer?: string; app?: string; ids?: number[] }) => {
    setBusy(true);
    setError("");
    try {
      const r = await sendJson<{ queued: number }>("POST", "/api/panel/feedback/fix", body);
      setNotice(t("feedback.started", { n: r.queued }));
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!view) return <div className="setcard"><p className="setnote">{error || t("common.loading")}</p></div>;
  const s = view.settings;
  const appName = (a: { title: string; zh?: string }) => (lang === "zh" && a.zh ? a.zh : a.title);
  const appTitle = (app: string, peer = "") => {
    const rows = peer ? (view.peers ?? []).find((p) => p.name === peer)?.apps ?? [] : view.apps;
    const a = rows.find((x) => x.app === app);
    return a ? appName(a) : app;
  };
  const appRow = (a: AppRow) => (
    <label className="setrow" key={a.app}>
      <span>
        {appName(a)}
        <small className="setsub">{a.enabled ? t("feedback.app.shown") : t("feedback.app.hidden")}</small>
      </span>
      <select className="setselect" value={s.apps[a.app] ?? "default"} onChange={(e) => void save({ apps: { [a.app]: e.target.value } as unknown as Settings["apps"] })}>
        <option value="default">{t("feedback.app.default", { state: s.appsDefault ? t("feedback.on") : t("feedback.off") })}</option>
        <option value="on">{t("feedback.on")}</option>
        <option value="off">{t("feedback.off")}</option>
      </select>
    </label>
  );
  const peers = view.peers ?? [];
  const peerWaiting = peers.filter((p) => p.ok && (p.counts.later ?? 0) > 0);
  const waiting = view.counts.later;
  return <>
    <div className="setcard">
      <label className="setrow">
        {t("feedback.enabled")}
        <input type="checkbox" role="switch" checked={s.enabled} onChange={() => void save({ enabled: !s.enabled })} />
      </label>
      <p className="setnote">{t("feedback.enabledHelp")}</p>
      <label className="setrow">
        {t("feedback.mode")}
        <select className="setselect" value={s.mode} onChange={(e) => void save({ mode: e.target.value as Settings["mode"] })}>
          <option value="auto">{t("feedback.mode.auto")}</option>
          <option value="later">{t("feedback.mode.later")}</option>
        </select>
      </label>
      <label className="setrow">
        {t("feedback.machine")}
        <select className="setselect" value={s.machine} onChange={(e) => void save({ machine: e.target.value })}>
          {view.machines.map((m) => <option key={m.value} value={m.value}>{m.value ? m.label : t("feedback.thisMachine", { name: m.label })}</option>)}
        </select>
      </label>
      <label className="setrow">
        {t("feedback.model")}
        <select className="setselect" value={s.model} onChange={(e) => void save({ model: e.target.value })}>
          <option value="">{t("feedback.modelDefault")}</option>
          {s.model && !view.models.some((o) => o.value === s.model) && <option value={s.model}>{s.model}</option>}
          {view.models.map((o) => <option key={o.value} value={o.value}>{`${o.runtime} · ${t(`modelTier.${o.tier}` as Key)} · ${o.model}`}</option>)}
        </select>
      </label>
      <label className="setrow">
        {t("feedback.effort")}
        <select className="setselect" value={s.effort} onChange={(e) => void save({ effort: e.target.value as Settings["effort"] })}>
          <option value="high">{t("feedback.effort.high")}</option>
          <option value="xhigh">{t("feedback.effort.xhigh")}</option>
          <option value="max">{t("feedback.effort.max")}</option>
        </select>
      </label>
      <label className="setrow">
        {t("feedback.errors")}
        <input type="checkbox" role="switch" checked={s.errors} onChange={() => void save({ errors: !s.errors })} />
      </label>
      <div className="setrow" style={{ cursor: "default" }}>
        {t("feedback.shortcut")}
        <kbd className="setkbd">{view.shortcut}</kbd>
      </div>
      <p className="setnote">{t("feedback.trust")}</p>
    </div>

    <div className="setcard">
      <p className="sethead">{t("feedback.apps")}</p>
      <label className="setrow">
        {t("feedback.appsDefault")}
        <input type="checkbox" role="switch" checked={s.appsDefault} onChange={() => void save({ appsDefault: !s.appsDefault })} />
      </label>
      {view.apps.map(appRow)}
      <p className="setnote">{t("feedback.appsHelp")}</p>
    </div>

    {peers.map((p) => (
      <div className="setcard" key={`peer-${p.name}`}>
        <p className="sethead">{t("feedback.peerApps", { name: p.name })}</p>
        {!p.ok && <p className="setnote err">{t("feedback.peerDown", { name: p.name, error: p.error ?? "" })}</p>}
        {p.ok && p.apps.length === 0 && <p className="setnote">{t("feedback.peerNone", { name: p.name })}</p>}
        {p.ok && p.apps.map(appRow)}
        {p.ok && !p.synced && <p className="setnote err">{t("feedback.peerUnsynced", { name: p.name, error: p.error ?? "" })}</p>}
        {p.ok && p.apps.length > 0 && <p className="setnote">{t("feedback.peerAppsHelp", { name: p.name })}</p>}
      </div>
    ))}

    <div className="setcard">
      <p className="sethead">{t("feedback.recent")}</p>
      {items.length === 0 && <p className="setnote">{t("feedback.none")}</p>}
      {items.map((i) => (
        <div className="setrow feedback-row" key={`${i.peer ?? ""}-${i.id}`}>
          <span className="feedback-text">
            <b>{appTitle(i.app, i.peer)}</b> {i.text}
            <small className="setsub">
              {i.peer ? `${i.peer} · ` : ""}{t(`feedback.status.${i.status}` as Key)}
              {i.todoId ? <> · {i.todoUrl ? <a href={i.todoUrl} target="_blank" rel="noopener">{t("feedback.todo", { n: i.todoId })}</a> : t("feedback.todo", { n: i.todoId })}</> : null}
              {i.runMachine ? ` · ${i.runMachine}` : ""} · {relTime(i.createdAt, lang)}
              {i.note && (i.status === "failed" || i.status === "skipped" || i.status === "recorded") ? <> · <span title={i.note}>{i.note.split("\n")[0]!.slice(0, 120)}</span></> : null}
            </small>
          </span>
          {(i.status === "failed" || i.status === "skipped" || i.status === "review" || i.status === "later") && i.todoId !== null && (
            <button className="btn2" disabled={busy} onClick={() => void fix({ ...(i.peer ? { peer: i.peer } : {}), ids: [i.id] })}>{i.status === "later" ? t("feedback.fixNow") : t("feedback.fixAgain")}</button>
          )}
        </div>
      ))}
      <div className="setbtns">
        {waiting > 0 && <span className="setnote">{t("feedback.waiting", { n: waiting })}</span>}
        <span className="setbtns-gap" />
        {waiting > 0 && <button className="btn2" disabled={busy} onClick={() => void fix({})}>{t("feedback.fixWaiting", { n: waiting })}</button>}
        {peerWaiting.map((p) => <button className="btn2" key={p.name} disabled={busy} onClick={() => void fix({ peer: p.name })}>{t("feedback.fixWaitingOn", { n: p.counts.later ?? 0, name: p.name })}</button>)}
        <button className="btn2" disabled={busy} onClick={load}>{t("feedback.refresh")}</button>
      </div>
      {notice && <p className="setnote" role="status">{notice}</p>}
    </div>
    {error && <p className="setnote err" role="alert">{error}</p>}
  </>;
}
