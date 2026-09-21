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

export const RUNTIME_KINDS = ["claude-code", "anthropic-api", "deepseek-harness"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

/** A runtime's name in the configuration and in the ledger (`claude`, `api`, `dsh`). */
export const RUNTIME_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Where a call ran: the machine's own CLI, one reached over ssh, or an HTTP API. */
export type Backend = "local" | `ssh:${string}` | "api";

export type Usage = {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
};

/** One request for an answer, after validation (the model service's request body). */
export type CompleteInput = {
  prompt: string;
  /** Replaces the runtime's own system prompt. */
  system: string;
  /** Model as the runtime names it, without the `runtime/` prefix. */
  model: string;
  /** Purpose of the call inside the app; `other` when not given. */
  tag: string;
  /** Tools the runtime may use; none by default. */
  tools: string[];
  timeoutMs: number;
  /** Output cap where the runtime has one (the API); a CLI has none. */
  maxTokens: number;
  /** Cap on thinking tokens; 0 turns thinking off; absent = the runtime's default. */
  thinking?: number;
  /**
   * Files the model may open (images the chat service stores). `name` is the
   * caller's short file name, unique inside the call and safe for a shell
   * (`a17.png`); `path` is where the bytes are on the machine ai-space runs
   * on. The prompt refers to files by name; the adapter appends where it put
   * them, which may be another machine.
   */
  files?: CompleteFile[];
};

export type CompleteFile = { name: string; path: string };

/** What a file name handed to a runtime must look like: the chat service generates them. */
export const FILE_NAME_PATTERN = /^[a-z0-9]+\.(png|jpe?g|gif|webp)$/;

/** Text of the answer as it is produced; a runtime that cannot stream never calls it and the caller gets the whole answer at the end. */
export type OnDelta = (text: string) => void;

export type CompleteOutcome =
  | { ok: true; text: string; usage?: Usage; costUsd?: number; backend: Backend }
  | { ok: false; error: string; usage?: Usage; costUsd?: number; backend: Backend };

/** An agent task: the prompt on stdin, the runtime's own tools, inside the app directory. */
export type AgentRun = {
  prompt: string;
  cwd: string;
  env: Record<string, string | undefined>;
  model?: string;
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
  model?: string;
  sessionId?: string;
  /** Write authorisation tier; anything else means read-only (the headless default). */
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
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
};

/** A past conversation as the chat panel shows it: the user's texts and the assistant's, with the tools it called. */
export type TranscriptMessage = { role: "user"; text: string } | { role: "ai"; text: string; tools: { name: string; hint: string }[] };

export type RuntimeAdapter = {
  readonly name: string;
  readonly kind: RuntimeKind;
  /** Where `complete` runs; the status view and the log line show it. */
  readonly backend: Backend;
  readonly capabilities: Capabilities;
  complete(input: CompleteInput, signal?: AbortSignal, onDelta?: OnDelta): Promise<CompleteOutcome>;
  runAgent(run: AgentRun): Promise<AgentOutcome>;
  /**
   * Spawn one turn and forward its events line by line. The lines are Claude
   * Code's `stream-json` shapes, which the panel reads; another runtime's
   * adapter translates its own events into them. Returns a handle to kill it.
   */
  chat(turn: ChatTurn, cb: ChatCallbacks): { kill: () => void };
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
 * DeepSeek Harness (`dsh`): `dsh --profile headless --json` for all three
 * operations, `--session-id` for chat continuity, a `--patch` overlay per run
 * for the system prompt, model, thinking and tool set. Billed by the DeepSeek
 * API key the harness home holds.
 */
export type DeepseekHarnessSpec = {
  name: string;
  kind: "deepseek-harness";
  /** The CLI command; default `dsh`. */
  bin: string[];
  /** The harness home (`DSH_HOME`); default the CLI's own (`~/.dsh`). Session logs are read from it. */
  home?: string;
  /** Profile to boot; default `headless`. */
  profile: string;
  /** Machine whose harness `complete` uses over ssh; agent runs and chats stay local. */
  sshHost?: string;
};

export type RuntimeSpec = ClaudeCodeSpec | AnthropicApiSpec | DeepseekHarnessSpec;

export type RuntimesConfig = {
  /** Runtime a bare model name (no `runtime/` prefix) goes to. */
  default: string;
  runtimes: RuntimeSpec[];
};

/** Not supported by this runtime: the operation names what was asked. */
export class Unsupported extends Error {
  constructor(runtime: string, operation: string) {
    super(`runtime ${runtime} does not support ${operation}`);
  }
}
