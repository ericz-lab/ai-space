import { MAX_PROMPT_CHARS } from "../model/types.ts";
import { HISTORY_WINDOW, type Attachment, type Message, type Role } from "./types.ts";

/**
 * The prompt one turn sends: the app's context as the first user turn, the
 * assistant's acknowledgement, the thread so far, the new message. One flat
 * text, because a runtime takes one prompt; the roles are marked in it.
 *
 *   <context.text>
 *
 *   ---
 *
 *   [assistant]
 *   <context.ack>
 *
 *   [user]
 *   <earlier message>
 *   (attached: a17.png)
 *
 *   [assistant]
 *   <earlier answer>
 *
 *   [user]
 *   <message>
 *
 * A failed answer and the message that caused it are left out; neighbours
 * with the same role are merged; the history is the last HISTORY_WINDOW
 * messages, then trimmed further from the oldest pair until the whole prompt
 * fits the model service's limit, so a long thread never fails outright.
 */

export type Turn = { role: Role; content: string };

/** Messages worth replaying: failed answers and the message that caused them are skipped. */
export function replayable(messages: Message[]): Turn[] {
  const out: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.error) continue;
    const next = messages[i + 1];
    if (m.role === "user" && next?.role === "assistant" && next.error) continue;
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Roles must alternate: merge neighbours with the same role, drop empty turns and a leading assistant. */
export function alternate(turns: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const t of turns) {
    const content = t.content.trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content = `${last.content}\n\n${content}`;
    else out.push({ role: t.role, content });
  }
  if (out[0]?.role === "assistant") out.shift();
  return out;
}

export type PromptInput = {
  context?: { text?: string; ack?: string };
  /** The thread before this turn, oldest first. */
  history: Message[];
  /** Attachments of the thread by message id; the ones in `shipped` are named as files, the rest as no longer visible. */
  attachments: Map<number, Attachment[]>;
  shipped: Set<number>;
  /** File name each shipped attachment has for the runtime (`a17.png`). */
  fileName: (a: Attachment) => string;
  message: string;
  /** Attachments of the new message. */
  messageAttachments: Attachment[];
  limit?: number;
};

function attachmentLine(list: Attachment[] | undefined, shipped: Set<number>, fileName: (a: Attachment) => string): string {
  if (!list?.length) return "";
  const now = list.filter((a) => shipped.has(a.id)).map(fileName);
  const gone = list.filter((a) => !shipped.has(a.id)).map((a) => a.name);
  const parts = [...(now.length ? [`(attached: ${now.join(", ")})`] : []), ...(gone.length ? [`(attached earlier: ${gone.join(", ")} — no longer visible)`] : [])];
  return parts.length ? `\n${parts.join("\n")}` : "";
}

export function buildPrompt(input: PromptInput): string {
  const limit = input.limit ?? MAX_PROMPT_CHARS - 4_096;
  const head: string[] = [];
  if (input.context?.text?.trim()) head.push(input.context.text.trim(), "---");
  if (input.context?.ack?.trim()) head.push(`[assistant]\n${input.context.ack.trim()}`);
  const tail = `[user]\n${input.message.trim()}${attachmentLine(input.messageAttachments, input.shipped, input.fileName)}`;

  // Each replayed user message carries its attachment line; assistant turns are plain.
  const withLines: Message[] = input.history.map((m) => (m.role === "user" ? { ...m, content: m.content + attachmentLine(input.attachments.get(m.id), input.shipped, input.fileName) } : m));
  let turns = alternate(replayable(withLines.slice(-HISTORY_WINDOW)));
  const render = (ts: Turn[]) => [...head, ...ts.map((t) => `[${t.role}]\n${t.content}`), tail].join("\n\n");
  let text = render(turns);
  while (text.length > limit && turns.length) {
    turns = turns.slice(turns[0]!.role === "user" && turns[1]?.role === "assistant" ? 2 : 1);
    if (turns[0]?.role === "assistant") turns = turns.slice(1);
    text = render(turns);
  }
  return text;
}
