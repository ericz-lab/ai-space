import { expect, test } from "bun:test";
import { chatPermOfTeam, queuedChatTurn, teamMemberOf, teamPermOfChat } from "./chat-request.ts";

test("Space Assistant's first send uses its selection even before model options have reached conversation state", () => {
  const bootstrapAgent = { app: "space", name: "assistant" };
  expect(queuedChatTurn(bootstrapAgent, "hello", "sonnet", "codex/basic", "")).toEqual({ message: "hello", model: "codex/basic", permissionMode: undefined, interactive: true });
  expect(queuedChatTurn(bootstrapAgent, "hello", "opus", "claude/junior", "acceptEdits")).toMatchObject({ model: "claude/junior", permissionMode: "acceptEdits" });
  expect(queuedChatTurn(bootstrapAgent, "hello", "opus", "", "").model).toBeUndefined();
});

test("queued turns keep their selections when another conversation's controls change", () => {
  const base = { app: "space", name: "assistant" };
  const queue = [queuedChatTurn(base, "first", "sonnet", "codex/basic", "")];
  queue.push(queuedChatTurn(base, "second", "sonnet", "codex/advanced", "acceptEdits"));
  const appTurn = queuedChatTurn({ app: "notes", name: "assistant" }, "third", "haiku", "codex/advanced", "bypassPermissions");
  expect(queue.map((turn) => turn.model)).toEqual(["codex/basic", "codex/advanced"]);
  expect(queue.map((turn) => turn.permissionMode)).toEqual([undefined, "acceptEdits"]);
  expect(appTurn.model).toBe("haiku");
});

test("an app agent with runtime/tier options sends its own pick; one of an older peer sends the Claude model", () => {
  const options = [{ value: "codex/intermediate", runtime: "codex", tier: "intermediate" as const, model: "gpt-6-sol" }];
  expect(queuedChatTurn({ app: "todo", name: "planner", modelOptions: options }, "hi", "haiku", "codex/intermediate", "").model).toBe("codex/intermediate");
  expect(queuedChatTurn({ app: "todo", name: "planner", modelOptions: options }, "hi", "haiku", "", "").model).toBeUndefined();
  expect(queuedChatTurn({ app: "todo", name: "planner" }, "hi", "haiku", "codex/intermediate", "").model).toBe("haiku");
});

test("agent intent turns retain the original sentence and routing context without changing permissions", () => {
  const text = "查今天金融新闻";
  const turn = queuedChatTurn({ app: "whymove", name: "curator" }, text, "", "", "plan", { intentId: "financial-news", timezone: "Asia/Seoul" });
  expect(turn).toEqual({ message: text, intentId: "financial-news", timezone: "Asia/Seoul", permissionMode: "plan", model: undefined, interactive: true });
});

test("a team member's chat permission is the team's, the same three tiers both ways", () => {
  const members = [{ agent: "space/director", permission: "full" as const }, { agent: "mac/notes/designer", permission: "edit" as const }];
  expect(teamMemberOf(members, { app: "space", name: "director" })?.permission).toBe("full");
  expect(teamMemberOf(members, { app: "notes", name: "designer", peer: "mac" })?.permission).toBe("edit");
  // The same agent on this machine is not the peer's member, and an agent outside the team has none.
  expect(teamMemberOf(members, { app: "notes", name: "designer" })).toBeUndefined();
  expect(teamMemberOf(null, { app: "space", name: "director" })).toBeUndefined();
  for (const p of ["ask", "edit", "full"] as const) expect(teamPermOfChat(chatPermOfTeam(p))).toBe(p);
  expect(chatPermOfTeam("ask")).toBe("");
  expect(chatPermOfTeam("full")).toBe("bypassPermissions");
  expect(teamPermOfChat("something-else")).toBe("ask");
});
