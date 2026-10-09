import { useState } from "react";
import { sendJson, type AppInfo } from "./api.ts";
import { localized, useLang } from "./i18n.ts";

// The panel's two dialogs in edit mode: add an app from a link, and confirm an uninstall.

export function AddForm({ onClose, onSaved }: { onClose: () => void; onSaved: (app?: AppInfo) => void }) {
  const { t } = useLang();
  const [link, setLink] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!/^https?:\/\//.test(link.trim())) return setErr(t("add.needLink"));
    setErr("");
    setBusy(true);
    try {
      const r = await sendJson<{ app?: AppInfo }>("POST", "/api/apps", { link: link.trim() });
      onSaved(r.app);
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t("add.title")}<span className="modal-sub">{t("add.sub")}</span>
        </h3>
        <div className="field">
          <label>{t("add.link")}</label>
          <input value={link} onChange={(e) => setLink(e.target.value)} disabled={busy} placeholder={t("add.placeholder")} onKeyDown={(e) => e.key === "Enter" && !busy && save()} />
        </div>
        <div className="form-hint">{t("add.hint")}</div>
        {err && <div className="form-err">{err}</div>}
        <div className="actions">
          <button className="btn2" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn2 primary" onClick={save} disabled={busy}>
            {busy ? t("add.resolving") : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The confirmation behind the uninstall zone: says what will happen to this app (service, directory,
 * data) and sends the DELETE, to the hub route for a peer's app.
 */
export function UninstallForm({ app, onClose, onDone }: { app: AppInfo; onClose: () => void; onDone: () => void }) {
  const { lang, t } = useLang();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const path = app.peer ? `/api/peers/${encodeURIComponent(app.peer)}/apps/${encodeURIComponent(app.name)}` : `/api/apps/${encodeURIComponent(app.name)}`;
  const run = async () => {
    setErr("");
    setBusy(true);
    try {
      await sendJson("DELETE", path);
      onDone();
    } catch (e) {
      setErr(String((e as Error).message || e));
      setBusy(false);
    }
  };
  return (
    <div className="overlay" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>
          {t("uninstall.title", { title: localized(lang, app).title })}
          {app.peer && <span className="modal-sub">{t("common.onPeer", { peer: app.peer })}</span>}
        </h3>
        <ul className="modal-list">
          {app.service ? <li>{t("uninstall.stopService", { port: app.service.port })}</li> : <li>{t("uninstall.noService")}</li>}
          {app.manifestOnly ? <li>{t("uninstall.deleteLink")}</li> : <li>{t("uninstall.moveDir")}</li>}
          <li>{t("uninstall.forget")}</li>
        </ul>
        {err && <div className="form-err">{err}</div>}
        <div className="actions">
          <button className="btn2" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button className="btn2 danger" onClick={run} disabled={busy}>
            {busy ? t("uninstall.busy") : t("uninstall.action")}
          </button>
        </div>
      </div>
    </div>
  );
}
