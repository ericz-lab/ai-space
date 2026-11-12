import type { ModelChoice } from "./api.ts";
import { ChoiceOption, SavedChoice } from "./model-choices.tsx";
import { useEffect, useMemo, useRef, useState } from "react";
import { type AppInfo, type RunInfo, type TaskInfo, dateTime, fmtDuration, getJson, isImgIcon, relTime, scheduleText, sendJson, untilTime } from "./api.ts";
import { type Key, type Lang, localized, useLang } from "./i18n.ts";
import { pollWhileVisible } from "./poll.ts";

// Tasks window: scheduler state and per-task model selection, by machine and app.
// - Reads `GET /api/tasks` when opened and every 30 s while open; the list is small (tens of tasks).
// - The list shows one line per app that has tasks: how many are active and how many fail. A click
//   opens the app's page with its tasks.
// - A task row shows the effective schedule and event triggers, the next run, the last outcome; clicking it loads run history.
// - App titles and icons come from `GET /api/apps?all=1` so headless and hidden apps still get a name.
// - On a hub, each peer's apps follow under that machine's name (docs/peers.md), as on the app
//   models page: read through `GET /api/peers/:peer/tasks`, with the runs, the model choices and
//   the model change forwarded the same way, since the task runs there. Such an app is keyed `<peer>/<app>`.
// - Which app is open is held by the caller when it passes `selected`/`onSelect` (Settings, whose
//   own back button returns to the list); the standalone window holds it here.
// Model changes use a narrow same-origin panel route; the browser never holds the operator token.

type AppLabel = { title: string; i18n?: AppInfo["i18n"]; icon: string };
type T = (key: Key, vars?: Record<string, string | number>) => string;
/** One app's tasks on one machine. */
export type TaskGroup = { key: string; app: string; peer?: string; title: string; icon: string; list: TaskInfo[] };
/** One peer's part of the page: its tasks, or why there are none. */
export type PeerTasks = { peer: string; tasks?: TaskInfo[]; error?: string; old?: boolean };

/** The task routes of this machine, or of a peer through the hub. */
const tasksBase = (peer?: string) => (peer ? `/api/peers/${encodeURIComponent(peer)}/tasks` : "/api/tasks");
export const runsPath = (id: string, peer?: string) => `${tasksBase(peer)}/${encodeURIComponent(id)}/runs?limit=20`;
export const modelsPath = (peer?: string) => `${tasksBase(peer)}/models`;
export const modelPath = (id: string, peer?: string) => (peer ? `${tasksBase(peer)}/${encodeURIComponent(id)}/model` : `/api/panel/tasks/${encodeURIComponent(id)}/model`);

/** How many tasks there are, how many are on, and how many of those failed their last run. */
export function counts(list: TaskInfo[]): { total: number; active: number; failing: number } {
  const on = list.filter((t) => t.enabled && !t.orphaned);
  return { total: list.length, active: on.length, failing: on.filter((t) => t.state.lastStatus === "error").length };
}

/** A peer's tasks; a peer whose core has no such route (404) is marked old rather than failed. */
export async function loadPeerTasks(peer: string): Promise<PeerTasks> {
  try {
    const r = await fetch(tasksBase(peer));
    if (r.status === 404 && !/^unknown peer/.test(((await r.clone().json().catch(() => ({}))) as { error?: string }).error ?? "")) return { peer, old: true };
    // An older core answers a path it does not know with its page, not JSON.
    if (r.ok && !r.headers.get("content-type")?.includes("json")) return { peer, old: true };
    const d = (await r.json()) as { ok: boolean; error?: string; tasks?: TaskInfo[] };
    if (!d.ok) return { peer, error: d.error || `HTTP ${r.status}` };
    return { peer, tasks: d.tasks ?? [] };
  } catch (e) {
    return { peer, error: String((e as Error).message || e) };
  }
}

function Ico({ icon }: { icon: string }) {
  const [broken, setBroken] = useState(false);
  if (isImgIcon(icon) && !broken) return <img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} />;
  return <>{isImgIcon(icon) ? "📦" : icon || "📦"}</>;
}

/** Status class of a row: the dot colour follows the last outcome; off and orphaned rows are muted. */
function rowStatus(t: TaskInfo): { cls: string; key: Key; n?: number } {
  if (t.orphaned) return { cls: "off", key: "tasks.orphaned" };
  if (!t.enabled) return { cls: "off", key: "tasks.off" };
  if (t.state.runningAt) return { cls: "running", key: "tasks.running" };
  switch (t.state.lastStatus) {
    case "ok":
      return { cls: "ok", key: "status.ok" };
    case "error":
      return t.state.consecutiveErrors > 1 ? { cls: "down", key: "tasks.errorN", n: t.state.consecutiveErrors } : { cls: "down", key: "tasks.error" };
    case "skipped":
      return { cls: "paused", key: "tasks.skipped" };
    default:
      return { cls: "", key: "tasks.neverRan" };
  }
}

const RUN_STATUS: Record<RunInfo["status"], Key> = { ok: "status.ok", error: "tasks.error", skipped: "tasks.skipped" };

function Runs({ taskId, peer }: { taskId: string; peer?: string }) {
  const { lang, t } = useLang();
  const [runs, setRuns] = useState<RunInfo[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setRuns(null);
    getJson<{ runs: RunInfo[] }>(runsPath(taskId, peer))
      .then((d) => setRuns(d.runs || []))
      .catch((e) => setErr(String((e as Error).message || e)));
  }, [taskId, peer]);
  if (err) return <p className="task-note">{t("common.unavailable", { error: err })}</p>;
  if (runs === null) return <p className="task-note">{t("common.loading")}</p>;
  if (!runs.length) return <p className="task-note">{t("tasks.noRuns")}</p>;
  return (
    <div className="runs">
      {runs.map((r) => (
        <div key={r.id} className="runrow">
          <div className="run-line">
            <span className={`status ${r.status === "ok" ? "ok" : r.status === "error" ? "down" : "paused"}`}>
              <i />
              {t(RUN_STATUS[r.status])}
            </span>
            <span className="run-time" title={dateTime(r.startedAt, lang)}>
              {relTime(r.startedAt, lang)}
            </span>
            {r.trigger === "manual" && <span className="task-badge">{t("tasks.manualRun")}</span>}
            {r.eventIds?.length ? <span className="task-badge">{t("tasks.eventRun", { n: r.eventIds.length })}</span> : null}
            <span className="run-dur">{fmtDuration(r.endedAt - r.startedAt, lang)}</span>
          </div>
          {r.error && <div className="run-err">{r.error}</div>}
          {r.output && <pre className="run-out">{r.output}</pre>}
        </div>
      ))}
    </div>
  );
}

type ModelOption = ModelChoice & { capabilities: { agent: boolean; complete: boolean } };

function ModelPicker({ task, peer, onSaved }: { task: TaskInfo; peer?: string; onSaved: (task: TaskInfo) => void }) {
  const { t } = useLang();
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [value, setValue] = useState(task.overrides.model ?? "");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => { setValue(task.overrides.model ?? ""); }, [task.id, task.overrides.model]);
  useEffect(() => {
    let live = true;
    // A peer's task runs there, so the choices are the peer's own.
    getJson<{ models: ModelOption[] }>(modelsPath(peer))
      .then((data) => { if (live) { setOptions(data.models); setLoaded(true); } })
      .catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [peer]);
  const eligible = options.filter((o) => task.target.kind === "agent" ? o.capabilities.agent : o.capabilities.complete);
  const save = async () => {
    setBusy(true); setError(""); setSaved(false);
    try {
      const result = await sendJson<{ task: TaskInfo }>("PATCH", modelPath(task.id, peer), { model: value || null });
      onSaved(result.task); setSaved(true);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!task.modelSelectable) return <p className="task-note">{t("tasks.modelUnsupported")}</p>;
  const selectId = `task-model-${peer ? `${peer}-` : ""}${task.id}`;
  return <div className="task-model">
    <label htmlFor={selectId}>{t("tasks.model")}</label>
    <div className="task-model-controls">
      <select id={selectId} value={value} disabled={busy || !loaded || task.orphaned} onChange={(e) => { setValue(e.target.value); setSaved(false); }}>
        <option value="">{t("tasks.modelDefault", { model: task.base?.model ?? t("chat.modelDefault") })}</option>
        {value && !eligible.some((o) => o.value === value) && <SavedChoice value={value} t={t} />}
        {[...new Set(eligible.map((o) => o.runtime))].map((runtime) => <optgroup key={runtime} label={runtime}>
          {eligible.filter((o) => o.runtime === runtime).map((o) => <ChoiceOption key={o.value} o={o} label={`${t(`modelTier.${o.tier}`)} · ${o.model}`} t={t} />)}
        </optgroup>)}
      </select>
      <button type="button" disabled={busy || !loaded || task.orphaned || value === (task.overrides.model ?? "")} onClick={() => void save()}>{busy ? t("common.loading") : t("common.save")}</button>
    </div>
    <p className="task-note">{t("tasks.modelNextRun")}</p>
    {saved && <p role="status" className="task-note">{t("tasks.modelSaved")}</p>}
    {error && <p role="alert" className="run-err">{error}</p>}
  </div>;
}

function TaskRow({ t, peer, open, onToggle, onSaved }: { t: TaskInfo; peer?: string; open: boolean; onToggle: () => void; onSaved: (task: TaskInfo) => void }) {
  const { lang, t: tr } = useLang();
  const st = rowStatus(t);
  const next = t.enabled && !t.orphaned && t.state.nextRunAt ? untilTime(t.state.nextRunAt, lang) : "";
  const last = t.state.lastRunAt ? relTime(t.state.lastRunAt, lang) : "";
  const badges = [t.source === "api" ? "api" : "", t.overrides.enabled !== undefined || t.overrides.schedule || t.overrides.model ? "override" : ""].filter(Boolean);
  return (
    <div className={`taskrow ${st.cls} ${open ? "open" : ""}`}>
      <button className="task-main" onClick={onToggle} title={t.description || `${t.app}/${t.name}`}>
        <span className={`status ${st.cls}`}>
          <i />
        </span>
        <span className="task-text">
          <span className="task-line">
            <span className="task-name">{t.name}</span>
            {badges.map((b) => (
              <span key={b} className="task-badge">
                {b}
              </span>
            ))}
            <span className="task-sched">
              {t.triggers.map((g) => (
                <span key={g.event} className="task-on" title={[g.filter && JSON.stringify(g.filter), g.debounceMs && fmtDuration(g.debounceMs, lang)].filter(Boolean).join(" · ") || undefined}>
                  {tr("tasks.on", { event: g.event })}
                </span>
              ))}
              {(t.schedule.kind !== "manual" || !t.triggers.length) && <span>{scheduleText(t.schedule, lang)}</span>}
            </span>
          </span>
          <span className="task-meta">
            <span>{tr(st.key, { n: st.n ?? 0 })}</span>
            {t.state.lastDurationMs !== undefined && <span>{fmtDuration(t.state.lastDurationMs, lang)}</span>}
            {last && <span title={t.state.lastRunAt && dateTime(t.state.lastRunAt, lang)}>{last}</span>}
            {next && <span title={t.state.nextRunAt && dateTime(t.state.nextRunAt, lang)}>{tr("tasks.next", { time: next })}</span>}
            {t.state.pending && <span title={t.state.pending.dueAt && dateTime(t.state.pending.dueAt, lang)}>{tr("tasks.pending", { n: t.state.pending.events })}</span>}
            <span className="task-kind">{t.target.kind}</span>
            {t.model && <span className="task-kind">{t.model}</span>}
          </span>
        </span>
      </button>
      {open && (
        <div className="task-detail">
          {t.description && <p className="task-desc">{t.description}</p>}
          <ModelPicker task={t} peer={peer} onSaved={onSaved} />
          <Runs taskId={t.id} peer={peer} />
        </div>
      )}
    </div>
  );
}

/** One machine's apps, one line each, for reading; a click opens the app's tasks. */
export function TaskAppList({ groups, onOpen, t, heading, note }: { groups: TaskGroup[]; onOpen: (key: string) => void; t: T; heading?: string; note?: string }) {
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
        const c = counts(g.list);
        return (
          <div key={g.key} className="taskrow">
            <button className="task-main app-model-row" data-app={g.key} onClick={() => onOpen(g.key)}>
              <span className="svc-ico">
                <Ico icon={g.icon} />
              </span>
              <span className="task-text">
                <span className="task-line">
                  <span className="task-name">{g.title}</span>
                </span>
                <span className="task-meta">
                  <span>{t("tasks.summary", c)}</span>
                  {c.failing > 0 && <span className="task-badge task-failing">{t("tasks.failingN", { n: c.failing })}</span>}
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

export default function Tasks({ open, onClose, onBack, embedded = false, selected: selectedProp, onSelect }: {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  embedded?: boolean;
  /** The app whose tasks are shown; null = the list. Pass with `onSelect` to hold it outside. */
  selected?: string | null;
  onSelect?: (app: string | null) => void;
}) {
  const { lang, t } = useLang();
  const [tasks, setTasks] = useState<TaskInfo[] | null>(null);
  const [peers, setPeers] = useState<PeerTasks[]>([]);
  const [labels, setLabels] = useState<Record<string, AppLabel>>({});
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [selectedHere, setSelectedHere] = useState<string | null>(null);
  const selected = selectedProp === undefined ? selectedHere : selectedProp;
  const select = (app: string | null) => (onSelect ? onSelect(app) : setSelectedHere(app));
  const root = useRef<HTMLDivElement>(null);
  const lastOpened = useRef<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const load = () => {
      getJson<{ tasks: TaskInfo[] }>("/api/tasks")
        .then((d) => {
          if (!live) return;
          setTasks(d.tasks || []);
          setErr("");
        })
        .catch((e) => live && setErr(String((e as Error).message || e)));
      // A space without peers answers with an empty list; each peer is read on its own, so a slow
      // one holds up only its section, and a refresh keeps what a peer showed until its answer is in.
      getJson<{ peers: { name: string }[] }>("/api/peers")
        .then((d) => {
          if (!live) return;
          const names = (d.peers ?? []).map((p) => p.name).sort();
          setPeers((ps) => names.map((peer) => ps.find((p) => p.peer === peer) ?? { peer }));
          for (const name of names) void loadPeerTasks(name).then((m) => live && setPeers((ps) => ps.map((p) => (p.peer === name ? m : p))));
        })
        .catch(() => live && setPeers((ps) => ps));
    };
    load();
    // Keyed by the layout id: a peer's app is `<peer>/<app>`.
    getJson<{ apps: AppInfo[] }>("/api/apps?all=1")
      .then((d) => live && setLabels(Object.fromEntries((d.apps || []).map((a) => [a.id || a.name, { title: a.title, ...(a.i18n ? { i18n: a.i18n } : {}), icon: a.icon }]))))
      .catch(() => {});
    const stop = pollWhileVisible(load, 30_000);
    return () => {
      live = false;
      stop();
    };
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

  // An app's page starts at the top with every task closed; back on the list, the app just left keeps the focus and stays in view.
  useEffect(() => {
    setOpenId(null);
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

  const toGroups = (list: TaskInfo[], peer?: string): TaskGroup[] => {
    const keyOf = (app: string) => (peer ? `${peer}/${app}` : app);
    const byApp = new Map<string, TaskInfo[]>();
    for (const task of list) byApp.set(task.app, [...(byApp.get(task.app) || []), task]);
    const title = (app: string) => (labels[keyOf(app)] ? localized(lang, labels[keyOf(app)]!).title : app);
    // A peer app the hub's list leaves out (one with the same link as a local app) still has its icon on the peer.
    const iconOf = (app: string) => labels[keyOf(app)]?.icon || (peer ? `/api/peers/${encodeURIComponent(peer)}/apps/${encodeURIComponent(app)}/icon` : "📦");
    return [...byApp.entries()]
      .map(([app, of]) => ({ key: keyOf(app), app, ...(peer ? { peer } : {}), title: title(app), icon: iconOf(app), list: of.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.title.localeCompare(b.title, lang as Lang));
  };
  const groups = useMemo(() => toGroups(tasks ?? []), [tasks, labels, lang]);
  const peerGroups = useMemo(() => peers.map((p) => ({ ...p, groups: toGroups(p.tasks ?? [], p.peer) })), [peers, labels, lang]);
  const all = [...groups, ...peerGroups.flatMap((p) => p.groups)];
  const group = selected ? all.find((g) => g.key === selected) : undefined;
  const loading = (p: PeerTasks) => !p.tasks && !p.error && !p.old;

  const swap = (list: TaskInfo[], next: TaskInfo) => list.map((row) => (row.id === next.id ? next : row));
  const replace = (peer: string | undefined) => (next: TaskInfo) =>
    peer ? setPeers((ps) => ps.map((p) => (p.peer === peer && p.tasks ? { ...p, tasks: swap(p.tasks, next) } : p))) : setTasks((current) => (current ? swap(current, next) : current));

  // The heading counts what is on the page: one app's tasks, or every machine's that has answered.
  const shown = counts(group ? group.list : [...(tasks ?? []), ...peers.flatMap((p) => p.tasks ?? [])]);
  const summary = tasks === null || (selected && !group) ? "" : `${t("tasks.summary", shown)}${shown.failing ? t("tasks.failing", { n: shown.failing }) : ""}`;

  return (
    <div ref={root} className={embedded ? "settings-detail" : `overlay${open ? "" : " off"}`} onClick={(e) => !embedded && e.target === e.currentTarget && onClose()}>
      <div className="tasks" role={embedded ? "region" : "dialog"} aria-label={selected ? (group?.title ?? selected) : t("tasks.title")}>
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
        <b>{selected ? (group?.title ?? selected) : t("tasks.title")}</b>
        <span className="chat-sub">{[group?.peer ? t("appModels.onPeer", { peer: group.peer }) : "", summary].filter(Boolean).join(" · ")}</span>
        {!embedded && (<button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
          ✕
        </button>)}
      </div>
      <div className="task-body">
        {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
        {tasks === null && !err && <p className="task-note">{t("common.loading")}</p>}
        {tasks !== null && !selected && all.length === 0 && peers.length === 0 && <p className="task-note">{t("tasks.empty")}</p>}
        {tasks !== null && selected && !group && !peerGroups.some(loading) && <p className="task-note">{t("tasks.appGone")}</p>}
        {!selected && tasks !== null && (
          <TaskAppList groups={groups} onOpen={select} t={t} {...(peers.length ? { heading: t("appModels.here"), ...(groups.length === 0 ? { note: t("tasks.noneHere") } : {}) } : {})} />
        )}
        {!selected &&
          peerGroups.map((p) => (
            <TaskAppList
              key={p.peer}
              groups={p.groups}
              onOpen={select}
              t={t}
              heading={t("appModels.onPeer", { peer: p.peer })}
              {...(loading(p) ? { note: t("common.loading") } : p.old ? { note: t("tasks.peerOld", { peer: p.peer }) } : p.error ? { note: t("appModels.peerDown", { peer: p.peer, error: p.error }) } : p.groups.length === 0 ? { note: t("tasks.noneHere") } : {})}
            />
          ))}
        {group && (
          <section className="task-group">
            {group.list.map((task) => (
              <TaskRow key={task.id} t={task} peer={group.peer} open={openId === task.id} onToggle={() => setOpenId(openId === task.id ? null : task.id)} onSaved={replace(group.peer)} />
            ))}
          </section>
        )}
      </div>
      </div>
    </div>
  );
}
