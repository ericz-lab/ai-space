/**
 * An app's log, read through the operator's command template until ai-space
 * collects the logs itself (service supervision, docs/app-spec.md).
 *
 * The template is `SPACE_SERVICE_LOGS` (docs/cli.md): `{app}` is the unit
 * name, `{lines}` how many lines to print, `{follow}` becomes `-f` when the
 * reader wants to keep the stream open and nothing otherwise. Only those
 * three words are substituted, and only for a plain app name, so the
 * template stays the operator's and the request cannot smuggle a shell word.
 */

export const SPACE_UNIT = "ai-space";
export const APP_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const MAX_LINES = 10_000;

/** `unit` overrides the unit behind `app` (the space's own `space-<app>.service` under SPACE_SUPERVISOR=space). */
export type LogsRequest = { app: string; lines: number; follow: boolean; unit?: string };

/** The unit behind an app name: the space's own service for `space`, the app itself otherwise. */
export function unitFor(app: string): string {
  return app === "space" ? SPACE_UNIT : app;
}

export function renderLogsCommand(template: string, req: LogsRequest): string {
  if (!APP_RE.test(req.app)) throw new Error("invalid app name");
  if (req.unit !== undefined && !/^[a-z0-9][a-z0-9._@-]{0,80}$/i.test(req.unit)) throw new Error("invalid unit name");
  const lines = Math.min(MAX_LINES, Math.max(1, Math.floor(req.lines) || 100));
  return template
    .replaceAll("{app}", req.unit ?? unitFor(req.app))
    .replaceAll("{lines}", String(lines))
    .replaceAll("{follow}", req.follow ? "-f" : "")
    .replace(/\s+$/, "");
}

export type LogsProcess = {
  /** Lines as they come, stdout and stderr merged. */
  lines: AsyncIterable<string>;
  /** Resolves with the exit code once the command ends. */
  exited: Promise<number>;
  kill(): void;
};

/** Start the template's command; the caller reads `lines` and kills it when the reader is gone. */
export function spawnLogs(template: string, req: LogsRequest, spawn: typeof Bun.spawn = Bun.spawn): LogsProcess {
  const proc = spawn(["sh", "-c", wrap(renderLogsCommand(template, req))], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  return {
    lines: readLines(proc.stdout as ReadableStream<Uint8Array>),
    exited: proc.exited,
    kill: () => proc.kill(),
  };
}

/**
 * The shell script around the command: stderr merged into stdout, and the
 * signal that ends the shell forwarded to the command, so a `journalctl -f`
 * does not outlive the reader that asked for it (`kill` reaches the shell,
 * which would otherwise leave its child running under init).
 */
export function wrap(cmd: string): string {
  return `trap 'kill -TERM $c 2>/dev/null; wait $c 2>/dev/null; exit 143' TERM INT HUP; ${cmd} 2>&1 & c=$!; wait $c`;
}

export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = rest.indexOf("\n")) >= 0) {
      yield rest.slice(0, i);
      rest = rest.slice(i + 1);
    }
  }
  rest += decoder.decode();
  if (rest) yield rest;
}
