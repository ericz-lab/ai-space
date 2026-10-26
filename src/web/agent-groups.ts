import type { AgentInfo } from "./api.ts";

/**
 * One tile per agent, whatever the number of machines it runs on (docs/peers.md#agents-on-several-machines).
 * An app deployed on this machine and on peers declares the same agents under the same `app/name`
 * on each; the panel groups them: the local one (else the first peer's) stands for the group on
 * the screens, in the library and in the chat's agent list, and the chat picks the machine.
 * Chat routes, sessions and runs stay per machine, so every variant keeps its own id.
 * Pure functions over the catalogue; App.tsx and Chat.tsx hold the state.
 */

export type AgentGroup = {
  /** `<app>/<name>`, the same on every machine. */
  key: string;
  /** The variant that stands for the group: the local one, else the first peer that answers, else the first listed. */
  primary: AgentInfo;
  /** Every machine's variant, the local one first, then the peers in the catalogue's order. */
  machines: AgentInfo[];
};

export const groupKeyOf = (a: Pick<AgentInfo, "app" | "name">) => `${a.app}/${a.name}`;

/** Groups in the order their first variant has in the catalogue; within a group the local variant comes first. */
export function groupAgents(agents: AgentInfo[]): AgentGroup[] {
  const byKey = new Map<string, AgentGroup>();
  for (const a of agents) {
    const key = groupKeyOf(a);
    const g = byKey.get(key);
    if (!g) byKey.set(key, { key, primary: a, machines: [a] });
    else if (!a.peer && g.primary.peer) {
      g.primary = a;
      g.machines.unshift(a);
    } else {
      g.machines.push(a);
      // An offline peer does not stand for the group while another peer answers.
      if (g.primary.peer && g.primary.stale && !a.stale) g.primary = a;
    }
  }
  return [...byKey.values()];
}

/** The group an agent (any of its variants) belongs to, or a group of itself alone when it is outside the catalogue. */
export function groupOf(groups: AgentGroup[], a: Pick<AgentInfo, "app" | "name">): AgentGroup | undefined {
  const key = groupKeyOf(a);
  return groups.find((g) => g.key === key);
}

/** The group whose variant carries this id. */
export function groupById(groups: AgentGroup[], id: string): AgentGroup | undefined {
  return groups.find((g) => g.machines.some((m) => m.id === id));
}

const MACHINE_KEY = "chat-machine:";

/** The machine the person last chose for this agent, as the peer's name, or "" for this machine; unset when never chosen. */
export function rememberedMachine(key: string): string | undefined {
  try {
    return localStorage.getItem(MACHINE_KEY + key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberMachine(key: string, peer: string | undefined): void {
  try {
    localStorage.setItem(MACHINE_KEY + key, peer ?? "");
  } catch {
    /* a convenience only */
  }
}

/**
 * The variant a tile opens: the machine chosen last time when it is still listed and answering,
 * else the primary. The choice is kept, so it comes back once that machine answers again.
 */
export function preferredMachine(g: AgentGroup, remembered: string | undefined = rememberedMachine(g.key)): AgentInfo {
  if (remembered === undefined) return g.primary;
  const m = g.machines.find((x) => (x.peer ?? "") === remembered);
  return m && !m.stale ? m : g.primary;
}

/**
 * Screen items with every agent key pointed at its group's primary and repeats dropped, so a
 * layout pinned before the grouping (one key per machine) shows one tile; keys of agents the
 * catalogue does not list are kept as they are.
 */
export function canonicalItems(items: string[], groups: AgentGroup[]): string[] {
  const out: string[] = [];
  for (const key of items) {
    const id = key.startsWith("agent:") ? key.slice("agent:".length) : undefined;
    const g = id ? groupById(groups, id) : undefined;
    const next = g ? `agent:${g.primary.id}` : key;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}
