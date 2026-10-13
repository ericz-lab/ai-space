import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompleteInput, CompleteOutcome, OnDelta, Usage } from "./types.ts";

async function* chunks(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try { for (;;) { const r = await reader.read(); if (r.done) break; yield r.value; } }
  finally { reader.releaseLock(); }
}

/** Opt-in, local, tool-free app-server completions. No persistent conversation or config writes. */
export async function streamCodex(bin: string[], input: CompleteInput, signal: AbortSignal | undefined, delta: OnDelta): Promise<CompleteOutcome> {
  if (signal?.aborted) return { ok: false, error: "aborted", backend: "local" };
  const dir = await mkdtemp(join(tmpdir(), "space-codex-stream-"));
  await Bun.write(join(dir, "system.txt"), input.system || "Answer the user's request.");
  const disabled = ["code_mode", "code_mode_host", "code_mode_only", "multi_agent_v2", "image_generation", "hooks", "tool_suggest", "default_mode_request_user_input", "send_message_to_user_async", "shell_tool", "unified_exec", "plugins", "apps", "multi_agent", "memories", "shell_snapshot", "view_image", "browser_use", "computer_use", "goals", "sleep_tool", "skill_search", "skill_mcp_dependency_install"];
  const command = [...bin, "app-server", ...disabled.flatMap(name => ["--disable", name])];
  const setsid = Bun.which("setsid");
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const child = Bun.spawn(setsid ? [setsid, ...command] : command, { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc = child;
    const send = (id: number | undefined, method: string, params: unknown) => {
      child.stdin.write(JSON.stringify({ ...(id !== undefined ? { id } : {}), method, params }) + "\n");
      void child.stdin.flush();
    };
    let finished = false, thread = "", text = "", usage: Usage | undefined;
    const kill = () => { try { if (setsid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} };
    return await new Promise<CompleteOutcome>(resolve => {
      const end = (error?: string) => {
        if (finished) return; finished = true;
        kill();
        resolve(error ? { ok: false, error, usage, backend: "local" } : { ok: true, text: text.trim(), usage, backend: "local" });
      };
      abort = () => end("aborted");
      timer = setTimeout(() => end(`timed out after ${Math.round(input.timeoutMs / 1000)}s`), input.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      // Drain stderr without persisting config, prompts, auth or diagnostics into the ledger.
      void (async () => { for await (const _ of chunks(child.stderr)) { /* drain */ } })().catch(() => {});
      void child.exited.then(() => { if (!finished) end("Codex app-server exited before turn completion"); });
      void (async () => {
        const decoder = new TextDecoder(); let rest = "";
        for await (const chunk of chunks(child.stdout)) {
          rest += decoder.decode(chunk, { stream: true });
          if (rest.length > 2_000_000) throw new Error("Codex app-server event exceeds limit");
          let nl: number;
          while ((nl = rest.indexOf("\n")) >= 0) {
            const line = rest.slice(0, nl); rest = rest.slice(nl + 1);
            if (!line.trim() || finished) continue;
            const m = JSON.parse(line), p = m.params ?? {};
            if (m.error) throw new Error(m.error.message ?? "Codex protocol error");
            if (m.id !== undefined && m.method) throw new Error("Unexpected tool or approval request in isolated completion");
            if (m.id === 0) { send(undefined, "initialized", {}); send(1, "config/read", { includeLayers: false }); }
            if (m.id === 1) {
              const config = m.result?.config;
              if (!config || typeof config !== "object") throw new Error("Missing Codex config response");
              const overrides: Record<string, unknown> = {
                developer_instructions: "", model_instructions_file: join(dir, "system.txt"), "agents.enabled": false,
                include_apps_instructions: false, include_collaboration_mode_instructions: false,
                include_environment_context: false, include_permissions_instructions: false,
                project_doc_max_bytes: 0, web_search: "disabled", "skills.include_instructions": false,
                "skills.bundled.enabled": false, "tools.update_plan.enabled": false,
                "tools.experimental_request_user_input.enabled": false,
              };
              for (const name of Object.keys(config.mcp_servers ?? {})) {
                if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("Cannot isolate configured MCP server name");
                overrides[`mcp_servers.${name}.enabled`] = false;
              }
              send(2, "thread/start", { model: input.model, cwd: dir, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", baseInstructions: input.system, developerInstructions: "", config: overrides });
            }
            if (m.id === 2) {
              thread = m.result?.thread?.id;
              if (!thread) throw new Error("Missing Codex thread id");
              send(3, "turn/start", { threadId: thread, input: [{ type: "text", text: input.prompt }], effort: "low", ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}) });
            }
            if (p.threadId && p.threadId !== thread) continue;
            if (m.method === "item/started" && !["userMessage", "agentMessage", "reasoning"].includes(p.item?.type)) throw new Error("Unexpected tool item in isolated completion");
            if (m.method === "item/agentMessage/delta") {
              if (typeof p.delta !== "string") throw new Error("Invalid Codex text delta");
              text += p.delta;
              if (text.length > 1_000_000) throw new Error("Codex answer exceeds limit");
              delta(p.delta);
            }
            if (m.method === "thread/tokenUsage/updated") {
              const u = p.tokenUsage?.total;
              if (u) usage = { inputTokens: Math.max(0, (u.inputTokens ?? 0) - (u.cachedInputTokens ?? 0) - (u.cacheWriteInputTokens ?? 0)), cacheReadTokens: u.cachedInputTokens ?? 0, cacheWriteTokens: u.cacheWriteInputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
            }
            if (m.method === "turn/completed") {
              if (p.turn?.status !== "completed") end(p.turn?.error?.message ?? `Codex turn ${p.turn?.status}`);
              else end(text.trim() ? undefined : "empty Codex answer");
            }
          }
        }
        if (!finished) end("Codex stream ended without turn completion");
      })().catch(e => end((e as Error).message));
      send(0, "initialize", { clientInfo: { name: "ai_space", version: "1.0" } });
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message, backend: "local" };
  } finally {
    clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort);
    if (proc) { try { proc.kill("SIGKILL"); } catch {} await proc.exited; }
    await rm(dir, { recursive: true, force: true });
  }
}
