import { randomBytes } from "node:crypto";
import { pumpLines, spawnCollect } from "./process.ts";
import { ustar } from "./tar.ts";
import { readClaudeTranscript } from "./transcripts.ts";
import { assertCompletionMode, FILE_NAME_PATTERN, type AgentOutcome, type AgentRun, type Backend, type ChatCallbacks, type ChatTurn, type ClaudeCodeSpec, type CompleteFile, type CompleteInput, type CompleteOutcome, type OnDelta, type RuntimeAdapter, type Usage } from "./types.ts";

/**
 * Claude Code as a runtime. Three operations, one CLI:
 *
 *   complete   `claude -p --output-format json`, started lean (below), the prompt on stdin;
 *              over ssh when the spec names a host, borrowing that machine's login. A caller
 *              that wants the text as it is produced gets `stream-json` instead and the
 *              text deltas as they come; the result envelope is the stream's last line
 *   agent      `claude -p --output-format json` in the app directory with the CLI's own
 *              system prompt and tools, the prompt file on stdin; always local
 *   chat       `claude -p <message> --output-format stream-json`, events forwarded as is;
 *              `--resume <sid>` for continuity; always local
 *
 * Why `complete` is started lean: left alone, `claude -p` sends its own system
 * prompt, every built-in tool's description, the MCP servers of the machine and
 * the CLAUDE.md files it finds, measured at 24K tokens ahead of a one-line
 * prompt. `--system-prompt` replaces the prompt, `--tools ""` drops the tool
 * set, `--strict-mcp-config` drops the servers; the same prompt then costs 393
 * tokens. A call that asks for tools gets exactly those and nothing else.
 * Thinking is the other fixed cost: the CLI thinks before every answer, ten
 * times a one-line translation's tokens; a request's `thinking` cap becomes
 * `MAX_THINKING_TOKENS` in the runtime's environment, 0 turning it off.
 *
 * Files (the chat service's image attachments) are opened by the CLI's Read
 * tool: the call gets `Read` among its tools and a note at the end of the
 * prompt naming each file and where it is. Locally that is the path the
 * caller gave. Over ssh the bytes travel on the same stdin as the prompt:
 * the remote command spools the prompt and every file into a directory of
 * its own with one `head -c <size>` each (GNU head reads exactly that many
 * bytes from a pipe), runs the CLI, and removes the directory.
 *
 * The CLI answers with one json envelope: the text under `result`, token counts
 * under `usage`, its own cost figure; `is_error` marks a failed run that exited
 * 0. An older CLI answering in plain text still works, with no usage recorded
 * (nothing is estimated).
 */

export const PERMISSION_MODES = ["acceptEdits", "bypassPermissions", "plan"] as const;

export function createClaudeCode(spec: ClaudeCodeSpec): RuntimeAdapter {
  const sshHost = spec.sshHost?.trim() ?? "";
  if (sshHost && !/^[A-Za-z0-9._@-]+$/.test(sshHost)) throw new Error(`runtime ${spec.name}: ssh host is not a host name: ${sshHost}`);
  const bin = spec.bin.length ? spec.bin : ["claude"];
  const backend: Backend = sshHost ? `ssh:${sshHost}` : "local";

  return {
    name: spec.name,
    kind: "claude-code",
    backend,
    capabilities: { complete: true, agent: true, chat: true },

    async complete(input, signal, onDelta) {
      assertCompletionMode(input);
      const stream = onDelta !== undefined;
      const badName = input.files?.find((f) => !FILE_NAME_PATTERN.test(f.name));
      if (badName) return { ok: false, error: `file name not allowed: ${badName.name}`, backend };
      if (sshHost) {
        let blobs: FileBlob[];
        try {
          blobs = await readFiles(input.files ?? []);
        } catch (e) {
          return { ok: false, error: `could not read a file: ${(e as Error).message}`, backend };
        }
        const remote = remoteCommand(bin, input, stream, blobs);
        if ("bad" in remote) return { ok: false, error: `argument not allowed over ssh: ${remote.bad}`, backend };
        const stdin = remote.spool ? remote.spool.archive : input.prompt;
        return runCompletion(["ssh", "-o", "BatchMode=yes", sshHost, `bash -lc '${remote.command}'`], input, stdin, backend, signal, onDelta);
      }
      return runCompletion(cliArgs(bin, input, stream), input, input.prompt + filesNote(input.files ?? [], (f) => f.path), "local", signal, onDelta);
    },

    async runAgent(run) {
      const cmd = [...bin, "-p", "--output-format", "json", ...(run.model ? ["--model", run.model] : [])];
      const r = await spawnCollect(cmd, { cwd: run.cwd, env: run.env, stdin: run.prompt, signal: run.signal });
      const output = joinOutput(r.stdout, r.stderr);
      if (r.timedOut || r.aborted) return { ok: false, error: "timed out", output, timedOut: true, backend: "local" };
      if (r.code !== 0) return { ok: false, error: `exit code ${r.code}`, output, timedOut: false, backend: "local" };
      const parsed = parseCliOutput(r.stdout);
      if (!parsed) return { ok: true, output, timedOut: false, backend: "local" };
      if (parsed.error !== undefined) return { ok: false, error: parsed.error, output, usage: parsed.usage, costUsd: parsed.costUsd, timedOut: false, backend: "local" };
      return { ok: true, output, text: parsed.text, usage: parsed.usage, costUsd: parsed.costUsd, timedOut: false, backend: "local" };
    },

    chat(turn, cb) {
      return chatStream([...bin, ...chatArgs(turn, spec.chatArgs)], turn, cb);
    },

    transcript: (cwd, sid) => readClaudeTranscript(cwd, sid, spec.transcriptHome),
  };
}

// ---------------------------------------------------------------- complete

/** The output format flags: one json envelope, or the event stream with partial messages when the caller wants deltas. */
function formatArgs(stream: boolean): string[] {
  return stream ? ["--output-format", "stream-json", "--verbose", "--include-partial-messages"] : ["--output-format", "json"];
}

/** The tools a call gets: what it asked for, plus Read when it carries files. */
function toolList(input: CompleteInput): string {
  const tools = input.files?.length && !input.tools.includes("Read") ? ["Read", ...input.tools] : input.tools;
  return tools.join(",");
}

/** The lines appended to a prompt that carries files: each name and where the CLI finds it. */
export function filesNote(files: CompleteFile[], pathOf: (f: CompleteFile) => string): string {
  if (!files.length) return "";
  return `\n\nAttached files (open them with the Read tool; refer to them by these names):\n${files.map((f) => `- ${f.name}: ${pathOf(f)}`).join("\n")}\n`;
}

/** Command line for the CLI on this machine; exported for tests. */
export function cliArgs(bin: string[], input: CompleteInput, stream = false): string[] {
  assertCompletionMode(input);
  const tools = toolList(input);
  const context = input.mode === "full" ? [] : ["--safe-mode", "--strict-mcp-config"];
  const toolArgs = input.mode === "full" && !tools ? [] : ["--tools", tools, ...(tools ? ["--allowedTools", tools] : [])];
  return [...bin, "-p", ...formatArgs(stream), "--model", input.model, ...context, ...toolArgs,
    ...(input.system ? ["--system-prompt", input.system] : [])];
}

export type FileBlob = { name: string; bytes: Uint8Array };

async function readFiles(files: CompleteFile[]): Promise<FileBlob[]> {
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: await Bun.file(f.path).bytes() })));
}

const SAFE_ARG = /^[A-Za-z0-9._:/@,()*-]+$/;

/**
 * The same command as one shell string for `ssh <host> bash -lc '…'`. Every
 * bare word is checked against SAFE_ARG; the system prompt, which is free
 * text, travels base64-encoded and is decoded by the remote shell, so no byte
 * of it is interpreted. Returns the offending word instead of a command when
 * one fails the check.
 */
export function remoteCommand(bin: string[], input: CompleteInput, stream = false, blobs: FileBlob[] = []): { command: string; spool?: { dir: string; archive: Uint8Array } } | { bad: string } {
  const tools = toolList(input);
  assertCompletionMode(input);
  const words = [...bin, "-p", ...formatArgs(stream), "--model", input.model, ...(input.mode === "full" ? [] : ["--safe-mode", "--strict-mcp-config"])];
  const bad = [...words, ...(tools ? [tools] : []), ...blobs.map((b) => b.name)].find((w) => !SAFE_ARG.test(w) || (blobs.some((b) => b.name === w) && !FILE_NAME_PATTERN.test(w)));
  if (bad) return { bad };
  const system = Buffer.from(input.system, "utf8").toString("base64");
  const env = input.thinking === undefined ? [] : [`MAX_THINKING_TOKENS=${Math.trunc(input.thinking)}`];
  const parts = [...env, ...words, ...(input.mode === "full" && !tools ? [] : ["--tools", tools ? tools : '""', ...(tools ? ["--allowedTools", tools] : [])]), ...(input.system ? ["--system-prompt", `"$(printf %s ${system} | base64 -d)"`] : [])];
  // The prompt is spooled to a file before the CLI starts: the CLI gives up on stdin after 3 s,
  // and a prompt of a few hundred KB can take longer than that to cross a slow ssh link.
  if (!blobs.length) return { command: `f=$(mktemp) && cat > "$f" && ${parts.join(" ")} < "$f"; rc=$?; rm -f "$f"; exit $rc` };
  // With files, stdin is one tar archive of the prompt and every file; the directory name is
  // chosen here so the prompt can name the paths, and `mkdir` without -p refuses a reused one.
  const dir = `/tmp/sc-${randomBytes(8).toString("hex")}`;
  const prompt = new TextEncoder().encode(input.prompt + filesNote(blobs.map((b) => ({ name: b.name, path: `${dir}/${b.name}` })), (f) => f.path));
  return {
    command: `dir=${dir}; mkdir "$dir" && tar -xf - -C "$dir" && ${parts.join(" ")} < "$dir/prompt"; rc=$?; rm -rf "$dir"; exit $rc`,
    spool: { dir, archive: ustar([{ name: "prompt", bytes: prompt }, ...blobs]) },
  };
}

/** Environment of a local CLI run: the process's own plus the thinking cap. */
export function cliEnv(input: CompleteInput, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return input.thinking === undefined ? base : { ...base, MAX_THINKING_TOKENS: String(Math.trunc(input.thinking)) };
}

type CliResult = {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
};

/** Read the CLI's json envelope; undefined when the output is not one. */
export function parseCliOutput(raw: string): { text?: string; error?: string; usage?: Usage; costUsd?: number } | undefined {
  let j: CliResult;
  try {
    j = JSON.parse(raw) as CliResult;
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object" || j.type !== "result") return undefined;
  const u = j.usage;
  const usage: Usage | undefined = u
    ? { inputTokens: u.input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }
    : undefined;
  const costUsd = typeof j.total_cost_usd === "number" ? j.total_cost_usd : undefined;
  if (j.is_error) return { error: (j.result ?? j.subtype ?? "the runtime reported an error").trim(), usage, costUsd };
  const text = j.result?.trim() ?? "";
  if (!text) return { error: "empty answer", usage, costUsd };
  return { text, usage, costUsd };
}

type StreamEvent = { type?: string; event?: { type?: string; delta?: { type?: string; text?: string } } };

/**
 * One line of the `stream-json` output: the text of a `content_block_delta`,
 * or the `result` envelope when the line is that; anything else (init,
 * whole assistant messages, tool events) is nothing to us.
 */
export function readStreamLine(line: string): { delta: string } | { result: string } | undefined {
  let ev: StreamEvent;
  try {
    ev = JSON.parse(line) as StreamEvent;
  } catch {
    return undefined;
  }
  if (!ev || typeof ev !== "object") return undefined;
  if (ev.type === "result") return { result: line };
  if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta" && ev.event.delta.text) return { delta: ev.event.delta.text };
  return undefined;
}

async function runCompletion(cmd: string[], input: CompleteInput, stdin: string | Uint8Array, backend: Backend, signal?: AbortSignal, onDelta?: OnDelta): Promise<CompleteOutcome> {
  let result: string | undefined;
  const onLine = onDelta
    ? (line: string) => {
        const ev = readStreamLine(line);
        if (!ev) return;
        if ("result" in ev) result = ev.result;
        else onDelta(ev.delta);
      }
    : undefined;
  let r: Awaited<ReturnType<typeof spawnCollect>>;
  try {
    r = await spawnCollect(cmd, { env: cliEnv(input), stdin, signal, timeoutMs: input.timeoutMs, onLine });
  } catch (e) {
    return { ok: false, error: `could not start ${cmd[0]}: ${(e as Error).message}`, backend };
  }
  if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, backend };
  if (r.aborted) return { ok: false, error: "aborted", backend };
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.code !== 0) return { ok: false, error: (err || out || `exited with ${r.code}`).slice(-800), backend };
  const parsed = parseCliOutput(result ?? out);
  if (!parsed) {
    // A CLI without `--output-format json`: the whole output is the answer, no usage is known.
    return out ? { ok: true, text: out, backend } : { ok: false, error: "empty answer", backend };
  }
  if (parsed.error !== undefined) return { ok: false, error: parsed.error, usage: parsed.usage, costUsd: parsed.costUsd, backend };
  return { ok: true, text: parsed.text!, usage: parsed.usage, costUsd: parsed.costUsd, backend };
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
}

// ---------------------------------------------------------------- chat

/** Arguments after the binary; exported for tests. */
export function chatArgs(t: ChatTurn, extra: string[] = []): string[] {
  const args = ["-p", t.message, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (t.model) args.push("--model", t.model);
  if (t.sessionId) args.push("--resume", t.sessionId);
  if ((PERMISSION_MODES as readonly string[]).includes(t.permissionMode ?? "")) args.push("--permission-mode", t.permissionMode!);
  if (t.systemPrompt) args.push("--append-system-prompt", t.systemPrompt);
  if (t.allowedTools?.length) args.push("--allowedTools", t.allowedTools.join(","));
  args.push(...extra);
  return args;
}

function chatStream(cmd: string[], t: ChatTurn, cb: ChatCallbacks): { kill: () => void } {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(cmd, { cwd: t.cwd, env: t.env ?? process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    queueMicrotask(() => cb.onFinish(`could not start the runtime: ${(e as Error).message}`));
    return { kill: () => {} };
  }

  let sessionSeen = false;
  const stderr = new Response(proc.stderr).text();
  const emit = (line: string) => {
    if (!sessionSeen && cb.onSession && line.includes('"session_id"')) {
      try {
        const ev = JSON.parse(line) as { session_id?: unknown };
        if (typeof ev.session_id === "string") {
          sessionSeen = true;
          cb.onSession(ev.session_id);
        }
      } catch {
        /* partial line */
      }
    }
    cb.onEvent(line);
  };

  void (async () => {
    await pumpLines(proc.stdout, emit).catch(() => {});
    const code = await proc.exited;
    const err = (await stderr).trim();
    cb.onFinish(code === 0 ? null : (err || `runtime exited with ${code}`).slice(-800));
  })();

  return { kill: () => proc.kill() };
}
