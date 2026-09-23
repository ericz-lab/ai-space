import type { AgentInfo } from "./api.ts";

export type QueuedChatTurn = { message: string; model?: string; permissionMode?: string };

/** Capture the visible controls at send time, before React commits conversation metadata. */
export function queuedChatTurn(agent: Pick<AgentInfo, "app" | "name">, message: string, appModel: string, baseModel: string, permissionMode: string): QueuedChatTurn {
  const isBase = agent.app === "space" && agent.name === "assistant";
  return { message, model: (isBase ? baseModel : appModel) || undefined, permissionMode: permissionMode || undefined };
}
