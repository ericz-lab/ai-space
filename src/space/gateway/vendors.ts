import { GATEWAY_PRESETS, GATEWAY_SITES, type GatewaySite } from "./config.ts";
import type { GatewayAuth } from "./types.ts";

/**
 * What Settings → Gateway knows of each preset vendor beyond its bases (docs/model-gateway.md#settings):
 * a label, where its model list is, and the models to offer when it has none. Each list endpoint
 * was checked against the vendor's own documentation on 2026-11-24 (the page in `source`); a vendor
 * that documents none gets its documented model ids, and the owner adds others by hand.
 *
 * Every URL is derived from the provider's configured bases, never a fixed host, so a preset whose
 * base was overridden (a proxy, a test stand-in) is asked at that base.
 */

export type ModelList = { url: string; auth: "x-api-key" | "bearer"; anthropic?: boolean };

export type VendorInfo = {
  label: string;
  /** The model list for these bases, or undefined when the vendor documents none. */
  list: (b: { messages?: string; openai?: string }) => ModelList | undefined;
  /** Offered when there is no list, or it could not be read. */
  defaults: string[];
  source?: string;
};

const strip = (url: string | undefined, suffix: RegExp) => url?.replace(suffix, "");

export const VENDORS: Record<string, VendorInfo> = {
  anthropic: { label: "Anthropic", list: (b) => (b.messages ? { url: `${b.messages}/v1/models?limit=1000`, auth: "x-api-key", anthropic: true } : undefined), defaults: [], source: "https://platform.claude.com/docs/en/api/models-list" },
  deepseek: { label: "DeepSeek", list: (b) => (b.messages ? { url: `${strip(b.messages, /\/anthropic$/)}/models`, auth: "bearer" } : undefined), defaults: ["deepseek-v4-pro", "deepseek-flash"], source: "https://api-docs.deepseek.com/api/list-models" },
  zai: { label: "Z.ai (GLM)", list: () => undefined, defaults: ["glm-5.4", "glm-5.3", "glm-5.3-flash"], source: "https://docs.z.ai/api-reference/introduction" },
  zhipu: { label: "Zhipu BigModel (GLM)", list: () => undefined, defaults: ["glm-5.3", "glm-5.2"], source: "https://docs.bigmodel.cn/cn/guide/develop/claude/introduction" },
  kimi: { label: "Kimi (Moonshot)", list: (b) => (b.messages ? { url: `${strip(b.messages, /\/anthropic$/)}/v1/models`, auth: "bearer" } : undefined), defaults: ["kimi-k3", "kimi-k3.1-pro"], source: "https://platform.kimi.ai/docs/api/list-models" },
  minimax: { label: "MiniMax", list: (b) => (b.messages ? { url: `${b.messages}/v1/models`, auth: "x-api-key", anthropic: true } : undefined), defaults: ["MiniMax-M3", "MiniMax-M3.1-Flash"], source: "https://platform.minimax.io/docs/api-reference/models/anthropic/list-models.md" },
  // Its Anthropic-compatible page says /v1/models is not provided there.
  dashscope: { label: "Alibaba DashScope (Qwen)", list: () => undefined, defaults: ["qwen4-max", "qwen3.7-plus", "qwen3.8-flash", "qwen3-coder-flash"], source: "https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages" },
  openai: { label: "OpenAI", list: (b) => (b.openai ? { url: `${b.openai}/models`, auth: "bearer" } : undefined), defaults: [], source: "https://developers.openai.com/api/reference/resources/models/methods/list" },
  groq: { label: "Groq", list: (b) => (b.openai ? { url: `${b.openai}/models`, auth: "bearer" } : undefined), defaults: [], source: "https://console.groq.com/docs/models" },
};

/**
 * A custom provider's list: its openai base's `/models` (the OpenAI shape), else its messages
 * base's `/v1/models` in the Anthropic shape with its own auth. Tried, and the page falls back to
 * ids typed by hand when the server has neither.
 */
export function customList(b: { messages?: string; openai?: string; auth: GatewayAuth }): ModelList | undefined {
  if (b.openai) return { url: `${b.openai}/models`, auth: "bearer" };
  if (b.messages) return { url: `${b.messages}/v1/models`, auth: b.auth, anthropic: true };
  return undefined;
}

/** The presets as the page offers them. */
export function presetList(): { name: string; label: string; messages?: string; openai?: string; auth: GatewayAuth; hasList: boolean; defaults: string[]; sites?: Record<GatewaySite, { messages?: string; openai?: string }> }[] {
  return Object.entries(GATEWAY_PRESETS).map(([name, p]) => ({
    name,
    label: VENDORS[name]?.label ?? name,
    ...(p.messages ? { messages: p.messages } : {}),
    ...(p.openai ? { openai: p.openai } : {}),
    auth: p.auth ?? "bearer",
    hasList: Boolean(VENDORS[name]?.list({ messages: p.messages, openai: p.openai })),
    defaults: VENDORS[name]?.defaults ?? [],
    ...(GATEWAY_SITES[name] ? { sites: GATEWAY_SITES[name] } : {}),
  }));
}

/** `text` with every occurrence of the key replaced: nothing a vendor echoes back carries it on. */
export function redact(text: string, key: string | undefined): string {
  if (!key || key.length < 4) return text;
  return text.split(key).join("[key]");
}

const LIST_TIMEOUT_MS = 15_000;

function authHeaders(kind: "x-api-key" | "bearer", key: string | undefined, anthropic?: boolean): Record<string, string> {
  const h: Record<string, string> = { accept: "application/json" };
  if (key) {
    if (kind === "x-api-key") h["x-api-key"] = key;
    else h.authorization = `Bearer ${key}`;
  }
  if (anthropic) h["anthropic-version"] = "2023-06-01";
  return h;
}

/** A short reason from a vendor's error answer, the key taken out. */
async function vendorError(res: Response, key: string | undefined): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 2000);
  let msg = text;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    msg = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? text;
  } catch { /* not JSON */ }
  return redact(`HTTP ${res.status}${msg ? `: ${msg.trim().slice(0, 300)}` : ""}`, key);
}

/** The model ids at `list`: `data[].id` (OpenAI and Anthropic shapes). */
export async function fetchModelList(list: ModelList, key: string | undefined, doFetch: typeof fetch = fetch): Promise<{ ok: true; models: string[] } | { ok: false; error: string }> {
  try {
    const res = await doFetch(list.url, { headers: authHeaders(list.auth, key, list.anthropic), signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
    if (!res.ok) return { ok: false, error: await vendorError(res, key) };
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200);
    if (!Array.isArray(body.data)) return { ok: false, error: "the answer has no data list" };
    return { ok: true, models: [...new Set(ids)].sort() };
  } catch (e) {
    return { ok: false, error: redact((e as Error).message, key) };
  }
}

export type TestResult = { base: "messages" | "openai"; ok: boolean; ms: number; status?: number; error?: string; detail?: string };

/**
 * One minimal request per base the provider has, with its key: on `messages`, a one-token
 * Messages call to `model` (it spends a few tokens, so it runs only when the owner asks); on
 * `openai`, the free model list. Never a picture or speech.
 */
export async function testProvider(p: { messages?: string; openai?: string; auth: GatewayAuth }, key: string | undefined, model: string | undefined, doFetch: typeof fetch = fetch, now: () => number = Date.now): Promise<TestResult[]> {
  const out: TestResult[] = [];
  if (p.messages) {
    const t0 = now();
    if (!model) out.push({ base: "messages", ok: false, ms: 0, error: "pick a model to test with: the Messages API needs one" });
    else {
      try {
        const res = await doFetch(`${p.messages}/v1/messages`, {
          method: "POST",
          headers: { ...authHeaders(p.auth, key, true), "content-type": "application/json" },
          body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS * 2),
        });
        const ms = now() - t0;
        if (res.ok) {
          await res.body?.cancel().catch(() => {});
          out.push({ base: "messages", ok: true, ms, status: res.status, detail: model });
        } else out.push({ base: "messages", ok: false, ms, status: res.status, error: await vendorError(res, key) });
      } catch (e) {
        out.push({ base: "messages", ok: false, ms: now() - t0, error: redact((e as Error).message, key) });
      }
    }
  }
  if (p.openai) {
    const t0 = now();
    const r = await fetchModelList({ url: `${p.openai}/models`, auth: "bearer" }, key, doFetch);
    out.push(r.ok ? { base: "openai", ok: true, ms: now() - t0, detail: `${r.models.length} models` } : { base: "openai", ok: false, ms: now() - t0, error: r.error });
  }
  return out;
}
