import { useState } from "react";
import { sendJson, type AppInfo } from "./api.ts";
import { localized, useLang } from "./i18n.ts";

// The panel's two dialogs in edit mode: add an app (make a new one inside the Space, or from a
// link), and confirm an uninstall.

export type CreatedApp = { app: string; version: string; dir: string; description: string };

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function AddForm({ onClose, onSaved, onCreated }: { onClose: () => void; onSaved: (app?: AppInfo) => void; onCreated?: (made: CreatedApp) => void }) {
  const { t } = useLang();
  const [mode, setMode] = useState<"new" | "link">(onCreated ? "new" : "link");
  const [link, setLink] = useState("");
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // A name from the title the user types, until they type a name themselves.
  const [nameTouched, setNameTouched] = useState(false);
  const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  const create = async () => {
    const n = name.trim();
    if (!NAME_RE.test(n)) return setErr(t("create.needName"));
    if (!description.trim()) return setErr(t("create.needWhat"));
    setErr("");
    setBusy(true);
    try {
      const r = await sendJson<{ dir: string; build: { app: string; version: string } }>("POST", "/api/studio/apps", { name: n, title: title.trim() || undefined, description: description.trim() });
      onCreated?.({ app: r.build.app, version: r.build.version, dir: r.dir, description: description.trim() });
    } catch (e) {
      setErr(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  };
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
          {t("add.title")}
          <span className="modal-sub">{mode === "new" ? t("create.sub") : t("add.sub")}</span>
        </h3>
        {onCreated && (
          <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <button role="tab" aria-selected={mode === "new"} className={`lib-chip${mode === "new" ? " on" : ""}`} onClick={() => (setMode("new"), setErr(""))} disabled={busy}>
              {t("create.tab")}
            </button>
            <button role="tab" aria-selected={mode === "link"} className={`lib-chip${mode === "link" ? " on" : ""}`} onClick={() => (setMode("link"), setErr(""))} disabled={busy}>
              {t("add.tab")}
            </button>
          </div>
        )}
        {mode === "new" ? (
          <>
            <div className="field">
              <label>{t("create.title")}</label>
              <input
                value={title}
                autoFocus
                disabled={busy}
                placeholder={t("create.titlePlaceholder")}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (!nameTouched) setName(slug(e.target.value));
                }}
              />
            </div>
            <div className="field">
              <label>{t("create.name")}</label>
              <input value={name} disabled={busy} placeholder="my-app" onChange={(e) => (setName(e.target.value), setNameTouched(true))} />
            </div>
            <div className="field">
              <label>{t("create.what")}</label>
              <textarea rows={4} value={description} disabled={busy} placeholder={t("create.whatPlaceholder")} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="form-hint">{t("create.hint")}</div>
          </>
        ) : (
          <>
            <div className="field">
              <label>{t("add.link")}</label>
              <input value={link} onChange={(e) => setLink(e.target.value)} disabled={busy} placeholder={t("add.placeholder")} onKeyDown={(e) => e.key === "Enter" && !busy && save()} />
            </div>
            <div className="form-hint">{t("add.hint")}</div>
          </>
        )}
        {err && <div className="form-err">{err}</div>}
        <div className="actions">
          <button className="btn2" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          {mode === "new" ? (
            <button className="btn2 primary" onClick={create} disabled={busy}>
              {busy ? t("create.making") : t("create.make")}
            </button>
          ) : (
            <button className="btn2 primary" onClick={save} disabled={busy}>
              {busy ? t("add.resolving") : t("common.save")}
            </button>
          )}
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
