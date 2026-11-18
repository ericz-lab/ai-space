import { describe, expect, test } from "bun:test";
import { canonicalItems, conversationTabs, groupAgents, groupById, groupOf, preferredMachine } from "./agent-groups.ts";
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

  test("an offline machine: not the primary while another peer answers, and a remembered one falls back until it is back", () => {
    const davidOff = { ...david, stale: true };
    expect(groupAgents([davidOff, eric])[0]!.primary).toBe(eric);
    expect(groupAgents([davidOff, eric])[0]!.machines).toEqual([davidOff, eric]);
    const g = groupAgents([local, davidOff, eric])[0]!;
    expect(preferredMachine(g, "david")).toBe(local);
    expect(preferredMachine(groupAgents([local, david, eric])[0]!, "david")).toBe(david);
  });

  test("the space assistant of every machine is one group, so the chat can pick the machine", () => {
    const remote = agent("david/space/assistant", "david");
    const g = groupAgents([assistant, remote])[0]!;
    expect(g.key).toBe("space/assistant");
    expect(g.machines).toEqual([assistant, remote]);
  });

  test("the phone's avatar bar shows an agent once, whatever the machines it has a conversation on", () => {
    const remote = agent("david/space/assistant", "david");
    const never = () => undefined;
    const tabs = conversationTabs([assistant, local, remote, david], remote, never);
    expect(tabs.map((t) => t.key)).toEqual(["space/assistant", "space-ops/engineer"]);
    expect(tabs.map((t) => t.ids)).toEqual([["space/assistant", "david/space/assistant"], ["space-ops/engineer", "david/space-ops/engineer"]]);
    // The shown variant for the shown agent; the first conversation's for another one.
    expect(tabs.map((t) => t.agent)).toEqual([remote, local]);
    expect(conversationTabs([assistant, assistant], assistant, never)).toEqual([{ key: "space/assistant", agent: assistant, ids: ["space/assistant"] }]);
  });

  test("the shown agent has its avatar without a conversation yet, alone or after the open ones", () => {
    const never = () => undefined;
    expect(conversationTabs([], assistant, never)).toEqual([{ key: "space/assistant", agent: assistant, ids: ["space/assistant"] }]);
    expect(conversationTabs([assistant], assistant, never)).toEqual([{ key: "space/assistant", agent: assistant, ids: ["space/assistant"] }]);
    expect(conversationTabs([other], assistant, never).map((t) => t.agent)).toEqual([other, assistant]);
    // Another machine's conversation of the shown agent: one avatar, opening the shown machine.
    const remote = agent("david/space/assistant", "david");
    expect(conversationTabs([remote], assistant, never)).toEqual([{ key: "space/assistant", agent: assistant, ids: ["david/space/assistant", "space/assistant"] }]);
  });

  test("an avatar opens the machine chosen last while it answers, else the first answering one", () => {
    const open = [local, david, eric];
    expect(conversationTabs(open, assistant, () => "eric")[0]!.agent).toBe(eric);
    expect(conversationTabs(open, assistant, () => "")[0]!.agent).toBe(local);
    const localOff = { ...local, stale: true };
    const ericOff = { ...eric, stale: true };
    expect(conversationTabs([localOff, david, ericOff], assistant, () => "eric")[0]!.agent).toBe(david);
    expect(conversationTabs([localOff, ericOff], assistant, () => undefined)[0]!.agent).toBe(localOff);
  });

  test("screen items point every machine's key at the primary, once; unknown keys stay", () => {
    const groups = groupAgents([local, david, eric]);
    const items = ["app:notes", "agent:david/space-ops/engineer", "builtin:inbox", "agent:space-ops/engineer", "agent:eric/space-ops/engineer", "agent:gone/x/y"];
    expect(canonicalItems(items, groups)).toEqual(["app:notes", "agent:space-ops/engineer", "builtin:inbox", "agent:gone/x/y"]);
  });
});
