import { randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { type TerminalConfig, sessionEnv } from "./config.ts";
import { type PtyBackend, type PtyHandle, clamp, detectPtyBackend, spawnPty } from "./pty.ts";
import type { SessionRecord, TerminalStore } from "./store.ts";

/**
 * Terminal sessions on this machine.
 *
 * Opening one is two steps, so that the WebSocket (which a browser cannot
 * send headers on) never carries the decision: `create()` runs the checks and
 * hands out a one-time ticket that lives 30 s; the socket then `redeem()`s it
 * and `attach()` spawns the shell. A ticket left unredeemed is swept and
 * counts against the session cap until then. The shell is the configured
 * one, in the workspace root, with credentials stripped from its environment;
 * nothing about it comes from the client except the window size.
 *
 * A session ends when the shell exits, when the socket closes (the shell is
 * hung up), when no keystroke arrived for the idle limit, or when the
 * operator kills it. Every session leaves one audit row.
 */

export type WsAttachment = {
  open(ws: ServerWebSocket<WsData>): void;
  message(ws: ServerWebSocket<WsData>, message: string | Buffer): void;
  close(ws: ServerWebSocket<WsData>, code: number, reason: string): void;
  drain?(ws: ServerWebSocket<WsData>): void;
};

/** What a terminal socket carries: who handles its events (a local session or a bridge to a peer), and its keepalive timer. */
export type WsData = { attachment: WsAttachment; pinger?: ReturnType<typeof setInterval> };

export type SessionView = {
  id: string;
  startedAt?: number;
  cols: number;
  rows: number;
  agent: string;
  bytesIn: number;
  bytesOut: number;
  /** `pending` until the socket arrives, then `open`. */
  state: "pending" | "open";
};

export type TerminalStatus = {
  enabled: boolean;
  /** Which PTY implementation this runtime offers; undefined = none, sessions cannot open. */
  backend?: PtyBackend;
  shell: string;
  passphrase: boolean;
  idleMs: number;
  maxSessions: number;
  active: number;
};

export type PassphraseCheck = "ok" | "required" | "wrong" | "locked";

type Session = {
  id: string;
  createdAt: number;
  startedAt?: number;
  cols: number;
  rows: number;
  agent: string;
  ticket?: string;
  ticketExpiresAt: number;
  pty?: PtyHandle;
  ws?: ServerWebSocket<WsData>;
  lastInputAt: number;
  bytesIn: number;
  bytesOut: number;
  ended: boolean;
};

export type TerminalServiceOptions = {
  config: TerminalConfig;
  /** Working directory of every session: the workspace root. */
  cwd: string;
  store?: TerminalStore;
  /** Base environment for sessions; default: the process's. */
  env?: Record<string, string | undefined>;
  /** Extra variables every session gets (SPACE_HOME and the like). */
  extraEnv?: Record<string, string>;
  now?: () => number;
  /** Force a backend; default: detect. */
  backend?: PtyBackend;
  ticketTtlMs?: number;
  /** How often idle sessions and stale tickets are checked. */
  sweepMs?: number;
  log?: (m: string) => void;
};

export const TICKET_TTL_MS = 30_000;
const SWEEP_MS = 15_000;
/** Wrong passphrases before a lockout, and how long the lockout lasts. */
export const PASSPHRASE_TRIES = 5;
export const PASSPHRASE_LOCK_MS = 60_000;
/** Bytes buffered towards a slow browser before output is dropped for it. */
const MAX_BACKLOG = 4 * 1024 * 1024;

export class TerminalService {
  readonly backend: PtyBackend | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly byTicket = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(private readonly opts: TerminalServiceOptions) {
    this.backend = opts.backend ?? (opts.config.enabled ? detectPtyBackend(opts.env ?? process.env) : undefined);
    if (opts.config.enabled) {
      this.timer = setInterval(() => this.sweep(), opts.sweepMs ?? SWEEP_MS);
      this.timer.unref?.();
    }
  }

  get enabled(): boolean {
    return this.opts.config.enabled && this.backend !== undefined;
  }

  get config(): TerminalConfig {
    return this.opts.config;
  }

  status(): TerminalStatus {
    const c = this.opts.config;
    return {
      enabled: this.enabled,
      ...(this.backend ? { backend: this.backend } : {}),
      shell: c.shell.join(" "),
      passphrase: c.passphrase.length > 0,
      idleMs: c.idleMs,
      maxSessions: c.maxSessions,
      active: this.sessions.size,
    };
  }

  /** Constant-time passphrase check with a lockout after repeated failures; `given` is the header value or null. */
  checkPassphrase(given: string | null): PassphraseCheck {
    const expected = this.opts.config.passphrase;
    if (!expected) return "ok";
    const now = this.now();
    if (now < this.lockedUntil) return "locked";
    if (given === null || given === "") return "required";
    const a = Buffer.from(given, "utf8");
    const b = Buffer.from(expected, "utf8");
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok) {
      this.failures = [];
      return "ok";
    }
    this.failures = this.failures.filter((t) => now - t < PASSPHRASE_LOCK_MS);
    this.failures.push(now);
    if (this.failures.length >= PASSPHRASE_TRIES) {
      this.lockedUntil = now + PASSPHRASE_LOCK_MS;
      this.failures = [];
      this.log(`passphrase locked for ${PASSPHRASE_LOCK_MS / 1000}s after ${PASSPHRASE_TRIES} failures`);
      return "locked";
    }
    return "wrong";
  }

  /** Reserve a session and issue its ticket. Throws `TooManySessions` at the cap. */
  create(input: { cols?: number; rows?: number; agent?: string }): { id: string; ticket: string; expiresIn: number } {
    if (!this.enabled) throw new Error("terminal is not enabled");
    this.sweep();
    if (this.sessions.size >= this.opts.config.maxSessions) throw new TooManySessions(this.opts.config.maxSessions);
    const now = this.now();
    const id = randomBytes(8).toString("hex");
    const ticket = randomBytes(24).toString("base64url");
    const ttl = this.opts.ticketTtlMs ?? TICKET_TTL_MS;
    const s: Session = {
      id,
      createdAt: now,
      cols: clamp(input.cols ?? 80),
      rows: clamp(input.rows ?? 24),
      agent: (input.agent ?? "").slice(0, 200),
      ticket,
      ticketExpiresAt: now + ttl,
      lastInputAt: now,
      bytesIn: 0,
      bytesOut: 0,
      ended: false,
    };
    this.sessions.set(id, s);
    this.byTicket.set(ticket, s);
    return { id, ticket, expiresIn: ttl };
  }

  /** Exchange a ticket for its session, once. Undefined for an unknown, used or expired ticket. */
  redeem(ticket: string): { id: string } | undefined {
    const s = this.byTicket.get(ticket);
    if (!s) return undefined;
    this.byTicket.delete(ticket);
    s.ticket = undefined;
    if (this.now() > s.ticketExpiresAt) {
      this.drop(s, "expired");
      return undefined;
    }
    return { id: s.id };
  }

  /** The socket handler for a redeemed session: spawns the shell on open, pumps both ways, ends the session on close. */
  attachment(id: string): WsAttachment {
    const s = this.sessions.get(id);
    if (!s || s.ws || s.pty) throw new Error("session is not waiting for a socket");
    return {
      open: (ws) => this.open(s, ws),
      message: (ws, m) => this.message(s, ws, m),
      close: () => this.end(s, "closed"),
    };
  }

  /** End a session from outside (the panel's kill, or a shutdown). */
  kill(id: string, reason = "killed"): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    if (!s.pty) {
      this.drop(s, reason);
      return true;
    }
    this.end(s, reason);
    return true;
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      ...(s.startedAt ? { startedAt: s.startedAt } : {}),
      cols: s.cols,
      rows: s.rows,
      agent: s.agent,
      bytesIn: s.bytesIn,
      bytesOut: s.bytesOut,
      state: s.pty ? "open" : "pending",
    }));
  }

  recent(limit = 20): SessionRecord[] {
    return this.opts.store?.recent(limit) ?? [];
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const s of [...this.sessions.values()]) this.kill(s.id, "shutdown");
  }

  // ---------------------------------------------------------------- internals

  private open(s: Session, ws: ServerWebSocket<WsData>): void {
    if (s.ended) {
      ws.close(4004, "session ended");
      return;
    }
    const now = this.now();
    s.ws = ws;
    s.startedAt = now;
    s.lastInputAt = now;
    const env = sessionEnv(this.opts.env ?? process.env, { ...(this.opts.extraEnv ?? {}), SPACE_TERMINAL_SESSION: s.id });
    try {
      s.pty = spawnPty(this.backend!, {
        cmd: this.opts.config.shell,
        cwd: this.opts.cwd,
        env,
        cols: s.cols,
        rows: s.rows,
        onData: (chunk) => {
          if (s.ended || !s.ws) return;
          s.bytesOut += chunk.byteLength;
          if (s.ws.getBufferedAmount() > MAX_BACKLOG) return; // a browser that stopped reading loses output, not the shell
          s.ws.send(chunk);
        },
        onExit: (code, detail) => this.exited(s, code, detail),
      });
    } catch (e) {
      const msg = `cannot start ${this.opts.config.shell[0]}: ${(e as Error).message}`;
      this.log(msg);
      send(ws, { type: "error", error: msg });
      this.end(s, "failed");
      return;
    }
    this.opts.store?.open({ id: s.id, startedAt: now, agent: s.agent, cols: s.cols, rows: s.rows });
    this.log(`session ${s.id} opened (pid ${s.pty.pid}, ${s.cols}x${s.rows})`);
    send(ws, { type: "ready", id: s.id, backend: this.backend, shell: this.opts.config.shell[0], idleMs: this.opts.config.idleMs });
  }

  private message(s: Session, ws: ServerWebSocket<WsData>, m: string | Buffer): void {
    if (s.ended || !s.pty) return;
    if (typeof m === "string") {
      // Control messages are JSON text frames; keystrokes are binary frames.
      let c: { type?: unknown; cols?: unknown; rows?: unknown };
      try {
        c = JSON.parse(m) as typeof c;
      } catch {
        return;
      }
      if (c.type === "resize" && typeof c.cols === "number" && typeof c.rows === "number") {
        s.cols = clamp(c.cols);
        s.rows = clamp(c.rows);
        s.pty.resize(s.cols, s.rows);
      } else if (c.type === "ping") send(ws, { type: "pong" });
      return;
    }
    s.lastInputAt = this.now();
    s.bytesIn += m.byteLength;
    s.pty.write(new Uint8Array(m.buffer, m.byteOffset, m.byteLength));
  }

  private exited(s: Session, code: number | null, detail?: string): void {
    if (s.ended) return;
    if (s.ws) {
      send(s.ws, { type: "exit", code, ...(detail ? { detail } : {}) });
    }
    this.end(s, "exit", code);
  }

  /** Close everything about a session once; `code` is the shell's exit code when it is known. */
  private end(s: Session, reason: string, code: number | null = null): void {
    if (s.ended) return;
    s.ended = true;
    this.sessions.delete(s.id);
    if (s.ticket) this.byTicket.delete(s.ticket);
    const ws = s.ws;
    s.ws = undefined;
    if (s.pty && reason !== "exit") s.pty.kill();
    if (ws) {
      try {
        if (reason === "idle" || reason === "killed" || reason === "shutdown") send(ws, { type: "closed", reason });
        ws.close(reason === "exit" ? 1000 : 4000, reason);
      } catch {
        /* already closed */
      }
    }
    if (s.startedAt) {
      this.opts.store?.close({ id: s.id, endedAt: this.now(), exitCode: code, reason, bytesIn: s.bytesIn, bytesOut: s.bytesOut });
      this.log(`session ${s.id} ended: ${reason}${code !== null ? ` (exit ${code})` : ""}`);
    }
  }

  /** Forget a session that never got its socket. */
  private drop(s: Session, reason: string): void {
    s.ended = true;
    this.sessions.delete(s.id);
    if (s.ticket) this.byTicket.delete(s.ticket);
    if (reason !== "expired") this.log(`session ${s.id} dropped: ${reason}`);
  }

  private sweep(): void {
    const now = this.now();
    const idle = this.opts.config.idleMs;
    for (const s of [...this.sessions.values()]) {
      if (!s.pty) {
        if (now > s.ticketExpiresAt) this.drop(s, "expired");
      } else if (idle > 0 && now - s.lastInputAt > idle) this.end(s, "idle");
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private log(m: string): void {
    (this.opts.log ?? ((x: string) => console.log(`[terminal] ${x}`)))(m);
  }
}

export class TooManySessions extends Error {
  constructor(readonly max: number) {
    super(`${max} terminal session${max === 1 ? "" : "s"} already open; close one first`);
  }
}

function send(ws: ServerWebSocket<WsData>, msg: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* closed */
  }
}
