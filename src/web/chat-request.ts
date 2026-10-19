import type { ChatImage } from "./chat-images.ts";
import type { AgentInfo } from "./api.ts";

export type QueuedChatTurn = { message: string; images?: ChatImage[]; model?: string; permissionMode?: string; intentId?: string; timezone?: string; interactive?: boolean };

/**
 * Capture the visible controls at send time, before React commits conversation metadata.
 * Space Assistant, and every agent that advertises runtime/tier options, sends its own runtime/tier pick;
 * an agent of an older peer without options sends the shared Claude model pick.
 * The panel answers approvals and adds messages to a running turn, so every turn is interactive
 * (docs/runtimes.md#live-chat); a runtime without live chat ignores the flag.
 */
export function queuedChatTurn(agent: Pick<AgentInfo, "app" | "name" | "modelOptions">, message: string, appModel: string, runtimeModel: string, permissionMode: string, context?: { intentId: string; timezone: string }): QueuedChatTurn {
  const picksRuntime = (agent.app === "space" && agent.name === "assistant") || !!agent.modelOptions;
  return { message, ...(context ?? {}), model: (picksRuntime ? runtimeModel : appModel) || undefined, permissionMode: permissionMode || undefined, interactive: true };
}
