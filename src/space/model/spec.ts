import { DEFAULT_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, MAX_PROMPT_CHARS, MAX_TIMEOUT_MS, MODEL_PATTERN, type RunInput, TAG_PATTERN, TOOL_PATTERN, WINDOWS, type Window } from "./types.ts";

/**
 * Validation of what comes over the API. Strict like manifests: an unknown
 * shape is rejected with the reason, never coerced.
 */

export function parseRunInput(body: Record<string, unknown>, defaults: { model?: string } = {}): RunInput {
  if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required");
  if (body.prompt.length > MAX_PROMPT_CHARS) throw new Error(`prompt is longer than ${MAX_PROMPT_CHARS} characters`);

  const model = body.model === undefined ? (defaults.model ?? DEFAULT_MODEL) : body.model;
  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) throw new Error("model must be a model alias or id (letters, digits, . _ : -)");

  const tag = body.tag === undefined ? "other" : body.tag;
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) throw new Error("tag must match [a-z0-9][a-z0-9._-]{0,63}");

  let tools: string[] = [];
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || !body.tools.every((t) => typeof t === "string")) throw new Error("tools must be an array of strings");
    tools = (body.tools as string[]).map((t) => t.trim()).filter(Boolean);
    for (const t of tools) if (!TOOL_PATTERN.test(t)) throw new Error(`invalid tool name: ${t}`);
    if (tools.length > 20) throw new Error("at most 20 tools");
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    if (typeof body.timeoutMs !== "number" || !Number.isFinite(body.timeoutMs) || body.timeoutMs <= 0) throw new Error("timeoutMs must be a positive number");
    timeoutMs = Math.min(Math.round(body.timeoutMs), MAX_TIMEOUT_MS);
  }

  let maxTokens = DEFAULT_MAX_TOKENS;
  if (body.maxTokens !== undefined) {
    if (typeof body.maxTokens !== "number" || !Number.isInteger(body.maxTokens) || body.maxTokens <= 0) throw new Error("maxTokens must be a positive integer");
    maxTokens = Math.min(body.maxTokens, 128_000);
  }

  return { prompt: body.prompt, model, tag, tools, timeoutMs, maxTokens };
}

export function parseWindow(raw: string | null | undefined): Window {
  if (raw === null || raw === undefined || raw === "") return "24h";
  if ((WINDOWS as readonly string[]).includes(raw)) return raw as Window;
  throw new Error(`window must be one of ${WINDOWS.join(", ")}`);
}
