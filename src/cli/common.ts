import { parseArgs } from "./args.ts";
import type { Client } from "./client.ts";
import { type Ctx, UsageError } from "./types.ts";

/** What several nouns share: task lookup, schedule text, JSON bodies, questions. */

export type TaskView = {
  id: string;
  app: string;
  name: string;
  description?: string;
  source: string;
  orphaned: boolean;
  enabled: boolean;
  schedule: { kind: "manual" } | { kind: "at"; at: string } | { kind: "every"; everyMs: number } | { kind: "cron"; expr: string; tz?: string };
  target: { kind: string } & Record<string, unknown>;
  timeoutMs?: number;
  triggers: { event: string }[];
  state: { nextRunAt?: string; runningAt?: string; lastRunAt?: string; lastStatus?: string; lastError?: string; lastDurationMs?: number; consecutiveErrors: number };
};

export type RunView = { id: number; taskId: string; startedAt: number | string; endedAt: number | string; status: string; error?: string; output?: string; trigger: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listTasks(client: Client): Promise<TaskView[]> {
  return (await client.get<{ tasks: TaskView[] }>("/api/tasks")).tasks;
}

/** `<app>/<name>`, a bare name when only one task has it, or an id. */
export async function resolveTask(client: Client, ref: string): Promise<TaskView> {
  if (UUID.test(ref)) return (await client.get<{ task: TaskView }>(`/api/tasks/${ref}`)).task;
  const tasks = await listTasks(client);
  const slash = ref.indexOf("/");
  const matches = slash >= 0 ? tasks.filter((t) => t.app === ref.slice(0, slash) && t.name === ref.slice(slash + 1)) : tasks.filter((t) => t.name === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new UsageError(`unknown task: ${ref} (space task ls)`);
  throw new UsageError(`${ref} names ${matches.length} tasks: ${matches.map((t) => `${t.app}/${t.name}`).join(", ")}`);
}

export function taskRef(t: { app: string; name: string }): string {
  return `${t.app}/${t.name}`;
}

export function scheduleText(s: TaskView["schedule"] | undefined): string {
  if (!s) return "";
  switch (s.kind) {
    case "manual":
      return "manual";
    case "at":
      return `at ${s.at}`;
    case "every":
      return `every ${everyText(s.everyMs)}`;
    case "cron":
      return `cron ${s.expr}${s.tz ? ` ${s.tz}` : ""}`;
  }
}

export function everyText(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3600_000 === 0) return `${ms / 3600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

export function targetText(t: TaskView["target"]): string {
  switch (t.kind) {
    case "http":
      return `http ${String(t.method ?? "GET")} ${String(t.url ?? "")}`;
    case "command":
      return `command ${String(t.command ?? "")}`;
    case "agent":
      return `agent ${String(t.runtime ?? t.model ?? "")}`.trim();
    default:
      return t.kind;
  }
}

export function iso(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === "number" ? new Date(v).toISOString() : v;
}

/** A JSON body from the argument, `--json-file`, or stdin when the argument is `-`. */
export async function readBody(ctx: Ctx, argument: string | undefined, file: string | undefined): Promise<unknown> {
  let text: string | undefined;
  if (file) text = await Bun.file(file).text();
  else if (argument === "-") text = await ctx.io.stdin();
  else if (argument !== undefined) text = argument;
  if (text === undefined || !text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new UsageError("the body must be JSON");
  }
}

/** Ask before something that cannot be undone; `--yes` skips it, a pipe cannot answer. */
export async function confirm(ctx: Ctx, yes: boolean | undefined, question: string): Promise<boolean> {
  if (yes) return true;
  if (!ctx.io.isTTY) throw new UsageError(`${question} --yes to proceed without a terminal`);
  const a = (await ctx.io.prompt(`${question} [y/N] `)).trim().toLowerCase();
  return a === "y" || a === "yes";
}

/** The app a command acts as: `--app`, then `SPACE_APP` (set inside a task). */
export function appOf(ctx: Ctx, flag: string | undefined, required = true): string | undefined {
  const app = flag?.trim() || ctx.io.env.SPACE_APP?.trim();
  if (!app && required) throw new UsageError("--app is required (or run inside a task, where SPACE_APP is set)");
  return app || undefined;
}

export { parseArgs };
