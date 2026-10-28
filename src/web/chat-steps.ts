/**
 * Ordered work shared by Claude and Codex's normalized stream events. A live turn
 * (docs/runtimes.md#live-chat) adds two kinds: an approval the agent waits for (`name` the tool,
 * `text` what it wants to do, `output` why) and a message the person added while it ran. An
 * approval with `questions` is a question the agent asks; `answers` is what the person chose.
 */
import { monitorInput, toolErrorText } from "../space/runtimes/tool-text.ts";

export type ChatQuestion = { id: string; header: string; question: string; options: { label: string; description: string }[]; multiSelect: boolean };
export type ChatStep = {
  id: string;
  kind: "text" | "tool" | "approval" | "steer";
  name: string;
  text: string;
  output: string;
  state: "running" | "completed" | "failed" | "incomplete" | "waiting" | "allowed" | "denied" | "cancelled";
  questions?: ChatQuestion[];
  answers?: Record<string, string[]>;
};
type Block = { type: string; id?: string; name?: string; text?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Event = { type: string; message?: { content?: Block[] }; event?: { delta?: { type?: string; text?: string } }; id?: string; tool?: string; title?: string; detail?: string; decision?: string; text?: string; questions?: ChatQuestion[]; answers?: Record<string, string[]> };
const detail = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 12000);
  if (Array.isArray(value)) {
    const texts = value.flatMap((v) => v?.type === "text" && typeof v.text === "string" ? [v.text] : []);
    if (texts.length) return texts.join("\n").slice(0, 12000);
  }
  return (JSON.stringify(value, null, 2) ?? "").slice(0, 12000);
};

export class ChatSteps {
  steps: ChatStep[] = [];
  private streaming: string | undefined;
  private serial = 0;

  private text(text: string, final: boolean) {
    const current = this.steps.find((s) => s.id === this.streaming);
    if (current) {
      current.text = final ? text : current.text + text;
      if (final) current.state = "completed";
    } else {
      const id = `text:${++this.serial}`;
      this.steps.push({ id, kind: "text", name: "", text, output: "", state: final ? "completed" : "running" });
      if (!final) this.streaming = id;
    }
    if (final) this.streaming = undefined;
  }

  apply(event: Event) {
    if (event.type === "approval_request" && event.id) {
      if (!this.steps.some((s) => s.id === `approval:${event.id}`)) this.steps.push({ id: `approval:${event.id}`, kind: "approval", name: event.tool ?? "tool", text: event.title ?? "", output: event.detail ?? "", state: "waiting", ...(event.questions?.length ? { questions: event.questions } : {}) });
    }
    if (event.type === "approval_resolved" && event.id) {
      const current = this.steps.find((s) => s.id === `approval:${event.id}`);
      if (current) {
        current.state = event.decision === "allow" ? "allowed" : event.decision === "deny" ? "denied" : "cancelled";
        if (event.answers) current.answers = event.answers;
      }
    }
    if (event.type === "steer") {
      this.steps.push({ id: `steer:${++this.serial}`, kind: "steer", name: "", text: event.text ?? "", output: "", state: "completed" });
    }
    if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") this.text(event.event.delta.text ?? "", false);
    for (const block of event.message?.content ?? []) {
      if (event.type === "assistant" && block.type === "text" && block.text) this.text(block.text, true);
      if (event.type === "assistant" && block.type === "tool_use" && block.id) {
        const id = `tool:${block.id}`;
        const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
        const hint = monitorInput(block.name ?? "", input) ?? detail(input.command ?? input.file_path ?? input.path ?? input.query ?? input.url ?? block.input);
        const current = this.steps.find((s) => s.id === id);
        if (current) { if (hint) current.text = hint; }
        else this.steps.push({ id, kind: "tool", name: block.name ?? "tool", text: hint, output: "", state: "running" });
      }
      if (event.type === "user" && block.type === "tool_result") {
        const current = this.steps.find((s) => s.id === `tool:${block.tool_use_id}`);
        if (current) { current.output = block.is_error ? toolErrorText(detail(block.content)) : detail(block.content); current.state = block.is_error ? "failed" : "completed"; }
      }
    }
    if (event.type === "done") this.finish();
  }

  finish() {
    for (const step of this.steps) {
      if (step.state === "running") step.state = step.kind === "tool" ? "incomplete" : "completed";
      if (step.state === "waiting") step.state = "cancelled";
    }
  }

  snapshot(): ChatStep[] { return this.steps.map((step) => ({ ...step })); }
}

/** A restored transcript's ordered steps (`TranscriptStep` on the server) as the panel draws them. */
export type HistoryStep = { kind: "text"; text: string } | { kind: "tool"; name: string; input: string; output: string; failed: boolean };
export const historySteps = (steps: HistoryStep[]): ChatStep[] => steps.map((step, i) => step.kind === "text"
  ? { id: `history:${i}`, kind: "text", name: "", text: step.text, output: "", state: "completed" }
  : { id: `history:${i}`, kind: "tool", name: step.name, text: step.input, output: step.output, state: step.failed ? "failed" : "completed" });

/** How a tool row is drawn: its icon, its localized title, and the one-line summary beside it. */
export type ToolVariant = "bash" | "read" | "write" | "edit" | "search" | "web" | "code" | "task" | "plan" | "monitor" | "other";
const VARIANTS: [RegExp, ToolVariant][] = [
  [/^(bash|pwsh|shell|exec|exec_command|command|command_execution|local_shell|run_command|terminal)$/i, "bash"],
  [/^(read|read_file|read_image|view|notebookread|cat)$/i, "read"],
  [/^(write|write_file|create_file)$/i, "write"],
  [/^(edit|multiedit|notebookedit|apply_patch|patch|file_change|str_replace)$/i, "edit"],
  [/^(grep|glob|ls|list|search|find|toolsearch|codebase_search)$/i, "search"],
  [/^(webfetch|websearch|web_fetch|web_search|fetch|browse)$/i, "web"],
  [/^(run_code|code)$/i, "code"],
  [/^(task|agent|subagent|spawn_agent|send_message|wait_agent)$/i, "task"],
  [/^(todowrite|todo_write|update_plan)$/i, "plan"],
  [/^monitor$/i, "monitor"],
];
export const toolVariant = (name: string): ToolVariant => {
  const bare = name.replace(/^mcp__.*__/, "");
  return VARIANTS.find(([re]) => re.test(bare))?.[1] ?? "other";
};
/** The first non-empty line, so a long command or a patch still reads as one row. */
export const toolSummary = (text: string): string => text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";

/** Whether a run of calls is all commands, so a folded transcript's head can say what ran. */
export const allCommands = (steps: ChatStep[]): boolean => steps.length > 0 && steps.every((step) => step.kind === "tool" && toolVariant(step.name) === "bash");

/** Runs of consecutive tool calls become one group, so they stack as a tight list between paragraphs. */
export const stepGroups = (steps: ChatStep[]): (ChatStep | ChatStep[])[] => steps.reduce<(ChatStep | ChatStep[])[]>((groups, step) => {
  const last = groups[groups.length - 1];
  if (step.kind !== "tool") groups.push(step);
  else if (Array.isArray(last)) last.push(step);
  else groups.push([step]);
  return groups;
}, []);

/** Safari can report the IME confirmation key as keyCode 229 after compositionend. */
export const submitsChat = (key: string, shift: boolean, composing: boolean, keyCode: number) => key === "Enter" && !shift && !composing && keyCode !== 229;
