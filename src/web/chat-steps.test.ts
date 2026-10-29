import { expect, test } from "bun:test";
import { ChatSteps, allCommands, applyJobs, historySteps, submitsChat, toolSummary, toolVariant } from "./chat-steps.ts";

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

test("a folded run names commands only when every call in it is one", () => {
  const run = (names: string[]) => historySteps(names.map((name) => ({ kind: "tool" as const, name, input: "x", output: "", failed: false })));
  expect(allCommands(run(["Bash", "exec_command", "run_command"]))).toBe(true);
  expect(allCommands(run(["Bash", "Read"]))).toBe(false);
  expect(allCommands(run(["Read"]))).toBe(false);
  expect(allCommands([])).toBe(false);
});
test("Monitor is an optional tool: drawn with its description, a rejection without the schema dump", () => {
  expect(toolVariant("Monitor")).toBe("monitor");
  const turn = new ChatSteps();
  turn.apply({ type: "assistant", message: { content: [{ type: "tool_use", id: "m", name: "Monitor", input: { description: "build finishes", command: "until test -f done; do sleep 5; done", timeout_ms: 60000 } }] } });
  turn.apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m", content: [{ type: "text", text: "Monitor started (task b1)." }] }] } });
  turn.apply({ type: "assistant", message: { content: [{ type: "tool_use", id: "n", name: "Monitor", input: { command: "tail -f log" } }] } });
  turn.apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "n", is_error: true, content: "<tool_use_error>InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing\n\nThis tool's schema was not sent to the API. For reference, this tool's input schema is: {\"type\":\"object\"}</tool_use_error>" }] } });
  turn.finish();
  // A started watch runs on in the background until its job's end is known.
  expect(turn.steps[0]).toMatchObject({ kind: "tool", state: "background", output: "Monitor started (task b1)." });
  expect(toolSummary(turn.steps[0]!.text)).toBe("build finishes");
  expect(turn.steps[1]).toMatchObject({ state: "failed", text: "tail -f log", output: "InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing" });
  // A runtime without Monitor never sends one: a turn of other tools is untouched.
  const plain = new ChatSteps();
  plain.apply(tool("a"));
  plain.finish();
  expect(plain.steps.map((s) => toolVariant(s.name))).toEqual(["bash"]);
});

// Claude Code 2.1.312's stdout for a Monitor and a background Bash (src/space/runtimes/fixtures).
const recorded = async () => (await Bun.file(new URL("../space/runtimes/fixtures/claude-background.jsonl", import.meta.url)).text()).trim().split("\n").map((l) => JSON.parse(l));
/** The recording cut into turns at each result: the person's, then the CLI's own. */
const turnsOf = (events: { type: string }[]) => events.reduce<{ type: string }[][]>((turns, ev) => {
  turns[turns.length - 1]!.push(ev);
  if (ev.type === "result") turns.push([]);
  return turns;
}, [[]]).filter((t) => t.length);

test("a Monitor and a background command show as running in the background; a report the agent read is a notice", async () => {
  const [first, ...wakes] = turnsOf(await recorded());
  const turn = new ChatSteps();
  for (const ev of first!) turn.apply(ev);
  turn.apply({ type: "done" });
  expect(turn.steps.map((s) => [s.kind, s.kind === "tool" ? toolVariant(s.name) : "", s.state])).toEqual([
    ["tool", "search", "completed"],
    ["tool", "monitor", "background"],
    ["tool", "bash", "background"],
    ["notice", "", "completed"],
    ["text", "", "completed"],
  ]);
  expect(turn.steps[3]!.text).toBe('Monitor event: "三次 tick 测试": tick 1');

  // The CLI's own turns: the job ends come as its events, once each.
  const later = new ChatSteps();
  for (const ev of wakes.flat()) later.apply(ev);
  const notices = later.steps.filter((s) => s.kind === "notice").map((s) => s.text);
  expect(notices).toEqual(['Monitor "三次 tick 测试" stream ended', 'Background command "后台等待20秒后输出" completed (exit code 0)']);

  // The rows of the first turn take their jobs' end from the conversation's job list.
  const toolUse = (n: number) => turn.steps[n]!.id.slice("tool:".length);
  const jobs = [
    { id: "a", kind: "monitor" as const, description: "", status: "completed" as const, startedAt: 1, endedAt: 2, toolUseId: toolUse(1) },
    { id: "b", kind: "bash" as const, description: "", status: "running" as const, startedAt: 1, endedAt: null, toolUseId: toolUse(2) },
  ];
  const steps = turn.snapshot();
  const next = applyJobs(steps, jobs);
  expect(next.map((s) => s.state)).toEqual(["completed", "completed", "background", "completed", "completed"]);
  expect(applyJobs(next, jobs)).toBe(next);
  expect(applyJobs(next, [{ ...jobs[1]!, status: "stopped" }])[2]!.state).toBe("stopped");
});

test("a background job's end in the same turn settles its row; the limit notice is a notice", () => {
  const turn = new ChatSteps();
  turn.apply({ type: "assistant", message: { content: [{ type: "tool_use", id: "bg", name: "Bash", input: { command: "sleep 1", run_in_background: true } }] } });
  turn.apply({ type: "system", subtype: "task_notification", task_id: "j1", tool_use_id: "bg", status: "failed", summary: "Background command failed" });
  turn.apply({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bg", content: "Command running in background" }] } });
  // The same end told again by the message the agent read is not a second notice.
  turn.apply({ type: "user", message: { content: "<task-notification>\n<task-id>j1</task-id>\n<status>failed</status>\n<summary>Background command failed</summary>\n</task-notification>" } });
  turn.apply({ type: "notice", kind: "limit", text: "The next ones run without being shown." });
  expect(turn.steps.map((s) => [s.kind, s.state, s.text])).toEqual([
    ["tool", "failed", "sleep 1"],
    ["notice", "completed", "Background command failed"],
    ["notice", "completed", "The next ones run without being shown."],
  ]);
  expect(historySteps([{ kind: "notice", text: "Monitor event: tick", detail: "tick 2" }])).toEqual([{ id: "history:0", kind: "notice", name: "", text: "Monitor event: tick", output: "tick 2", state: "completed" }]);
});
