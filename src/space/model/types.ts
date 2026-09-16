/**
 * Data model of the model service: what an app asks for, what one call
 * produced, and the ledger row every call leaves behind.
 */

export const APP_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
/** A model alias or id as `claude --model` accepts it; also safe inside a shell command. */
export const MODEL_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
/** A tag names the purpose of a call inside an app (translate, story, digest). */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Tool names as `--allowedTools` takes them: bare (WebSearch) or with a matcher (Bash(git:*)). */
export const TOOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\([^,\s()]{1,120}\))?$/;

export const DEFAULT_MODEL = "sonnet";
/**
 * The system prompt when a request brings none. A `claude -p` run without
 * `--system-prompt` carries Claude Code's own system prompt (rules, tool
 * descriptions, the machine's CLAUDE.md files), around twenty thousand tokens
 * per call; naming one replaces all of it.
 */
export const DEFAULT_SYSTEM = "You answer one request from an application. Reply with exactly what it asks for and nothing else.";
export const MAX_SYSTEM_CHARS = 20_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_PROMPT_CHARS = 2_000_000;

/** What a call asks for, after validation. */
export type RunInput = {
  prompt: string;
  /** Replaces the runtime's own system prompt; `DEFAULT_SYSTEM` when the request brings none. */
  system: string;
  model: string;
  /** Purpose of the call inside the app; `other` when not given. */
  tag: string;
  /** Tools the CLI may use (`--allowedTools`); none by default. */
  tools: string[];
  timeoutMs: number;
  /** Output cap on the API backend; the CLI has none. */
  maxTokens: number;
};

export type Usage = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

/** Where a call ran: the machine's own `claude`, one reached over ssh, or the HTTP API. */
export type Backend = "local" | `ssh:${string}` | "api";

export type RunOutcome =
  | { ok: true; text: string; usage?: Usage; costUsd?: number; backend: Backend }
  | { ok: false; error: string; usage?: Usage; costUsd?: number; backend: Backend };

/** Why a call happened: an app's request, or the scheduler running an agent task. */
export type Origin = "run" | "task";

export type CallStatus = "ok" | "error";

/** One row of the ledger. Token counts are absent when the backend reported none; nothing is estimated. */
export type ModelCall = {
  id: number;
  app: string;
  tag: string;
  model: string;
  backend: string;
  origin: Origin;
  status: CallStatus;
  error?: string;
  startedAt: number;
  durationMs: number;
  promptChars: number;
  outputChars?: number;
  usage?: Usage;
  costUsd?: number;
};

export type ModelCallInput = Omit<ModelCall, "id">;

/** Sums over a set of calls. */
export type UsageTotals = {
  calls: number;
  errors: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  /** All four token kinds added up. */
  tokens: number;
  costUsd: number;
  durationMs: number;
};

export const WINDOWS = ["5h", "24h", "7d", "30d"] as const;
export type Window = (typeof WINDOWS)[number];
export const WINDOW_MS: Record<Window, number> = { "5h": 5 * 3600_000, "24h": 24 * 3600_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000 };
