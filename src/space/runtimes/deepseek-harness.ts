import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pumpLines, spawnCollect } from "./process.ts";
import { readDshTranscript } from "./transcripts.ts";
import type { AgentOutcome, AgentRun, Backend, ChatCallbacks, ChatTurn, CompleteInput, CompleteOutcome, DeepseekHarnessSpec, RuntimeAdapter, Usage } from "./types.ts";

/**
 * DeepSeek Harness (`dsh`) as a runtime. One command for all three operations,
 * `dsh --profile headless --json`, the task on stdin (`-`) or as the argument:
 *
 *   complete   a `--patch` overlay per call replaces the system prompt (the harness identity
 *              and runtime context off, the request's `system` as the persona), sets the
 *              model and thinking, and disables every tool row unless the request asked for
 *              web tools; measured: 6,872 input tokens as shipped → 32 with the overlay
 *   agent      the profile as configured (its own prompt, its tools), the prompt file on
 *              stdin, inside the app directory; a model overlay when the target names one
 *   chat       `--session-id` for continuity; the agent's prompt becomes the persona prefix
 *              (identity and tools kept); the harness's events are translated into the
 *              `stream-json` shapes the panel reads
 *
 * Events (`--json`): `session` (id, cwd) first; `thinking`, `text`, `tool_call`,
 * `tool_result` as steps commit; `status` with `phase: step_end` carrying the
 * step's usage; `status turn_end` with the reason; `final` with the answer;
 * `error` when the runner failed outside a turn. Exit 1 on failure. Usage is
 * summed over the steps; cost is computed from DeepSeek's list prices below.
 *
 * The harness must have been prepared on its machine: the CLI installed, the
 * profile initialised, `DEEPSEEK_API_KEY` in its home's `.env`, and session
 * log upload and telemetry turned off (docs/runtimes.md).
 */

export const DEFAULT_PROFILE = "headless";
const DEFAULT_PROVIDER = "deepseek-official";

/**
 * DeepSeek list prices, USD per million tokens at peak: input (cache miss),
 * cache write (same as input: the API charges no extra for writing), cache
 * hit, output. Off-peak (all but 01:00–04:00 and 06:00–10:00 UTC on weekdays)
 * is half; the ledger takes the peak figure and so overstates off-peak calls.
 */
const PRICES: Record<string, [number, number, number, number]> = {
  "deepseek-flash": [0.3, 0.3, 0.006, 1.2],
  "deepseek-v4-pro": [1.32, 1.32, 0.044, 3.96],
};

export function dshCost(model: string, u: Usage): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (u.inputTokens * p[0] + u.cacheWriteTokens * p[1] + u.cacheReadTokens * p[2] + u.outputTokens * p[3]) / 1e6;
}

/** Tool rows of the base bundle that a lean answer switches off. `tool-web` stays when web tools were asked for. */
export const TOOL_ROWS = [
  "tool-bash", "tool-pwsh", "tool-jobs", "tool-fs", "tool-fs-search", "tool-skill", "skill-filesystem", "skill-badge",
  "commands", "command-feedback", "command-goal", "goal-round-driver", "plan-mode", "user-questions", "session-title-llm",
  "agent-instructions", "tool-subagent-control", "tool-subagent-list-agents", "tool-subagent", "tool-subagent-fork",
  "tool-workflow", "tool-todo", "tool-goal", "tool-ralph", "repeat-tool-reminder", "tool-web", "mcp-resources",
];

/** Web tools as the request names them (Claude Code's names) → the harness keeps its `tool-web` row. */
const WEB_TOOLS = new Set(["WebSearch", "WebFetch"]);

/** A request's thinking cap as the harness's reasoning effort: 0 off, small low, large high, huge max. */
export function reasoningEffort(thinking: number | undefined): "off" | "low" | "high" | "max" | undefined {
  if (thinking === undefined) return undefined;
  if (thinking <= 0) return "off";
  if (thinking <= 4096) return "low";
  if (thinking <= 32_768) return "high";
  return "max";
}

/** `provider:model` or a bare DeepSeek model id. */
export function splitModel(model: string): { provider: string; model: string } {
  const i = model.indexOf(":");
  return i > 0 ? { provider: model.slice(0, i), model: model.slice(i + 1) } : { provider: DEFAULT_PROVIDER, model };
}

export type PatchOptions = {
  /** Replace the system prompt with this text (identity and runtime context off). */
  system?: string;
  /** Prepend this persona to the harness's own prompt (chat). */
  persona?: string;
  model?: string;
  thinking?: number;
  /** Disable the tool rows; those web tools stay when named. */
  leanTools?: string[];
};

/** The `--patch` overlay for one run, as YAML. Free text goes in as JSON strings, which YAML reads verbatim. */
export function buildPatch(o: PatchOptions): string {
  const rows: string[] = [];
  if (o.system !== undefined) {
    rows.push(`- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: ${JSON.stringify(o.system)}\n    personaSuffix: ""`);
  } else if (o.persona !== undefined) {
    rows.push(`- id: system-prompt\n  config:\n    personaPrefix: ${JSON.stringify(o.persona)}\n    personaSuffix: ${JSON.stringify("Your working directory is {{cwd}}.")}`);
  }
  const effort = reasoningEffort(o.thinking);
  if (effort) rows.push(`- id: llm-deepseek\n  config:\n    reasoningEffort: ${JSON.stringify(effort)}`);
  if (o.model) {
    const m = splitModel(o.model);
    rows.push(`- id: agent-default-model\n  config:\n    provider: ${JSON.stringify(m.provider)}\n    model: ${JSON.stringify(m.model)}`);
  }
  if (o.leanTools) {
    const keepWeb = o.leanTools.some((t) => WEB_TOOLS.has(t));
    for (const id of TOOL_ROWS) if (!(keepWeb && id === "tool-web")) rows.push(`- id: ${id}\n  disabled: true`);
  }
  return rows.length ? `${rows.join("\n")}\n` : "[]\n";
}

// ---------------------------------------------------------------- events

type DshEvent = {
  type?: string;
  sessionId?: string;
  cwd?: string;
  phase?: string;
  text?: string;
  message?: string;
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  reason?: { kind?: string; error?: { message?: string; code?: string } };
  callId?: string;
  tool?: string;
  input?: unknown;
  status?: string;
  result?: string;
};

export type ParsedRun = { sessionId?: string; text?: string; error?: string; usage?: Usage; final: boolean };

/** Fold the event lines of one run: the session id, summed usage, the final text, the first error. */
export function parseEvents(stdout: string): ParsedRun {
  const out: ParsedRun = { final: false };
  let usage: Usage | undefined;
  for (const line of stdout.split("\n")) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (ev.type === "session" && typeof ev.sessionId === "string") out.sessionId = ev.sessionId;
    else if (ev.type === "status" && ev.phase === "step_end" && ev.usage) {
      usage ??= { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 };
      usage.inputTokens += ev.usage.inputTokens ?? 0;
      usage.outputTokens += ev.usage.outputTokens ?? 0;
      usage.cacheReadTokens += ev.usage.cacheReadTokens ?? 0;
      usage.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0;
    } else if (ev.type === "status" && ev.phase === "turn_end" && ev.reason?.kind && ev.reason.kind !== "completed") {
      out.error ??= ev.reason.error?.message ?? `turn ended: ${ev.reason.kind}`;
    } else if (ev.type === "error") out.error ??= ev.message ?? "the runtime reported an error";
    else if (ev.type === "final") {
      out.final = true;
      out.text = (ev.text ?? "").trim();
    }
  }
  out.usage = usage;
  return out;
}

function parseLine(line: string): DshEvent | undefined {
  if (!line.trim()) return undefined;
  try {
    const ev = JSON.parse(line) as DshEvent;
    return ev && typeof ev === "object" ? ev : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- adapter

const SAFE_ARG = /^[A-Za-z0-9._:/@,()*-]+$/;

export function createDeepseekHarness(spec: DeepseekHarnessSpec): RuntimeAdapter {
  const sshHost = spec.sshHost?.trim() ?? "";
  if (sshHost && !/^[A-Za-z0-9._@-]+$/.test(sshHost)) throw new Error(`runtime ${spec.name}: ssh host is not a host name: ${sshHost}`);
  const bin = spec.bin.length ? spec.bin : ["dsh"];
  const profile = spec.profile || DEFAULT_PROFILE;
  const backend: Backend = sshHost ? `ssh:${sshHost}` : "local";
  const localHome = spec.home?.trim() || join(homedir(), ".dsh");
  const env = (base: Record<string, string | undefined>): Record<string, string | undefined> => (spec.home ? { ...base, DSH_HOME: spec.home } : base);

  return {
    name: spec.name,
    kind: "deepseek-harness",
    backend,
    capabilities: { complete: true, agent: true, chat: true },

    async complete(input, signal) {
      if (input.files?.length) return { ok: false, error: "files need a runtime with a Read tool; dsh has none", backend };
      const foreign = input.tools.filter((t) => !WEB_TOOLS.has(t));
      if (foreign.length) return { ok: false, error: `tools not available on this runtime: ${foreign.join(", ")}`, backend };
      const patch = buildPatch({ system: input.system, model: input.model, thinking: input.thinking, leanTools: input.tools });
      if (sshHost) {
        const words = [...bin, "--profile", profile];
        const bad = words.find((w) => !SAFE_ARG.test(w));
        if (bad) return { ok: false, error: `argument not allowed over ssh: ${bad}`, backend };
        const b64 = Buffer.from(patch, "utf8").toString("base64");
        const home = spec.home ? `DSH_HOME=${JSON.stringify(spec.home)} ` : "";
        // The overlay lands in a temp file on the remote machine for the run and is removed after it.
        const command = `f=$(mktemp) && printf %s ${b64} | base64 -d > "$f" && ${home}${words.join(" ")} --patch "$f" --json -; s=$?; rm -f "$f"; exit $s`;
        return runCompletion(["ssh", "-o", "BatchMode=yes", sshHost, `bash -lc '${command.replace(/'/g, "'\\''")}'`], input, backend, process.env, signal);
      }
      return withPatchFile(patch, (file) => runCompletion([...bin, "--profile", profile, "--patch", file, "--json", "-"], input, "local", env(process.env), signal));
    },

    async runAgent(run) {
      const patch = run.model ? buildPatch({ model: run.model }) : undefined;
      const go = async (file?: string): Promise<AgentOutcome> => {
        const cmd = [...bin, "--profile", profile, ...(file ? ["--patch", file] : []), "--json", "-"];
        const r = await spawnCollect(cmd, { cwd: run.cwd, env: env(run.env), stdin: run.prompt, signal: run.signal });
        const output = joinOutput(r.stdout, r.stderr);
        if (r.timedOut || r.aborted) return { ok: false, error: "timed out", output, timedOut: true, backend: "local" };
        const parsed = parseEvents(r.stdout);
        const base = { output, usage: parsed.usage, costUsd: parsed.usage && run.model ? dshCost(splitModel(run.model).model, parsed.usage) : parsed.usage ? dshCost("deepseek-flash", parsed.usage) : undefined, timedOut: false, backend: "local" as Backend };
        if (r.code !== 0) return { ok: false, error: parsed.error ?? `exit code ${r.code}`, ...base };
        if (parsed.error) return { ok: false, error: parsed.error, ...base };
        return { ok: true, text: parsed.text, ...base };
      };
      return patch ? withPatchFile(patch, go) : go();
    },

    chat(turn, cb) {
      const patch = buildPatch({ persona: turn.systemPrompt, model: turn.model });
      return chatStream(bin, profile, patch, turn, cb, env(turn.env ?? process.env));
    },

    transcript: (cwd, sid) => readDshTranscript(localHome, cwd, sid),
  };
}

async function withPatchFile<T>(patch: string, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "space-dsh-"));
  const file = join(dir, "patch.yml");
  await writeFile(file, patch, { mode: 0o600 });
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCompletion(cmd: string[], input: CompleteInput, backend: Backend, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<CompleteOutcome> {
  let r: Awaited<ReturnType<typeof spawnCollect>>;
  try {
    r = await spawnCollect(cmd, { env, stdin: input.prompt, signal, timeoutMs: input.timeoutMs });
  } catch (e) {
    return { ok: false, error: `could not start ${cmd[0]}: ${(e as Error).message}`, backend };
  }
  if (r.timedOut) return { ok: false, error: `timed out after ${Math.round(input.timeoutMs / 1000)}s`, backend };
  if (r.aborted) return { ok: false, error: "aborted", backend };
  const parsed = parseEvents(r.stdout);
  const costUsd = parsed.usage ? dshCost(splitModel(input.model).model, parsed.usage) : undefined;
  if (r.code !== 0) return { ok: false, error: (parsed.error ?? r.stderr.trim() ?? `exited with ${r.code}`).slice(-800) || `exited with ${r.code}`, usage: parsed.usage, costUsd, backend };
  if (parsed.error) return { ok: false, error: parsed.error, usage: parsed.usage, costUsd, backend };
  if (!parsed.final) return { ok: false, error: (r.stderr.trim() || "no answer").slice(-800), usage: parsed.usage, costUsd, backend };
  if (!parsed.text) return { ok: false, error: "empty answer", usage: parsed.usage, costUsd, backend };
  return { ok: true, text: parsed.text, usage: parsed.usage, costUsd, backend };
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
}

// ---------------------------------------------------------------- chat

/**
 * The panel speaks Claude Code's `stream-json`; each harness event becomes the
 * nearest of those: `session` → `system/init` with the session id, `text` →
 * an assistant message, `tool_call` → an assistant `tool_use` block, a failed
 * `tool_result` → a user `tool_result` block flagged `is_error`, `final` →
 * `result`. Thinking is not shown.
 */
export function translateEvent(line: string, state: { sid?: string; failed?: string }): string[] {
  const ev = parseLine(line);
  if (!ev) return [];
  switch (ev.type) {
    case "session":
      state.sid = ev.sessionId;
      return [JSON.stringify({ type: "system", subtype: "init", session_id: ev.sessionId, cwd: ev.cwd })];
    case "text":
      return ev.text ? [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: ev.text }] } })] : [];
    case "tool_call":
      return [JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: ev.callId, name: ev.tool, input: ev.input ?? {} }] } })];
    case "tool_result":
      return ev.status === "error" ? [JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: ev.callId, is_error: true, content: ev.result ?? "" }] } })] : [];
    case "status":
      if (ev.phase === "turn_end" && ev.reason?.kind && ev.reason.kind !== "completed") state.failed = ev.reason.error?.message ?? `turn ended: ${ev.reason.kind}`;
      return [];
    case "error":
      state.failed = ev.message ?? "the runtime reported an error";
      return [JSON.stringify({ type: "result", session_id: state.sid, is_error: true, result: state.failed })];
    case "final":
      return [JSON.stringify({ type: "result", session_id: state.sid, is_error: Boolean(state.failed), result: state.failed ?? ev.text ?? "" })];
    default:
      return [];
  }
}

function chatStream(bin: string[], profile: string, patch: string, t: ChatTurn, cb: ChatCallbacks, env: Record<string, string | undefined>): { kill: () => void } {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let killed = false;
  let dir: string | undefined;
  const cleanup = async () => {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  };
  void (async () => {
    try {
      dir = await mkdtemp(join(tmpdir(), "space-dsh-"));
      const file = join(dir, "patch.yml");
      await writeFile(file, patch, { mode: 0o600 });
      if (killed) return cb.onFinish("aborted");
      const args = [...bin, "--profile", profile, "--patch", file, "--json", ...(t.sessionId ? ["--session-id", t.sessionId] : []), t.message];
      proc = Bun.spawn(args, { cwd: t.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      await cleanup();
      return cb.onFinish(`could not start the runtime: ${(e as Error).message}`);
    }
    const state: { sid?: string; failed?: string } = {};
    const stderr = new Response(proc.stderr).text();
    await pumpLines(proc.stdout, (line) => {
      const before = state.sid;
      for (const out of translateEvent(line, state)) cb.onEvent(out);
      if (!before && state.sid && cb.onSession) cb.onSession(state.sid);
    }).catch(() => {});
    const code = await proc.exited;
    const err = (await stderr).trim();
    await cleanup();
    cb.onFinish(code === 0 ? null : (state.failed ?? err ?? `runtime exited with ${code}`).slice(-800) || `runtime exited with ${code}`);
  })();
  return {
    kill: () => {
      killed = true;
      proc?.kill();
    },
  };
}
