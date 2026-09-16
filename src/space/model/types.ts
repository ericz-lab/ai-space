import type { Backend, CompleteInput, CompleteOutcome, Usage } from "../runtimes/types.ts";

/**
 * Data model of the model service: what an app asks for, what one call
 * produced, and the ledger row every call leaves behind. The request and
 * outcome shapes are the runtime adapters' (`../runtimes/types.ts`); the
 * service adds the ledger.
 */

export type { Backend, Usage };
/** What a call asks for, after validation; `model` may carry a `runtime/` prefix until the service resolves it. */
export type RunInput = CompleteInput;
export type RunOutcome = CompleteOutcome;

export const APP_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
/** A model alias or id as a runtime names it, optionally prefixed `runtime/`; also safe inside a shell command. */
export const MODEL_PATTERN = /^(?:[a-z][a-z0-9-]{0,31}\/)?[a-z0-9][a-z0-9._:-]{0,63}$/i;
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
export const MAX_SYSTEM_CHARS = 200_000;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_MAX_TOKENS = 4096;
export const MAX_THINKING_TOKENS = 128_000;
export const MAX_PROMPT_CHARS = 2_000_000;

/** Why a row exists: an app's request, the scheduler running an agent task, or an import of an app's own history. */
export type Origin = "run" | "task" | "import";

export type CallStatus = "ok" | "error";

/** One row of the ledger. Token counts are absent when the backend reported none; nothing is estimated. */
export type ModelCall = {
  id: number;
  app: string;
  tag: string;
  model: string;
  /** Which configured runtime ran it; absent on rows written before runtimes were named and on imported rows. */
  runtime?: string;
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
