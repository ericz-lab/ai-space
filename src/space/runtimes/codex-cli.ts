import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCollect } from "./process.ts";
import { readCodexTranscript, SESSION_ID_RE } from "./transcripts.ts";
import { ustar } from "./tar.ts";
import { assertCompletionMode, type AgentRun, type ChatTurn, type ChatCallbacks, type Backend, type CodexCliSpec, type CompleteInput, type GeneratedImage, type ImageInput, type RuntimeAdapter, type Usage } from "./types.ts";

/** Codex completions, agent runs and persistent local chat. Authentication stays in the CLI home. */
export function createCodexCli(spec: CodexCliSpec, deps: Partial<{
  spawn: typeof spawnCollect;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}> = {}): RuntimeAdapter {
  const spawn = deps.spawn ?? spawnCollect;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const host = spec.sshHost?.trim();
  if (host && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) throw new Error(`runtime ${spec.name}: ssh is not a host name`);
  const bin = spec.bin.length ? spec.bin : ["codex"];
  const backend: Backend = host ? `ssh:${host}` : "local";
  return {
    name: spec.name, kind: "codex-cli", backend,
    capabilities: { complete: true, agent: true, chat: true, image: true },
    async complete(input, signal, onDelta) {
      assertCompletionMode(input);
      if (input.files?.length) return { ok: false, error: "codex-cli completions do not support file attachments", backend };
      const unsupported = input.tools.filter((tool) => tool !== "WebSearch" && tool !== "WebFetch");
      if (unsupported.length) return { ok: false, error: `codex-cli completions support only WebSearch and WebFetch tool lists; unsupported: ${unsupported.join(", ")}`, backend };
      if (signal?.aborted) return { ok: false, error: "aborted", backend };
      let dir: string | undefined;
      const deadline = now() + input.timeoutMs;
      try {
        for (let attempt = 0; ; attempt++) {
          if (signal?.aborted) return { ok: false, error: "aborted", backend };
          const remainingMs = Math.ceil(deadline - now());
          if (remainingMs <= 0) return { ok: false, error: "timed out before retry", backend };
          let cmd: string[];
          let stdin: string | Uint8Array = input.prompt;
          if (host) {
            const remote = codexRemoteCommand(bin, { ...input, timeoutMs: remainingMs });
            cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, `bash -lc ${quote(remote.command)}`];
            stdin = remote.archive;
          } else {
            if (!dir) {
              dir = await mkdtemp(join(tmpdir(), "space-codex-"));
              await Bun.write(join(dir, "system.txt"), input.system);
            }
            cmd = codexArgs(bin, input, dir);
          }
          const r = await spawn(cmd, { cwd: input.mode === "full" ? undefined : dir, stdin, signal, timeoutMs: Math.max(1, Math.ceil(deadline - now())) });
          if (r.aborted) return { ok: false, error: "aborted", backend };
          if (r.timedOut || r.code === 124) return { ok: false, error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, backend };
          const parsed = parseCodexOutput(r.stdout);
          if (r.code !== 0 || parsed.error) {
            const error = ((r.code !== 0 && r.stderr.trim()) || parsed.error || `exited with ${r.code}`).slice(-800);
            // Only isolated text generation is safe to replay. Never replay a completed answer.
            const retryable = input.mode !== "full" && !input.tools.length && !parsed.text && !parsed.usage
              && transientCompletionError(`${r.stderr}\n${parsed.error ?? ""}`);
            const waitMs = 1000 * 2 ** attempt;
            if (!retryable || attempt >= 3 || deadline - now() <= waitMs) return { ok: false, error, usage: parsed.usage, backend };
            await sleep(waitMs, signal);
            continue;
          }
          // exec emits complete messages, not text deltas. Deliver only the validated final answer.
          onDelta?.(parsed.text!);
          return { ok: true, text: parsed.text!, usage: parsed.usage, backend };
        }
      } catch (e) {
        if (signal?.aborted) return { ok: false, error: "aborted", backend };
        return { ok: false, error: `could not run Codex: ${(e as Error).message}`, backend };
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
    // Always local, like every runtime's agent run: it works in the app directory. `ssh` is for answers only.
    async runAgent(run) {
      if (run.allowedTools?.length) return { ok: false, error: `runtime ${spec.name} cannot limit an agent run to a tool list; use permissionMode`, output: "", timedOut: false, backend: "local" };
      let r: Awaited<ReturnType<typeof spawnCollect>>;
      try {
        r = await spawnCollect([...bin, ...codexAgentArgs(run)], { cwd: run.cwd, env: run.env, stdin: run.prompt, signal: run.signal });
      } catch (e) {
        return { ok: false, error: `could not run Codex: ${(e as Error).message}`, output: "", timedOut: false, backend: "local" };
      }
      const output = [r.stdout, r.stderr].filter(Boolean).join("\n--- stderr ---\n");
      if (r.timedOut || r.aborted) return { ok: false, error: "timed out", output, timedOut: true, backend: "local" };
      const parsed = parseCodexOutput(r.stdout);
      const base = { output, usage: parsed.usage, timedOut: false, backend: "local" as Backend };
      if (r.code !== 0) return { ok: false, error: (r.stderr.trim() || parsed.error || `exit code ${r.code}`).slice(-800), ...base };
      if (parsed.error) return { ok: false, error: parsed.error, ...base };
      return { ok: true, text: parsed.text, ...base };
    },
    // Same script locally and over ssh: the prompt and the images arrive as one archive on stdin.
    async image(input, signal) {
      if (signal?.aborted) return { ok: false, error: "aborted", backend };
      try {
        const job = await codexImageCommand(bin, input, !!host);
        const cmd = host ? ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, `bash -lc ${quote(job.command)}`] : ["bash", "-c", job.command];
        const r = await spawnCollect(cmd, { stdin: job.archive, signal, timeoutMs: input.timeoutMs + 30_000 });
        if (r.aborted) return { ok: false, error: "aborted", backend };
        if (r.timedOut || r.code === 124) return { ok: false, error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, backend };
        const { events, images } = splitImageOutput(r.stdout);
        const parsed = parseCodexOutput(events);
        if (r.code !== 0 || parsed.error) return { ok: false, error: ((r.code !== 0 && r.stderr.trim()) || parsed.error || `exited with ${r.code}`).slice(-800), usage: parsed.usage, backend };
        if (!images.length) return { ok: false, error: `no image produced: ${parsed.text!.slice(0, 300)}`, usage: parsed.usage, backend };
        return { ok: true, text: parsed.text!, images, usage: parsed.usage, backend };
      } catch (e) {
        return { ok: false, error: `could not run Codex: ${(e as Error).message}`, backend };
      }
    },
    chat(turn, cb) { return codexChat(bin, turn, cb); },
    transcript: (cwd, sid) => readCodexTranscript(cwd, sid),
  };
}

/** Match transport failures narrowly; an unrelated model-list warning is not a retry reason. */
function transientCompletionError(error: string): boolean {
  if (/permission denied|authentication|unauthorized|forbidden|oauth|invalid.*(?:key|token)|model.*not supported|unknown model|host key verification/i.test(error)) return false;
  return /broken pipe|connection (?:reset|closed|refused|timed out)|connection to .+ closed|network is unreachable|temporary failure in name resolution|ECONNRESET|ECONNREFUSED|ETIMEDOUT|stream disconnected before completion|error sending request for url/i.test(error);
}

/** Use the request as model instructions, not as a second user message. */
export function codexArgs(bin: string[], input: CompleteInput, dir: string, fullCwd = process.cwd()): string[] {
  assertCompletionMode(input);
  const common = ["--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", "read-only", "--model", input.model];
  // Explicit web-only lists must not inherit native shell, plugins or MCP tools.
  if (input.mode === "full" && !input.tools.length) {
    return [...bin, "exec", ...common, "--cd", fullCwd, "-c", 'approval_policy="never"',
      ...(input.system ? ["-c", `model_instructions_file=${JSON.stringify(join(dir, "system.txt"))}`] : []), "-"];
  }
  const config: Record<string, string | number | boolean> = {
    model_instructions_file: join(dir, "system.txt"),
    developer_instructions: "",
    "agents.enabled": false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    include_permissions_instructions: false,
    project_doc_max_bytes: 0,
    model_reasoning_effort: "low",
    web_search: input.tools.length ? "live" : "disabled",
    approval_policy: "never",
    "skills.include_instructions": false,
    "skills.bundled.enabled": false,
    "tools.update_plan.enabled": false,
    "tools.experimental_request_user_input.enabled": false,
    suppress_unstable_features_warning: true,
  };
  // Current Codex routes web calls through Code Mode; its host is required even with shell disabled.
  const disabled = [...(input.tools.length ? [] : ["code_mode", "code_mode_host", "code_mode_only"]), "multi_agent_v2", "image_generation", "hooks", "tool_suggest", "default_mode_request_user_input", "send_message_to_user_async", "shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "memories", "shell_snapshot", "view_image", "browser_use", "computer_use", "goals", "sleep_tool", "skill_search", "skill_mcp_dependency_install"];
  return [...bin, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", "read-only", "--cd", dir, "--model", input.model,
    ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    ...disabled.flatMap((key) => ["--disable", key]),
    ...(input.tools.length ? ["--enable", "code_mode", "--enable", "code_mode_host"] : []), "--enable", "skip_host_skill_discovery", "-"];
}

/**
 * An image call: the slim isolation of `codexArgs`, with the image tool as the only tool. Current
 * Codex runs that tool through Code Mode, so its host stays on; the input images are attached with
 * `--image`, one flag each, because the flag takes several values and would swallow the `-`.
 */
export function codexImageArgs(bin: string[], input: Pick<ImageInput, "model" | "files">, dir: string): string[] {
  const config: Record<string, string | number | boolean> = {
    model_instructions_file: join(dir, "system.txt"),
    developer_instructions: "",
    "agents.enabled": false,
    include_apps_instructions: false,
    include_collaboration_mode_instructions: false,
    include_environment_context: false,
    include_permissions_instructions: false,
    project_doc_max_bytes: 0,
    model_reasoning_effort: "low",
    web_search: "disabled",
    approval_policy: "never",
    "skills.include_instructions": false,
    "skills.bundled.enabled": false,
    "tools.update_plan.enabled": false,
    "tools.experimental_request_user_input.enabled": false,
    suppress_unstable_features_warning: true,
  };
  const disabled = ["multi_agent_v2", "hooks", "tool_suggest", "default_mode_request_user_input", "send_message_to_user_async", "shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "memories", "shell_snapshot", "view_image", "browser_use", "computer_use", "goals", "sleep_tool", "skill_search", "skill_mcp_dependency_install"];
  return [...bin, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", "read-only", "--cd", dir, "--model", input.model,
    ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    ...disabled.flatMap((key) => ["--disable", key]),
    "--enable", "image_generation", "--enable", "code_mode", "--enable", "code_mode_host", "--enable", "skip_host_skill_discovery",
    ...input.files.flatMap((f) => ["--image", join(dir, f.name)]), "-"];
}

/** Marks each generated file after the event stream: `<marker> <name>`, then its base64 on one line. */
export const IMAGE_MARKER = "@@space-image@@";

/**
 * The shell script of one image call. Codex saves what its image tool makes under
 * `$CODEX_HOME/generated_images/<thread id>/` (also with `--ephemeral`) and says nothing of it in
 * the event stream, so the script prints the stream, then every file of that thread's directory
 * as base64, and removes the directory. The request directory goes away on exit either way.
 */
export async function codexImageCommand(bin: string[], input: ImageInput, remote: boolean): Promise<{ command: string; archive: Uint8Array; dir: string }> {
  const dir = join(remote ? "/tmp" : tmpdir(), `space-codex-img-${randomUUID()}`);
  const encode = (s: string) => new TextEncoder().encode(s);
  const entries = [{ name: "prompt.txt", bytes: encode(input.prompt) }, { name: "system.txt", bytes: encode(input.system) }];
  for (const f of input.files) entries.push({ name: f.name, bytes: new Uint8Array(await Bun.file(f.path).arrayBuffer()) });
  const limit = remote ? `timeout --signal=TERM --kill-after=5s ${Math.ceil(input.timeoutMs / 1000)}s ` : "";
  const command = [
    `umask 077; dir=${quote(dir)}; mkdir "$dir" || exit 1; trap 'rm -rf -- "$dir"' EXIT; tar -xf - -C "$dir" || exit 1; builtin cd "$dir" || exit 1`,
    `${limit}${codexImageArgs(bin, input, dir).map(quote).join(" ")} < "$dir/prompt.txt" > "$dir/out.jsonl" 2> "$dir/err.txt"; rc=$?`,
    `cat "$dir/out.jsonl"; cat "$dir/err.txt" >&2`,
    `tid=$(sed -nE 's/.*"thread_id": ?"([0-9A-Za-z-]+)".*/\\1/p' "$dir/out.jsonl" | head -n 1)`,
    `if [ -n "$tid" ]; then g="\${CODEX_HOME:-$HOME/.codex}/generated_images/$tid"; if [ -d "$g" ]; then for f in "$g"/*; do [ -f "$f" ] || continue; printf '\\n%s %s\\n' ${quote(IMAGE_MARKER)} "\${f##*/}"; base64 < "$f" | tr -d '\\n'; printf '\\n'; done; rm -rf -- "$g"; fi; fi`,
    `exit $rc`,
  ].join("\n");
  return { command, dir, archive: ustar(entries) };
}

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The event stream, and the images the script appended after it, in the order Codex saved them. */
export function splitImageOutput(stdout: string): { events: string; images: GeneratedImage[] } {
  const at = stdout.indexOf(`\n${IMAGE_MARKER} `);
  if (at < 0) return { events: stdout, images: [] };
  const images: GeneratedImage[] = [];
  const lines = stdout.slice(at + 1).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith(`${IMAGE_MARKER} `)) continue;
    const name = lines[i]!.slice(IMAGE_MARKER.length + 1);
    const data = lines[i + 1] ?? "";
    const type = IMAGE_TYPES[name.split(".").pop()!.toLowerCase()];
    if (type && data) images.push({ type, bytes: new Uint8Array(Buffer.from(data, "base64")) });
  }
  return { events: stdout.slice(0, at), images };
}

/** Quote an entire shell argument, including embedded quotes, dollars and newlines. */
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function codexRemoteCommand(bin: string[], input: CompleteInput): { command: string; archive: Uint8Array; dir: string } {
  const dir = `/tmp/space-codex-${randomUUID()}`;
  const encode = (s: string) => new TextEncoder().encode(s);
  // The remote timeout bounds orphan lifetime after SSH disconnects. Retries share the original deadline; there is no model fallback.
  // `builtin cd`: the login shell may load a profile that wraps `cd` in a function, and RVM's
  // wrapper runs `trap - EXIT`, which dropped the cleanup and left the request files behind.
  const command = `umask 077; mkdir ${quote(dir)} || exit 1; trap ${quote(`rm -rf -- ${quote(dir)}`)} EXIT; tar -xf - -C ${quote(dir)} || exit 1; ${input.mode === "full" ? "" : `builtin cd ${quote(dir)} || exit 1; `}timeout --signal=TERM --kill-after=5s ${Math.ceil(input.timeoutMs / 1000)}s ${codexArgs(bin, input, dir, ".").map(quote).join(" ")} < ${quote(join(dir, "prompt.txt"))}`;
  return { command, dir, archive: ustar([{ name: "prompt.txt", bytes: encode(input.prompt) }, { name: "system.txt", bytes: encode(input.system) }]) };
}

/** Never mistake an exit-zero error, partial stream or log line for a successful answer. */
export function parseCodexOutput(raw: string): { text?: string; error?: string; usage?: Usage } {
  let text: string | undefined;
  let error: string | undefined;
  let completed = false;
  let usage: Usage | undefined;
  for (const line of raw.split(/\r?\n/).filter((s) => s.trim())) {
    let ev: { type?: string; message?: string; error?: { message?: string }; item?: { type?: string; text?: string }; usage?: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number } };
    try { ev = JSON.parse(line); } catch { return { error: "invalid Codex JSON stream", usage }; }
    if (!ev || typeof ev !== "object") return { error: "invalid Codex event", usage };
    if (ev.type === "turn.failed") error = ev.error?.message || "Codex turn failed";
    if (ev.type === "error") error = ev.message || "Codex reported an error";
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") text = ev.item.text;
    if (ev.type === "turn.completed") {
      completed = true;
      const u = ev.usage;
      if (u && [u.input_tokens, u.cached_input_tokens ?? 0, u.cache_write_input_tokens ?? 0, u.output_tokens].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) && (u.cached_input_tokens ?? 0) <= u.input_tokens!) {
        const cached = u.cached_input_tokens ?? 0;
        // Codex input_tokens includes cached input; the Space ledger keeps them separate.
        usage = { inputTokens: u.input_tokens! - cached, cacheReadTokens: cached, cacheWriteTokens: u.cache_write_input_tokens ?? 0, outputTokens: u.output_tokens! };
      }
    }
  }
  return { text, usage, ...(error ? { error } : !completed ? { error: "Codex stream ended without turn.completed" } : !text?.trim() ? { error: "empty Codex answer" } : {}) };
}

/** Persistent local chat with native context, skills and tools; permissions remain explicit. */
export function codexChatArgs(turn: ChatTurn): string[] {
  const sandbox = turn.permissionMode === "bypassPermissions" ? "danger-full-access" : turn.permissionMode === "acceptEdits" ? "workspace-write" : "read-only";
  return ["exec", "--skip-git-repo-check", "--json", "--sandbox", sandbox, "-c", 'approval_policy="never"',
    ...(turn.model ? ["--model", turn.model] : []),
    ...(turn.systemPrompt ? ["-c", `developer_instructions=${JSON.stringify(turn.systemPrompt)}`] : []),
    ...(turn.sessionId ? ["resume", turn.sessionId] : []), "-"];
}

/**
 * An agent task: the prompt on stdin, the CLI's own instructions, skills and tools, in the app
 * directory. The permission mode maps to a sandbox as for chat. Codex drops variables whose names
 * contain KEY, SECRET or TOKEN from the commands it runs; the task's environment is what ai-space
 * handed this app (its SPACE_APP_TOKEN among it), so it reaches the commands whole, as with Claude Code.
 */
export function codexAgentArgs(run: Pick<AgentRun, "model" | "permissionMode">): string[] {
  const sandbox = run.permissionMode === "bypassPermissions" ? "danger-full-access" : run.permissionMode === "acceptEdits" ? "workspace-write" : "read-only";
  return ["exec", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", sandbox, "-c", 'approval_policy="never"',
    "-c", "shell_environment_policy.ignore_default_excludes=true", ...(run.model ? ["--model", run.model] : []), "-"];
}

function codexChat(bin: string[], turn: ChatTurn, cb: ChatCallbacks): { kill: () => void } {
  const controller = new AbortController();
  const emit = (event: unknown) => cb.onEvent(JSON.stringify(event));
  void (async () => {
    try {
      if (turn.allowedTools?.length) throw new Error("Codex chat does not support custom tool allow-lists");
      let sid = turn.sessionId;
      const result = await spawnCollect([...bin, ...codexChatArgs(turn)], {
        cwd: turn.cwd, env: turn.env, stdin: turn.message, signal: controller.signal,
        onLine(line) {
          let event;
          try { event = JSON.parse(line); } catch { return; }
          if (event?.type === "thread.started" && typeof event.thread_id === "string" && SESSION_ID_RE.test(event.thread_id)) {
            sid = event.thread_id;
            cb.onSession?.(sid!);
            emit({ type: "system", subtype: "init", session_id: sid, model: turn.model ?? "codex" });
          }
          const item = event?.item;
          if (event?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
            emit({ type: "assistant", message: { content: [{ type: "text", text: item.text }] } });
          } else if ((event?.type === "item.started" || event?.type === "item.completed") && item && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(item.type)) {
            const name = item.type === "command_execution" ? "Bash" : item.type === "file_change" ? "Edit" : item.tool ?? item.type;
            emit({ type: "assistant", message: { content: [{ type: "tool_use", id: item.id, name, input: { command: item.command ?? item.query ?? item.changes?.map((c: { path: string }) => c.path).join(", ") ?? "" } }] } });
            if (item.status === "failed") emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: item.id, is_error: true, content: item.aggregated_output ?? item.error?.message ?? "Tool failed" }] } });
          }
        },
      });
      const parsed = parseCodexOutput(result.stdout);
      const error = result.aborted ? "aborted" : result.code !== 0 ? (result.stderr.trim() || `runtime exited with ${result.code}`).slice(-800) : parsed.error ?? null;
      if (!error) emit({ type: "result", session_id: sid, is_error: false });
      cb.onFinish(error);
    } catch (e) {
      cb.onFinish(`could not run Codex: ${(e as Error).message}`);
    }
  })();
  return { kill: () => controller.abort() };
}
