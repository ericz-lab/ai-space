import { fetchVendorImage, type VendorImageDeps } from "../model/vendor-image.ts";
import type { GatewayLink } from "../gateway/types.ts";
import { gatewayFigures } from "../gateway/trace.ts";
import { sniffImage } from "../model/images.ts";
import { DEFAULT_IMAGE_SYSTEM } from "../model/types.ts";
import { readUsage } from "../gateway/forward.ts";
import type { AnthropicApiSpec, Backend, CompleteInput, CompleteOutcome, GeneratedImage, ImageInput, ImageOutcome, RuntimeAdapter, Usage } from "./types.ts";
import { FILE_NAME_PATTERN, Unsupported } from "./types.ts";

/**
 * The Messages API as a runtime: answers only. No login state, no tools (a
 * request that asks for them is refused rather than quietly served without),
 * no agent runs or chats. Files (images an app or the chat service sends) go
 * in the user message as base64 image blocks. Aliases the CLI understands are mapped to model ids;
 * anything else is passed to the API as is. Cost is computed from the list
 * prices below for the models listed, and left unknown otherwise.
 *
 * `url` may point at a gateway that speaks the same API, such as magpie on this machine
 * (docs/model-gateway.md#magpie): its `provider/model` ids come from the runtime's `models:` pins, and
 * what it says answered (`X-Magpie-Model`) goes into the call's trace as `served`. A refusal's
 * Retry-After is kept in the error (`retry after 30s`), where failure.ts reads when to try again.
 *
 * `gateway: space` (docs/model-gateway.md) answers through the built-in model gateway: its loopback
 * address, a token issued for the one call instead of a key, and what answered read from that
 * token's trace as `served`.
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

export function createAnthropicApi(spec: AnthropicApiSpec, deps: { fetch?: typeof fetch; gateway?: GatewayLink; vendorImage?: VendorImageDeps } = {}): RuntimeAdapter {
  const doFetch = deps.fetch ?? fetch;
  const backend: Backend = "api";
  /** Where one call goes, and with which key: the spec's, or the built-in gateway's with a token of its own. */
  const target = (): { apiUrl: string; apiKey: string; run?: string } | { error: string } => {
    if (spec.gateway !== "space") return { apiUrl: spec.apiUrl || DEFAULT_API_URL, apiKey: spec.apiKey };
    const base = deps.gateway?.base();
    if (!deps.gateway || !base) return { error: `runtime ${spec.name} answers through the built-in model gateway, which is off: ${deps.gateway?.problem() ?? "this space has none"}` };
    const grant = deps.gateway.issue();
    return { apiUrl: `${base}/v1/messages`, apiKey: grant.token, run: grant.run };
  };
  // Pictures through the built-in gateway when one of its providers has an OpenAI-style base
  // (docs/model-gateway.md#images). Read when asked: Settings → Gateway may add or remove that provider while ai-space runs.
  const capabilities: RuntimeAdapter["capabilities"] = { complete: true, agent: false, chat: false };
  if (spec.gateway === "space" && deps.gateway) Object.defineProperty(capabilities, "image", { enumerable: true, get: () => (deps.gateway!.has("openai") ? true : undefined) });
  return {
    name: spec.name,
    kind: "anthropic-api",
    backend,
    capabilities,
    ...(spec.gateway === "space" && deps.gateway
      ? {
          image: async (input: ImageInput, signal?: AbortSignal): Promise<ImageOutcome> => {
            const base = deps.gateway!.base();
            if (!deps.gateway!.has("openai")) return { ok: false, error: `runtime ${spec.name}: no provider of the built-in model gateway can make pictures (none is on with an openai base)`, backend };
            if (!base) return { ok: false, error: `runtime ${spec.name} answers through the built-in model gateway, which is off: ${deps.gateway!.problem()}`, backend };
            const grant = deps.gateway!.issue();
            const outcome = await gatewayImage(input, { base: `${base}/v1`, token: grant.token, fetch: doFetch, signal, ...(deps.vendorImage ? { vendorImage: deps.vendorImage } : {}) });
            const trace = deps.gateway!.trace(grant.run);
            const served = trace?.served;
            // The pictures' cost at the answering model's price (per picture, or its tokens), and the answers to price them again.
            const priced = { ...outcome, ...(trace?.costUsd !== undefined ? { costUsd: trace.costUsd } : {}), ...(trace?.priceBasis ? { priceBasis: trace.priceBasis } : {}) } as ImageOutcome;
            // What answered goes in the account of the pictures; the ledger row keeps the model asked for.
            return priced.ok && served ? { ...priced, text: `${priced.text} by ${served}` } : priced;
          },
        }
      : {}),
    complete: async (input, signal) => {
      const t = target();
      if ("error" in t) return { ok: false, error: t.error, backend };
      const outcome = await runApi(input, { apiKey: t.apiKey, apiUrl: t.apiUrl, fetch: doFetch, signal });
      if (!t.run) return outcome;
      // Through the built-in gateway: what answered, and its cost at that model's price, from the run's trace.
      const { costUsd: _, ...rest } = outcome;
      return gatewayFigures(rest as CompleteOutcome, deps.gateway!.trace(t.run));
    },
    runAgent: () => Promise.reject(new Unsupported(spec.name, "agent runs")),
    chat: () => {
      throw new Unsupported(spec.name, "chat");
    },
  };
}

/**
 * The built-in model gateway called directly (docs/model.md#models): an app's text call or picture
 * call that names a gateway model (`<provider>/<model>`) goes here, with no runtime. Text goes out
 * as Anthropic Messages to the gateway's loopback route, pictures as OpenAI Images; each call
 * carries a token issued for it, and what answered, its cost and the answers to price again come
 * from that token's trace. Failover is the gateway's own (its rests); there is no runtime fallback.
 *
 * Not a runtime: it is not in runtimes.yaml, not listed, never a default. The model service holds
 * it under the name `gateway` and writes its rows with no runtime and backend `gateway`.
 */
export function createGatewayModels(deps: { gateway: GatewayLink; fetch?: typeof fetch; vendorImage?: VendorImageDeps }): RuntimeAdapter {
  const doFetch = deps.fetch ?? fetch;
  const backend: Backend = "gateway";
  const off = () => `the built-in model gateway is off: ${deps.gateway.problem() ?? "it does not listen yet"}`;
  return {
    name: "gateway",
    // The shape of the calls it makes; the service never shows it as a runtime.
    kind: "anthropic-api",
    backend,
    capabilities: { complete: true, agent: false, chat: false, image: true },
    complete: async (input, signal) => {
      const base = deps.gateway.base();
      if (!base) return { ok: false, error: off(), backend };
      const grant = deps.gateway.issue();
      const outcome = await runApi(input, { apiKey: grant.token, apiUrl: `${base}/v1/messages`, fetch: doFetch, signal });
      const { costUsd: _, ...rest } = outcome;
      return gatewayFigures({ ...rest, backend } as CompleteOutcome, deps.gateway.trace(grant.run));
    },
    image: async (input, signal) => {
      const base = deps.gateway.base();
      if (!base) return { ok: false, error: off(), backend };
      const grant = deps.gateway.issue();
      // The image route's default system is an instruction to an agent with an image tool: a picture
      // model gets only what the caller sent (its prompt, and its system when it sent one).
      const sent = input.system === DEFAULT_IMAGE_SYSTEM ? { ...input, system: "" } : input;
      const outcome = await gatewayImage(sent, { base: `${base}/v1`, token: grant.token, fetch: doFetch, signal, ...(deps.vendorImage ? { vendorImage: deps.vendorImage } : {}) });
      const trace = deps.gateway.trace(grant.run);
      const priced = { ...outcome, backend, ...(trace?.costUsd !== undefined ? { costUsd: trace.costUsd } : {}), ...(trace?.priceBasis ? { priceBasis: trace.priceBasis } : {}) } as ImageOutcome;
      return priced.ok && trace?.served ? { ...priced, text: `${priced.text} by ${trace.served}` } : priced;
    },
    runAgent: () => Promise.reject(new Unsupported("gateway", "agent runs")),
    chat: () => {
      throw new Unsupported("gateway", "chat");
    },
  };
}

/**
 * The user message: the prompt alone, or, with files, each image as a base64 block after a text
 * block naming it (the prompt refers to files by name, `img1.png`), then the prompt.
 */
export async function userContent(input: Pick<CompleteInput, "prompt" | "files">): Promise<string | Record<string, unknown>[]> {
  if (!input.files?.length) return input.prompt;
  const blocks: Record<string, unknown>[] = [];
  for (const f of input.files) {
    const bytes = await Bun.file(f.path).bytes();
    const type = sniffImage(bytes);
    if (!type) throw new Error(`${f.name} is not a png, jpeg, gif or webp image`);
    blocks.push({ type: "text", text: f.name }, { type: "image", source: { type: "base64", media_type: type, data: Buffer.from(bytes).toString("base64") } });
  }
  blocks.push({ type: "text", text: input.prompt });
  return blocks;
}

async function runApi(input: CompleteInput, o: { apiKey: string; apiUrl: string; fetch: typeof fetch; signal?: AbortSignal }): Promise<CompleteOutcome> {
  const backend: Backend = "api";
  if (input.tools.length) return { ok: false, error: "tools need a CLI runtime; the API has none", backend };
  if (input.files?.some((f) => !FILE_NAME_PATTERN.test(f.name))) return { ok: false, error: "file name not allowed", backend };
  let content: Awaited<ReturnType<typeof userContent>>;
  try {
    content = await userContent(input);
  } catch (e) {
    return { ok: false, error: `could not read a file: ${(e as Error).message}`, backend };
  }
  const model = API_MODELS[input.model] ?? input.model;
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(input.timeoutMs)]) : AbortSignal.timeout(input.timeoutMs);
  let res: Response;
  try {
    res = await o.fetch(o.apiUrl, {
      method: "POST",
      headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: input.maxTokens, system: input.system, messages: [{ role: "user", content }] }),
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

/**
 * One OpenAI Images call through the built-in gateway: `images/generations` from the prompt, or
 * `images/edits` (multipart, one `image[]` per input file) when input images are given. `b64_json`
 * is asked for; a vendor that answers only with a URL (Zhipu, Z.ai) has that picture fetched under
 * the rules of model/vendor-image.ts: the URL comes from the vendor's answer here, never from a
 * caller. GPT image models always answer base64 and refuse `response_format`, so it is asked only
 * of the others.
 */
export async function gatewayImage(input: ImageInput, o: { base: string; token: string; fetch: typeof fetch; signal?: AbortSignal; vendorImage?: VendorImageDeps }): Promise<ImageOutcome> {
  const backend: Backend = "api";
  const prompt = input.system ? `${input.system}\n\n${input.prompt}` : input.prompt;
  const bare = input.model.slice(input.model.indexOf("/") + 1);
  const format = /^(gpt-image|chatgpt-image)/i.test(bare) ? {} : { response_format: "b64_json" };
  const signal = o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(input.timeoutMs)]) : AbortSignal.timeout(input.timeoutMs);
  let res: Response;
  try {
    if (input.files.length) {
      const form = new FormData();
      form.append("model", input.model);
      form.append("prompt", prompt);
      for (const [k, v] of Object.entries(format)) form.append(k, v);
      for (const f of input.files) {
        if (!FILE_NAME_PATTERN.test(f.name)) return { ok: false, error: "file name not allowed", backend };
        const bytes = await Bun.file(f.path).bytes();
        form.append("image[]", new File([bytes], f.name, { type: sniffImage(bytes) ?? "application/octet-stream" }));
      }
      res = await o.fetch(`${o.base}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${o.token}` }, body: form, signal });
    } else {
      res = await o.fetch(`${o.base}/images/generations`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: JSON.stringify({ model: input.model, prompt, n: 1, ...format }), signal });
    }
  } catch (e) {
    const err = e as Error;
    return { ok: false, error: err.name === "TimeoutError" ? `timed out after ${Math.round(input.timeoutMs / 1000)}s` : err.message, backend };
  }
  const body = (await res.json().catch(() => ({}))) as { data?: { b64_json?: unknown; url?: unknown }[]; usage?: unknown; error?: { message?: string } };
  const usage = readUsage(body.usage);
  if (!res.ok) return { ok: false, error: `API ${res.status}: ${body.error?.message ?? "request failed"}`, backend, ...(usage ? { usage } : {}) };
  const images: GeneratedImage[] = [];
  const refused: string[] = [];
  for (const d of (body.data ?? []).slice(0, 4)) {
    if (typeof d.b64_json === "string") {
      const bytes = new Uint8Array(Buffer.from(d.b64_json, "base64"));
      images.push({ type: sniffImage(bytes) ?? "image/png", bytes });
    } else if (typeof d.url === "string") {
      const got = await fetchVendorImage(d.url, o.vendorImage);
      if (got.ok) images.push({ type: got.type, bytes: got.bytes });
      else refused.push(got.error);
    }
  }
  if (!images.length) return { ok: false, error: refused[0] ?? "no image produced", backend, ...(usage ? { usage } : {}) };
  return { ok: true, text: `${images.length} image${images.length === 1 ? "" : "s"}`, images, backend, ...(usage ? { usage } : {}) };
}

/** Retry-After as whole seconds: a number of seconds, or an HTTP date. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(v)) return Math.ceil(Number(v));
  const at = Date.parse(v);
  return Number.isFinite(at) && at > now ? Math.ceil((at - now) / 1000) : undefined;
}
