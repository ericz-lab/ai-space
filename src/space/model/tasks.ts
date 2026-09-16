import type { RunResult } from "../scheduler/targets.ts";
import type { Task } from "../scheduler/types.ts";
import type { ModelService } from "./service.ts";

/**
 * Scheduler hook: an agent task spawns `claude -p --output-format json`
 * itself (see scheduler/targets.ts), so its usage reaches the ledger from the
 * run result instead of through `POST /api/model/run`. The row is tagged with
 * the task name and marked `origin: task`; a run that produced no usage (a
 * timeout, a codex runtime, an older CLI) is still recorded as a call so the
 * count is honest, with no token figures.
 */

export type AgentRunRecorder = (task: Task, result: RunResult, startedAt: number, endedAt: number) => void;

export function recordAgentRun(service: ModelService, log: (m: string) => void = (m) => console.log(`[model] ${m}`)): AgentRunRecorder {
  return (task, result, startedAt, endedAt) => {
    if (task.target.kind !== "agent") return;
    try {
      service.record({
        app: task.app,
        tag: task.name,
        model: task.target.model ?? "default",
        backend: `agent:${task.target.runtime}`,
        ok: result.status === "ok",
        error: result.status === "ok" ? undefined : (result.error ?? result.status),
        startedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        promptChars: result.promptChars ?? 0,
        outputChars: result.status === "ok" ? result.output?.length : undefined,
        usage: result.usage,
        costUsd: result.costUsd,
      });
    } catch (e) {
      log(`${task.app}/${task.name}: could not record the agent run: ${(e as Error).message}`);
    }
  };
}
