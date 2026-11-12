/**
 * Spawn a runtime process, feed it stdin, collect both streams and wait,
 * honouring a timeout and an abort signal. A kill takes the whole tree, not
 * just a shell wrapper: where `setsid` exists (Linux) the child starts in its
 * own process group and the group is killed; without it (macOS) the child
 * stays in the service's group, so stopping the service still reaches it, and
 * a kill takes the child and every descendant `ps` shows. After a kill we stop
 * waiting on the pipes: an orphaned grandchild could otherwise hold stdout open.
 */

import { access, constants, stat } from "node:fs/promises";

export type SpawnOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** What the process reads: text, bytes, or several byte parts written in order. */
  stdin?: string | Uint8Array | Uint8Array[];
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Each line of stdout as it arrives (stdout is still collected whole). */
  onLine?: (line: string) => void;
};

export type SpawnResult = {
  /** Exit code; null when the process was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
};

/** Throws only when the process cannot be started (no such binary). */
export async function spawnCollect(cmd: string[], opts: SpawnOptions = {}): Promise<SpawnResult> {
  // Through setsid a missing binary would only show as setsid's own failure, so look first.
  const bin = cmd[0] ?? "";
  if (!(await startable(bin, (opts.env ?? process.env).PATH))) throw new Error(`${bin}: not found or not executable`);
  const setsid = Bun.which("setsid");
  const proc = Bun.spawn(setsid ? [setsid, ...cmd] : cmd, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdin: opts.stdin !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (opts.stdin !== undefined) {
    const stdin = proc.stdin as Bun.FileSink;
    for (const part of Array.isArray(opts.stdin) ? opts.stdin : [opts.stdin]) stdin.write(part);
    stdin.end();
  }
  const onLine = opts.onLine;
  const stdout = onLine
    ? (async () => {
        const lines: string[] = [];
        await pumpLines(proc.stdout, (line) => {
          lines.push(line);
          onLine(line);
        });
        return lines.join("\n");
      })()
    : new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();

  let timedOut = false;
  let aborted = false;
  const kill = () => {
    // The tree is listed before anything dies: a killed parent's children move to init.
    for (const pid of setsid ? [-proc.pid] : [proc.pid, ...descendants(proc.pid)]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), kill()), opts.timeoutMs);
  const onAbort = () => ((aborted = true), kill());
  if (opts.signal?.aborted) onAbort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  const code = await proc.exited;
  clearTimeout(timer);
  opts.signal?.removeEventListener("abort", onAbort);

  if (timedOut || aborted) {
    // Whatever the pipes still hold within a moment; an orphan may keep them open.
    const partial = await Promise.race([Promise.all([stdout, stderr]), Bun.sleep(200).then(() => ["", ""] as const)]);
    return { code: null, stdout: partial[0], stderr: partial[1], timedOut, aborted };
  }
  return { code, stdout: await stdout, stderr: await stderr, timedOut: false, aborted: false };
}

/** Every process below `root`, from one `ps` listing; none when it cannot be read. */
export function descendants(root: number): number[] {
  let listing = "";
  try {
    const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    listing = r.stdout.toString();
  } catch {
    return [];
  }
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) for (const pid of children.get(queue.shift()!) ?? []) if (!out.includes(pid)) out.push(pid), queue.push(pid);
  return out;
}

/** Read newline-delimited output as it arrives; the last partial line is delivered at the end. */
export async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  let rest = "";
  const reader = stream.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += dec.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onLine(line);
  }
  if (rest.trim()) onLine(rest);
}

/** Whether `bin` names a program that can be started: a path to an executable file, or a name on PATH. */
async function startable(bin: string, path: string | undefined): Promise<boolean> {
  if (!bin) return false;
  if (!bin.includes("/")) return Boolean(Bun.which(bin, path === undefined ? {} : { PATH: path }));
  try {
    await access(bin, constants.X_OK);
    return (await stat(bin)).isFile();
  } catch {
    return false;
  }
}
