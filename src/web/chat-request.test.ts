import { expect, test } from "bun:test";
import { queuedChatTurn } from "./chat-request.ts";

test("Base's first send uses its selection even before model options have reached conversation state", () => {
  const bootstrapAgent = { app: "space", name: "assistant" };
  expect(queuedChatTurn(bootstrapAgent, "hello", "sonnet", "codex/basic", "")).toEqual({ message: "hello", model: "codex/basic", permissionMode: undefined });
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
