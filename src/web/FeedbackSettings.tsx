import { useCallback, useEffect, useState } from "react";
import { getJson, relTime, sendJson } from "./api.ts";
import { useLang } from "./i18n.ts";
import type { Key } from "./i18n.ts";

/**
 * Settings → Feedback (docs/feedback.md): the button app pages show, what happens to what is sent
 * with it, where the Fix Engineer runs and on which model, which apps show the button, and the
 * feedback sent lately with a way to start the waiting ones.
 */

type Status = "later" | "queued" | "fixing" | "review" | "failed" | "skipped" | "recorded";
type Settings = { enabled: boolean; appsDefault: boolean; apps: Record<string, "on" | "off">; mode: "auto" | "later"; machine: string; model: string; effort: "high" | "xhigh" | "max"; errors: boolean };
type View = {
  settings: Settings;
  apps: { app: string; title: string; zh?: string; status: string; enabled: boolean }[];
  machines: { value: string; label: string }[];
  models: { value: string; runtime: string; tier: string; model: string }[];
  counts: Record<Status, number>;
  shortcut: string;
};
type Item = { id: number; app: string; text: string; status: Status; path: string; todoId: number | null; todoPeer: string; todoUrl: string | null; runId: string | null; runMachine: string; note: string | null; createdAt: number };

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

  const save = async (patch: Partial<Settings>) => {
    setBusy(true);
    setError("");
    try {
      setView(await sendJson<View>("PUT", "/api/panel/feedback/settings", patch));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fix = async (body: { app?: string; ids?: number[] }) => {
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
  const appTitle = (app: string) => {
    const a = view.apps.find((x) => x.app === app);
    return a ? appName(a) : app;
  };
  const waiting = view.counts.later;
  return <>
    <div className="setcard">
      <label className="setrow">
        {t("feedback.enabled")}
        <input type="checkbox" role="switch" checked={s.enabled} disabled={busy} onChange={() => void save({ enabled: !s.enabled })} />
      </label>
      <p className="setnote">{t("feedback.enabledHelp")}</p>
      <label className="setrow">
        {t("feedback.mode")}
        <select className="setselect" value={s.mode} disabled={busy} onChange={(e) => void save({ mode: e.target.value as Settings["mode"] })}>
          <option value="auto">{t("feedback.mode.auto")}</option>
          <option value="later">{t("feedback.mode.later")}</option>
        </select>
      </label>
      <label className="setrow">
        {t("feedback.machine")}
        <select className="setselect" value={s.machine} disabled={busy} onChange={(e) => void save({ machine: e.target.value })}>
          {view.machines.map((m) => <option key={m.value} value={m.value}>{m.value ? m.label : t("feedback.thisMachine", { name: m.label })}</option>)}
        </select>
      </label>
      <label className="setrow">
        {t("feedback.model")}
        <select className="setselect" value={s.model} disabled={busy} onChange={(e) => void save({ model: e.target.value })}>
          <option value="">{t("feedback.modelDefault")}</option>
          {s.model && !view.models.some((o) => o.value === s.model) && <option value={s.model}>{s.model}</option>}
          {view.models.map((o) => <option key={o.value} value={o.value}>{`${o.runtime} · ${t(`modelTier.${o.tier}` as Key)} · ${o.model}`}</option>)}
        </select>
      </label>
      <label className="setrow">
        {t("feedback.effort")}
        <select className="setselect" value={s.effort} disabled={busy} onChange={(e) => void save({ effort: e.target.value as Settings["effort"] })}>
          <option value="high">{t("feedback.effort.high")}</option>
          <option value="xhigh">{t("feedback.effort.xhigh")}</option>
          <option value="max">{t("feedback.effort.max")}</option>
        </select>
      </label>
      <label className="setrow">
        {t("feedback.errors")}
        <input type="checkbox" role="switch" checked={s.errors} disabled={busy} onChange={() => void save({ errors: !s.errors })} />
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
        <input type="checkbox" role="switch" checked={s.appsDefault} disabled={busy} onChange={() => void save({ appsDefault: !s.appsDefault })} />
      </label>
      {view.apps.map((a) => (
        <label className="setrow" key={a.app}>
          <span>
            {appName(a)}
            <small className="setsub">{a.enabled ? t("feedback.app.shown") : t("feedback.app.hidden")}</small>
          </span>
          <select className="setselect" value={s.apps[a.app] ?? "default"} disabled={busy} onChange={(e) => void save({ apps: { [a.app]: e.target.value } as unknown as Settings["apps"] })}>
            <option value="default">{t("feedback.app.default", { state: s.appsDefault ? t("feedback.on") : t("feedback.off") })}</option>
            <option value="on">{t("feedback.on")}</option>
            <option value="off">{t("feedback.off")}</option>
          </select>
        </label>
      ))}
      <p className="setnote">{t("feedback.appsHelp")}</p>
    </div>

    <div className="setcard">
      <p className="sethead">{t("feedback.recent")}</p>
      {items.length === 0 && <p className="setnote">{t("feedback.none")}</p>}
      {items.map((i) => (
        <div className="setrow feedback-row" key={i.id}>
          <span className="feedback-text">
            <b>{appTitle(i.app)}</b> {i.text}
            <small className="setsub">
              {t(`feedback.status.${i.status}` as Key)}
              {i.todoId ? <> · {i.todoUrl ? <a href={i.todoUrl} target="_blank" rel="noopener">{t("feedback.todo", { n: i.todoId })}</a> : t("feedback.todo", { n: i.todoId })}</> : null}
              {i.runMachine ? ` · ${i.runMachine}` : ""} · {relTime(i.createdAt, lang)}
              {i.note && (i.status === "failed" || i.status === "skipped" || i.status === "recorded") ? <> · <span title={i.note}>{i.note.split("\n")[0]!.slice(0, 120)}</span></> : null}
            </small>
          </span>
          {(i.status === "failed" || i.status === "skipped" || i.status === "review" || i.status === "later") && i.todoId !== null && (
            <button className="btn2" disabled={busy} onClick={() => void fix({ ids: [i.id] })}>{i.status === "later" ? t("feedback.fixNow") : t("feedback.fixAgain")}</button>
          )}
        </div>
      ))}
      <div className="setbtns">
        {waiting > 0 && <span className="setnote">{t("feedback.waiting", { n: waiting })}</span>}
        <span className="setbtns-gap" />
        {waiting > 0 && <button className="btn2" disabled={busy} onClick={() => void fix({})}>{t("feedback.fixWaiting", { n: waiting })}</button>}
        <button className="btn2" disabled={busy} onClick={load}>{t("feedback.refresh")}</button>
      </div>
      {notice && <p className="setnote" role="status">{notice}</p>}
    </div>
    {error && <p className="setnote err" role="alert">{error}</p>}
  </>;
}
