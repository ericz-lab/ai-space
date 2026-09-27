import { useEffect, useMemo, useState } from "react";
import { type AppInfo, getJson, isImgIcon, sendJson } from "./api.ts";
import { type Key, type Lang, localized, useLang } from "./i18n.ts";

// App models window: which model each app's calls run on when they name none (docs/model.md#app-models).
// - Reads `GET /api/model/apps` when opened: per app, one row for the whole app and one per tag
//   (declared in space.yaml, overridden here, or seen in the ledger over 30 days).
// - A row shows the model it runs on now and the layer that chose it; the select sets or clears the
//   panel override through the same-origin `PATCH /api/panel/apps/:app/model`, and saves at once.

type Source = "request" | "override-tag" | "override-app" | "manifest-tag" | "manifest-default" | "default";
type Row = { tag: string | null; manifest?: string; override?: string; model: string; source: Source };
type AppRows = { app: string; rows: Row[] };
type Option = { value: string; runtime: string; tier: "basic" | "junior" | "intermediate" | "advanced"; model: string };
type AppLabel = { title: string; i18n?: AppInfo["i18n"]; icon: string };

function Ico({ icon }: { icon: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? "📦" : icon || "📦"}</>;
}

function ModelRow({ app, row, options, onSaved }: { app: string; row: Row; options: Option[]; onSaved: (rows: AppRows) => void }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await sendJson<AppRows>("PATCH", `/api/panel/apps/${encodeURIComponent(app)}/model`, { ...(row.tag === null ? {} : { tag: row.tag }), model: value || null }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="taskrow">
      <div className="task-model app-model">
        <label htmlFor={`app-model-${app}-${row.tag ?? ""}`}>
          <span className="task-name">{row.tag ?? t("appModels.allTags")}</span>
          <span className="task-meta">
            <span className="task-kind">{row.model}</span>
            <span>{t(`appModels.source.${row.source}` as Key)}</span>
            {row.manifest && <span>{t("appModels.declared", { model: row.manifest })}</span>}
          </span>
        </label>
        <div className="task-model-controls">
          <select id={`app-model-${app}-${row.tag ?? ""}`} value={row.override ?? ""} disabled={busy} onChange={(e) => void save(e.target.value)}>
            <option value="">{t("appModels.noOverride")}</option>
            {row.override && !options.some((o) => o.value === row.override) && <option value={row.override}>{row.override}</option>}
            {[...new Set(options.map((o) => o.runtime))].map((runtime) => (
              <optgroup key={runtime} label={runtime}>
                {options.filter((o) => o.runtime === runtime).map((o) => <option key={o.value} value={o.value}>{t(`modelTier.${o.tier}`)} · {o.model}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        {error && <p role="alert" className="run-err">{error}</p>}
      </div>
    </div>
  );
}

export default function AppModels({ open, onClose, onBack }: { open: boolean; onClose: () => void; onBack?: () => void }) {
  const { lang, t } = useLang();
  const [data, setData] = useState<{ apps: AppRows[]; options: Option[] } | null>(null);
  const [labels, setLabels] = useState<Record<string, AppLabel>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    getJson<{ apps: AppRows[]; options: Option[] }>("/api/model/apps")
      .then((d) => {
        setData(d);
        setErr("");
      })
      .catch((e) => setErr(String((e as Error).message || e)));
    getJson<{ apps: AppInfo[] }>("/api/apps?all=1")
      .then((d) => setLabels(Object.fromEntries((d.apps || []).map((a) => [a.name, { title: a.title, ...(a.i18n ? { i18n: a.i18n } : {}), icon: a.icon }]))))
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const label = (app: string) => (labels[app] ? localized(lang, labels[app]).title : app);
    return (data?.apps ?? []).map((a) => ({ ...a, title: label(a.app), icon: labels[a.app]?.icon || "📦" })).sort((a, b) => a.title.localeCompare(b.title, lang as Lang));
  }, [data, labels, lang]);

  const replace = (next: AppRows) => setData((d) => (d ? { ...d, apps: d.apps.map((a) => (a.app === next.app ? { app: next.app, rows: next.rows } : a)) } : d));

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks" role="dialog" aria-label={t("appModels.title")}>
        <div className="task-head">
          {onBack && (
            <button className="chat-hbtn back" title={t("common.back")} onClick={onBack}>
              ‹
            </button>
          )}
          <b>{t("appModels.title")}</b>
          <span className="chat-sub">{t("appModels.summary")}</span>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="task-body">
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {data === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {groups.map((g) => (
            <section key={g.app} className="task-group">
              <div className="task-app">
                <span className="svc-ico">
                  <Ico icon={g.icon} />
                </span>
                <span className="svc-name">{g.title}</span>
              </div>
              {g.rows.map((row) => (
                <ModelRow key={row.tag ?? ""} app={g.app} row={row} options={data?.options ?? []} onSaved={replace} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
