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

/** A member of this Space's team as the chat needs it (docs/orders.md#team). */
export type TeamPermissionMember = { role: string; title: string; i18n?: Record<string, { title: string }>; agent: string; permission: "ask" | "edit" | "full" };

/** The chat's permission menu value of each team setting, the same three tiers (src/space/team/store.ts `PERMISSION_MODE`). */
const TEAM_TO_CHAT: Record<TeamPermissionMember["permission"], string> = { ask: "", edit: "acceptEdits", full: "bypassPermissions" };

/** The team member an agent shown in the chat is: its id here, or `<peer>/<app>/<agent>` for a peer's. */
export function teamMemberOf<M extends Pick<TeamPermissionMember, "agent">>(members: M[] | null | undefined, agent: Pick<AgentInfo, "app" | "name" | "peer">): M | undefined {
  const id = `${agent.peer ? `${agent.peer}/` : ""}${agent.app}/${agent.name}`;
  return members?.find((m) => m.agent === id);
}

/** A team permission as the chat's permission mode. */
export const chatPermOfTeam = (p: TeamPermissionMember["permission"]): string => TEAM_TO_CHAT[p] ?? "";

/** A chat permission mode as the team's setting; an unknown mode is `ask`. */
export const teamPermOfChat = (mode: string): TeamPermissionMember["permission"] => (mode === "bypassPermissions" ? "full" : mode === "acceptEdits" ? "edit" : "ask");
