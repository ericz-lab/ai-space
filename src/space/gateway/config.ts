import { join } from "node:path";
import { GATEWAY_AUTH, GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN, GATEWAY_TIERS, type GatewayAuth, type GatewayConfig, type GatewayProvider, type GatewayTier, type GatewayTiers } from "./types.ts";

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
 *   tiers:                                # optional: what answers each ai-space tier through it
 *     advanced: glm/glm-4.6               # mixed vendors are fine; a group works too
 *     intermediate: deepseek/deepseek-chat
 *     image: openai/gpt-image-1           # pictures: a provider with an openai base
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

/**
 * The vendors with a China and an international site: one account works on one site only, so a key
 * from platform.minimaxi.com is refused at api.minimax.io and the other way round. The preset's own
 * base is one of the two; Settings switches to the other by writing it as the provider's base
 * override. Each base answered an unauthenticated Messages call with 401 or 403 on 2026-11-24.
 */
export type GatewaySite = "intl" | "cn";
export const GATEWAY_SITES: Record<string, Record<GatewaySite, Pick<GatewayProvider, "messages" | "openai">>> = {
  minimax: { intl: { messages: "https://api.minimax.io/anthropic" }, cn: { messages: "https://api.minimaxi.com/anthropic" } },
  kimi: { intl: { messages: "https://api.moonshot.ai/anthropic" }, cn: { messages: "https://api.moonshot.cn/anthropic" } },
  dashscope: { intl: { messages: "https://dashscope-intl.aliyuncs.com/apps/anthropic" }, cn: { messages: "https://dashscope.aliyuncs.com/apps/anthropic" } },
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
  for (const key of Object.keys(doc)) if (key !== "providers" && key !== "groups" && key !== "tiers") throw new Error(`${GATEWAY_FILE}: unknown key "${key}"`);
  // No provider yet (the last one removed in Settings): the gateway is on and answers nothing.
  if (doc.providers === undefined || doc.providers === null) doc.providers = {};
  if (!isRecord(doc.providers)) throw new Error(`${GATEWAY_FILE}: providers must be a mapping`);

  const warnings: string[] = [];
  const off: Record<string, string> = {};
  const providers: GatewayProvider[] = [];
  for (const [name, raw] of Object.entries(doc.providers)) {
    const p = parseProvider(name, raw, env);
    providers.push(p);
    if (p.disabled) off[name] = "turned off";
    else if (p.apiKeyEnv && !p.apiKey) {
      off[name] = `${p.apiKeyEnv} is not set`;
      warnings.push(`model gateway provider ${name} is off: ${p.apiKeyEnv} is not set`);
    }
  }
  const groups = parseGroups(doc.groups, providers);
  const tiers = parseTiers(doc.tiers, providers, groups, warnings);
  return { config: { providers, groups, tiers, off }, warnings };
}

function parseProvider(name: string, raw: unknown, env: Record<string, string | undefined>): GatewayProvider {
  const ctx = `${GATEWAY_FILE}: provider ${name}`;
  if (!GATEWAY_NAME_PATTERN.test(name)) throw new Error(`${GATEWAY_FILE}: invalid provider name "${name}" (lowercase letters, digits and -)`);
  if (!isRecord(raw)) throw new Error(`${ctx} must be a mapping`);
  for (const key of Object.keys(raw)) if (!["preset", "messages", "openai", "auth", "apiKeyEnv", "models", "disabled"].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
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
  if (raw.disabled !== undefined && raw.disabled !== null && typeof raw.disabled !== "boolean") throw new Error(`${ctx}: disabled must be true or false`);
  return {
    name, auth: auth as GatewayAuth, models,
    ...(raw.disabled === true ? { disabled: true } : {}),
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

/**
 * `tiers:`: the model or group behind each ai-space tier (basic, junior, intermediate, advanced)
 * and behind `image`. Each should name a group of this file or `provider/model` with a provider of
 * this file that has the base the tier needs: `messages` for text, `openai` for pictures (a group:
 * at least one member that has it). One that does not (a provider removed since) stays, with a
 * warning: its calls fail with the gateway's reason, and the rest of the gateway still answers.
 */
function parseTiers(raw: unknown, providers: GatewayProvider[], groups: Record<string, string[]>, warnings: string[]): GatewayTiers {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${GATEWAY_FILE}: tiers must map ${GATEWAY_TIERS.join(", ")} to a model or a group`);
  const out: GatewayTiers = {};
  for (const [tier, value] of Object.entries(raw)) {
    if (!(GATEWAY_TIERS as readonly string[]).includes(tier)) throw new Error(`${GATEWAY_FILE}: tiers has unknown key "${tier}" (${GATEWAY_TIERS.join(", ")})`);
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string" || !GATEWAY_MODEL_PATTERN.test(value.trim())) throw new Error(`${GATEWAY_FILE}: tiers.${tier} must be a model or a group`);
    const why = tierProblem(tier as GatewayTier, value.trim(), providers, groups);
    if (why) warnings.push(`${GATEWAY_FILE}: tiers.${tier}: ${why}`);
    out[tier as GatewayTier] = value.trim();
  }
  return out;
}

/** Why `id` cannot answer `tier` through this file's providers, or undefined when it can. */
export function tierProblem(tier: GatewayTier, id: string, providers: GatewayProvider[], groups: Record<string, string[]>): string | undefined {
  const base = tier === "image" ? "openai" : "messages";
  const members = groups[id];
  const ids = members ?? [id];
  if (!members) {
    const split = splitModelId(id);
    if (!split) return `${id} is neither a group of this file nor provider/model`;
    if (!providers.some((p) => p.name === split.provider)) return `${id} names provider ${split.provider}, which is not in this file`;
  }
  const can = ids.some((m) => providers.find((p) => p.name === splitModelId(m)?.provider)?.[base]);
  if (!can) return `${id} has no provider with a ${base} base (${tier === "image" ? "pictures" : "text"} go there)`;
  return undefined;
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

/**
 * gateway.yaml with its `tiers:` set to `tiers` (none set removes the block). The text is edited,
 * not re-serialized, so the operator's comments and order elsewhere stay; the block is written
 * where it was, or at the end; a tier that keeps its value keeps its comment. The result must parse with exactly these tiers and every provider
 * and group as before, or nothing is written.
 */
export function setGatewayTiersText(current: string, tiers: GatewayTiers, env: Record<string, string | undefined> = process.env): string {
  const lines = current.split("\n");
  const content = (l: string) => l.trim() !== "" && !l.trim().startsWith("#");
  const indent = (l: string) => /^(\s*)/.exec(l)![1]!.length;
  const at = lines.findIndex((l) => /^tiers:/.test(l));
  if (at >= 0 && !/^tiers:\s*(#.*)?$/.test(lines[at]!)) throw new Error(`${GATEWAY_FILE} writes tiers: on one line; set the tiers by hand`);
  // The indent of the file's own nested keys, so the new lines match it.
  const nested = lines.find((l) => content(l) && indent(l) > 0);
  const pad = " ".repeat(nested ? indent(nested) : 2);
  const set = GATEWAY_TIERS.filter((t) => tiers[t]);
  let last = at;
  if (at >= 0) {
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (!content(l)) continue;
      if (indent(l) === 0) break;
      last = i;
    }
  }
  // A tier that keeps its value keeps its line's comment.
  const kept = new Map<string, string>();
  for (const l of at >= 0 ? lines.slice(at + 1, last + 1) : []) {
    const m = /^\s+([a-z]+):\s*(["']?)([^"'#\s]*)\2\s*(#.*)?$/.exec(l);
    if (m?.[4] && tiers[m[1] as GatewayTier] === m[3]) kept.set(m[1]!, m[4]);
  }
  const line = (t: GatewayTier) => `${pad}${t}: ${JSON.stringify(tiers[t])}${kept.has(t) ? `   ${kept.get(t)}` : ""}`;
  const block = set.length ? [lines[at]?.startsWith("tiers:") ? lines[at]! : "tiers:", ...set.map(line)] : [];
  if (at >= 0) {
    lines.splice(at, last - at + 1, ...block);
  } else if (block.length) {
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(...block, "");
  }
  const next = lines.join("\n");
  const before = parseGatewayYaml(current, env).config;
  const after = parseGatewayYaml(next, env).config;
  const same = (c: GatewayConfig) => JSON.stringify({ ...c, tiers: undefined });
  const want = JSON.stringify(Object.fromEntries(set.map((t) => [t, tiers[t]])));
  if (same(before) !== same(after) || JSON.stringify(after.tiers) !== want) throw new Error(`could not set the tiers in ${GATEWAY_FILE} safely; set them by hand`);
  return next;
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
