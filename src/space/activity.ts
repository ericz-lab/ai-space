import { isOperator } from "./auth.ts";

/**
 * What the Space is doing right now, so an update can wait for it instead of cutting it off
 * (docs/local.md#updates). A restart drains this work anyway (SIGTERM, SPACE_DRAIN_SECONDS);
 * this lets the one restarting choose a moment when there is nothing to drain.
 *
 *   GET /api/space/activity   owner: { busy, items: [{ kind, label, since? }] }
 */

export type ActivityItem = { kind: "task" | "model" | "agent" | "terminal" | "package"; label: string; since?: number };

export type ActivitySources = {
  tasks?: () => string[];
  modelCalls?: () => { app: string; tag: string; model: string; startedAt: number }[];
  agentTurns?: () => { agent: string; startedAt: number }[];
  terminals?: () => number;
  packageChanges?: () => number;
};

export function activity(s: ActivitySources): { busy: boolean; items: ActivityItem[] } {
  const items: ActivityItem[] = [
    ...(s.tasks?.() ?? []).map((id) => ({ kind: "task" as const, label: id })),
    ...(s.modelCalls?.() ?? []).map((c) => ({ kind: "model" as const, label: `${c.app}/${c.tag} (${c.model})`, since: c.startedAt })),
    ...(s.agentTurns?.() ?? []).map((r) => ({ kind: "agent" as const, label: r.agent, since: r.startedAt })),
  ];
  const terminals = s.terminals?.() ?? 0;
  if (terminals) items.push({ kind: "terminal", label: `${terminals} terminal session${terminals === 1 ? "" : "s"}` });
  const packages = s.packageChanges?.() ?? 0;
  if (packages) items.push({ kind: "package", label: `${packages} app install${packages === 1 ? "" : "s"} or upgrade${packages === 1 ? "" : "s"}` });
  return { busy: items.length > 0, items };
}

export function createActivityRoutes(s: ActivitySources & { token: string }) {
  return {
    "/api/space/activity": {
      GET: (req: Request) => (isOperator(req, s.token) ? Response.json({ ok: true, ...activity(s) }) : Response.json({ ok: false, error: "unauthorized" }, { status: 401 })),
    },
  };
}
