/**
 * The Director's status line (docs/orders.md#state): the last line of every reply it gives, in
 * exactly this form, which the orders service reads and the Orders page hides:
 *
 *   〔状态: done〕          the order is dealt with, nothing waits for the person
 *   〔状态: needs-you〕     the reply asks the person something; the topic waits for their answer
 *   〔状态: failed〕        the Director could not do it
 *   〔状态: working〕       something it started goes on by itself (read as done once the turn ended)
 *
 * The line `hive` used carried an owner after the state (`〔状态: working · 负责人: …〕`); anything
 * after the state up to the closing bracket is accepted and ignored. ASCII brackets, an English
 * `status` and a full-width colon are accepted too, since a model may write them. Pure: the page imports it.
 */

export const REPORTED_STATES = ["working", "needs-you", "done", "failed"] as const;
export type ReportedState = (typeof REPORTED_STATES)[number];

/** The canonical line the prompt asks for. */
export const statusLine = (state: ReportedState) => `〔状态: ${state}〕`;

const LINE = /^\s*[〔[【]\s*(?:状态|狀態|status)\s*[:：]\s*(working|needs-you|done|failed)\b[^〕\]】\n]*[〕\]】]\s*$/i;

/** The state the reply's last non-empty line reports; undefined when it has none. */
export function parseStatus(text: string): ReportedState | undefined {
  const last = lastLine(text);
  const m = last === undefined ? null : LINE.exec(last);
  return m ? (m[1]!.toLowerCase() as ReportedState) : undefined;
}

/** The reply without its status line (and the blank lines before it). */
export function stripStatus(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  if (lines.length && LINE.test(lines[lines.length - 1]!)) {
    lines.pop();
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
  }
  return lines.join("\n");
}

/** One line of what the reply says last, for a notification: the last non-empty line before the status, trimmed. */
export function lastWords(text: string, max = 200): string {
  const line = lastLine(stripStatus(text))?.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function lastLine(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim());
  return lines[lines.length - 1];
}
