import { join } from "node:path";
import { GATEWAY_AUTH, GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN, type GatewayAuth, type GatewayConfig, type GatewayProvider } from "./types.ts";

/**
 * The built-in model gateway's configuration: `<workspace>/gateway.yaml` (docs/model-gateway.md#configuration).
 *
 *   providers:
 *     deepseek:
 *       preset: deepseek                  # optional: the bases of a vendor checked against its docs
 *       messages: https://…               # base that speaks Anthropic Messages ({messages}/v1/messages)
 *       openai: https://api.openai.com/v1 # OpenAI-style base (audio, images)
 *       auth: bearer                      # optional: x-api-key or bearer on the messages base
 *       apiKeyEnv: DEEPSEEK_API_KEY       # never the key itself
 *       models: [deepseek-chat]           # optional: listed in /v1/models
 *   groups:
 *     fast: [deepseek/deepseek-chat, glm/glm-4.5-air]   # tried in order
 *
 * A file of its own, not a key of runtimes.yaml or providers.yaml: both parsers refuse an unknown
 * key, so an older ai-space would lose its runtimes or its speech on a rollback. No file: no
 * built-in gateway, and nothing changes. A provider whose key variable is empty stays listed, off,
 * with a warning, as a speech provider does.
 */

export const GATEWAY_FILE = "gateway.yaml";

/**
 * Bases of vendors checked against their own documentation on 2026-11-23 (docs/model-gateway.md#presets
 * lists the pages). Only the bases: the key always comes from `apiKeyEnv`. A vendor not here is
 * written out with its URL.
 */
export const GATEWAY_PRESETS: Record<string, Pick<GatewayProvider, "messages" | "openai" | "auth">> = {
  anthropic: { messages: "https://api.anthropic.com", auth: "x-api-key" },
  deepseek: { messages: "https://api.deepseek.com/anthropic", auth: "bearer" },
  zai: { messages: "https://api.z.ai/api/anthropic", auth: "bearer" },
  zhipu: { messages: "https://open.bigmodel.cn/api/anthropic", auth: "bearer" },
  kimi: { messages: "https://api.moonshot.ai/anthropic", auth: "bearer" },
  minimax: { messages: "https://api.minimax.io/anthropic", auth: "bearer" },
  dashscope: { messages: "https://dashscope.aliyuncs.com/apps/anthropic", auth: "bearer" },
  openai: { openai: "https://api.openai.com/v1", auth: "bearer" },
  groq: { openai: "https://api.groq.com/openai/v1", auth: "bearer" },
};

export type LoadedGateway = { config: GatewayConfig; warnings: string[] };

export function parseGatewayYaml(text: string, env: Record<string, string | undefined> = process.env): LoadedGateway {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    throw new Error(`${GATEWAY_FILE}: invalid YAML: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) throw new Error(`${GATEWAY_FILE}: must be a mapping`);
  for (const key of Object.keys(doc)) if (key !== "providers" && key !== "groups") throw new Error(`${GATEWAY_FILE}: unknown key "${key}"`);
  if (!isRecord(doc.providers) || Object.keys(doc.providers).length === 0) throw new Error(`${GATEWAY_FILE}: providers must be a non-empty mapping`);

  const warnings: string[] = [];
  const off: Record<string, string> = {};
  const providers: GatewayProvider[] = [];
  for (const [name, raw] of Object.entries(doc.providers)) {
    const p = parseProvider(name, raw, env);
    providers.push(p);
    if (p.apiKeyEnv && !p.apiKey) {
      off[name] = `${p.apiKeyEnv} is not set`;
      warnings.push(`model gateway provider ${name} is off: ${p.apiKeyEnv} is not set`);
    }
  }
  const groups = parseGroups(doc.groups, providers);
  return { config: { providers, groups, off }, warnings };
}

function parseProvider(name: string, raw: unknown, env: Record<string, string | undefined>): GatewayProvider {
  const ctx = `${GATEWAY_FILE}: provider ${name}`;
  if (!GATEWAY_NAME_PATTERN.test(name)) throw new Error(`${GATEWAY_FILE}: invalid provider name "${name}" (lowercase letters, digits and -)`);
  if (!isRecord(raw)) throw new Error(`${ctx} must be a mapping`);
  for (const key of Object.keys(raw)) if (!["preset", "messages", "openai", "auth", "apiKeyEnv", "models"].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  const presetName = optionalString(raw.preset, `${ctx}: preset`);
  const preset = presetName === undefined ? undefined : GATEWAY_PRESETS[presetName];
  if (presetName !== undefined && !preset) throw new Error(`${ctx}: preset must be one of ${Object.keys(GATEWAY_PRESETS).join(", ")}`);
  const messages = baseUrl(raw.messages, `${ctx}: messages`) ?? preset?.messages;
  const openai = baseUrl(raw.openai, `${ctx}: openai`) ?? preset?.openai;
  if (!messages && !openai) throw new Error(`${ctx} needs a messages or an openai base (or a preset)`);
  const auth = optionalString(raw.auth, `${ctx}: auth`) ?? preset?.auth ?? "bearer";
  if (!(GATEWAY_AUTH as readonly string[]).includes(auth)) throw new Error(`${ctx}: auth must be x-api-key or bearer`);
  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
  if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${ctx}: apiKeyEnv must name an environment variable, never hold the key`);
  const apiKey = apiKeyEnv ? env[apiKeyEnv]?.trim() || undefined : undefined;
  let models: string[] = [];
  if (raw.models !== undefined && raw.models !== null) {
    if (!Array.isArray(raw.models) || !raw.models.every((m) => typeof m === "string" && GATEWAY_MODEL_PATTERN.test(m.trim()))) throw new Error(`${ctx}: models must be a list of model names`);
    models = [...new Set((raw.models as string[]).map((m) => m.trim()))];
  }
  return {
    name, auth: auth as GatewayAuth, models,
    ...(messages ? { messages } : {}), ...(openai ? { openai } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(apiKey ? { apiKey } : {}), ...(presetName ? { preset: presetName } : {}),
  };
}

function parseGroups(raw: unknown, providers: GatewayProvider[]): Record<string, string[]> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${GATEWAY_FILE}: groups must map a name to a list of provider/model`);
  const out: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(raw)) {
    const ctx = `${GATEWAY_FILE}: group ${name}`;
    if (!GATEWAY_NAME_PATTERN.test(name)) throw new Error(`${GATEWAY_FILE}: invalid group name "${name}" (lowercase letters, digits and -)`);
    if (providers.some((p) => p.name === name)) throw new Error(`${ctx}: a group may not be named like a provider`);
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${ctx} must be a non-empty list of provider/model`);
    const members: string[] = [];
    for (const entry of list) {
      if (typeof entry !== "string") throw new Error(`${ctx}: every member is a provider/model string`);
      const id = entry.trim();
      const split = splitModelId(id);
      if (!split) throw new Error(`${ctx}: ${id} must be provider/model`);
      if (!providers.some((p) => p.name === split.provider)) throw new Error(`${ctx}: ${id} names provider ${split.provider}, which is not in this file`);
      if (members.includes(id)) throw new Error(`${ctx} lists ${id} twice`);
      members.push(id);
    }
    out[name] = members;
  }
  return out;
}

/** `provider/model` → its parts; undefined when it is not that shape. */
export function splitModelId(id: string): { provider: string; model: string } | undefined {
  const slash = id.indexOf("/");
  if (slash < 0) return undefined;
  const provider = id.slice(0, slash);
  const model = id.slice(slash + 1);
  if (!GATEWAY_NAME_PATTERN.test(provider) || !GATEWAY_MODEL_PATTERN.test(model)) return undefined;
  return { provider, model };
}

/** The file when present; undefined when the space has none (no built-in gateway). Throws on an invalid file. */
export async function loadGateway(workspaceHome: string, env: Record<string, string | undefined> = process.env): Promise<LoadedGateway | undefined> {
  const file = Bun.file(join(workspaceHome, GATEWAY_FILE));
  if (!(await file.exists())) return undefined;
  return parseGatewayYaml(await file.text(), env);
}

/** A base URL: http(s), a host, a path or none, no query, fragment or credentials; trailing slashes dropped. */
function baseUrl(v: unknown, ctx: string): string | undefined {
  const s = optionalString(v, ctx);
  if (s === undefined) return undefined;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${ctx} must be an http(s) URL`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname || u.search || u.hash || u.username || u.password) throw new Error(`${ctx} must be an http(s) URL without a query, fragment or credentials`);
  return s.replace(/\/+$/, "");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown, ctx: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${ctx} must be a string`);
  return v.trim() || undefined;
}
