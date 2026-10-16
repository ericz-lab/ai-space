import type { Action, ActionInput, RunResult } from "../space/shortcuts/types.ts";
import type { Lang } from "./i18n.ts";
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
