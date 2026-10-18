import { accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { whichUsable } from "../host-tools.ts";

/**
 * A pseudo-terminal running one command, with two backends behind one
 * handle: `Bun.Terminal` where the runtime has it, and otherwise a small
 * wrapper around `forkpty`: `pty_helper.py` on the standard `pty` module,
 * which every Linux server has, or the same program in C (`pty_helper.c`,
 * shipped built as `runtime/space-pty` by the Local edition, for a Mac with
 * no working python3). Output arrives as bytes; input and resizes go in; a
 * kill hangs the process up and, if it stays, kills it.
 */

export type PtyBackend = "helper" | "bun" | "python";

export type PtyOptions = {
  cmd: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
  /** Exit code of the command; null when it was killed. Called once. */
  onExit: (code: number | null, detail?: string) => void;
};

export type PtyHandle = {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** SIGHUP, then SIGKILL after a grace period if the command is still running. */
  kill(): void;
  readonly pid: number;
};

const KILL_GRACE_MS = 2_000;

/**
 * The backend this runtime can offer, if any. A forkpty helper first: it makes
 * the shell a session leader with the PTY as its controlling terminal, so job
 * control, Ctrl-C and programs that open /dev/tty (sudo, ssh, polkit) work.
 * The built helper comes before Python when it is there; a Command Line Tools
 * stub of python3 on a Mac counts as no python3 (`host-tools.ts`).
 * `Bun.Terminal` (checked on 1.3.14 through 1.4.2) attaches the PTY as plain
 * stdio without a controlling terminal: bash warns "no job control", Ctrl-C
 * reaches nothing. It stays as the last fallback.
 * `SPACE_TERMINAL_PTY=helper|bun|python` forces one.
 */
export function detectPtyBackend(env: Record<string, string | undefined> = process.env): PtyBackend | undefined {
  const forced = env.SPACE_TERMINAL_PTY?.trim().toLowerCase();
  const hasHelper = Boolean(ptyHelper(env));
  const hasBun = typeof (Bun as unknown as { Terminal?: unknown }).Terminal === "function";
  const hasPython = Boolean(whichUsable("python3"));
  if (forced === "helper") return hasHelper ? "helper" : undefined;
  if (forced === "bun") return hasBun ? "bun" : undefined;
  if (forced === "python") return hasPython ? "python" : undefined;
  if (hasHelper) return "helper";
  if (hasPython) return "python";
  if (hasBun) return "bun";
  return undefined;
}

/** Where a release ships the built helper: `<release>/runtime/space-pty`. */
export const BUNDLED_PTY_HELPER = resolve(import.meta.dir, "..", "..", "..", "runtime", "space-pty");

/** The built forkpty helper, if one is there and executable: `SPACE_PTY_HELPER`, else the release's. */
export function ptyHelper(env: Record<string, string | undefined> = process.env): string | undefined {
  const path = env.SPACE_PTY_HELPER?.trim() || BUNDLED_PTY_HELPER;
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

export function spawnPty(backend: PtyBackend, opts: PtyOptions): PtyHandle {
  if (backend === "bun") return spawnBun(opts);
  if (backend === "helper") return spawnFramed([ptyHelper() ?? BUNDLED_PTY_HELPER, ...opts.cmd], opts);
  return spawnFramed([whichUsable("python3") ?? "python3", HELPER, ...opts.cmd], opts);
}

function spawnBun(opts: PtyOptions): PtyHandle {
  const terminal = new Bun.Terminal({ cols: clamp(opts.cols), rows: clamp(opts.rows), data: (_t, d) => opts.onData(d) });
  const proc = Bun.spawn(opts.cmd, { cwd: opts.cwd, env: opts.env, terminal });
  let done = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  void proc.exited.then((code) => {
    done = true;
    clearTimeout(killer);
    // Whatever the PTY still holds is delivered before close; give it a tick.
    setTimeout(() => {
      try {
        terminal.close();
      } catch {
        /* already closed */
      }
      opts.onExit(proc.signalCode ? null : code);
    }, 20);
  });
  return {
    pid: proc.pid,
    write: (data) => {
      if (!done && !terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!done && !terminal.closed) terminal.resize(clamp(cols), clamp(rows));
    },
    kill: () => {
      if (done) return;
      try {
        proc.kill("SIGHUP");
      } catch {
        /* gone */
      }
      killer = setTimeout(() => {
        if (!done) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }
      }, KILL_GRACE_MS);
    },
  };
}

const HELPER = join(import.meta.dir, "pty_helper.py");

/** A forkpty helper speaking the frame protocol of `pty_helper.py`, started as `argv`. */
function spawnFramed(argv: string[], opts: PtyOptions): PtyHandle {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: { ...opts.env, PTY_COLS: String(clamp(opts.cols)), PTY_ROWS: String(clamp(opts.rows)) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdin = proc.stdin as Bun.FileSink;
  let done = false;
  let closedIn = false;
  let killer: ReturnType<typeof setTimeout> | undefined;
  const pump = async () => {
    const reader = proc.stdout.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      opts.onData(value);
    }
  };
  const errText = new Response(proc.stderr).text();
  void Promise.all([pump().catch(() => {}), proc.exited]).then(async ([, code]) => {
    done = true;
    clearTimeout(killer);
    const err = (await errText.catch(() => "")).trim();
    // The helper's own failure (no python module, exec failed) is reported; a killed child is null.
    opts.onExit(code === 129 || proc.signalCode ? null : code, err || undefined);
  });
  const frame = (kind: number, payload: Uint8Array) => {
    if (done || closedIn) return;
    const b = new Uint8Array(5 + payload.length);
    b[0] = kind;
    new DataView(b.buffer).setUint32(1, payload.length);
    b.set(payload, 5);
    stdin.write(b);
    stdin.flush();
  };
  return {
    pid: proc.pid,
    write: (data) => frame(0, data),
    resize: (cols, rows) => {
      const p = new Uint8Array(4);
      const v = new DataView(p.buffer);
      v.setUint16(0, clamp(cols));
      v.setUint16(2, clamp(rows));
      frame(1, p);
    },
    kill: () => {
      if (done || closedIn) return;
      closedIn = true;
      try {
        stdin.end(); // the helper hangs the child up, then kills it
      } catch {
        /* gone */
      }
      killer = setTimeout(() => {
        if (!done) {
          try {
            proc.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }
      }, KILL_GRACE_MS + 1_500);
    },
  };
}

/** Terminal sizes a client may ask for. */
export function clamp(n: number): number {
  return Math.max(2, Math.min(500, Math.floor(Number(n) || 0) || 80));
}
