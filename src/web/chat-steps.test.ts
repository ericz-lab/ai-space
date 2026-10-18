import { expect, test } from "bun:test";
import { ChatSteps, submitsChat } from "./chat-steps.ts";

const tool = (id: string) => ({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "pwd" } }] } });
test("Codex work preserves text order, repeated tools and separate results", () => {
  const turn = new ChatSteps();
  turn.apply({ type: "assistant", message: { content: [{ type: "text", text: "Checking." }] } });
  turn.apply(tool("a"));
  const before = turn.snapshot();
  turn.apply(tool("a"));
  turn.apply(tool("b"));
  turn.apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "/workspace" }, { type: "tool_result", tool_use_id: "b", is_error: true, content: "Failed" }] } });
  turn.apply({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
  turn.finish();
  expect(turn.steps.map(s => s.kind)).toEqual(["text", "tool", "tool", "text"]);
  expect(turn.steps[1]).toMatchObject({ state: "completed", output: "/workspace" });
  expect(turn.steps[2]).toMatchObject({ state: "failed", output: "Failed" });
  expect(before[1]!.state).toBe("running");
});
test("streaming text is reconciled and unfinished tools remain incomplete", () => {
  const turn = new ChatSteps();
  turn.apply({ type: "stream_event", event: { delta: { type: "text_delta", text: "Hel" } } });
  turn.apply({ type: "stream_event", event: { delta: { type: "text_delta", text: "lo" } } });
  turn.apply({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } });
  turn.apply(tool("a"));
  turn.finish();
  expect(turn.steps).toHaveLength(2);
  expect(turn.steps[0]!.text).toBe("Hello");
  expect(turn.steps[1]!.state).toBe("incomplete");
});
test("results retain literal HTML and bound large output", () => {
  const turn = new ChatSteps();
  turn.apply(tool("a"));
  turn.apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "<script>bad()</script>" + "x".repeat(20000) }] } });
  expect(turn.steps[0]!.output).toStartWith("<script>");
  expect(turn.steps[0]!.output).toHaveLength(12000);
});
test("Enter sends only outside composition, including Safari's confirmation event", () => {
  expect(submitsChat("Enter", false, true, 13)).toBe(false);
  expect(submitsChat("Enter", false, false, 229)).toBe(false);
  expect(submitsChat("Enter", true, false, 13)).toBe(false);
  expect(submitsChat("Enter", false, false, 13)).toBe(true);
});
