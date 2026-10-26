import type { ChatImage } from "../agents/images.ts";
/**
 * Runtime adapters: the one place ai-space starts an AI runtime, shared by the
 * model service (a one-shot answer), the scheduler (an agent task fed a prompt
 * file) and the panel (a chat turn). Each adapter wraps one runtime kind and
 * says which of the three operations it supports; the registry names the
 * configured runtimes and resolves a `runtime/model` string to one of them.
 *
 * What a runtime is: a coding agent's CLI (Claude Code today, others next)
 * or a bare model API. A CLI runtime carries the machine's own login, so the
 * transport matters: `complete` may borrow another machine's login over ssh,
 * while agent runs and chats need the app directory and run where ai-space
 * runs.
 */

export const RUNTIME_KINDS = ["claude-code", "anthropic-api", "deepseek-harness", "codex-cli"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** A runtime's name in the configuration and in the ledger (`claude`, `api`, `dsh`). */
export const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Where a call ran: the machine's own CLI, one reached over ssh, an HTTP API, or another space reached as a peer. */
export type Backend = "local" | `ssh:${string}` | "api" | `peer:${string}`;

/**
 * A machine's name in a model string (`box:codex/basic`, docs/model-machines.md): a peer
 * (`SPACE_PEER_<NAME>`) or an ssh login under `machines:` in runtimes.yaml.
 */
export const MACHINE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An ssh login that runs this space's runtimes for answers (`machines:` in runtimes.yaml). */
export type MachineSpec = { name: string; ssh: string };

export type Usage = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

/** One request for an answer, after validation (the model service's request body). */
export type CompleteInput = {
  prompt: string;
  /** Omitted preserves legacy behavior; text-only calls default to slim. */
  mode?: CompletionMode;
  /** Custom system instructions replace native base instructions in either mode. */
  system: string;
  /** Model as the runtime names it, without the `runtime/` prefix. */
  model: string;
  /** Purpose of the call inside the app; `other` when not given. */
  tag: string;
  /** Explicit tool selection; slim rejects it, full uses native tools when empty. */
  tools: string[];
  timeoutMs: number;
  /** Output cap where the runtime has one (the API); a CLI has none. */
  maxTokens: number;
  /** Cap on thinking tokens; 0 turns thinking off; absent = the runtime's default. */
  thinking?: number;
  /** Explicit per-request speed tier; currently supported by local Codex streaming only. */
  serviceTier?: "priority" | "default";
  /**
   * Files the model may open (images the chat service stores). `name` is the
   * caller's short file name, unique inside the call and safe for a shell
   * (`a17.png`); `path` is where the bytes are on the machine ai-space runs
   * on. The prompt refers to files by name; the adapter appends where it put
   * them, which may be another machine.
   */
  files?: CompleteFile[];
  /** The app the call is for; a runtime that runs on another space records it there. */
  caller?: string;
};

export const COMPLETION_MODES = ["slim", "full"] as const;
export type CompletionMode = (typeof COMPLETION_MODES)[number];

/** Explicit slim calls never silently acquire tools through attachments. */
export function assertCompletionMode(input: CompleteInput): void {
  if (input.mode !== undefined && !COMPLETION_MODES.includes(input.mode)) throw new Error("mode must be slim or full");
  if (input.mode === "slim" && (input.tools.length || input.files?.length)) throw new Error("slim mode does not support tools or files; use full mode");
}

export type CompleteFile = { name: string; path: string };

/** What a file name handed to a runtime must look like: the chat service generates them. */
export const FILE_NAME_PATTERN = /^[a-z0-9]+\.(png|jpe?g|gif|webp)$/;

/** Text of the answer as it is produced; a runtime that cannot stream never calls it and the caller gets the whole answer at the end. */
export type OnDelta = (text: string) => void;

/** `model`: the concrete model, when another space resolved the tier (a peer runtime). */
export type CompleteOutcome =
  | { ok: true; text: string; usage?: Usage; costUsd?: number; backend: Backend; model?: string }
  | { ok: false; error: string; usage?: Usage; costUsd?: number; backend: Backend; model?: string };

/** Write authorisation tiers a chat turn or an agent task may ask for; absent means read-only (the headless default). */
export const PERMISSION_MODES = ["acceptEdits", "bypassPermissions", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** An agent task: the prompt on stdin, the runtime's own tools, inside the app directory. */
export type AgentRun = {
  prompt: string;
  cwd: string;
  env: Record<string, string | undefined>;
  model?: string;
  /** Write tier from the task's manifest; a runtime that cannot honour it refuses the run. */
  permissionMode?: PermissionMode;
  /** Tools the run may use without asking, from the task's manifest. */
  allowedTools?: string[];
  signal: AbortSignal;
};

/**
 * What an agent run produced. `output` is the process's whole stdout and
 * stderr for the run record; `text` the final answer when the runtime
 * reported one apart from its logs. A run the signal stopped is `timedOut`.
 */
export type AgentOutcome = {
  ok: boolean;
  error?: string;
  output: string;
  text?: string;
  usage?: Usage;
  costUsd?: number;
  timedOut: boolean;
  backend: Backend;
};

/** One turn of a conversation, decided by the caller from the manifest, never by the browser. */
export type ChatTurn = {
  message: string;
  images?: ChatImage[];
  model?: string;
  sessionId?: string;
  /** Write authorisation tier; anything else means read-only (the headless default). */
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /**
   * The client answers approvals and may add messages while the turn runs: the turn goes to a
   * process the runtime keeps for the conversation (docs/runtimes.md#live-chat). A runtime
   * without live chat ignores it and runs the turn as usual.
   */
  interactive?: boolean;
};

/** A message the person adds to a running turn. */
export type SteerInput = { message: string; images?: ChatImage[] };

/** The person's answer to an approval request: run the action once, or refuse it. */
export const APPROVAL_DECISIONS = ["allow", "deny"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * A question the agent asks the person while its turn runs (an `approval_request` whose `tool` is
 * `AskUserQuestion`). The person picks options or types an answer of their own.
 */
export type AgentQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[]; multiSelect: boolean };

/** Answers to an agent's questions: question id → the chosen labels or the typed text. */
export type QuestionAnswers = Record<string, string[]>;

/**
 * A running chat turn. `kill` ends it: a one-shot turn's process is killed, a live turn is
 * interrupted and its process kept for the next one. Live turns also take messages and answers.
 */
export type ChatHandle = {
  kill: () => void;
  /** Hand a message to the running turn; rejects when the turn cannot take one now. */
  steer?: (input: SteerInput) => Promise<void>;
  /**
   * Answer an approval request (`approval_request` event); false for an unknown or settled one.
   * A question is answered with `allow` and its `answers`; `deny`, or `allow` without answers, skips it.
   */
  respond?: (id: string, decision: ApprovalDecision, answers?: QuestionAnswers) => boolean;
};

export type ChatCallbacks = {
  /** A raw event line of the runtime's own stream format, forwarded to the client as is. */
  onEvent: (line: string) => void;
  /** First event carrying a session id. */
  onSession?: (sid: string) => void;
  /** Process ended; `error` is null on a clean exit. */
  onFinish: (error: string | null) => void;
};

export type Capabilities = {
  complete: boolean;
  agent: boolean;
  chat: boolean;
  /** Makes pictures: `image` below. Absent means no. */
  image?: boolean;
};

/**
 * One request for pictures: create from the prompt, or edit the `files` it
 * names (`img1.png`, …, as for an answer). The runtime returns the image
 * bytes it produced; the text is its one-line account of them.
 */
export type ImageInput = {
  prompt: string;
  system: string;
  /** Model as the runtime names it; it drives the runtime's own image tool. */
  model: string;
  tag: string;
  files: CompleteFile[];
  timeoutMs: number;
  /** The app the call is for, as for `CompleteInput`. */
  caller?: string;
};

export type GeneratedImage = { type: string; bytes: Uint8Array };

export type ImageOutcome =
  | { ok: true; text: string; images: GeneratedImage[]; usage?: Usage; costUsd?: number; backend: Backend; model?: string }
  | { ok: false; error: string; usage?: Usage; costUsd?: number; backend: Backend; model?: string };

/**
 * A past conversation as the chat panel shows it: the user's texts and the assistant's, with the
 * tools it called. `steps` holds the assistant's text and tool calls in the order they happened,
 * with each call's input and output, where the runtime's records have them.
 */
export type TranscriptMessage = { role: "user"; text: string } | { role: "ai"; text: string; tools: { name: string; hint: string }[]; steps?: TranscriptStep[] };

export type TranscriptStep = { kind: "text"; text: string } | { kind: "tool"; name: string; input: string; output: string; failed: boolean };

export type RuntimeAdapter = {
  readonly name: string;
  readonly kind: RuntimeKind;
  /** Where `complete` runs; the status view and the log line show it. */
  readonly backend: Backend;
  /** The machine `complete` runs on when it is not this one (a peer or a `machines:` entry); the ledger's `machine`. */
  readonly machine?: string;
  readonly capabilities: Capabilities;
  complete(input: CompleteInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<CompleteOutcome>;
  runAgent(run: AgentRun): Promise<AgentOutcome>;
  /**
   * Spawn one turn and forward its events line by line. The lines are Claude
   * Code's `stream-json` shapes, which the panel reads; another runtime's
   * adapter translates its own events into them. Returns a handle to kill it, and for an
   * interactive turn on a runtime with live chat, to steer it and answer its approvals.
   */
  chat(turn: ChatTurn, cb: ChatCallbacks): ChatHandle;
  /** Close the processes live chat keeps between turns (service shutdown). */
  closeLive?(): void;
  /** Pictures from a prompt and optional input images; only a runtime whose capabilities say `image`. */
  image?(input: ImageInput, signal?: AbortSignal): Promise<ImageOutcome>;
  /** A past chat session from the runtime's own records; null when it has none. */
  transcript?(cwd: string, sessionId: string): Promise<TranscriptMessage[] | null>;
};

// ---------------------------------------------------------------- specs

/** Claude Code: `claude -p` for answers and agent runs, `stream-json` for chat. */
export type ClaudeCodeSpec = {
  name: string;
  kind: "claude-code";
  /** The CLI command; default `claude`. */
  bin: string[];
  /** Machine whose login `complete` borrows over ssh; agent runs and chats stay local. */
  sshHost?: string;
  /** Extra arguments appended to every chat turn (a permission wrapper, say). */
  chatArgs: string[];
  /** Home directory whose `.claude/projects` holds the transcripts; default the process's (tests). */
  transcriptHome?: string;
};

/** The Messages API with a key: answers only, no tools, no login state. */
export type AnthropicApiSpec = {
  name: string;
  kind: "anthropic-api";
  apiKey: string;
  apiUrl: string;
};

/**
 * DeepSeek Harness (`dsh`): `dsh --profile headless --json` for answers and
 * agent runs, `dsh --profile acp` (Agent Client Protocol over stdio) for live
 * chat, a `--patch` overlay per run for the system prompt, model, thinking and
 * tool set. Billed by the DeepSeek API key the harness home holds, or by the
 * harness's signed-in account when `provider` names `deepseek-account`.
 */
export type DeepseekHarnessSpec = {
  name: string;
  kind: "deepseek-harness";
  /** The CLI command; default `dsh`. */
  bin: string[];
  /** The harness home (`DSH_HOME`); default the CLI's own (`~/.dsh`). Session logs are read from it. */
  home?: string;
  /** Profile for answers and agent runs; default `headless`. */
  profile: string;
  /** Profile for live chat; default `acp` (the harness's Agent Client Protocol app). */
  liveProfile?: string;
  /**
   * Provider route for a model without `provider:model`; default
   * `deepseek-official`. `deepseek-account` uses the harness's signed-in
   * account and needs no API key.
   */
  provider?: string;
  /** Machine whose harness `complete` uses over ssh; agent runs and chats stay local. */
  sshHost?: string;
};

/** Codex CLI: slim/full completions and persistent local chat using the CLI's saved login. */
export type CodexCliSpec = {
  name: string;
  kind: "codex-cli";
  bin: string[];
  sshHost?: string;
  /** Local, tool-free slim completions may use app-server text deltas. */
  streamCompletions?: boolean;
};

export const MODEL_TIERS = ["basic", "junior", "intermediate", "advanced"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export type TierModels = Partial<Record<ModelTier, string>>;

export type RuntimeSpec = (ClaudeCodeSpec | AnthropicApiSpec | DeepseekHarnessSpec | CodexCliSpec) & { models?: TierModels };

export type RuntimesConfig = {
  /**
   * Runtime a bare model name (no `runtime/` prefix) goes to. Absent (a runtimes.yaml without
   * `default`, as the Local edition writes it): there is none, and every model must name its runtime.
   */
  default?: string;
  runtimes: RuntimeSpec[];
  /** ssh logins that answer as `<machine>:<runtime>/<model>`; empty when absent. */
  machines?: MachineSpec[];
};

/** Not supported by this runtime: the operation names what was asked. */
export class Unsupported extends Error {
  constructor(runtime: string, operation: string) {
    super(`runtime ${runtime} does not support ${operation}`);
  }
}
