import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type TeamAgentInfo, createTeamRoutes, parseTeamUpdate } from "./api.ts";
import { TeamStore } from "./store.ts";

/** The team table and `GET/PUT /api/team` (docs/orders.md#team). */

const options = [{ value: "claude/advanced", runtime: "claude", tier: "advanced", model: "opus" }];
const agents: TeamAgentInfo[] = [
  { id: "space/director", title: "Director", description: "", builtin: true },
  { id: "space/engineer", title: "Engineer", description: "", builtin: true },
  { id: "ai-design/designer", title: "Designer", description: "Designs pages in the style book." },
  { id: "david/ai-todo/planner", title: "Planner", description: "", peer: "david" },
];

function setup() {
  const team = new TeamStore(new Database(":memory:"));
  let caller: string | null = null;
  const routes = createTeamRoutes({ team, modelOptions: () => options, agents: () => agents, callerApp: async () => caller });
  const req = async (method: "GET" | "PUT", body?: unknown) => {
    const r = await routes["/api/team"]![method]!(Object.assign(new Request("http://x/api/team", { method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), { params: {} }));
    return { status: r.status, body: (await r.json()) as { error?: string; members: { role: string; agent: string; permission: string; model: string | null; enabled: boolean; builtin: boolean; summary: string; title: string }[]; agents: TeamAgentInfo[] } };
  };
  return { team, req, as: (c: string | null) => (caller = c) };
}

describe("the team", () => {
  test("is seeded with the Director and the Engineer, and a seed never overwrites the person's settings", () => {
    const db = new Database(":memory:");
    const team = new TeamStore(db);
    expect(team.list().map((m) => [m.role, m.agent, m.permission, m.builtin])).toEqual([
      ["director", "space/director", "ask", true],
      ["engineer", "space/engineer", "edit", true],
    ]);
    team.update("engineer", { permission: "full", summary: "mine" });
    expect(new TeamStore(db).get("engineer")).toMatchObject({ permission: "full", summary: "mine" });
  });

  test("a phase-1 Director row gets the summary that mentions delegation, unless the person changed it", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE team_members (role TEXT PRIMARY KEY, title TEXT NOT NULL, i18n TEXT NOT NULL DEFAULT '{}', agent TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', model TEXT, permission TEXT NOT NULL DEFAULT 'ask', enabled INTEGER NOT NULL DEFAULT 1, builtin INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
    db.query("INSERT INTO team_members VALUES ('director', 'Director', '{}', 'space/director', 'Takes every order: answers, looks things up, records to-dos and asks the person when an order needs more.', 'claude/advanced', 'full', 1, 1, 1)").run();
    const team = new TeamStore(db);
    expect(team.director()).toMatchObject({ model: "claude/advanced", permission: "full" });
    expect(team.director().summary).toContain("delegates");
    expect(team.get("engineer")).toBeDefined();
  });
});

describe("GET/PUT /api/team", () => {
  test("lists the members, the models and this Space's agents (not a peer's)", async () => {
    const { req } = setup();
    const r = await req("GET");
    expect(r.body.members.map((m) => m.role)).toEqual(["director", "engineer"]);
    expect(r.body.agents.map((a) => a.id)).toEqual(["space/director", "space/engineer", "ai-design/designer"]);
  });

  test("adds an app agent as a member, its summary defaulting to the agent's description", async () => {
    const { req, team } = setup();
    const r = await req("PUT", { members: [{ role: "designer", agent: "ai-design/designer", permission: "full" }] });
    expect(r.status).toBe(200);
    expect(team.get("designer")).toMatchObject({ title: "Designer", agent: "ai-design/designer", summary: "Designs pages in the style book.", permission: "full", enabled: true, builtin: false });
    // Edited, disabled, then removed.
    expect((await req("PUT", { members: [{ role: "designer", title: "UI designer", i18n: { zh: { title: "设计师" } }, summary: "Pages.", model: "claude/advanced", enabled: false }] })).status).toBe(200);
    expect(team.get("designer")).toMatchObject({ title: "UI designer", i18n: { zh: { title: "设计师" } }, summary: "Pages.", model: "claude/advanced", enabled: false });
    expect((await req("PUT", { remove: ["designer"] })).status).toBe(200);
    expect(team.get("designer")).toBeUndefined();
  });

  test("edits a built-in row and disables the Engineer, but never the Director", async () => {
    const { req, team } = setup();
    expect((await req("PUT", { members: [{ role: "engineer", enabled: false, permission: "ask" }, { role: "director", model: "claude/advanced", permission: "full" }] })).status).toBe(200);
    expect(team.get("engineer")).toMatchObject({ enabled: false, permission: "ask" });
    expect(team.director()).toMatchObject({ model: "claude/advanced", permission: "full" });
  });

  test("refuses what breaks a rule, and changes nothing then", async () => {
    const { req, team } = setup();
    for (const [body, words] of [
      [{ members: [{ role: "director", enabled: false }] }, "cannot be disabled"],
      [{ remove: ["engineer"] }, "built in"],
      [{ remove: ["director"] }, "built in"],
      [{ members: [{ role: "engineer", agent: "ai-design/designer" }] }, "its agent stays space/engineer"],
      [{ members: [{ role: "designer", agent: "ai-design/nobody" }] }, "not an agent of this Space"],
      [{ members: [{ role: "planner", agent: "david/ai-todo/planner" }] }, "an agent of david"],
      [{ members: [{ role: "planner", agent: "ai-todo/planner" }] }, "not an agent of this Space"],
      [{ members: [{ role: "boss", agent: "space/director" }] }, "member once"],
      [{ members: [{ role: "designer" }] }, "name its agent"],
      [{ members: [{ role: "Designer!", agent: "ai-design/designer" }] }, "role must be"],
      [{ members: [{ role: "designer", agent: "ai-design/designer" }, { role: "designer", agent: "ai-design/designer" }] }, "listed twice"],
      [{ members: [{ role: "director", permission: "root" }] }, "permission"],
      [{ members: [{ role: "director", model: "gpt/9" }] }, "model must be null"],
      [{ members: [{ role: "director", owner: "me" }] }, "unknown field"],
      [{ members: [] }, "nothing to change"],
      [{ remove: ["nobody"] }, "unknown role"],
      [[1], "body must be"],
      // One bad change in a batch: the good one is not applied either.
      [{ members: [{ role: "engineer", permission: "full" }, { role: "director", enabled: false }] }, "cannot be disabled"],
    ] as const) {
      const r = await req("PUT", body);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(words);
    }
    expect(team.get("engineer")?.permission).toBe("edit");
    expect(parseTeamUpdate({ members: [{ role: "director", model: null }] }, team, ["claude/advanced"], agents)).toEqual([{ kind: "update", role: "director", patch: { model: null } }]);
  });

  test("is the owner's only", async () => {
    const { req, as } = setup();
    as("notes");
    expect((await req("GET")).status).toBe(403);
    expect((await req("PUT", { members: [{ role: "director", permission: "full" }] })).status).toBe(403);
  });
});
