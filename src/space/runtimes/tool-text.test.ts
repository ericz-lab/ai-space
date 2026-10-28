import { expect, test } from "bun:test";
import { monitorInput, taskNotice, toolErrorText } from "./tool-text.ts";
import { parseClaudeTranscript } from "./transcripts.ts";

/** What Claude Code answers when a model calls Monitor before loading its schema. */
const UNLOADED = "<tool_use_error>InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. Load the tool first: call ToolSearch with query \"select:Monitor\", then retry this call. For reference, this tool's input schema is: {\"$schema\":\"https://json-schema.org/draft/2020-12/schema\",\"type\":\"object\",\"required\":[\"description\",\"timeout_ms\"]}</tool_use_error>";
const WATCH = "until grep -q ok /tmp/job.output; do sleep 15; done";

test("a rejected call keeps its reason, not the CLI wrapper, the load guidance or the schema", () => {
  expect(toolErrorText(UNLOADED)).toBe("InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing");
  expect(toolErrorText("<tool_use_error>Error: No such tool available: x</tool_use_error>")).toBe("Error: No such tool available: x");
  expect(toolErrorText("exit code 1\nboom")).toBe("exit code 1\nboom");
});

test("Monitor reads as its description, then what feeds it; other tools and bare calls keep their input", () => {
  expect(monitorInput("Monitor", { description: "build finishes", command: WATCH, timeout_ms: 60000 })).toBe(`build finishes\n${WATCH}`);
  expect(monitorInput("Monitor", { description: "deploy log", ws: { url: "ws://127.0.0.1/x" } })).toBe("deploy log\nws://127.0.0.1/x");
  expect(monitorInput("Monitor", { command: WATCH })).toBeUndefined();
  expect(monitorInput("Bash", { description: "list", command: "ls" })).toBeUndefined();
});

test("a restored transcript shows Monitor calls and their rejection cleanly", () => {
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "m1", name: "Monitor", input: { command: WATCH } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m1", is_error: true, content: UNLOADED }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "m2", name: "Monitor", input: { description: "job done", command: WATCH, timeout_ms: 600000 } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "m2", content: "Monitor started (task b1)." }] } },
  ].map((l) => JSON.stringify(l)).join("\n");
  const [ai] = parseClaudeTranscript(lines);
  expect(ai?.role === "ai" && ai.steps).toEqual([
    { kind: "tool", name: "Monitor", input: WATCH, output: "InputValidationError: Monitor failed due to the following issue:\nThe required parameter `description` is missing", failed: true },
    { kind: "tool", name: "Monitor", input: `job done\n${WATCH}`, output: "Monitor started (task b1).", failed: false },
  ]);
});

test("a background job's report reads as one line with the rest under it", () => {
  expect(taskNotice('<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: "ticks"</summary>\n<event>tick 2\nmore</event>\n</task-notification>')).toEqual({ taskId: "b1", summary: 'Monitor event: "ticks"', event: "tick 2\nmore", line: 'Monitor event: "ticks": tick 2', detail: 'Monitor event: "ticks"\ntick 2\nmore' });
  expect(taskNotice("<task-notification><task-id>b2</task-id><tool-use-id>t1</tool-use-id><status>completed</status><summary>done</summary></task-notification>")).toMatchObject({ taskId: "b2", toolUseId: "t1", status: "completed", line: "done" });
  expect(taskNotice("hello <task-notification>")).toBeNull();
});

test("a restored session keeps each background report before the reply that answered it", async () => {
  // Claude Code 2.1.312's record of a Monitor (three ticks) and a background Bash (fixtures/).
  const jsonl = await Bun.file(new URL("./fixtures/claude-background-transcript.jsonl", import.meta.url)).text();
  const msgs = parseClaudeTranscript(jsonl);
  expect(msgs.map((m) => m.role)).toEqual(["user", "ai"]);
  const steps = msgs[1]!.role === "ai" ? msgs[1]!.steps ?? [] : [];
  expect(steps.map((s) => (s.kind === "tool" ? `tool ${s.name}` : s.kind === "notice" ? `notice ${s.text}` : `text ${s.text}`))).toEqual([
    "tool ToolSearch",
    "tool Monitor",
    "tool Bash",
    'notice Monitor event: "三次 tick 测试": tick 1',
    "text started",
    'notice Monitor event: "三次 tick 测试": tick 2',
    "text Monitor 通知：tick 2。",
    'notice Monitor event: "三次 tick 测试": tick 3',
    "text Monitor 通知：tick 3。",
    'notice Monitor "三次 tick 测试" stream ended',
    'notice Background command "后台等待20秒后输出" completed (exit code 0)',
    "text 两条通知：Monitor 的流已结束（三次 tick 全部收到），以及后台 Bash 命令 `sleep 20; echo bgdone` 已完成（退出码 0）。",
  ]);
});
