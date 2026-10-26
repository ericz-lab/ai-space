import { useEffect, useMemo, useRef, useState } from "react";
import { type AppInfo, getJson, isImgIcon, sendJson } from "./api.ts";
import { type Key, type Lang, localized, useLang } from "./i18n.ts";

// App models window: which model each app's calls run on when they name none (docs/model.md#app-models).
// - Reads `GET /api/model/apps` when opened: per app, one row for the whole app and one per tag
//   (declared in space.yaml, overridden here, or seen in the ledger over 30 days).
// - The list shows one line per app: the model its calls run on now, the layer that chose it, and
//   how many purposes run on another model. A click opens the app's page.
// - The app's page shows the app-wide row and one row per tag; each select sets or clears the
//   panel override through the same-origin `PATCH /api/panel/apps/:app/model`, and saves at once.
// - Which app is open is held by the caller when it passes `selected`/`onSelect`: Settings shows
//   the list inside its Models section and the app's page as that section's sub-page, so its own
//   back button returns to the list. The standalone window holds it here.

type Source = "request" | "choice" | "override-tag" | "override-app" | "manifest-tag" | "manifest-default" | "default";
export type Row = { tag: string | null; manifest?: string; override?: string; model: string; source: Source };
export type AppRows = { app: string; rows: Row[] };
export type Option = { value: string; runtime: string; tier: "basic" | "junior" | "intermediate" | "advanced"; model: string };
type AppLabel = { title: string; i18n?: AppInfo["i18n"]; icon: string };
export type AppGroup = AppRows & { title: string; icon: string };
type T = (key: Key, vars?: Record<string, string | number>) => string;

/** The app-wide row, and how many tags run on a model other than it. */
export function summarize(rows: Row[]): { app: Row | undefined; differ: number } {
  const app = rows.find((r) => r.tag === null);
  return { app, differ: app ? rows.filter((r) => r.tag !== null && r.model !== app.model).length : 0 };
}

/** Sets (`value`) or clears (empty) the override of an app, or of one of its tags (`tag` null = the app). */
export function saveAppModel(app: string, tag: string | null, value: string): Promise<AppRows> {
  return sendJson<AppRows>("PATCH", `/api/panel/apps/${encodeURIComponent(app)}/model`, { ...(tag === null ? {} : { tag }), model: value || null });
}

function Ico({ icon }: { icon: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? "📦" : icon || "📦"}</>;
}

/** One line per app, for reading; a click opens the app's page. */
export function AppModelList({ groups, onOpen, t }: { groups: AppGroup[]; onOpen: (app: string) => void; t: T }) {
  if (groups.length === 0) return null;
  return (
    <section className="task-group app-model-list">
      {groups.map((g) => {
        const { app, differ } = summarize(g.rows);
        return (
          <div key={g.app} className="taskrow">
            <button className="task-main app-model-row" data-app={g.app} onClick={() => onOpen(g.app)}>
              <span className="svc-ico">
                <Ico icon={g.icon} />
              </span>
              <span className="task-text">
                <span className="task-line">
                  <span className="task-name">{g.title}</span>
                  {app && <span className="task-sched">{app.model}</span>}
                </span>
                <span className="task-meta">
                  {app && <span>{t(`appModels.source.${app.source}` as Key)}</span>}
                  {differ > 0 && <span className="task-badge">{differ === 1 ? t("appModels.differOne") : t("appModels.differ", { n: differ })}</span>}
                </span>
              </span>
              <span className="app-model-chev" aria-hidden="true">›</span>
            </button>
          </div>
        );
      })}
    </section>
  );
}

function ModelRow({ app, row, options, onSaved }: { app: string; row: Row; options: Option[]; onSaved: (rows: AppRows) => void }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await saveAppModel(app, row.tag, value));
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
            <span>{row.manifest ? t("appModels.declared", { model: row.manifest }) : t("appModels.undeclared")}</span>
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

/** One app's page: the app-wide override, then one row per purpose. */
export function AppModelDetail({ group, options, onSaved, t }: { group: AppGroup; options: Option[]; onSaved: (rows: AppRows) => void; t: T }) {
  const whole = group.rows.filter((r) => r.tag === null);
  const tags = group.rows.filter((r) => r.tag !== null);
  return (
    <>
      <section className="task-group">
        {whole.map((row) => <ModelRow key="" app={group.app} row={row} options={options} onSaved={onSaved} />)}
      </section>
      <section className="task-group">
        <div className="task-app">
          <span className="svc-name">{t("appModels.tags")}</span>
        </div>
        {tags.length === 0 && <p className="task-note">{t("appModels.noTags")}</p>}
        {tags.map((row) => <ModelRow key={row.tag} app={group.app} row={row} options={options} onSaved={onSaved} />)}
      </section>
    </>
  );
}

export default function AppModels({ open, onClose, onBack, embedded = false, selected: selectedProp, onSelect }: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  embedded?: boolean;
  /** The app whose page is shown; null = the list. Pass with `onSelect` to hold it outside. */
  selected?: string | null;
  onSelect?: (app: string | null) => void;
}) {
  const { lang, t } = useLang();
  const [data, setData] = useState<{ apps: AppRows[]; options: Option[] } | null>(null);
  const [labels, setLabels] = useState<Record<string, AppLabel>>({});
  const [err, setErr] = useState("");
  const [selectedHere, setSelectedHere] = useState<string | null>(null);
  const selected = selectedProp === undefined ? selectedHere : selectedProp;
  const select = (app: string | null) => (onSelect ? onSelect(app) : setSelectedHere(app));
  const root = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<string | null>(null);

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
    if (!open) setSelectedHere(null);
  }, [open]);

  useEffect(() => {
    if (!open || embedded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, embedded]);

  // An app's page starts at the top; back on the list, the app just left keeps the focus and stays in view.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (selected) {
      lastOpened.current = selected;
      el.closest(".setbody")?.scrollTo?.(0, 0);
      el.querySelector(".task-body")?.scrollTo?.(0, 0);
    } else if (lastOpened.current) {
      const row = [...el.querySelectorAll<HTMLButtonElement>(".app-model-row")].find((b) => b.dataset.app === lastOpened.current);
      row?.focus();
      lastOpened.current = null;
    }
  }, [selected]);

  const groups = useMemo(() => {
    const label = (app: string) => (labels[app] ? localized(lang, labels[app]).title : app);
    return (data?.apps ?? []).map((a) => ({ ...a, title: label(a.app), icon: labels[a.app]?.icon || "📦" })).sort((a, b) => a.title.localeCompare(b.title, lang as Lang));
  }, [data, labels, lang]);
  const group = selected ? groups.find((g) => g.app === selected) : undefined;

  const replace = (next: AppRows) => setData((d) => (d ? { ...d, apps: d.apps.map((a) => (a.app === next.app ? { app: next.app, rows: next.rows } : a)) } : d));

  return (
    <div ref={root} className={embedded ? "settings-detail" : `overlay${open ? "" : " off"}`} onClick={(e) => !embedded && e.target === e.currentTarget && onClose()}>
      <div className="tasks" role={embedded ? "region" : "dialog"} aria-label={selected ? (group?.title ?? selected) : t("appModels.title")}>
        <div className="task-head">
          {!embedded && (selected || onBack) && (
            <button className="chat-hbtn back" title={t("common.back")} onClick={() => (selected ? select(null) : onBack?.())}>
              ‹
            </button>
          )}
          {selected && group && (
            <span className="svc-ico">
              <Ico icon={group.icon} />
            </span>
          )}
          <b>{selected ? (group?.title ?? selected) : t("appModels.title")}</b>
          <span className="chat-sub">{t("appModels.summary")}</span>
          {!embedded && (<button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>)}
        </div>
        <div className="task-body">
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {data === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {data !== null && !selected && groups.length === 0 && <p className="task-note">{t("appModels.empty")}</p>}
          {data !== null && selected && !group && <p className="task-note">{t("appModels.missing")}</p>}
          {!selected && <AppModelList groups={groups} onOpen={select} t={t} />}
          {group && <AppModelDetail group={group} options={data?.options ?? []} onSaved={replace} t={t} />}
        </div>
      </div>
    </div>
  );
}
