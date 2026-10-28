import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage, TranscriptStep } from "./types.ts";
import { monitorInput, toolErrorText } from "./tool-text.ts";

/**
 * Past chat sessions, read back from each runtime's own records so restoring
 * one costs no storage of ours. Framework messages are skipped; consecutive
 * assistant blocks merge into one message, whose `steps` keep its text and
 * tool calls (with their results where recorded) in order.
 *
 *   Claude Code       ~/.claude/projects/<cwd encoded>/<sid>.jsonl
 *   DeepSeek Harness  $DSH_HOME/sessions/<cwd encoded>/<sid>/session.v{4,3}.jsonl (plain JSONL; the
 *                     harness must be configured with `compression: none`, see docs/runtimes.md)
 *   Codex             $CODEX_HOME/sessions/<date>/rollout-<time>-<sid>.jsonl
 */

export const SESSION_ID_RE = /^[a-z0-9-]{8,72}$/i;

// ---------------------------------------------------------------- claude code

export function claudeTranscriptPath(cwd: string, sid: string, home = homedir()): string {
  if (!SESSION_ID_RE.test(sid)) throw new Error("invalid session id");
  return join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"), `${sid}.jsonl`);
}

export async function readClaudeTranscript(cwd: string, sid: string, home = homedir()): Promise<TranscriptMessage[] | null> {
  const file = Bun.file(claudeTranscriptPath(cwd, sid, home));
  if (!(await file.exists())) return null;
  return parseClaudeTranscript(await file.text());
}

export function parseClaudeTranscript(jsonl: string): TranscriptMessage[] {
  const msgs: TranscriptMessage[] = [];
  const calls = new Map<string, ToolStep>();
  for (const line of jsonl.split("\n")) {
    let ev: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const content = ev?.message?.content;
    if (ev.type === "user" && !ev.isMeta) {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .filter((b) => b?.type === "text")
                .map((b) => String(b.text ?? ""))
                .join("")
            : "";
      if (text.trim() && !text.trimStart().startsWith("<")) msgs.push({ role: "user", text });
      if (Array.isArray(content)) {
        for (const b of content) {
          const step = b?.type === "tool_result" ? calls.get(String(b.tool_use_id)) : undefined;
          if (step) {
            step.output = clip(resultText(b.content));
            step.failed = b.is_error === true;
            if (step.failed) step.output = clip(toolErrorText(resultText(b.content)));
          }
        }
      }
    } else if (ev.type === "assistant" && Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && b.text) addText(msgs, String(b.text));
        else if (b?.type === "tool_use") {
          const step = addTool(msgs, String(b.name ?? "tool"), b.input);
          if (b.id) calls.set(String(b.id), step);
        }
      }
    }
  }
  return msgs;
}

// ---------------------------------------------------------------- deepseek harness

/** The harness's own encoding of a working directory into one directory name (`/tmp/x` → `--tmp-x--`). */
export function dshProjectKey(cwd: string): string {
  let readable = "";
  let separatorRun = false;
  for (const ch of cwd) {
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

export function dshTranscriptPath(home: string, cwd: string, sid: string, version: 3 | 4 = 3): string {
  if (!SESSION_ID_RE.test(sid)) throw new Error("invalid session id");
  return join(home, "sessions", dshProjectKey(cwd), sid, `session.v${version}.jsonl`);
}

export async function readDshTranscript(home: string, cwd: string, sid: string): Promise<TranscriptMessage[] | null> {
  // The harness may retain v3 after migrating a session; v4 is authoritative.
  for (const version of [4, 3] as const) {
    const file = Bun.file(dshTranscriptPath(home, cwd, sid, version));
    if (await file.exists()) return parseDshTranscript(await file.text());
  }
  return null;
}

type DshBlock = { type?: string; text?: string };
type DshEvent = {
  type?: string;
  data?: {
    content?: DshBlock[];
    source?: { kind?: string };
    message?: { role?: string; content?: DshBlock[] };
    name?: string;
    arguments?: unknown;
  };
};

/** The harness log: `user/message` from the user, `assistant/message` text, `tool/call` names. Runtime-context snapshots are skipped. */
export function parseDshTranscript(jsonl: string): TranscriptMessage[] {
  const msgs: TranscriptMessage[] = [];
  for (const line of jsonl.split("\n")) {
    let ev: DshEvent;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const d = ev.data ?? {};
    if (ev.type === "user/message" && d.source?.kind === "user") {
      const text = (d.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("");
      if (text.trim()) msgs.push({ role: "user", text });
    } else if (ev.type === "assistant/message") {
      for (const b of d.message?.content ?? []) if (b.type === "text" && b.text) addText(msgs, String(b.text));
    } else if (ev.type === "tool/call") {
      let input: unknown = d.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* keep the raw text */
        }
      }
      addTool(msgs, String(d.name ?? "tool"), input);
    }
  }
  return msgs;
}

// ---------------------------------------------------------------- shared

type ToolStep = Extract<TranscriptStep, { kind: "tool" }>;
const STEP_MAX = 12000;
const clip = (text: string) => text.slice(0, STEP_MAX);

function lastAi(msgs: TranscriptMessage[]): Extract<TranscriptMessage, { role: "ai" }> {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "ai") return last;
  const fresh = { role: "ai" as const, text: "", tools: [], steps: [] };
  msgs.push(fresh);
  return fresh;
}

function addText(msgs: TranscriptMessage[], text: string): void {
  const last = lastAi(msgs);
  last.text += (last.text ? "\n\n" : "") + text;
  (last.steps ??= []).push({ kind: "text", text });
}

function addTool(msgs: TranscriptMessage[], name: string, input: unknown, output = "", failed = false): ToolStep {
  const last = lastAi(msgs);
  last.tools.push({ name, hint: toolHint(input) });
  const step: ToolStep = { kind: "tool", name, input: clip(monitorInput(name, input) ?? stepInput(input)), output: clip(output), failed };
  (last.steps ??= []).push(step);
  return step;
}

/** What a tool step shows as its input: the command, the file, the query, else the input as JSON. */
function stepInput(input: unknown): string {
  if (typeof input === "string") return clip(input);
  if (typeof input !== "object" || input === null) return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.queries ?? i.url;
  if (typeof v === "string") return clip(v);
  if (Array.isArray(v)) return clip(v.join(" "));
  return clip(JSON.stringify(input, null, 2) ?? "");
}

/** A tool result's content as text: a string, the text blocks of a list, else JSON. */
function resultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.flatMap((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? [String((b as { text?: unknown }).text ?? "")] : []));
    if (texts.length) return texts.join("\n");
  }
  return JSON.stringify(content) ?? "";
}

export function toolHint(input: unknown): string {
  if (typeof input !== "object" || input === null) return typeof input === "string" ? input.replace(/\s+/g, " ").slice(0, 42) : "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.path ?? i.query ?? i.queries ?? "";
  return (Array.isArray(v) ? v.join(" ") : String(v)).replace(/\s+/g, " ").slice(0, 42);
}

/**
 * Codex persists rollouts by date; verify the session metadata and cwd before returning one.
 *
 * Tool calls come from the `item_completed` events, which carry the same command, file-change,
 * search and MCP items the live chat shows. The raw model calls (`response_item`) are only read
 * when a rollout has no such items (older CLIs): in code mode they are one `exec` script per batch
 * of commands. A question the agent asked (`request_user_input`) is a raw call in either case.
 */
export async function readCodexTranscript(cwd: string, sid: string, home = process.env.CODEX_HOME || join(homedir(), ".codex")): Promise<TranscriptMessage[] | null> {
  if (!SESSION_ID_RE.test(sid)) throw new Error("invalid session id");
  if (!existsSync(join(home, "sessions"))) return null;
  for await (const path of new Bun.Glob(`sessions/**/rollout-*-${sid}.jsonl`).scan({ cwd: home, absolute: true, onlyFiles: true })) {
    const messages = parseCodexTranscript(await Bun.file(path).text(), cwd, sid);
    if (messages) return messages;
  }
  return null;
}

/** One rollout as a transcript; null when it belongs to another session or directory. */
export function parseCodexTranscript(jsonl: string, cwd: string, sid: string): TranscriptMessage[] | null {
  const events: { type?: string; payload?: Record<string, any> }[] = [];
  for (const line of jsonl.split("\n")) {
    try { events.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  const itemTools = events.some((e) => e?.type === "event_msg" && e.payload?.type === "item_completed" && codexItemTool(e.payload.item) !== null);
  const messages: TranscriptMessage[] = [];
  const calls = new Map<string, ToolStep>();
  let matches = false;
  let previousUser: { source: string; text: string } | undefined;
  const user = (text: string, source: string) => {
    if (!text.trim()) return;
    // Some CLI versions persist both forms for the same input, in either order.
    if (previousUser?.text === text && previousUser.source !== source) {
      previousUser = undefined;
      return;
    }
    messages.push({ role: "user", text });
    previousUser = { source, text };
  };
  for (const event of events) {
    const data = event?.payload;
    if (!data) continue;
    if (event.type === "session_meta") matches = data.id === sid && data.cwd === cwd;
    // event_msg contains the actual user input, without injected environment instructions.
    if (event.type === "event_msg" && data.type === "user_message" && typeof data.message === "string") user(data.message, "event_msg");
    if (event.type === "event_msg" && data.type === "task_started") previousUser = undefined;
    if (event.type === "event_msg" && data.type === "item_completed") {
      const tool = codexItemTool(data.item);
      if (tool) {
        previousUser = undefined;
        addTool(messages, tool.name, tool.input, tool.output, tool.failed);
      }
    }
    if (event.type !== "response_item") continue;
    if (data.type === "message" && data.role === "user") {
      const text = (Array.isArray(data.content) ? data.content : [])
        .filter((b: { type?: string; text?: unknown }) => b.type === "input_text" && typeof b.text === "string")
        .map((b: { text: string }) => b.text)
        .filter((text: string) => !/^# AGENTS\.md instructions for [^\n]+\n/.test(text)
          && !/^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(text)
          && !/^\s*<image\b[^>]*>\s*$/.test(text) && !/^\s*<\/image>\s*$/.test(text))
        .join("\n");
      user(text, "response_item");
    }
    if (data.type === "message" && data.role === "assistant") {
      previousUser = undefined;
      const text = (data.content ?? []).filter((b: { type: string }) => b.type === "output_text").map((b: { text: string }) => b.text).join("");
      if (text) addText(messages, text);
    }
    const call = codexCall(data);
    if (call && (!itemTools || call.name === "AskUserQuestion")) {
      previousUser = undefined;
      const step = addTool(messages, call.name, call.input);
      if (typeof data.call_id === "string") calls.set(data.call_id, step);
    }
    if ((data.type === "function_call_output" || data.type === "custom_tool_call_output") && typeof data.call_id === "string") {
      const step = calls.get(data.call_id);
      if (step) step.output = clip(step.name === "AskUserQuestion" ? codexAnswers(data.output) : codexOutput(data.output));
    }
  }
  return matches ? messages : null;
}

type CodexTool = { name: string; input: unknown; output: string; failed: boolean };

/** A completed rollout item as a tool step; null for items that are not tool calls (messages, reasoning, sleeps). */
function codexItemTool(item: any): CodexTool | null {
  if (!item || typeof item !== "object") return null;
  const failed = item.status === "failed" || item.status === "declined" || (typeof item.exit_code === "number" && item.exit_code !== 0) || Boolean(item.error);
  if (item.type === "CommandExecution") {
    const argv = item.command;
    // The shell wrapper (`/bin/zsh -lc <script>`) adds nothing: show the script.
    const command = Array.isArray(argv) ? (argv.length === 3 && /^-l?c$/.test(String(argv[1])) ? String(argv[2]) : argv.join(" ")) : String(argv ?? "");
    return { name: "Bash", input: { command }, output: String(item.aggregated_output ?? item.stderr ?? ""), failed };
  }
  if (item.type === "FileChange") {
    const changes: [string, any][] = Array.isArray(item.changes) ? item.changes.map((c: any) => [String(c?.path ?? ""), c]) : Object.entries(item.changes ?? {});
    const output = changes.map(([path, c]) => c?.unified_diff ?? c?.diff ?? (typeof c?.content === "string" ? `+++ ${path}\n${c.content}` : path)).join("\n");
    return { name: "Edit", input: { path: changes.map(([path]) => path).join(", ") }, output: output || String(item.stdout ?? ""), failed };
  }
  if ((item.type === "Extension" && item.kind === "web.search") || item.type === "WebSearch") {
    const queries = item.action?.queries;
    const query = item.query || (Array.isArray(queries) ? queries.join(" · ") : "");
    const results = Array.isArray(item.results) ? item.results.map((r: any) => [r?.title, r?.domain].filter(Boolean).join(" — ")).filter(Boolean).join("\n") : "";
    return { name: "WebSearch", input: { query }, output: results, failed };
  }
  if (item.type === "McpToolCall") {
    const result = item.error?.message ?? item.result ?? "";
    return { name: String(item.tool ?? "mcp"), input: item.arguments ?? {}, output: typeof result === "string" ? result : JSON.stringify(result), failed };
  }
  return null;
}

/** A raw model call: a function call, a custom tool (`apply_patch`, code mode's `exec`) or a shell call. */
function codexCall(data: Record<string, any>): { name: string; input: unknown } | null {
  if (data.type === "function_call") {
    let input: unknown = data.arguments;
    try { input = JSON.parse(String(input)); } catch { /* Keep text arguments. */ }
    if (data.name === "request_user_input") return { name: "AskUserQuestion", input: codexQuestions(input) };
    return { name: String(data.name ?? "tool"), input };
  }
  if (data.type === "custom_tool_call") return { name: String(data.name ?? "tool"), input: String(data.input ?? "") };
  if (data.type === "local_shell_call") {
    const argv = data.action?.command;
    return { name: "Bash", input: { command: Array.isArray(argv) ? argv.join(" ") : String(argv ?? "") } };
  }
  return null;
}

function codexQuestions(input: unknown): string {
  const questions = (input as { questions?: { question?: unknown; options?: { label?: unknown }[] }[] } | null)?.questions;
  if (!Array.isArray(questions)) return "";
  return questions.map((q) => [String(q?.question ?? ""), ...(Array.isArray(q?.options) ? q.options.map((o) => `· ${String(o?.label ?? "")}`) : [])].join("\n")).join("\n\n");
}

/** `{"answers":{"<id>":{"answers":["Tea"]}}}` as `Tea`; one line per question. */
function codexAnswers(output: unknown): string {
  try {
    const answers = (JSON.parse(String(output)) as { answers?: Record<string, { answers?: unknown[] }> }).answers ?? {};
    return Object.values(answers).map((a) => (a?.answers ?? []).map(String).join(", ")).join("\n");
  } catch {
    return codexOutput(output);
  }
}

function codexOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && typeof (output as { content?: unknown }).content === "string") return (output as { content: string }).content;
  return resultText(output);
}
