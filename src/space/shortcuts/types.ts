/**
 * Shortcuts and universal search (docs/shortcuts.md): the data model.
 *
 * An action is one operation the operator can run from the command box or the
 * Shortcuts panel: a built-in (calculator, currency conversion, running a task)
 * or an app capability that opts in with an `action:` block under `provides:`.
 * A run is one submitted execution with its arguments, resolved time context,
 * status and result, kept in space.db so it survives closing the page.
 */

/** What an action does to the world: `read` runs on Enter; `write` and `run` need an explicit Create / Run. */
export const EFFECTS = ["read", "write", "run"] as const;
export type Effect = (typeof EFFECTS)[number];

/** The result card an action fills: a list (news, calendar entries), a creation receipt, or one value. */
export const RESULT_KINDS = ["list", "receipt", "value"] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

/**
 * The phase-1 template slots. An app action names the slot it fills with `template:`; a slot with no
 * provider still shows in the catalogue, unavailable, with the dependency it is missing.
 */
export const TEMPLATES = ["calc", "convert", "run-task", "news", "calendar", "todo"] as const;
export type Template = (typeof TEMPLATES)[number];
/** The result kind each app-provided slot requires. */
export const TEMPLATE_RESULTS: Partial<Record<Template, ResultKind>> = { news: "list", calendar: "list", todo: "receipt" };

/**
 * Input types. `date` is a calendar date (`YYYY-MM-DD`, or `today` / `tomorrow` / `yesterday`), `time`
 * a local wall-clock `HH:MM`, `period` a date range sent as `{ from, to }` (inclusive dates; `today`,
 * `tomorrow`, `this-week`, `next-week`, `this-month`, `last-7-days`, or `YYYY-MM-DD..YYYY-MM-DD`).
 * Relative values resolve when the run executes, in the run's timezone.
 */
export const INPUT_TYPES = ["text", "number", "date", "time", "period", "choice", "task"] as const;
export type InputType = (typeof INPUT_TYPES)[number];
export const PERIODS = ["today", "tomorrow", "this-week", "next-week", "this-month", "last-7-days"] as const;
export const RELATIVE_DATES = ["today", "tomorrow", "yesterday"] as const;

export type ActionOption = { value: string; label: string };

export type ActionInput = {
  name: string;
  type: InputType;
  label: string;
  required?: boolean;
  /** Filled in when the form opens; a relative date or period stays relative until the run. */
  default?: string | number;
  /** `choice`: the values offered. */
  options?: ActionOption[];
  /** `number`: bounds. */
  min?: number;
  max?: number;
  /** The command box puts the text typed after the action's keyword here. */
  query?: boolean;
};

/** Display text in another language: the action's, its inputs' labels and its options' labels by value. */
export type ActionI18n = Record<string, { title?: string; description?: string; keywords?: string[]; inputs?: Record<string, string>; options?: Record<string, string> }>;

/** `provides.<capability>.action` in space.yaml. */
export type ActionSpec = {
  title: string;
  description?: string;
  keywords: string[];
  effect: Effect;
  /** An app action answers list, receipt or value; the built-in task runner answers a task card. */
  result: ResultKind | "task";
  template?: Template;
  /** write: the provider answers a repeated `idempotencyKey` with the first result, so a retry never duplicates. */
  idempotent?: boolean;
  inputs: ActionInput[];
  i18n?: ActionI18n;
};

/** One entry of the catalogue, as the API returns it. */
export type Action = ActionSpec & {
  /** `space/<name>` for a built-in, `<app>/<capability>` for an app's. */
  id: string;
  /** The peer that provides it; absent here. */
  peer?: string;
  /** Built-ins are `space`. */
  app: string;
  builtin: boolean;
  /** False when it cannot run now; `reason` says what is missing. */
  available: boolean;
  reason?: string;
};

export type RunStatus = "running" | "ok" | "error" | "unknown";

export type ListItem = { title: string; url?: string; source?: string; at?: string; date?: string; time?: string; timezone?: string; detail?: string; tag?: string };
export type ReceiptItem = { id: string; title: string; url?: string; detail?: string };

export type RunResult =
  | { kind: "list"; items: ListItem[]; asOf?: string; total?: number }
  | { kind: "receipt"; items: ReceiptItem[] }
  | { kind: "value"; value: string | number; text: string; unit?: string; detail?: string; source?: string; asOf?: string; stale?: boolean }
  | { kind: "task"; taskId: string; task: string; startedAt: string; runId?: number; status: "running" | "ok" | "error"; error?: string; output?: string };

export type Run = {
  id: number;
  /** The client's id for one submission; a second POST with it answers the first run. */
  requestId: string;
  action: string;
  peer?: string;
  title: string;
  effect: Effect;
  /** What was submitted, relative values as typed. */
  args: Record<string, unknown>;
  /** What was sent: relative dates and periods resolved, in `timezone`. */
  resolved?: Record<string, unknown>;
  timezone?: string;
  status: RunStatus;
  result?: RunResult;
  error?: string;
  /** Sent with a write to an idempotent provider, and again on a retry. */
  idempotencyKey?: string;
  attempts: number;
  /** The bus call record of the last attempt. */
  callId?: number;
  /** run-task: the scheduler task and the start of its run. */
  taskId?: string;
  taskStartedAt?: number;
  createdAt: number;
  endedAt?: number;
};

export const MAX_RUNS = 500;
export const MAX_ITEMS = 100;
