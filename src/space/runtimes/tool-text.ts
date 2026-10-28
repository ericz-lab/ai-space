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
