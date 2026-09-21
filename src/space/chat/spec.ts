import { MAX_SYSTEM_CHARS, MAX_THINKING_TOKENS, MAX_TIMEOUT_MS, MODEL_PATTERN, TOOL_PATTERN } from "../model/types.ts";
import { CHAT_TOOLS, DEFAULT_TIMEOUT_MS, MAX_ACK_CHARS, MAX_ATTACHMENTS_PER_MESSAGE, MAX_CONTEXT_CHARS, MAX_MESSAGE_CHARS, MAX_TITLE_CHARS, SCOPE_PATTERN, type TurnInput } from "./types.ts";

/** Validation of what comes over the API, strict like the model service's: an unknown shape is rejected with the reason. */

export function parseScope(raw: unknown): string {
  if (typeof raw !== "string" || !SCOPE_PATTERN.test(raw)) throw new Error("scope must match [a-z0-9][a-z0-9:._/-]{0,127}");
  return raw;
}

export function parseTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("title must be a string");
  return raw.trim().slice(0, MAX_TITLE_CHARS);
}

export function parseTurnInput(body: Record<string, unknown>): TurnInput {
  if (typeof body.message !== "string" || !body.message.trim()) throw new Error("message is required");
  if (body.message.length > MAX_MESSAGE_CHARS) throw new Error(`message is longer than ${MAX_MESSAGE_CHARS} characters`);

  let context: TurnInput["context"];
  if (body.context !== undefined) {
    const c = body.context;
    if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("context must be an object");
    const { system, text, ack } = c as Record<string, unknown>;
    context = {};
    if (system !== undefined) {
      if (typeof system !== "string" || !system.trim()) throw new Error("context.system must be a non-empty string");
      if (system.length > MAX_SYSTEM_CHARS) throw new Error(`context.system is longer than ${MAX_SYSTEM_CHARS} characters`);
      context.system = system;
    }
    if (text !== undefined) {
      if (typeof text !== "string") throw new Error("context.text must be a string");
      if (text.length > MAX_CONTEXT_CHARS) throw new Error(`context.text is longer than ${MAX_CONTEXT_CHARS} characters`);
      context.text = text;
    }
    if (ack !== undefined) {
      if (typeof ack !== "string") throw new Error("context.ack must be a string");
      if (ack.length > MAX_ACK_CHARS) throw new Error(`context.ack is longer than ${MAX_ACK_CHARS} characters`);
      context.ack = ack;
    }
  }

  let attachments: number[] = [];
  if (body.attachments !== undefined) {
    if (!Array.isArray(body.attachments) || !body.attachments.every((a) => Number.isInteger(a) && (a as number) > 0)) throw new Error("attachments must be an array of ids");
    attachments = [...new Set(body.attachments as number[])];
    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error(`at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message`);
  }

  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !MODEL_PATTERN.test(body.model)) throw new Error("model must be a model alias or id (letters, digits, . _ : -)");
    model = body.model;
  }

  let tools: string[] = [];
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || !body.tools.every((t) => typeof t === "string")) throw new Error("tools must be an array of strings");
    tools = [...new Set((body.tools as string[]).map((t) => t.trim()).filter(Boolean))];
    for (const t of tools) if (!TOOL_PATTERN.test(t) || !CHAT_TOOLS.has(t)) throw new Error(`tool not available in a chat: ${t}`);
  }

  let thinking: number | undefined;
  if (body.thinking !== undefined) {
    if (typeof body.thinking !== "number" || !Number.isInteger(body.thinking) || body.thinking < 0) throw new Error("thinking must be a non-negative integer (0 turns thinking off)");
    thinking = Math.min(body.thinking, MAX_THINKING_TOKENS);
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    timeoutMs = Math.min(Math.round(body.timeoutMs), MAX_TIMEOUT_MS);
  }

  return { message: body.message, attachments, tools, timeoutMs, ...(context ? { context } : {}), ...(model ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}
