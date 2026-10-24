import { expect, test } from "bun:test";
import { callerAppOf } from "./api.ts";

const opts = {
  operatorToken: "op",
  hubToken: "hub",
  isDevice: (t: string) => t === "dev",
  appForToken: async (t: string) => (t === "todo-token" ? "ai-todo" : undefined),
};
const req = (token?: string) => new Request("http://x/api/agents", token ? { headers: { authorization: `Bearer ${token}` } } : {});

test("the owner's credentials and the hub's token are the owner", async () => {
  for (const t of [undefined, "op", "hub", "dev"]) expect(await callerAppOf(req(t), opts)).toBeNull();
});

test("an app's token is that app, an unknown token is no app", async () => {
  expect(await callerAppOf(req("todo-token"), opts)).toBe("ai-todo");
  expect(await callerAppOf(req("other"), opts)).toBe("");
});

test("an empty hub token matches nothing", async () => {
  expect(await callerAppOf(req("other"), { ...opts, hubToken: "" })).toBe("");
});
