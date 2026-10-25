import { describe, expect, test } from "bun:test";
import { activity, createActivityRoutes } from "./activity.ts";

describe("activity", () => {
  test("nothing running is not busy", () => {
    expect(activity({})).toEqual({ busy: false, items: [] });
    expect(activity({ tasks: () => [], terminals: () => 0, packageChanges: () => 0 })).toEqual({ busy: false, items: [] });
  });

  test("lists each kind with its label and start, in order", () => {
    const r = activity({
      tasks: () => ["todo/sync"],
      modelCalls: () => [{ app: "todo", tag: "summary", model: "m1", startedAt: 5 }],
      agentTurns: () => [{ agent: "space/assistant", startedAt: 7 }],
      terminals: () => 2,
      packageChanges: () => 1,
    });
    expect(r).toEqual({
      busy: true,
      items: [
        { kind: "task", label: "todo/sync" },
        { kind: "model", label: "todo/summary (m1)", since: 5 },
        { kind: "agent", label: "space/assistant", since: 7 },
        { kind: "terminal", label: "2 terminal sessions" },
        { kind: "package", label: "1 app install or upgrade" },
      ],
    });
    expect(activity({ terminals: () => 1, packageChanges: () => 3 }).items.map((i) => i.label)).toEqual(["1 terminal session", "3 app installs or upgrades"]);
  });
});

describe("GET /api/space/activity", () => {
  const get = (token: string, headers: Record<string, string> = {}) =>
    createActivityRoutes({ token, tasks: () => ["a/b"] })["/api/space/activity"].GET(new Request("http://127.0.0.1/api/space/activity", { headers }));

  test("the operator token reads it; another or none is 401", async () => {
    expect(await get("op", { authorization: "Bearer op" }).json()).toEqual({ ok: true, busy: true, items: [{ kind: "task", label: "a/b" }] });
    expect(get("op", { authorization: "Bearer other" }).status).toBe(401);
    expect(get("op").status).toBe(401);
  });

  test("with no token configured, loopback callers read it", () => {
    expect(get("").status).toBe(200);
  });
});
