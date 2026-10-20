import { expect, test } from "bun:test";
import { ChatSteps, historySteps, submitsChat, toolSummary, toolVariant } from "./chat-steps.ts";

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

test("a live turn's approvals and added messages are steps in order; an unanswered approval ends cancelled", () => {
  const steps = new ChatSteps();
  steps.apply({ type: "stream_event", event: { delta: { type: "text_delta", text: "Removing it." } } });
  steps.apply({ type: "approval_request", id: "r1", tool: "Bash", title: "rm a.txt", detail: "Remove a.txt" });
  steps.apply({ type: "approval_request", id: "r1", tool: "Bash", title: "rm a.txt" }); // replayed after a reconnect
  steps.apply({ type: "approval_resolved", id: "r1", decision: "allow" });
  steps.apply({ type: "steer", text: "also say BANANA" });
  steps.apply({ type: "approval_request", id: "r2", tool: "Edit", title: "b.txt" });
  steps.apply({ type: "done" });
  expect(steps.snapshot().map((s) => [s.kind, s.name, s.text, s.output, s.state])).toEqual([
    ["text", "", "Removing it.", "", "completed"],
    ["approval", "Bash", "rm a.txt", "Remove a.txt", "allowed"],
    ["steer", "", "also say BANANA", "", "completed"],
    ["approval", "Edit", "b.txt", "", "cancelled"],
  ]);
});
test("an agent's question keeps its options and, once answered, the answers", () => {
  const steps = new ChatSteps();
  const questions = [{ id: "pick", header: "Asset", question: "Which one?", options: [{ label: "Contract", description: "" }], multiSelect: false }];
  steps.apply({ type: "approval_request", id: "q1", tool: "AskUserQuestion", title: "Which one?", questions });
  expect(steps.snapshot()[0]).toMatchObject({ kind: "approval", state: "waiting", questions });
  steps.apply({ type: "approval_resolved", id: "q1", decision: "allow", answers: { pick: ["Contract"] } });
  expect(steps.snapshot()[0]).toMatchObject({ state: "allowed", answers: { pick: ["Contract"] } });
});

test("a restored transcript's steps draw as finished text and tool rows in order", () => {
  expect(historySteps([{ kind: "text", text: "Checking." }, { kind: "tool", name: "Bash", input: "ls", output: "a", failed: false }, { kind: "tool", name: "Bash", input: "false", output: "", failed: true }])
    .map((s) => [s.kind, s.name, s.text, s.output, s.state])).toEqual([
    ["text", "", "Checking.", "", "completed"],
    ["tool", "Bash", "ls", "a", "completed"],
    ["tool", "Bash", "false", "", "failed"],
  ]);
});

test("tool rows pick a variant across runtimes and summarize to one line", () => {
  expect(["Bash", "bash", "command_execution", "exec"].map(toolVariant)).toEqual(["bash", "bash", "bash", "bash"]);
  expect(["Read", "Edit", "MultiEdit", "Write", "Grep", "Glob", "WebFetch", "web_search", "run_code", "Task", "TodoWrite"].map(toolVariant))
    .toEqual(["read", "edit", "edit", "write", "search", "search", "web", "web", "code", "task", "plan"]);
  expect(toolVariant("mcp__github__search")).toBe("search");
  expect(toolVariant("space_notify")).toBe("other");
  expect(toolSummary("\n  for d in *; do\n  echo $d\ndone")).toBe("for d in *; do");
  expect(toolSummary("")).toBe("");
});
