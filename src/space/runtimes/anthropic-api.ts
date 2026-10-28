import type { AnthropicApiSpec, Backend, CompleteInput, CompleteOutcome, RuntimeAdapter, Usage } from "./types.ts";
import { Unsupported } from "./types.ts";

/**
 * The Messages API as a runtime: answers only. No login state, no tools (a
 * request that asks for them is refused rather than quietly served without),
 * no agent runs or chats. Aliases the CLI understands are mapped to model ids;
 * anything else is passed to the API as is. Cost is computed from the list
 * prices below for the models listed, and left unknown otherwise.
 *
 * `url` may point at a gateway that speaks the same API, such as magpie on this machine
 * (docs/runtimes.md#magpie): its `provider/model` ids come from the runtime's `models:` pins, and
 * what it says answered (`X-Magpie-Model`) goes into the call's trace as `served`. A refusal's
 * Retry-After is kept in the error (`retry after 30s`), where failure.ts reads when to try again.
 */

export const DEFAULT_API_URL = "https://api.anthropic.com/v1/messages";

export const API_MODELS: Record<string, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5",
};

/** API list prices in USD per million tokens: input, cache write, cache read, output. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-4-5": [1, 1.25, 0.1, 5],
  "claude-sonnet-5": [2, 2.5, 0.2, 10],
  "claude-opus-5": [5, 6.25, 0.5, 25],
};

/** Cost of one API call from its usage, for the models whose prices are listed. */
export function apiCost(model: string, u: Usage): number | undefined {
  const p = PRICES[model];
  if (!p) return undefined;
  return (u.inputTokens * p[0] + u.cacheWriteTokens * p[1] + u.cacheReadTokens * p[2] + u.outputTokens * p[3]) / 1e6;
}

export function createAnthropicApi(spec: AnthropicApiSpec, deps: { fetch?: typeof fetch } = {}): RuntimeAdapter {
  const doFetch = deps.fetch ?? fetch;
  const backend: Backend = "api";
  return {
    name: spec.name,
    kind: "anthropic-api",
    backend,
    capabilities: { complete: true, agent: false, chat: false },
    complete: (input, signal) =>
      input.files?.length
        ? Promise.resolve({ ok: false, error: "files need a runtime with a Read tool; the API backend takes text only", backend })
        : runApi(input, { apiKey: spec.apiKey, apiUrl: spec.apiUrl || DEFAULT_API_URL, fetch: doFetch, signal }),
    runAgent: () => Promise.reject(new Unsupported(spec.name, "agent runs")),
    chat: () => {
      throw new Unsupported(spec.name, "chat");
    },
  };
}

async function runApi(input: CompleteInput, o: { apiKey: string; apiUrl: string; fetch: typeof fetch; signal?: AbortSignal }): Promise<CompleteOutcome> {
  const backend: Backend = "api";
  if (input.tools.length) return { ok: false, error: "tools need a CLI runtime; the API has none", backend };
  const model = API_MODELS[input.model] ?? input.model;
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(input.timeoutMs)]) : AbortSignal.timeout(input.timeoutMs);
  let res: Response;
  try {
    res = await o.fetch(o.apiUrl, {
      method: "POST",
      headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: input.maxTokens, system: input.system, messages: [{ role: "user", content: input.prompt }] }),
      signal,
    });
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "TimeoutError" ? `timed out after ${Math.round(input.timeoutMs / 1000)}s` : err.message, backend };
  }
  const body = (await res.json().catch(() => ({}))) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    error?: { message?: string };
  };
  const served = res.headers.get("x-magpie-model")?.trim().slice(0, 200) || undefined;
  const upstream = served ? { served } : {};
  if (!res.ok) {
    const wait = retryAfterSeconds(res.headers.get("retry-after"));
    return { ok: false, error: `API ${res.status}: ${body.error?.message ?? "request failed"}${wait !== undefined ? ` (retry after ${wait}s)` : ""}`, backend, ...upstream };
  }
  const u = body.usage;
  const usage: Usage | undefined = u
    ? { inputTokens: u.input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, outputTokens: u.output_tokens ?? 0 }
    : undefined;
  const costUsd = usage ? apiCost(model, usage) : undefined;
  const text = (body.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
  if (!text) return { ok: false, error: "empty answer", usage, costUsd, backend, ...upstream };
  return { ok: true, text, usage, costUsd, backend, ...upstream };
}

/** Retry-After as whole seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.ceil(Number(v));
  const at = Date.parse(v);
  return Number.isFinite(at) && at > now ? Math.ceil((at - now) / 1000) : undefined;
}
