import { describe, expect, test } from "bun:test";
import * as web from "../../../../src/web/agent-groups.ts";
import type { AgentInfo } from "../../../../src/web/api.ts";
import { canonicalItems, groupAgents, groupById, machinesOf, preferredMachine } from "./agents.ts";
import { decodeCatalogue, entriesByKey } from "./catalogue.ts";

const agent = (id: string, peer?: string, stale?: boolean): AgentInfo => {
  const [app, name] = id.split("/").slice(-2) as [string, string];
  return { id, app, name, title: name, avatar: "🦾", appIcon: "📦", runtime: "claude", ...(peer ? { peer } : {}), ...(stale ? { stale } : {}) };
};

const local = agent("space-ops/engineer");
const david = agent("david/space-ops/engineer", "david");
const eric = agent("eric/space-ops/engineer", "eric");
const assistant = agent("space/assistant");
const davidAssistant = agent("david/space/assistant", "david");
const other = agent("david/notes/librarian", "david");

describe("agents across machines", () => {
  test("groups as the web panel does, the local variant first", () => {
    for (const list of [[assistant, local, other, david, eric, davidAssistant], [david, eric, local], [agent("a/x/y", "a", true), agent("b/x/y", "b")]]) {
      const ours = groupAgents(list).map((g) => [g.key, g.primary.id, g.machines.map((m) => m.id)]);
      const theirs = web.groupAgents(list).map((g) => [g.key, g.primary.id, g.machines.map((m) => m.id)]);
      expect(ours).toEqual(theirs);
    }
    const groups = groupAgents([assistant, local, other, david, eric, davidAssistant]);
    expect(groups.map((g) => g.key)).toEqual(["space/assistant", "space-ops/engineer", "notes/librarian"]);
    expect(groups[0]!.machines.map((m) => m.id)).toEqual(["space/assistant", "david/space/assistant"]);
    expect(groups[1]!.machines).toEqual([local, david, eric]);
  });

  test("an offline peer does not stand for the group while another answers", () => {
    const off = agent("a/x/y", "a", true);
    const on = agent("b/x/y", "b");
    expect(groupAgents([off, on])[0]!.primary).toBe(on);
  });

  test("the remembered machine opens while it answers, else the group's own", () => {
    const g = groupAgents([local, david, eric])[0]!;
    expect(preferredMachine(g, undefined)).toBe(local);
    expect(preferredMachine(g, "eric")).toBe(eric);
    expect(preferredMachine(g, "")).toBe(local);
    expect(preferredMachine(g, "gone")).toBe(local);
    const g2 = groupAgents([local, agent("eric/space-ops/engineer", "eric", true)])[0]!;
    expect(preferredMachine(g2, "eric")).toBe(local);
    expect(preferredMachine(g, "eric")).toBe(web.preferredMachine(web.groupAgents([local, david, eric])[0]!, "eric"));
  });

  test("the machine menu lists the group's variants; an agent outside the catalogue stands alone", () => {
    const groups = groupAgents([local, david]);
    expect(machinesOf(groups, david)).toEqual([local, david]);
    expect(machinesOf(groups, other)).toEqual([other]);
    expect(groupById(groups, "david/space-ops/engineer")?.key).toBe("space-ops/engineer");
  });

  test("screens pinned per machine show one tile, other keys untouched", () => {
    const groups = groupAgents([local, david, eric]);
    const items = ["app:notes", "agent:david/space-ops/engineer", "agent:space-ops/engineer", "agent:unknown/x", "agent:eric/space-ops/engineer"];
    expect(canonicalItems(items, groups)).toEqual(["app:notes", "agent:space-ops/engineer", "agent:unknown/x"]);
    expect(canonicalItems(items, groups)).toEqual(web.canonicalItems(items, web.groupAgents([local, david, eric])));
  });

  test("the catalogue lists each agent once and keeps every machine's variant", () => {
    const c = decodeCatalogue({
      apps: { apps: [] },
      widgets: { widgets: [] },
      peers: { peers: [{ name: "david", health: "ok" }, { name: "eric", health: "ok", stale: true }] },
      agents: { agents: [local, david, { ...eric, stale: undefined }, assistant, davidAssistant] },
    });
    expect(c.agents.map((e) => e.ref)).toEqual(["space-ops/engineer", "space/assistant"]);
    expect(c.agents[0]!.machines).toEqual(["", "david", "eric"]);
    expect(c.agentInfo).toHaveLength(5);
    // A peer the hub marks stale makes its variants offline.
    expect(c.agentInfo.find((a) => a.id === "eric/space-ops/engineer")?.stale).toBe(true);
    expect(c.agentInfo.find((a) => a.id === "david/space-ops/engineer")?.stale).toBeUndefined();
    const byKey = entriesByKey(c);
    expect(byKey.get("agent:eric/space-ops/engineer")?.ref).toBe("space-ops/engineer");
  });

  test("only peers' variants: the first answering one stands for the agent", () => {
    const c = decodeCatalogue({ apps: { apps: [] }, widgets: { widgets: [] }, agents: { agents: [agent("a/x/y", "a", true), agent("b/x/y", "b")] } });
    expect(c.agents.map((e) => [e.ref, e.reach])).toEqual([["b/x/y", "unknown"]]);
  });
});
