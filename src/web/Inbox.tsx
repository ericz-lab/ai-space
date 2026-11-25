import { useEffect, useRef, useState } from "react";
import { type AppInfo, type InboxItem, type InboxSummary, dateTime, getJson, relTime, sendJson } from "./api.ts";
import { type Key, localized, useLang } from "./i18n.ts";
import { PAGE } from "./panel-link.ts";
import { pollWhileVisible } from "./poll.ts";

// Inbox window (a floating panel): every app's notifications in one list (docs/notify.md#inbox).
// - A thread is one app's notifications with the same key: a task that failed 300 times is one row with a count.
// - Opening a row marks it read; "done" closes a thread until a newer notification arrives in it.
// - `alert` and `warn` are the levels that ask for something; the "to handle" filter shows only those still open.
// The list refreshes every 30 s while open; every change reports the new summary to the launcher's badge.

type Filter = "all" | "unread" | "handle" | "done";
const FILTERS: { id: Filter; key: Key }[] = [
  { id: "all", key: "inbox.all" },
  { id: "unread", key: "inbox.unread" },
  { id: "handle", key: "inbox.toHandle" },
  { id: "done", key: "inbox.done" },
];
const QUERY: Record<Filter, string> = { all: "filter=all", unread: "filter=unread", handle: "filter=open&action=1", done: "filter=done" };

const LEVEL_DOT: Record<InboxItem["level"], string> = { alert: "down", warn: "paused", success: "ok", report: "", info: "" };

export default function Inbox({ open, onClose, onSummary }: { open: boolean; onClose: () => void; onSummary: (s: InboxSummary) => void }) {
  const { lang, t } = useLang();
  const [filter, setFilter] = useState<Filter>("all");
  const [app, setApp] = useState("");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [summary, setSummary] = useState<InboxSummary | null>(null);
  const [apps, setApps] = useState<string[]>([]);
  const [err, setErr] = useState("");
  const [openThread, setOpenThread] = useState<string | null>(null);
  const openRef = useRef(openThread);
  openRef.current = openThread;
  // Apps by their titles, not their ids (keyed by the layout id, as in the Tasks window).
  const [labels, setLabels] = useState<Record<string, { title: string; i18n?: AppInfo["i18n"] }>>({});
  useEffect(() => {
    if (!open) return;
    getJson<{ apps: AppInfo[] }>("/api/apps?all=1")
      .then((d) => setLabels(Object.fromEntries((d.apps || []).map((a) => [a.id || a.name, { title: a.title, ...(a.i18n ? { i18n: a.i18n } : {}) }]))))
      .catch(() => {});
  }, [open]);
  const appTitle = (id: string) => (labels[id] ? localized(lang, labels[id]!).title : id);

  const report = (s: InboxSummary) => {
    setSummary(s);
    onSummary(s);
  };
  // Only the newest request is shown: an answer for the previous filter or app must not land under the new one.
  const request = useRef(0);
  const load = () => {
    const mine = ++request.current;
    return getJson<{ items: InboxItem[]; summary: InboxSummary }>(`/api/inbox?${QUERY[filter]}&limit=200${app ? `&app=${encodeURIComponent(app)}` : ""}`)
      .then((d) => {
        if (mine !== request.current) return;
        // Under "Unread", the thread being read stays where it is: opening it marked it read, and a
        // refresh must not take it away from under the reader.
        setItems((prev) => {
          const next = d.items || [];
          const at = filter === "unread" && prev ? prev.findIndex((x) => x.thread === openRef.current) : -1;
          if (at < 0 || next.some((x) => x.thread === openRef.current)) return next;
          return [...next.slice(0, at), { ...prev![at]!, unread: false }, ...next.slice(at)];
        });
        report(d.summary);
        // The app menu remembers every app seen, so narrowing the list does not empty it.
        setApps((prev) => [...new Set([...prev, ...(d.items || []).map((i) => i.app)])].sort());
        setErr("");
      })
      .catch((e) => mine === request.current && setErr(String((e as Error).message || e)));
  };

  useEffect(() => {
    if (!open) return;
    setItems(null);
    load();
    return pollWhileVisible(load, 30_000);
  }, [open, filter, app]);

  useEffect(() => {
    if (!open || PAGE) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const mark = (thread: string, patch: { read?: boolean; done?: boolean }) =>
    sendJson<{ summary: InboxSummary }>("POST", "/api/inbox/mark", { threads: [thread], ...patch })
      .then((d) => {
        report(d.summary);
        load();
      })
      .catch((e) => setErr(String((e as Error).message || e)));

  const toggle = (i: InboxItem) => {
    const next = openThread === i.thread ? null : i.thread;
    setOpenThread(next);
    if (next && i.unread) {
      setItems((list) => list && list.map((x) => (x.thread === i.thread ? { ...x, unread: false } : x)));
      void mark(i.thread, { read: true });
    }
  };

  const readAll = () =>
    sendJson<{ summary: InboxSummary }>("POST", "/api/inbox/read-all", app ? { app } : {})
      .then((d) => {
        report(d.summary);
        load();
      })
      .catch((e) => setErr(String((e as Error).message || e)));

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="tasks" role="dialog" aria-label={t("inbox.title")}>
        <div className="task-head">
          <b>{t("inbox.title")}</b>
          <span className="chat-sub">{summary ? t("inbox.summary", { unread: summary.unread, open: summary.open }) : ""}</span>
          <button className="inbox-pill" disabled={!summary?.unread} onClick={readAll}>
            {t("inbox.readAll")}
          </button>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="inbox-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={`inbox-pill${filter === f.id ? " on" : ""}`} onClick={() => setFilter(f.id)}>
              {t(f.key)}
            </button>
          ))}
          <select className="setselect inbox-app" value={app} onChange={(e) => setApp(e.target.value)} aria-label={t("inbox.app")}>
            <option value="">{t("inbox.allApps")}</option>
            {apps.map((a) => (
              <option key={a} value={a}>
                {appTitle(a)}
              </option>
            ))}
          </select>
        </div>
        <div className="task-body">
          {err && <p className="task-note">{t("common.unavailable", { error: err })}</p>}
          {items === null && !err && <p className="task-note">{t("common.loading")}</p>}
          {items !== null && !items.length && <p className="task-note">{t(filter === "all" && !app ? "inbox.empty" : "inbox.emptyFiltered")}</p>}
          {(items || []).map((i) => (
            <div key={i.thread} className={`taskrow inbox-row${i.unread ? " unread" : ""}${i.done ? " off" : ""}${openThread === i.thread ? " open" : ""}`}>
              <button className="task-main" onClick={() => toggle(i)}>
                <span className={`status ${LEVEL_DOT[i.level]}`}>
                  <i />
                </span>
                <span className="task-text">
                  <span className="task-line">
                    <span className="task-name">{i.title || firstLine(i.text)}</span>
                    {i.count > 1 && <span className="task-badge">×{i.count}</span>}
                    <span className="task-sched">
                      <span title={dateTime(i.lastAt, lang)}>{relTime(i.lastAt, lang)}</span>
                    </span>
                  </span>
                  <span className="task-meta">
                    <span className="task-badge" title={i.app}>{appTitle(i.app)}</span>
                    {i.action && !i.done && <span className="task-on">{t("inbox.needsAction")}</span>}
                    {i.done && <span>{t("inbox.doneTag")}</span>}
                    {i.title && <span className="ev-data">{firstLine(i.text)}</span>}
                  </span>
                </span>
              </button>
              {openThread === i.thread && (
                <div className="task-detail">
                  <div className="inbox-text">{i.text}</div>
                  {i.count > 1 && <p className="task-desc">{t("inbox.since", { n: i.count, at: dateTime(i.firstAt, lang) })}</p>}
                  <div className="inbox-actions">
                    {i.url && (
                      <a className="inbox-pill" href={i.url} target="_blank" rel="noopener noreferrer">
                        {t("inbox.openLink")} ↗
                      </a>
                    )}
                    <button className="inbox-pill" onClick={() => void mark(i.thread, { done: !i.done })}>
                      {t(i.done ? "inbox.reopen" : "inbox.markDone")}
                    </button>
                    {!i.done && (
                      <button className="inbox-pill" onClick={() => void mark(i.thread, { read: false })}>
                        {t("inbox.markUnread")}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
