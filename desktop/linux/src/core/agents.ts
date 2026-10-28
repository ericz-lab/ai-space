/**
 * One agent across machines, the web panel's rules (src/web/agent-groups.ts, docs/peers.md#agents-on-several-machines):
 * the catalogue lists the same `app/name` agent once per machine; the client shows it once, the
 * local variant (else the first peer that answers) standing for the group, and the chat picks the
 * machine. Every variant keeps its own id, sessions and routes.
 */

export type Variant = { id: string; app: string; name: string; peer?: string; stale?: boolean };

export type AgentGroup<T extends Variant = Variant> = {
  /** `<app>/<name>`, the same on every machine. */
  key: string;
  /** The variant that stands for the group. */
  primary: T;
  /** Every machine's variant, the local one first, then the peers in the catalogue's order. */
  machines: T[];
};

export const groupKeyOf = (a: Pick<Variant, "app" | "name">) => `${a.app}/${a.name}`;

/** Groups in the order their first variant has in the catalogue; within a group the local variant comes first. */
export function groupAgents<T extends Variant>(agents: T[]): AgentGroup<T>[] {
  const byKey = new Map<string, AgentGroup<T>>();
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

/** The group whose variant carries this id. */
export function groupById<T extends Variant>(groups: AgentGroup<T>[], id: string): AgentGroup<T> | undefined {
  return groups.find((g) => g.machines.some((m) => m.id === id));
}

/**
 * The variant a tile opens: the machine chosen last time (`""` for this machine) when it is still
 * listed and answering, else the primary. The choice is kept, so it comes back once that machine answers.
 */
export function preferredMachine<T extends Variant>(g: AgentGroup<T>, remembered: string | undefined): T {
  if (remembered === undefined) return g.primary;
  const m = g.machines.find((x) => (x.peer ?? "") === remembered);
  return m && !m.stale ? m : g.primary;
}

/** The variants the chat's machine menu lists for an agent: its group's, or the agent alone. */
export function machinesOf<T extends Variant>(groups: AgentGroup<T>[], agent: T): T[] {
  const g = groupById(groups, agent.id);
  return g ? g.machines : [agent];
}

/** The agent ids every variant stands for: a variant's id maps to its group's primary. */
export function primaryIds(groups: AgentGroup[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const g of groups) for (const m of g.machines) out.set(m.id, g.primary.id);
  return out;
}

/**
 * Screen items with every agent key pointed at its group's primary and repeats dropped, so a
 * screen pinned before the grouping (one key per machine) shows one tile.
 */
export function canonicalItems(items: string[], groups: AgentGroup[]): string[] {
  const primary = primaryIds(groups);
  const out: string[] = [];
  for (const key of items) {
    const id = key.startsWith("agent:") ? key.slice("agent:".length) : undefined;
    const p = id ? primary.get(id) : undefined;
    const next = p ? `agent:${p}` : key;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}
