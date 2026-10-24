import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

/**
 * One terminal session in the Linux client: xterm.js in a web view whose page counts as the
 * Space's origin, so the session request and the socket carry the connection's cookies exactly as
 * the panel's terminal does (src/web/Terminal.tsx, docs/terminal.md). The app writes the settings
 * into the page as `window.AISPACE_TERMINAL` and hears back through the `aispace` message handler.
 */

type Config = {
  /** `/api/terminal` or `/api/peers/<name>/terminal`. */
  base: string;
  passphrase?: string;
  dark: boolean;
  font: string;
  fontSize: number;
  text: { exited: string; closed: string; closedIdle: string; closedKilled: string; closedShutdown: string; signal: string };
};

declare global {
  interface Window {
    AISPACE_TERMINAL: Config;
    webkit?: { messageHandlers?: Record<string, { postMessage(v: unknown): void }> };
  }
}

const cfg = window.AISPACE_TERMINAL;
const post = (msg: Record<string, unknown>) => window.webkit?.messageHandlers?.aispace?.postMessage(JSON.stringify(msg));

const LIGHT = { background: "#ffffff", foreground: "#1d1d1f", cursor: "#1d1d1f", cursorAccent: "#ffffff", selectionBackground: "#b4d5fe", black: "#1d1d1f", brightBlack: "#6e6e73", white: "#e5e5ea", brightWhite: "#ffffff", blue: "#2563eb", brightBlue: "#3b82f6", green: "#16a34a", brightGreen: "#22c55e", red: "#dc2626", brightRed: "#ef4444", yellow: "#b45309", brightYellow: "#d97706", magenta: "#9333ea", brightMagenta: "#a855f7", cyan: "#0e7490", brightCyan: "#0891b2" };
const DARK = { background: "#1e1e1e", foreground: "#e6e6e6", cursor: "#e6e6e6", cursorAccent: "#1e1e1e", selectionBackground: "#3f5f8a", black: "#1e1e1e", brightBlack: "#6b7280", white: "#d1d5db", brightWhite: "#f9fafb" };

const dim = (s: string) => `\r\n\x1b[2m[${s}]\x1b[0m\r\n`;
const red = (s: string) => `\r\n\x1b[31m${s}\x1b[0m\r\n`;

const term = new Terminal({ cursorBlink: true, fontSize: cfg.fontSize, fontFamily: cfg.font, theme: cfg.dark ? DARK : LIGHT, scrollback: 5000, allowProposedApi: false });
const fit = new FitAddon();
term.loadAddon(fit);
document.body.style.background = (cfg.dark ? DARK : LIGHT).background;
const el = document.getElementById("term")!;
term.open(el);
const refit = () => {
  try {
    fit.fit();
  } catch {
    /* not measurable yet */
  }
};
new ResizeObserver(refit).observe(el);
term.onTitleChange((title) => post({ type: "title", title }));

/** The app follows the desktop's light and dark style. */
(window as unknown as { setDark: (dark: boolean) => void }).setDark = (dark: boolean) => {
  term.options.theme = dark ? DARK : LIGHT;
  document.body.style.background = (dark ? DARK : LIGHT).background;
};

let ws: WebSocket | undefined;
(window as unknown as { closeSession: () => void }).closeSession = () => ws?.close(1000, "closed");

async function connect(): Promise<void> {
  refit();
  let ticket: string;
  try {
    const r = await fetch(`${cfg.base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.passphrase ? { "x-terminal-passphrase": cfg.passphrase } : {}) },
      body: JSON.stringify({ cols: term.cols, rows: term.rows }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; ticket?: string; error?: string };
    if (!r.ok || !j.ok || !j.ticket) {
      if (r.status === 401) post({ type: "passphrase", error: j.error || "passphrase required" });
      else if (r.redirected || r.status === 403) post({ type: "signin" });
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    ticket = j.ticket;
  } catch (e) {
    term.write(red((e as Error).message));
    post({ type: "state", state: "closed" });
    return;
  }
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${cfg.base}/ws?ticket=${encodeURIComponent(ticket)}`);
  socket.binaryType = "arraybuffer";
  ws = socket;
  const enc = new TextEncoder();
  /** Whether the server already said why the session ended. */
  let told = false;
  socket.onopen = () => {
    post({ type: "state", state: "open" });
    socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    term.focus();
  };
  socket.onmessage = (e) => {
    if (typeof e.data !== "string") return term.write(new Uint8Array(e.data as ArrayBuffer));
    let c: { type?: string; code?: number | null; error?: string; reason?: string; detail?: string };
    try {
      c = JSON.parse(e.data) as typeof c;
    } catch {
      return;
    }
    if (c.type === "exit") (told = true), term.write(dim(cfg.text.exited.replace("{code}", c.code === null || c.code === undefined ? cfg.text.signal : String(c.code))) + (c.detail ? red(c.detail) : ""));
    else if (c.type === "error" && c.error) term.write(red(c.error));
    else if (c.type === "closed") {
      told = true;
      const reasons: Record<string, string> = { idle: cfg.text.closedIdle, killed: cfg.text.closedKilled, shutdown: cfg.text.closedShutdown };
      term.write(dim(reasons[c.reason ?? ""] ?? cfg.text.closed));
    }
  };
  socket.onclose = (e) => {
    post({ type: "state", state: "closed" });
    if (e.code !== 1000 && !told && !["idle", "killed", "shutdown"].includes(e.reason)) term.write(dim(e.reason || cfg.text.closed));
  };
  term.onData((d) => socket.readyState === 1 && socket.send(enc.encode(d)));
  term.onBinary((d) => socket.readyState === 1 && socket.send(Uint8Array.from(d, (ch) => ch.charCodeAt(0))));
  term.onResize(({ cols, rows }) => socket.readyState === 1 && socket.send(JSON.stringify({ type: "resize", cols, rows })));
}

requestAnimationFrame(() => {
  refit();
  term.focus();
  void connect();
});
