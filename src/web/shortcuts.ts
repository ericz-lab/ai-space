import type { Action, ActionInput, RunResult } from "../space/shortcuts/types.ts";
import type { Lang } from "./i18n.ts";
import type { Intent } from "../space/shortcuts/resolve.ts";
export { actionKey, intents, complete, fill, extractWhen, parseConversion, captureInput, type Intent } from "../space/shortcuts/resolve.ts";

export type { Action, ActionInput, RunResult };

/** A run as `/api/shortcuts/runs` returns it. */
export type RunView = {
  id: number;
  requestId: string;
  action: string;
  peer?: string;
  title: string;
  effect: Action["effect"];
  args: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  timezone?: string;
  status: "running" | "ok" | "error" | "unknown";
  result?: RunResult;
  error?: string;
  attempts: number;
  createdAt: string;
  endedAt?: string;
};

/** The operator's zone, sent with every run: relative dates resolve in it, never in the server's. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** The action's display text in `lang`, with its inputs' and options' labels. */
export function actionText(a: Action, lang: Lang): { title: string; description?: string; input: (i: ActionInput) => string; option: (value: string, fallback: string) => string } {
  const tr = a.i18n?.[lang] ?? Object.entries(a.i18n ?? {}).find(([tag]) => tag.split("-")[0] === lang)?.[1];
  const description = tr?.description ?? a.description;
  return {
    title: tr?.title ?? a.title,
    ...(description ? { description } : {}),
    input: (i) => tr?.inputs?.[i.name] ?? i.label,
    option: (value, fallback) => tr?.options?.[value] ?? fallback,
  };
}

/** A fresh id for one submission; the server answers a repeat with the first run. */
export function requestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The Shortcuts page opened on the action a sentence names (`/?page=shortcuts&run=<text>`): what
 * the native clients' command boxes open, the Space having read the text (`POST /api/shortcuts/resolve`).
 */
export const shortcutsRunHref = (text: string) => `/?page=shortcuts&run=${encodeURIComponent(text)}`;

/** The sentence of a `run=` link, at most 4000 characters as the resolver takes; null without one. */
export function runParam(search: string): string | null {
  const text = new URLSearchParams(search).get("run")?.trim();
  return text ? text.slice(0, 4000) : null;
}

type Resolved = { intents: Intent[]; agentIntents?: unknown[]; ambiguous?: boolean };

/**
 * The action and arguments a sentence runs, the way Enter in the command box picks it: arithmetic
 * (the catalogue's calculator), a conversion, or an action named at the start, when the sentence
 * means one thing only, no agent's skill took it, and the action can run here. Null otherwise.
 */
export function intentToRun(r: Resolved, actions: Action[]): { action: Action; args: Record<string, unknown> } | null {
  if (r.ambiguous || (r.agentIntents?.length ?? 0) > 0) return null;
  const first = r.intents[0];
  if (!first) return null;
  if (first.kind === "calc") {
    const calc = actions.find((a) => a.id === "space/calc" && !a.peer && a.available);
    const input = calc?.inputs.find((i) => i.query) ?? calc?.inputs[0];
    return calc && input ? { action: calc, args: { [input.name]: first.expression } } : null;
  }
  if (first.kind === "action" && (!first.strong || first.ambiguous)) return null;
  return first.action.available ? { action: first.action, args: { ...first.args } } : null;
}
