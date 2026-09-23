import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnCollect } from "./process.ts";
import { ustar } from "./tar.ts";
import { Unsupported, type Backend, type CodexCliSpec, type CompleteInput, type RuntimeAdapter, type Usage } from "./types.ts";

/** Text-only, single-turn Codex. Auth stays in the CLI home; request files never do. */
export function createCodexCli(spec: CodexCliSpec): RuntimeAdapter {
  const host = spec.sshHost?.trim();
  if (host && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(host)) throw new Error(`runtime ${spec.name}: ssh is not a host name`);
  const bin = spec.bin.length ? spec.bin : ["codex"];
  const backend: Backend = host ? `ssh:${host}` : "local";
  return {
    name: spec.name, kind: "codex-cli", backend,
    capabilities: { complete: true, agent: false, chat: false },
    async complete(input, signal, onDelta) {
      if (input.tools.length || input.files?.length) return { ok: false, error: "codex-cli completions do not support tools or files", backend };
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
        const r = await spawnCollect(cmd, { cwd: dir, stdin, signal, timeoutMs: input.timeoutMs });
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
    chat() { throw new Unsupported(spec.name, "chat"); },
  };
}

/** Use the request as model instructions, not as a second user message. */
export function codexArgs(bin: string[], input: CompleteInput, dir: string): string[] {
  const config: Record<string, string | number | boolean> = {
    model_instructions_file: join(dir, "system.txt"),
    developer_instructions: "",
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
  const disabled = ["shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "memories", "shell_snapshot", "view_image", "browser_use", "computer_use", "goals", "sleep_tool", "skill_search", "skill_mcp_dependency_install"];
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
  const command = `umask 077; mkdir ${quote(dir)} || exit 1; trap ${quote(`rm -rf -- ${quote(dir)}`)} EXIT; tar -xf - -C ${quote(dir)} || exit 1; cd ${quote(dir)} || exit 1; timeout --signal=TERM --kill-after=5s ${Math.ceil(input.timeoutMs / 1000)}s ${codexArgs(bin, input, dir).map(quote).join(" ")} < prompt.txt`;
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
