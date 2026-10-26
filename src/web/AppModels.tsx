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
// - On a hub, each peer's apps follow under that machine's name (docs/peers.md): read through
//   `GET /api/peers/:peer/model/apps`, saved through `PATCH /api/peers/:peer/apps/:app/model`, and
//   offered the peer's own choices, since the call runs there. Such an app is keyed `<peer>/<app>`.

type Source = "request" | "choice" | "override-tag" | "override-app" | "manifest-tag" | "manifest-default" | "default";
export type Row = { tag: string | null; manifest?: string; override?: string; model: string; source: Source };
export type AppRows = { app: string; rows: Row[] };
export type Option = { value: string; runtime: string; tier: "basic" | "junior" | "intermediate" | "advanced"; model: string };
type AppLabel = { title: string; i18n?: AppInfo["i18n"]; icon: string };
export type AppGroup = AppRows & { key: string; peer?: string; title: string; icon: string };
/** One peer's part of the page: its rows and choices, or why there are none. */
export type PeerModels = { peer: string; apps?: AppRows[]; options?: Option[]; error?: string; old?: boolean };
type T = (key: Key, vars?: Record<string, string | number>) => string;

/** The app-wide row, and how many tags run on a model other than it. */
export function summarize(rows: Row[]): { app: Row | undefined; differ: number } {
  const app = rows.find((r) => r.tag === null);
  return { app, differ: app ? rows.filter((r) => r.tag !== null && r.model !== app.model).length : 0 };
}

/** Sets (`value`) or clears (empty) the override of an app, or of one of its tags (`tag` null = the app). */
export function saveAppModel(app: string, tag: string | null, value: string, peer?: string): Promise<AppRows> {
  const path = peer ? `/api/peers/${encodeURIComponent(peer)}/apps/${encodeURIComponent(app)}/model` : `/api/panel/apps/${encodeURIComponent(app)}/model`;
  return sendJson<AppRows>("PATCH", path, { ...(tag === null ? {} : { tag }), model: value || null });
}

/** A peer's rows; a peer whose core has no such route (404) is marked old rather than failed. */
export async function loadPeerModels(peer: string): Promise<PeerModels> {
  try {
    const r = await fetch(`/api/peers/${encodeURIComponent(peer)}/model/apps`);
    if (r.status === 404 && !/^unknown peer/.test(((await r.clone().json().catch(() => ({}))) as { error?: string }).error ?? "")) return { peer, old: true };
    // An older core answers a path it does not know with its page, not JSON.
    if (r.ok && !r.headers.get("content-type")?.includes("json")) return { peer, old: true };
    const d = (await r.json()) as { ok: boolean; error?: string; apps?: AppRows[]; options?: Option[] };
    if (!d.ok) return { peer, error: d.error || `HTTP ${r.status}` };
    return { peer, apps: d.apps ?? [], options: d.options ?? [] };
  } catch (e) {
    return { peer, error: String((e as Error).message || e) };
  }
}

function Ico({ icon }: { icon: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? "📦" : icon || "📦"}</>;
}

/** One line per app, for reading; a click opens the app's page. */
export function AppModelList({ groups, onOpen, t, heading, note }: { groups: AppGroup[]; onOpen: (key: string) => void; t: T; heading?: string; note?: string }) {
  if (groups.length === 0 && !note) return null;
  return (
    <section className="task-group app-model-list">
      {heading && (
        <div className="task-app">
          <span className="svc-name">{heading}</span>
        </div>
      )}
      {note && <p className="task-note">{note}</p>}
      {groups.map((g) => {
        const { app, differ } = summarize(g.rows);
        return (
          <div key={g.key} className="taskrow">
            <button className="task-main app-model-row" data-app={g.key} onClick={() => onOpen(g.key)}>
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

function ModelRow({ app, peer, row, options, onSaved }: { app: string; peer?: string; row: Row; options: Option[]; onSaved: (rows: AppRows) => void }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    setBusy(true);
    setError("");
    try {
      onSaved(await saveAppModel(app, row.tag, value, peer));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="taskrow">
      <div className="task-model app-model">
        <label htmlFor={`app-model-${peer ? `${peer}-` : ""}${app}-${row.tag ?? ""}`}>
          <span className="task-name">{row.tag ?? t("appModels.allTags")}</span>
          <span className="task-meta">
            <span className="task-kind">{row.model}</span>
            <span>{t(`appModels.source.${row.source}` as Key)}</span>
            <span>{row.manifest ? t("appModels.declared", { model: row.manifest }) : t("appModels.undeclared")}</span>
          </span>
        </label>
        <div className="task-model-controls">
          <select id={`app-model-${peer ? `${peer}-` : ""}${app}-${row.tag ?? ""}`} value={row.override ?? ""} disabled={busy} onChange={(e) => void save(e.target.value)}>
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
        {whole.map((row) => <ModelRow key="" app={group.app} peer={group.peer} row={row} options={options} onSaved={onSaved} />)}
      </section>
      <section className="task-group">
        <div className="task-app">
          <span className="svc-name">{t("appModels.tags")}</span>
        </div>
        {tags.length === 0 && <p className="task-note">{t("appModels.noTags")}</p>}
        {tags.map((row) => <ModelRow key={row.tag} app={group.app} peer={group.peer} row={row} options={options} onSaved={onSaved} />)}
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
  const [peers, setPeers] = useState<PeerModels[]>([]);
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
    // A space without peers answers with an empty list; each peer is read on its own, so a slow one holds up only its section.
    getJson<{ peers: { name: string }[] }>("/api/peers")
      .then((d) => {
        const names = (d.peers ?? []).map((p) => p.name).sort();
        setPeers(names.map((peer) => ({ peer })));
        for (const name of names) void loadPeerModels(name).then((m) => setPeers((ps) => ps.map((p) => (p.peer === name ? m : p))));
      })
      .catch(() => setPeers([]));
    // Keyed by the layout id: a peer's app is `<peer>/<app>`.
    getJson<{ apps: AppInfo[] }>("/api/apps?all=1")
      .then((d) => setLabels(Object.fromEntries((d.apps || []).map((a) => [a.id || a.name, { title: a.title, ...(a.i18n ? { i18n: a.i18n } : {}), icon: a.icon }]))))
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

  const toGroups = (apps: AppRows[], peer?: string): AppGroup[] => {
    const keyOf = (app: string) => (peer ? `${peer}/${app}` : app);
    const label = (key: string, app: string) => (labels[key] ? localized(lang, labels[key]).title : app);
    return apps.map((a) => ({ ...a, key: keyOf(a.app), ...(peer ? { peer } : {}), title: label(keyOf(a.app), a.app), icon: labels[keyOf(a.app)]?.icon || "📦" })).sort((a, b) => a.title.localeCompare(b.title, lang as Lang));
  };
  const groups = useMemo(() => toGroups(data?.apps ?? []), [data, labels, lang]);
  const peerGroups = useMemo(() => peers.map((p) => ({ ...p, groups: toGroups(p.apps ?? [], p.peer) })), [peers, labels, lang]);
  const all = [...groups, ...peerGroups.flatMap((p) => p.groups)];
  const group = selected ? all.find((g) => g.key === selected) : undefined;
  const optionsOf = (g: AppGroup) => (g.peer ? (peers.find((p) => p.peer === g.peer)?.options ?? []) : (data?.options ?? []));
  const loading = (p: PeerModels) => !p.apps && !p.error && !p.old;

  const swap = (apps: AppRows[], next: AppRows) => apps.map((a) => (a.app === next.app ? { app: next.app, rows: next.rows } : a));
  const replace = (peer: string | undefined) => (next: AppRows) =>
    peer ? setPeers((ps) => ps.map((p) => (p.peer === peer && p.apps ? { ...p, apps: swap(p.apps, next) } : p))) : setData((d) => (d ? { ...d, apps: swap(d.apps, next) } : d));

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
          <span className="chat-sub">{group?.peer ? t("appModels.onPeer", { peer: group.peer }) : t("appModels.summary")}</span>
          {!embedded && (<button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>)}
        </div>
        <div className="task-body">
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {data === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {data !== null && !selected && all.length === 0 && peers.length === 0 && <p className="task-note">{t("appModels.empty")}</p>}
          {data !== null && selected && !group && !peerGroups.some(loading) && <p className="task-note">{t("appModels.missing")}</p>}
          {!selected && <AppModelList groups={groups} onOpen={select} t={t} {...(peers.length ? { heading: t("appModels.here") } : {})} />}
          {!selected &&
            peerGroups.map((p) => (
              <AppModelList
                key={p.peer}
                groups={p.groups}
                onOpen={select}
                t={t}
                heading={t("appModels.onPeer", { peer: p.peer })}
                {...(loading(p) ? { note: t("common.loading") } : p.old ? { note: t("appModels.peerOld", { peer: p.peer }) } : p.error ? { note: t("appModels.peerDown", { peer: p.peer, error: p.error }) } : p.groups.length === 0 ? { note: t("appModels.empty") } : {})}
              />
            ))}
          {group && <AppModelDetail group={group} options={optionsOf(group)} onSaved={replace(group.peer)} t={t} />}
        </div>
      </div>
    </div>
  );
}
