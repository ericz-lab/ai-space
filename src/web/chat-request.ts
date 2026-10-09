import type { AgentInfo } from "./api.ts";

export type QueuedChatTurn = { message: string; model?: string; permissionMode?: string };

/**
 * Capture the visible controls at send time, before React commits conversation metadata.
 * Space Assistant, and every agent that advertises runtime/tier options, sends its own runtime/tier pick;
 * an agent of an older peer without options sends the shared Claude model pick.
 */
export function queuedChatTurn(agent: Pick<AgentInfo, "app" | "name" | "modelOptions">, message: string, appModel: string, runtimeModel: string, permissionMode: string): QueuedChatTurn {
  const picksRuntime = (agent.app === "space" && agent.name === "assistant") || !!agent.modelOptions;
  return { message, model: (picksRuntime ? runtimeModel : appModel) || undefined, permissionMode: permissionMode || undefined };
}
