import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { dateTime, fmtDuration, getJson, relTime } from "./api.ts";
import { type Key, useLang } from "./i18n.ts";

// Terminal window (a floating panel): shells on this machine and on peer machines, in xterm.js.
// - Mounted permanently (closing only slides it away) so sessions survive closing the panel.
// - One tab per session; each has its own xterm and socket. Keystrokes go as binary frames,
//   resizes as JSON text frames; output comes back as binary, control messages as JSON.
// - Opening a session is two requests: POST for a one-time ticket (same-origin, optional
//   passphrase header), then the socket with the ticket. The passphrase lives in memory only.
// - Nothing here decides what runs: the server picks the shell, the directory and the environment.

type Machine = { name: string; peer?: string; enabled: boolean; health: "ok" | "down" };
type Recent = { id: string; startedAt: number; endedAt?: number; exitCode?: number | null; reason?: string; agent: string; bytesIn: number; bytesOut: number };
type Status = { enabled: boolean; backend?: string; shell: string; passphrase: boolean; idleMs: number; maxSessions: number; active: number; machines: Machine[]; sessions: { id: string }[]; recent: Recent[] };

type Tab = {
  key: string;
  machine: Machine;
  n: number;
  term: XTerm;
  fit: FitAddon;
  ws?: WebSocket;
  state: "connecting" | "open" | "closed";
  started: boolean;
};

const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';
const LIGHT = { background: "#fbfbfd", foreground: "#1d1d1f", cursor: "#1d1d1f", cursorAccent: "#fbfbfd", selectionBackground: "rgba(99, 102, 241, 0.28)", black: "#1d1d1f", brightBlack: "#6e6e73", white: "#e5e5ea", brightWhite: "#ffffff", blue: "#2563eb", brightBlue: "#3b82f6", green: "#16a34a", brightGreen: "#22c55e", red: "#dc2626", brightRed: "#ef4444", yellow: "#b45309", brightYellow: "#d97706", magenta: "#9333ea", brightMagenta: "#a855f7", cyan: "#0e7490", brightCyan: "#0891b2" };
const DARK = { background: "#0b0d12", foreground: "#e6e8ee", cursor: "#e6e8ee", cursorAccent: "#0b0d12", selectionBackground: "rgba(139, 92, 246, 0.35)", black: "#0b0d12", brightBlack: "#6b7280", white: "#d1d5db", brightWhite: "#f9fafb" };
const themeOf = () => (document.documentElement.dataset.theme === "dark" ? DARK : LIGHT);
const CLOSED_REASON: Record<string, Key> = { idle: "term.closedIdle", killed: "term.closedKilled", shutdown: "term.closedShutdown" };
const dim = (s: string) => `\r\n\x1b[2m[${s}]\x1b[0m\r\n`;
const red = (s: string) => `\r\n\x1b[31m${s}\x1b[0m\r\n`;

const baseOf = (m: Machine) => (m.peer ? `/api/peers/${encodeURIComponent(m.peer)}/terminal` : "/api/terminal");

export default function Terminal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { lang, t } = useLang();
  const tRef = useRef(t);
  tRef.current = t;
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [machine, setMachine] = useState("");
  const [pass, setPass] = useState("");
  const [needPass, setNeedPass] = useState<string | null>(null);
  const [hist, setHist] = useState(false);
  const passRef = useRef("");
  const counters = useRef<Record<string, number>>({});
  const bodyRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const curRef = useRef(cur);
  curRef.current = cur;

  const load = () =>
    getJson<Status>("/api/terminal")
      .then((s) => {
        setStatus(s);
        setErr("");
        setMachine((m) => (m && s.machines.some((x) => x.name === m) ? m : (s.machines.find((x) => x.enabled) ?? s.machines[0])?.name ?? ""));
      })
      .catch((e) => setErr(String((e as Error).message || e)));

  useEffect(() => {
    if (!open) return;
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [open]);

  const bump = (tab: Tab, patch: Partial<Tab>) => {
    Object.assign(tab, patch);
    setTabs((all) => [...all]);
  };

  // The visible terminal follows its container; a hidden one is fitted when it becomes visible.
  const fitCurrent = () => {
    const tab = tabsRef.current.find((x) => x.key === curRef.current);
    if (!tab || !tab.started) return;
    try {
      tab.fit.fit();
    } catch {
      /* not measurable yet */
    }
  };
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      fitCurrent();
      tabsRef.current.find((x) => x.key === cur)?.term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, cur]);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => fitCurrent());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const mo = new MutationObserver(() => {
      const theme = themeOf();
      for (const tab of tabsRef.current) tab.term.options.theme = theme;
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  const connect = async (tab: Tab) => {
    const { term } = tab;
    const base = baseOf(tab.machine);
    let ticket: string;
    try {
      const r = await fetch(`${base}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(passRef.current ? { "x-terminal-passphrase": passRef.current } : {}) },
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; ticket?: string; error?: string };
      if (!r.ok || !j.ok || !j.ticket) {
        if (r.status === 401) {
          passRef.current = "";
          setPass("");
          setNeedPass(j.error || "passphrase required");
        }
        throw new Error(j.error || `HTTP ${r.status}`);
      }
      ticket = j.ticket;
    } catch (e) {
      term.write(red((e as Error).message));
      bump(tab, { state: "closed" });
      return;
    }
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${base}/ws?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    tab.ws = ws;
    const enc = new TextEncoder();
    ws.onopen = () => {
      bump(tab, { state: "open" });
      ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      term.focus();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        term.write(new Uint8Array(e.data as ArrayBuffer));
        return;
      }
      let c: { type?: string; code?: number | null; error?: string; reason?: string; detail?: string };
      try {
        c = JSON.parse(e.data) as typeof c;
      } catch {
        return;
      }
      const tt = tRef.current;
      if (c.type === "exit") term.write(dim(tt("term.exited", { code: c.code === null || c.code === undefined ? "signal" : c.code })) + (c.detail ? red(c.detail) : ""));
      else if (c.type === "error" && c.error) term.write(red(c.error));
      else if (c.type === "closed") term.write(dim(tt(CLOSED_REASON[c.reason ?? ""] ?? "term.closed")));
    };
    ws.onclose = (e) => {
      bump(tab, { state: "closed" });
      if (e.code !== 1000 && e.reason && !CLOSED_REASON[e.reason]) term.write(dim(e.reason));
      load();
    };
    term.onData((d) => ws.readyState === 1 && ws.send(enc.encode(d)));
    term.onBinary((d) => ws.readyState === 1 && ws.send(Uint8Array.from(d, (ch) => ch.charCodeAt(0))));
    term.onResize(({ cols, rows }) => ws.readyState === 1 && ws.send(JSON.stringify({ type: "resize", cols, rows })));
  };

  /** The pane's ref callback: open the xterm in it once, fit, then connect. */
  const mount = (tab: Tab, el: HTMLDivElement | null) => {
    if (!el || tab.started) return;
    tab.started = true;
    tab.term.open(el);
    requestAnimationFrame(() => {
      try {
        tab.fit.fit();
      } catch {
        /* hidden */
      }
      void connect(tab);
    });
  };

  const newTab = () => {
    const m = status?.machines.find((x) => x.name === machine) ?? status?.machines.find((x) => x.enabled);
    if (!m) return;
    if (!m.enabled) {
      setErr(t("term.disabled", { name: m.name }));
      return;
    }
    const term = new XTerm({ cursorBlink: true, fontSize: 13, fontFamily: FONT, theme: themeOf(), scrollback: 5000, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const tab: Tab = { key: `${m.name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, machine: m, n: (counters.current[m.name] = (counters.current[m.name] ?? 0) + 1), term, fit, state: "connecting", started: false };
    setTabs((all) => [...all, tab]);
    setCur(tab.key);
    setErr("");
  };

  const closeTab = (tab: Tab) => {
    try {
      tab.ws?.close(1000, "closed");
    } catch {
      /* already closed */
    }
    tab.term.dispose();
    setTabs((all) => {
      const rest = all.filter((x) => x !== tab);
      if (curRef.current === tab.key) setCur(rest.at(-1)?.key ?? null);
      return rest;
    });
    load();
  };

  const unlock = () => {
    passRef.current = pass;
    setNeedPass(null);
    newTab();
  };

  const label = (m: Machine) => (m.peer ? m.name : t("term.thisMachine", { name: m.name }));
  const current = tabs.find((x) => x.key === cur);
  const machines = status?.machines ?? [];
  const localOff = status && !status.enabled && machines.every((m) => !m.enabled);

  return (
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="term" role="dialog" aria-label={t("term.title")}>
        <div className="task-head">
          <b>{t("term.title")}</b>
          <span className="chat-sub">{status ? `${t("term.openCount", { n: status.sessions.length + tabs.filter((x) => x.machine.peer && x.state === "open").length })}${status.idleMs ? ` · ${t("term.idleAfter", { idle: fmtDuration(status.idleMs, lang) })}` : ""}` : ""}</span>
          <select className="chat-model" value={machine} onChange={(e) => setMachine(e.target.value)} title={t("term.machine")} disabled={!machines.length}>
            {machines.map((m) => (
              <option key={m.name} value={m.name} disabled={!m.enabled || m.health !== "ok"}>
                {label(m)}
                {!m.enabled ? ` · ${t("term.off")}` : m.health !== "ok" ? ` · ${t("status.down")}` : ""}
              </option>
            ))}
          </select>
          <button className="chat-hbtn" title={t("term.new")} onClick={newTab} disabled={!machines.some((m) => m.enabled)}>
            ＋
          </button>
          <button className="chat-hbtn" title={t("term.history")} onClick={() => setHist((h) => !h)}>
            🕘
          </button>
          <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
            ✕
          </button>
        </div>
        {tabs.length > 0 && (
          <div className="term-tabs">
            {tabs.map((tab) => (
              <button key={tab.key} className={`term-tab ${tab.key === cur ? "on" : ""} ${tab.state}`} onClick={() => setCur(tab.key)} title={label(tab.machine)}>
                <i />
                {tab.machine.name} #{tab.n}
                <span
                  className="term-tab-x"
                  role="button"
                  title={t("term.closeTab")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab);
                  }}
                >
                  ✕
                </span>
              </button>
            ))}
          </div>
        )}
        {(needPass || (status?.passphrase && !passRef.current && machines.find((m) => m.name === machine && !m.peer))) && (
          <form
            className="term-pass"
            onSubmit={(e) => {
              e.preventDefault();
              unlock();
            }}
          >
            <span className="setnote">{needPass && needPass !== "passphrase required" ? needPass : t("term.passphraseHint")}</span>
            <div className="term-pass-row">
              <input type="password" autoComplete="off" value={pass} placeholder={t("term.passphrase")} onChange={(e) => setPass(e.target.value)} />
              <button type="submit" className="chat-send" disabled={!pass}>
                {t("term.unlock")}
              </button>
            </div>
          </form>
        )}
        {hist && (
          <div className="term-hist">
            <p className="sethead">{t("term.history")}</p>
            {!status?.recent.length && <p className="task-note">{t("term.noHistory")}</p>}
            {status?.recent.map((r) => (
              <div key={r.id} className="runrow" title={`${r.agent}\n${r.bytesIn} B in · ${r.bytesOut} B out`}>
                <div className="run-line">
                  <span className={`status ${r.endedAt === undefined ? "running" : r.reason === "exit" && r.exitCode === 0 ? "ok" : r.reason === "exit" ? "down" : "paused"}`}>
                    <i />
                    {r.endedAt === undefined ? t("term.open") : r.reason === "exit" ? t("term.exitCode", { code: r.exitCode ?? "signal" }) : (r.reason ?? "")}
                  </span>
                  <span className="run-time" title={dateTime(r.startedAt, lang)}>
                    {relTime(r.startedAt, lang)}
                  </span>
                  {r.endedAt !== undefined && <span className="run-dur">{fmtDuration(r.endedAt - r.startedAt, lang)}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="term-body" ref={bodyRef}>
          {err && <p className="task-note err">{err}</p>}
          {!err && status === null && <p className="task-note">{t("common.loading")}</p>}
          {!err && localOff && !tabs.length && <p className="task-note">{t("term.disabled", { name: machines[0]?.name ?? "" })}</p>}
          {!err && status && !localOff && !tabs.length && <p className="task-note">{t("term.empty")}</p>}
          {tabs.map((tab) => (
            <div key={tab.key} className={`term-pane ${tab.key === cur ? "" : "hidden"}`} ref={(el) => mount(tab, el)} />
          ))}
          {current && current.state === "connecting" && <span className="term-state">{t("term.connecting")}</span>}
        </div>
        <p className="term-note">{t("term.securityNote")}</p>
      </div>
    </div>
  );
}
