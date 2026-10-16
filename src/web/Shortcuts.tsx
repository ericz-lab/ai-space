import { useEffect, useMemo, useState } from "react";
import ActionRunner, { RunCard } from "./ActionRunner.tsx";
import { getJson, relTime } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";
import { type Action, type RunView, actionKey, actionText } from "./shortcuts.ts";

// Shortcuts window (docs/shortcuts.md#user-experience): the action catalogue with a search, one
// action's form and result, and the recent runs. A run started here or in the command box keeps
// going when the window closes; it is listed here with its status and result when it reopens.
// An action that cannot run says what it is missing instead of disappearing.

export default function Shortcuts({ open, onClose, onOpenTasks, focus }: { open: boolean; onClose: () => void; onOpenTasks: () => void; focus?: { action?: string; run?: number } }) {
  const { lang, t } = useLang();
  const [actions, setActions] = useState<Action[] | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<number | null>(null);

  const loadRuns = () =>
    getJson<{ runs: RunView[] }>("/api/shortcuts/runs?limit=30")
      .then((d) => setRuns(d.runs))
      .catch(() => {});
  useEffect(() => {
    if (!open) return;
    getJson<{ actions: Action[] }>("/api/shortcuts/actions")
      .then((d) => {
        setActions(d.actions);
        setErr("");
      })
      .catch((e) => setErr(String((e as Error).message || e)));
    void loadRuns();
    if (focus?.action) setSelected(focus.action);
    if (focus?.run) setOpenRun(focus.run);
  }, [open, focus]);
  // Running runs are followed while the window is open.
  const running = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(loadRuns, running ? 2_000 : 15_000);
    return () => clearInterval(timer);
  }, [open, running]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    const list = (actions ?? []).filter((a) => {
      if (!needle) return true;
      const tx = actionText(a, lang);
      return [tx.title, tx.description, a.title, a.app, ...a.keywords, ...Object.values(a.i18n ?? {}).flatMap((x) => [x.title, ...(x.keywords ?? [])])].some((w) => w?.toLocaleLowerCase().includes(needle));
    });
    return [...list.filter((a) => a.available), ...list.filter((a) => !a.available)];
  }, [actions, q, lang]);
  const current = (actions ?? []).find((a) => actionKey(a) === selected);
  const byKey = (r: RunView) => (actions ?? []).find((a) => a.id === r.action && (a.peer ?? "") === (r.peer ?? ""));

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks sc-window" role="dialog" aria-label={t("sc.title")}>
        <div className="task-head">
          <b>{t("sc.title")}</b>
          <span className="chat-sub">{t("sc.blurb")}</span>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="task-body sc-body">
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {actions === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {actions && (
            <>
              <input className="sc-input sc-search" placeholder={t("sc.search")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("sc.search")} />
              <div className="sc-catalogue">
                {shown.map((a) => {
                  const tx = actionText(a, lang);
                  const key = actionKey(a);
                  return (
                    <button key={key} className={`sc-card${selected === key ? " on" : ""}${a.available ? "" : " off"}`} onClick={() => setSelected(selected === key ? null : key)} title={a.available ? tx.description : a.reason}>
                      <b>{tx.title}</b>
                      <span className="sc-sub">
                        {a.builtin ? t("sc.builtin") : a.app}
                        {a.peer ? ` · ${a.peer}` : ""}
                        {a.effect !== "read" ? ` · ${t(a.effect === "write" ? "sc.effect.write" : "sc.effect.run")}` : ""}
                      </span>
                      {!a.available && <span className="sc-sub sc-why">{a.reason}</span>}
                    </button>
                  );
                })}
              </div>
              {current && (
                <div className="sc-selected">
                  <h4>{actionText(current, lang).title}</h4>
                  {actionText(current, lang).description && <p className="sc-sub">{actionText(current, lang).description}</p>}
                  <ActionRunner key={actionKey(current)} action={current} args={{}} onOpenTasks={onOpenTasks} />
                </div>
              )}
              <h4 className="sc-h">{t("sc.recent")}</h4>
              {!runs.length && <p className="task-note">{t("sc.noRuns")}</p>}
              {runs.map((r) => (
                <div key={r.id} className={`taskrow sc-runrow${openRun === r.id ? " open" : ""}`}>
                  <button className="sc-runline" onClick={() => setOpenRun(openRun === r.id ? null : r.id)}>
                    <span className={`sc-badge ${r.status}`}>{t(`sc.status.${r.status}` as Key)}</span>
                    <b>{byKey(r) ? actionText(byKey(r)!, lang).title : r.title}</b>
                    <span className="sc-sub">{summary(r)}</span>
                    <span className="sc-sub sc-time">{relTime(r.createdAt, lang)}</span>
                  </button>
                  {openRun === r.id && <RunCard run={r} action={byKey(r)} onOpenTasks={onOpenTasks} />}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** The arguments of a run on one line, as typed. */
function summary(r: RunView): string {
  if (r.result?.kind === "task") return r.result.task;
  return Object.values(r.args)
    .map((v) => String(v))
    .filter(Boolean)
    .join(" · ")
    .slice(0, 80);
}
