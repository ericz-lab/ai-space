import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCollect } from "./process.ts";
import { readCodexTranscript, SESSION_ID_RE } from "./transcripts.ts";
import { ustar } from "./tar.ts";
import { assertCompletionMode, Unsupported, type ChatTurn, type ChatCallbacks, type Backend, type CodexCliSpec, type CompleteInput, type RuntimeAdapter, type Usage } from "./types.ts";

/** Codex completions and persistent local chat. Authentication stays in the CLI home. */
export function createCodexCli(spec: CodexCliSpec): RuntimeAdapter {
  const host = spec.sshHost?.trim();
  if (host && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) throw new Error(`runtime ${spec.name}: ssh is not a host name`);
  const bin = spec.bin.length ? spec.bin : ["codex"];
  const backend: Backend = host ? `ssh:${host}` : "local";
  return {
    name: spec.name, kind: "codex-cli", backend,
    capabilities: { complete: true, agent: false, chat: true },
    async complete(input, signal, onDelta) {
      assertCompletionMode(input);
      if (input.tools.length || input.files?.length) return { ok: false, error: "codex-cli completions do not support custom tool lists or file attachments", backend };
      if (signal?.aborted) return { ok: false, error: "aborted", backend };
      let dir: string | undefined;
      try {
        let cmd: string[];
        let stdin: string | Uint8Array = input.prompt;
        if (host) {
          const remote = codexRemoteCommand(bin, input);
          cmd = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, `bash -lc ${quote(remote.command)}`];
          stdin = remote.archive;
        } else {
          dir = await mkdtemp(join(tmpdir(), "space-codex-"));
          await Bun.write(join(dir, "system.txt"), input.system);
          cmd = codexArgs(bin, input, dir);
        }
        const r = await spawnCollect(cmd, { cwd: input.mode === "full" ? undefined : dir, stdin, signal, timeoutMs: input.timeoutMs });
        if (r.aborted) return { ok: false, error: "aborted", backend };
        if (r.timedOut || r.code === 124) return { ok: false, error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, backend };
        const parsed = parseCodexOutput(r.stdout);
        if (r.code !== 0 || parsed.error) return { ok: false, error: ((r.code !== 0 && r.stderr.trim()) || parsed.error || `exited with ${r.code}`).slice(-800), usage: parsed.usage, backend };
        // exec emits complete messages, not text deltas. Deliver only the validated final answer.
        onDelta?.(parsed.text!);
        return { ok: true, text: parsed.text!, usage: parsed.usage, backend };
      } catch (e) {
        return { ok: false, error: `could not run Codex: ${(e as Error).message}`, backend };
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true });
      }
    },
    async runAgent() { throw new Unsupported(spec.name, "agent"); },
    chat(turn, cb) { return codexChat(bin, turn, cb); },
    transcript: (cwd, sid) => readCodexTranscript(cwd, sid),
  };
}

/** Use the request as model instructions, not as a second user message. */
export function codexArgs(bin: string[], input: CompleteInput, dir: string, fullCwd = process.cwd()): string[] {
  assertCompletionMode(input);
  const common = ["--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", "read-only", "--model", input.model];
  if (input.mode === "full") {
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
    web_search: "disabled",
    approval_policy: "never",
    "skills.include_instructions": false,
    "skills.bundled.enabled": false,
    "tools.update_plan.enabled": false,
    "tools.experimental_request_user_input.enabled": false,
    suppress_unstable_features_warning: true,
  };
  const disabled = ["code_mode", "code_mode_host", "code_mode_only", "multi_agent_v2", "image_generation", "hooks", "tool_suggest", "default_mode_request_user_input", "send_message_to_user_async", "shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "memories", "shell_snapshot", "view_image", "browser_use", "computer_use", "goals", "sleep_tool", "skill_search", "skill_mcp_dependency_install"];
  return [...bin, "exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--json", "--color", "never", "--sandbox", "read-only", "--cd", dir, "--model", input.model,
    ...Object.entries(config).flatMap(([key, value]) => ["-c", `${key}=${JSON.stringify(value)}`]),
    ...disabled.flatMap((key) => ["--disable", key]), "--enable", "skip_host_skill_discovery", "-"];
}

/** Quote an entire shell argument, including embedded quotes, dollars and newlines. */
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function codexRemoteCommand(bin: string[], input: CompleteInput): { command: string; archive: Uint8Array; dir: string } {
  const dir = `/tmp/space-codex-${randomUUID()}`;
  const encode = (s: string) => new TextEncoder().encode(s);
  // The remote timeout bounds orphan lifetime after SSH disconnects. No retry or model fallback.
  const command = `umask 077; mkdir ${quote(dir)} || exit 1; trap ${quote(`rm -rf -- ${quote(dir)}`)} EXIT; tar -xf - -C ${quote(dir)} || exit 1; ${input.mode === "full" ? "" : `cd ${quote(dir)} || exit 1; `}timeout --signal=TERM --kill-after=5s ${Math.ceil(input.timeoutMs / 1000)}s ${codexArgs(bin, input, dir, ".").map(quote).join(" ")} < ${quote(join(dir, "prompt.txt"))}`;
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
