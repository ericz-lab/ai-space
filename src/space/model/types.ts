import type { Backend, CompleteInput, CompleteOutcome, CompletionMode, ImageInput, ImageOutcome, Usage } from "../runtimes/types.ts";
import type { FailureKind } from "./failure.ts";

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
/** A request for pictures, after validation; `model` as for a run. */
export type ImageRunInput = ImageInput;
export type ImageRunOutcome = ImageOutcome;

export const APP_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
/**
 * A model alias or id as a runtime names it, optionally prefixed `runtime/` or `machine:runtime/`
 * (docs/model-machines.md); also safe inside a shell command. A colon after the `/` is the
 * runtime's own (DeepSeek's `provider:model`).
 */
export const MODEL_PATTERN = /^(?:(?:[a-z0-9][a-z0-9._-]{0,63}:)?[a-z][a-z0-9-]{0,31}\/)?[a-z0-9][a-z0-9._:-]{0,63}$/i;
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
/** An image call: the runtime's image tool takes minutes, not seconds. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 10 * 60_000;
export const MAX_IMAGE_PROMPT_CHARS = 32_000;
export const DEFAULT_IMAGE_SYSTEM = "You create or edit images for an application with the image generation tool. Produce exactly the images the request asks for, using the attached images as the request says, then reply with one short line describing what you made.";

/**
 * Why a row exists: an app's request, the scheduler running an agent task, an import of an app's
 * own history, or a call another space forwarded here (`peer`, docs/model-machines.md#ledger).
 */
export type Origin = "run" | "task" | "import" | "peer";

export type CallStatus = "ok" | "error";

/** One row of the ledger. Token counts are absent when the backend reported none; nothing is estimated. */
export type ModelCall = {
  id: number;
  app: string;
  tag: string;
  model: string;
  /** Which configured runtime ran it; absent on rows written before runtimes were named and on imported rows. */
  runtime?: string;
  /** The machine that ran it when not this one (a peer or a `machines:` name); absent for this machine. */
  machine?: string;
  /** Absent for legacy, imported, or agent/chat records. */
  mode?: CompletionMode;
  /** Which layer chose the model (app-models.ts `ModelSource`); absent on rows before layers were recorded, imports and agent tasks. */
  modelSource?: string;
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
  /** The first choice, `[machine:]runtime/model`, when another candidate of its fallback list answered. */
  fallbackFrom?: string;
  /** How many runtimes were tried; absent on rows that never ran (a refused request, a task, an import). */
  tries?: number;
  /** How the call was placed, when there was more to it than the row says (below). */
  trace?: CallTrace;
};

export type ModelCallInput = Omit<ModelCall, "id">;

/**
 * The decision behind a call (docs/model.md#trace), written where it was made with the values it
 * was made from. Kept only when it says more than the row: a fallback list, a layer skipped, more
 * than one try, or an upstream gateway naming what served it. A row without one ran its first and
 * only candidate: its runtime, machine, model and `modelSource` are the whole story.
 */
export type CallTrace = {
  /** Layers above the one that chose, which named a model this space cannot run. */
  skippedLayers?: { source: string; model: string }[];
  /** The first choice, then its fallback list, in the order they were considered. */
  candidates?: TraceCandidate[];
  /** Each runtime tried, in order. */
  tries: TraceTry[];
  /** Why the chain stopped where it did. */
  stop?: TraceStop;
};

/**
 * `answered`: a try succeeded. `not-switched`: the failure was not one a call moves on for (auth,
 * a bad request, a timeout). `streamed`: output had reached the caller. `no-time`: the request's
 * timeout was spent. `exhausted`: every candidate failed. `aborted`: the caller went away.
 */
export const TRACE_STOPS = ["answered", "not-switched", "streamed", "no-time", "exhausted", "aborted"] as const;
export type TraceStop = (typeof TRACE_STOPS)[number];

export type TraceCandidate = {
  /** As configured: `[machine:]runtime/tier`, or the request's own model for the first choice. */
  model: string;
  /** Put after the others before anything was tried, and why; never dropped. */
  later?: "resting" | "signed-out" | "unreachable" | "not-installed";
  restKind?: FailureKind;
  until?: string;
  /** Not tried at all: it cannot take this call, or names nothing this space knows. */
  skipped?: string;
};

export type TraceTry = {
  runtime: string;
  machine?: string;
  /** The model as that runtime was asked (a tier resolved here, or a peer's tier). */
  model: string;
  ok: boolean;
  error?: string;
  kind?: FailureKind;
  ms: number;
  /** Output had reached the caller when it failed, so the call could not move on. */
  streamed?: boolean;
  /** What an upstream gateway said answered it (magpie's `provider/model`). */
  served?: string;
};

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
