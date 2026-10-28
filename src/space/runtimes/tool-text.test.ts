import { expect, test } from "bun:test";
import { monitorInput, toolErrorText } from "./tool-text.ts";
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
