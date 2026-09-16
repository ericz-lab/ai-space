import { join } from "node:path";
import type { RuntimeRegistry } from "../runtimes/registry.ts";
import { spawnCollect } from "../runtimes/process.ts";
import { eventEnv, eventPayload, eventPromptSection } from "./events.ts";
import type { RunStatus, RunTrigger, SpaceEvent, Target } from "./types.ts";

/**
 * Target runners: turn a task's target into one execution with a timeout.
 *
 * Every runner returns a RunResult and never throws. `output` is truncated so
 * it can be stored with the run record. Command and agent targets run inside
 * the app directory with the app's `.env` merged into the environment.
 *
 * A run started by events carries them: http targets get `event` / `events`
 * merged into a JSON body (and `x-space-trigger` always), commands and agents
 * get `SPACE_TRIGGER`, `SPACE_EVENT`, `SPACE_EVENTS`, and an agent prompt ends
 * with an "Events" section.
 */

export type RunResult = {
  status: RunStatus;
  error?: string;
  output?: string;
  /** Agent targets: what the runtime reported about the model call, for the model ledger. */
  usage?: { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };
  costUsd?: number;
  promptChars?: number;
  /** Agent targets: where the runtime ran (`local`, `ssh:<host>`), for the ledger. */
  backend?: string;
};

export type RunContext = {
  /** App directory; default cwd for command/agent targets and base for prompt paths. */
  appDir?: string;
  /** Extra variables for command/agent targets, layered over the app's `.env` (storage's space.env). */
  env?: Record<string, string>;
  signal: AbortSignal;
  /** Why the run started; default schedule. */
  trigger?: RunTrigger;
  /** Events delivered with this run, oldest first. */
  events?: SpaceEvent[];
  /** The configured runtimes; an agent target names one of them. Absent = agent targets fail. */
  runtimes?: RuntimeRegistry;
};

const MAX_OUTPUT_CHARS = 4000;

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}\n…(${t.length - max} more chars)` : t;
}

export async function runTarget(target: Target, ctx: RunContext): Promise<RunResult> {
  try {
    switch (target.kind) {
      case "http":
        return await runHttp(target, ctx);
      case "command":
        return await runCommand(target, ctx);
      case "agent":
        return await runAgent(target, ctx);
      default:
        return { status: "error", error: `unknown target kind: ${String((target as { kind: unknown }).kind)}` };
    }
  } catch (e) {
    const err = e as Error;
    if (ctx.signal.aborted || err.name === "TimeoutError" || err.name === "AbortError") {
      return { status: "error", error: "timed out" };
    }
    return { status: "error", error: err.message ?? String(e) };
  }
}

// ---------------------------------------------------------------- http

async function runHttp(target: Extract<Target, { kind: "http" }>, ctx: RunContext): Promise<RunResult> {
  const headers: Record<string, string> = { "x-space-trigger": ctx.trigger ?? "schedule" };
  for (const [k, v] of Object.entries(target.headers ?? {})) headers[k] = interpolate(v);
  let body: string | undefined;
  const events = ctx.events ?? [];
  // Events ride along in the JSON body. A string body is the app's own format and is sent as is.
  const merged =
    events.length && target.method !== "GET" && (target.body === undefined || (typeof target.body === "object" && target.body !== null && !Array.isArray(target.body)))
      ? { ...((target.body as Record<string, unknown> | undefined) ?? {}), event: eventPayload(events[events.length - 1]!), events: events.map(eventPayload) }
      : target.body;
  if (merged !== undefined && target.method !== "GET") {
    body = typeof merged === "string" ? interpolate(merged) : JSON.stringify(merged);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(interpolate(target.url), { method: target.method, headers, body, signal: ctx.signal });
  const raw = await res.text();
  const text = truncate(raw);
  if (!res.ok) return { status: "error", error: `HTTP ${res.status}`, output: text };
  // Light protocol: a 2xx JSON body may carry its own verdict, e.g. an app that
  // skipped a round because the previous one is still running.
  const verdict = parseVerdict(raw);
  if (verdict) return { status: verdict.status, error: verdict.error, output: text };
  return { status: "ok", output: text };
}

function parseVerdict(raw: string): { status: RunStatus; error?: string } | undefined {
  try {
    const v = JSON.parse(raw) as { status?: unknown; error?: unknown };
    if (v?.status === "ok" || v?.status === "error" || v?.status === "skipped") {
      return { status: v.status, error: typeof v.error === "string" ? v.error : undefined };
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

// ---------------------------------------------------------------- command / agent

async function runCommand(target: Extract<Target, { kind: "command" }>, ctx: RunContext): Promise<RunResult> {
  const cwd = target.cwd ?? ctx.appDir ?? process.cwd();
  const env = { ...process.env, ...(await loadAppEnv(cwd)), ...(ctx.env ?? {}), ...(target.env ?? {}), ...eventEnv(ctx.trigger ?? "schedule", ctx.events ?? []) };
  // ${VAR} placeholders resolve from the scheduler environment, same as http targets,
  // so machine-specific paths (a venv python, a token) stay out of the manifest.
  const r = await spawnCollect(["sh", "-c", interpolate(target.command)], { cwd, env, signal: ctx.signal });
  const output = truncate(joinOutput(r.stdout, r.stderr));
  if (r.aborted || r.timedOut) return { status: "error", error: "timed out", output };
  if (r.code !== 0) return { status: "error", error: `exit code ${r.code}`, output };
  return { status: "ok", output };
}

/**
 * An agent task runs on the runtime the target names, in the app directory,
 * with the prompt file (plus the events section) on stdin. The runtime's own
 * system prompt and tools apply: this is a coding agent at work, not a
 * one-shot answer. What it reported about the model call travels in the
 * result for the ledger.
 */
async function runAgent(target: Extract<Target, { kind: "agent" }>, ctx: RunContext): Promise<RunResult> {
  const runtime = ctx.runtimes?.get(target.runtime);
  if (!runtime) return { status: "error", error: `runtime ${target.runtime} is not configured` };
  if (!runtime.capabilities.agent) return { status: "error", error: `runtime ${target.runtime} does not run agent tasks` };
  const cwd = target.cwd ?? ctx.appDir ?? process.cwd();
  const promptPath = target.prompt.startsWith("/") ? target.prompt : join(cwd, target.prompt);
  const promptFile = Bun.file(promptPath);
  if (!(await promptFile.exists())) return { status: "error", error: `prompt file not found: ${promptPath}` };
  const prompt = (await promptFile.text()) + (ctx.events?.length ? eventPromptSection(ctx.events) : "");
  const env = { ...process.env, ...(await loadAppEnv(cwd)), ...(ctx.env ?? {}), ...eventEnv(ctx.trigger ?? "schedule", ctx.events ?? []) };
  const r = await runtime.runAgent({ prompt, cwd, env, model: target.model, signal: ctx.signal });
  const base = { promptChars: prompt.length, backend: r.backend, ...(r.usage ? { usage: r.usage } : {}), ...(r.costUsd !== undefined ? { costUsd: r.costUsd } : {}) };
  if (!r.ok) return { status: "error", error: r.error ?? "failed", output: truncate(r.output), ...base };
  return { status: "ok", output: truncate(r.text ?? r.output), ...base };
}

function joinOutput(stdout: string, stderr: string): string {
  return [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
}

// ---------------------------------------------------------------- env helpers

/** Resolve `${VAR}` and `${VAR:-default}` from the scheduler's own environment. */
export function interpolate(text: string, env: Record<string, string | undefined> = process.env): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    throw new Error(`missing environment variable ${name}`);
  });
}

/** Minimal dotenv reader for an app's `.env`; missing file yields {}. */
export async function loadAppEnv(dir: string): Promise<Record<string, string>> {
  const file = Bun.file(join(dir, ".env"));
  if (!(await file.exists())) return {};
  const out: Record<string, string> = {};
  for (const raw of (await file.text()).split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
