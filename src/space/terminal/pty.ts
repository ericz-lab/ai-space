import { join } from "node:path";

/**
 * A pseudo-terminal running one command, with two backends behind one
 * handle: `Bun.Terminal` where the runtime has it, and otherwise a small
 * Python wrapper around the standard `pty` module (`pty_helper.py`), which
 * every Linux server and macOS has. Output arrives as bytes; input and
 * resizes go in; a kill hangs the process up and, if it stays, kills it.
 */

export type PtyBackend = "bun" | "python";

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
 * The backend this runtime can offer, if any. Python first: `pty.fork()` makes
 * the shell a session leader with the PTY as its controlling terminal, so job
 * control, Ctrl-C and programs that open /dev/tty (sudo, ssh, polkit) work.
 * `Bun.Terminal` (checked on 1.3.14 through 1.4.2) attaches the PTY as plain
 * stdio without a controlling terminal: bash warns "no job control", Ctrl-C
 * reaches nothing. It stays as the fallback for a machine without python3.
 * `SPACE_TERMINAL_PTY=bun|python` forces one.
 */
export function detectPtyBackend(env: Record<string, string | undefined> = process.env): PtyBackend | undefined {
  const forced = env.SPACE_TERMINAL_PTY?.trim().toLowerCase();
  const hasBun = typeof (Bun as unknown as { Terminal?: unknown }).Terminal === "function";
  const hasPython = Boolean(Bun.which("python3"));
  if (forced === "bun") return hasBun ? "bun" : undefined;
  if (forced === "python") return hasPython ? "python" : undefined;
  if (hasPython) return "python";
  if (hasBun) return "bun";
  return undefined;
}

export function spawnPty(backend: PtyBackend, opts: PtyOptions): PtyHandle {
  return backend === "bun" ? spawnBun(opts) : spawnPython(opts);
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

function spawnPython(opts: PtyOptions): PtyHandle {
  const python = Bun.which("python3") ?? "python3";
  const proc = Bun.spawn([python, HELPER, ...opts.cmd], {
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
