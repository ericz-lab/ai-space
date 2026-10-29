/**
 * How a tool call reads in a chat, shared by the live stream (src/web/chat-steps.ts) and restored
 * transcripts (transcripts.ts). Pure: the panel bundles it.
 */

/**
 * A rejected call's message without the CLI's wrapper and the guidance meant for the model: Claude
 * Code answers a deferred tool called before it was loaded (Monitor, often) with the parameter
 * error, a paragraph on loading the tool, and the tool's whole JSON schema.
 */
export function toolErrorText(text: string): string {
  const bare = text.replace(/^\s*<tool_use_error>/, "").replace(/<\/tool_use_error>\s*$/, "");
  const cut = bare.search(/\n*\s*(This tool's schema was not sent to the API|For reference, this tool's input schema is:)/);
  return (cut >= 0 ? bare.slice(0, cut) : bare).trim();
}

/**
 * Monitor (Claude Code's background watch) says what it watches in `description`: that line first,
 * then the command or socket that feeds it. Any other tool, or a Monitor call without a
 * description, is undefined and keeps the usual input.
 */
export function monitorInput(name: string, input: unknown): string | undefined {
  if (name.replace(/^mcp__.*__/, "").toLowerCase() !== "monitor" || typeof input !== "object" || input === null) return undefined;
  const i = input as { description?: unknown; command?: unknown; ws?: { url?: unknown } };
  if (typeof i.description !== "string" || !i.description.trim()) return undefined;
  const source = typeof i.command === "string" ? i.command : typeof i.ws?.url === "string" ? i.ws.url : "";
  return [i.description.trim(), source].filter(Boolean).join("\n");
}

/**
 * A background job's report as Claude Code hands it to the agent, a user message
 * `<task-notification><task-id>…</task-id><status>…</status><summary>…</summary><event>…</event></task-notification>`:
 * a Monitor event carries `<event>`, an ended job `<status>`. `line` is what the chat shows,
 * `detail` what opens under it; null for any other text.
 */
export type TaskNotice = { taskId: string; toolUseId?: string; status?: string; summary: string; event?: string; line: string; detail: string };

export function taskNotice(text: string): TaskNotice | null {
  const body = /^\s*<task-notification>([\s\S]*?)<\/task-notification>/.exec(text)?.[1];
  if (body === undefined) return null;
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim() || undefined;
  const taskId = tag("task-id") ?? "";
  const toolUseId = tag("tool-use-id");
  const status = tag("status");
  const summary = tag("summary") ?? "";
  const event = tag("event");
  const line = (event ? `${summary}: ${event.split("\n")[0]}` : summary) || taskId || "background job";
  const detail = [summary, event, status && `status: ${status}`].filter(Boolean).join("\n");
  return { taskId, ...(toolUseId ? { toolUseId } : {}), ...(status ? { status } : {}), summary, ...(event ? { event } : {}), line: line.slice(0, 300), detail: detail.slice(0, 12000) };
}
