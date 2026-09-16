import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptMessage } from "./types.ts";

/**
 * Past chat sessions, read back from each runtime's own records so restoring
 * one costs no storage of ours. Tool results and framework messages are
 * skipped; consecutive assistant blocks merge into one message.
 *
 *   Claude Code       ~/.claude/projects/<cwd encoded>/<sid>.jsonl
 *   DeepSeek Harness  $DSH_HOME/sessions/<cwd encoded>/<sid>/session.v3.jsonl (plain JSONL; the
 *                     harness must be configured with `compression: none`, see docs/runtimes.md)
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
    } else if (ev.type === "assistant" && Array.isArray(content)) {
      const last = lastAi(msgs);
      for (const b of content) {
        if (b?.type === "text" && b.text) last.text += (last.text ? "\n\n" : "") + String(b.text);
        else if (b?.type === "tool_use") last.tools.push({ name: String(b.name ?? "tool"), hint: toolHint(b.input) });
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

export function dshTranscriptPath(home: string, cwd: string, sid: string): string {
  if (!SESSION_ID_RE.test(sid)) throw new Error("invalid session id");
  return join(home, "sessions", dshProjectKey(cwd), sid, "session.v3.jsonl");
}

export async function readDshTranscript(home: string, cwd: string, sid: string): Promise<TranscriptMessage[] | null> {
  const file = Bun.file(dshTranscriptPath(home, cwd, sid));
  if (!(await file.exists())) return null;
  return parseDshTranscript(await file.text());
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
      const last = lastAi(msgs);
      for (const b of d.message?.content ?? []) if (b.type === "text" && b.text) last.text += (last.text ? "\n\n" : "") + String(b.text);
    } else if (ev.type === "tool/call") {
      let input: unknown = d.arguments;
      if (typeof input === "string") {
        try {
          input = JSON.parse(input);
        } catch {
          /* keep the raw text */
        }
      }
      lastAi(msgs).tools.push({ name: String(d.name ?? "tool"), hint: toolHint(input) });
    }
  }
  return msgs;
}

// ---------------------------------------------------------------- shared

function lastAi(msgs: TranscriptMessage[]): Extract<TranscriptMessage, { role: "ai" }> {
  const last = msgs[msgs.length - 1];
  if (last && last.role === "ai") return last;
  const fresh = { role: "ai" as const, text: "", tools: [] };
  msgs.push(fresh);
  return fresh;
}

export function toolHint(input: unknown): string {
  if (typeof input !== "object" || input === null) return typeof input === "string" ? input.replace(/\s+/g, " ").slice(0, 42) : "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.path ?? i.query ?? i.queries ?? "";
  return (Array.isArray(v) ? v.join(" ") : String(v)).replace(/\s+/g, " ").slice(0, 42);
}
