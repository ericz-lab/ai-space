import type { AgentInfo } from "./api.ts";
import { groupKeyOf } from "./agent-groups.ts";

/**
 * Links into the panel (docs/panel.md#panel-links): the address's fragment names a window to open
 * once the page is up, so a desktop client can show the Inbox, the Terminal, Settings or a chat
 * without a native copy of them. `#chat=<app>/<agent>&text=…` opens that agent's chat with the
 * text in its message field. The text is a draft: it is never sent, so a link from anywhere cannot
 * make an agent act. The panel clears the fragment once it is read.
 */
export type PanelLink =
  | { open: "chat"; agent: string | null; text: string }
  | { open: "inbox" | "terminal" | "settings" | "shortcuts" };

const WINDOWS = ["inbox", "terminal", "settings", "shortcuts"] as const;

/** The same cap as an `aispace://chat` link's text in the desktop clients. */
export const MAX_DRAFT = 20_000;

/** The link a fragment holds; null for any other fragment, which the panel leaves alone. */
export function parsePanelLink(hash: string): PanelLink | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const first = [...params.keys()][0];
  if (first === "chat") {
    const agent = params.get("chat")?.trim() || null;
    return { open: "chat", agent, text: (params.get("text") ?? "").slice(0, MAX_DRAFT) };
  }
  const name = WINDOWS.find((w) => w === first);
  return name && !params.get(name) ? { open: name } : null;
}

/**
 * The agent a link names: an exact id, else `<app>/<agent>` on any machine, the local one first.
 * Null when the Space has no such agent; the chat then stays on the agent it shows.
 */
export function linkedAgent(agents: AgentInfo[], ref: string): AgentInfo | null {
  const exact = agents.find((a) => a.id === ref && !a.peer) ?? agents.find((a) => a.id === ref);
  if (exact) return exact;
  const same = agents.filter((a) => groupKeyOf(a) === ref);
  return same.find((a) => !a.peer) ?? same.find((a) => !a.stale) ?? same[0] ?? null;
}

/** A draft added to what the field already holds, as the desktop clients' Quick Chat does. */
export const withDraft = (current: string, text: string) => (current.trim() ? `${current}\n\n${text}` : text);
