import { describe, expect, test } from "bun:test";
import { canonicalItems, groupAgents, groupById, groupOf, preferredMachine } from "./agent-groups.ts";
import type { AgentInfo } from "./api.ts";

const agent = (id: string, peer?: string): AgentInfo => {
  const [app, name] = id.split("/").slice(-2) as [string, string];
  return { id, app, name, title: name, avatar: "🦾", appIcon: "📦", runtime: "claude", ...(peer ? { peer } : {}) };
};

const local = agent("space-ops/engineer");
const david = agent("david/space-ops/engineer", "david");
const eric = agent("eric/space-ops/engineer", "eric");
const assistant = agent("space/assistant");
const other = agent("david/notes/librarian", "david");

describe("agent groups", () => {
  test("the same agent on several machines is one group, the local variant first", () => {
    const groups = groupAgents([assistant, local, other, david, eric]);
    expect(groups.map((g) => g.key)).toEqual(["space/assistant", "space-ops/engineer", "notes/librarian"]);
    const g = groups[1]!;
    expect(g.primary).toBe(local);
    expect(g.machines).toEqual([local, david, eric]);
    expect(groups[2]!.machines).toEqual([other]);
  });

  test("without a local variant the first peer stands for the group, and a local one listed later takes over", () => {
    expect(groupAgents([david, eric])[0]!.primary).toBe(david);
    const g = groupAgents([david, eric, local])[0]!;
    expect(g.primary).toBe(local);
    expect(g.machines).toEqual([local, david, eric]);
  });

  test("a group is found by any of its variants and by any variant's id", () => {
    const groups = groupAgents([local, david, eric]);
    expect(groupOf(groups, eric)?.primary).toBe(local);
    expect(groupById(groups, "david/space-ops/engineer")?.primary).toBe(local);
    expect(groupById(groups, "nobody/x/y")).toBeUndefined();
  });

  test("the remembered machine wins while it is listed; otherwise the primary", () => {
    const g = groupAgents([local, david, eric])[0]!;
    expect(preferredMachine(g, undefined)).toBe(local);
    expect(preferredMachine(g, "eric")).toBe(eric);
    expect(preferredMachine(g, "")).toBe(local);
    expect(preferredMachine(g, "gone")).toBe(local);
  });

  test("screen items point every machine's key at the primary, once; unknown keys stay", () => {
    const groups = groupAgents([local, david, eric]);
    const items = ["app:notes", "agent:david/space-ops/engineer", "builtin:inbox", "agent:space-ops/engineer", "agent:eric/space-ops/engineer", "agent:gone/x/y"];
    expect(canonicalItems(items, groups)).toEqual(["app:notes", "agent:space-ops/engineer", "builtin:inbox", "agent:gone/x/y"]);
  });
});
