/**
 * Spawn a runtime process, feed it stdin, collect both streams and wait,
 * honouring a timeout and an abort signal. The child is started in its own
 * process group where `setsid` exists (Linux) so a kill takes the whole tree,
 * not just a shell wrapper; without it (macOS) only the direct child is
 * killed. After a kill we stop waiting on the pipes: an orphaned grandchild
 * could otherwise hold stdout open.
 */

export type SpawnOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
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
    stdin.write(opts.stdin);
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
    try {
      if (setsid) process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      /* already gone */
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
