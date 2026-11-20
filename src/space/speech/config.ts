import { join } from "node:path";
import {
  KIND_CAPABILITIES,
  PROVIDER_NAME_PATTERN,
  ROLE_CAPABILITY,
  SPEECH_KINDS,
  SPEECH_ROLES,
  VOICE_PATTERN,
  type OpenAiSpec,
  type Price,
  type ProviderSpec,
  type SpeechConfig,
  type SpeechKind,
  type SpeechRole,
} from "./types.ts";

/**
 * Which speech providers a space has (docs/speech.md#configuration): the `speech:` section of
 * `<workspace>/providers.yaml`, or, without it, the one `voice-studio` provider every space had before.
 *
 *   speech:
 *     default: { asr: gpu, tts: gpu }   # live: defaults to asr's
 *     providers:
 *       gpu: { kind: voice-studio, machine: gpu-box }
 *       openai: { kind: openai-compatible, url: https://api.openai.com/v1, apiKeyEnv: OPENAI_API_KEY }
 *     fallback: { asr: [openai] }
 *     voices: { narrator: { gpu: en-Frank_man, openai: onyx } }
 *
 * A file of its own, not a section of runtimes.yaml: an older ai-space refuses an unknown key there
 * and would lose its runtimes on a rollback. Keys stay in the environment: `apiKeyEnv` names the
 * variable; a provider whose variable is empty stays listed, off, with a warning.
 */

export const PROVIDERS_FILE = "providers.yaml";
export const OPENAI_URL = "https://api.openai.com/v1";

export type LoadedSpeech = { config: SpeechConfig; source: "file" | "builtin"; warnings: string[] };

/** The space without a file: `voice-studio` here, else on its one peer, for all three roles. */
export function builtinSpeech(): SpeechConfig {
  return {
    providers: [{ name: "voice-studio", kind: "voice-studio", app: "voice-studio" }],
    default: { asr: "voice-studio", tts: "voice-studio", live: "voice-studio" },
    fallback: {},
    voices: {},
    off: {},
  };
}

export function parseProvidersYaml(text: string, env: Record<string, string | undefined> = process.env): { config: SpeechConfig; warnings: string[]; source: "file" | "builtin" } {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    throw new Error(`${PROVIDERS_FILE}: invalid YAML: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return { config: builtinSpeech(), warnings: [], source: "builtin" };
  if (!isRecord(doc)) throw new Error(`${PROVIDERS_FILE}: must be a mapping`);
  for (const key of Object.keys(doc)) if (key !== "speech") throw new Error(`${PROVIDERS_FILE}: unknown key "${key}"`);
  if (doc.speech === undefined || doc.speech === null) return { config: builtinSpeech(), warnings: [], source: "builtin" };
  const { config, warnings } = parseSpeech(doc.speech, env);
  return { config, warnings, source: "file" };
}

export function parseSpeech(raw: unknown, env: Record<string, string | undefined> = process.env): { config: SpeechConfig; warnings: string[] } {
  const ctx = `${PROVIDERS_FILE}: speech`;
  if (!isRecord(raw)) throw new Error(`${ctx} must be a mapping`);
  for (const key of Object.keys(raw)) if (!["default", "providers", "fallback", "voices"].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  if (!isRecord(raw.providers) || Object.keys(raw.providers).length === 0) throw new Error(`${ctx}.providers must be a non-empty mapping`);

  const warnings: string[] = [];
  const off: Record<string, string> = {};
  const providers: ProviderSpec[] = [];
  for (const [name, p] of Object.entries(raw.providers)) {
    if (!PROVIDER_NAME_PATTERN.test(name)) throw new Error(`${ctx}: invalid provider name "${name}"`);
    if (!isRecord(p)) throw new Error(`${ctx}: provider ${name} must be a mapping`);
    const kind = p.kind;
    if (typeof kind !== "string" || !(SPEECH_KINDS as readonly string[]).includes(kind)) throw new Error(`${ctx}: provider ${name}: kind must be one of ${SPEECH_KINDS.join(", ")}`);
    const spec = parseProvider(name, kind as SpeechKind, p, env);
    providers.push(spec.spec);
    if (spec.off) {
      off[name] = spec.off;
      warnings.push(`speech provider ${name} is off: ${spec.off}`);
    }
  }
  const byName = new Map(providers.map((p) => [p.name, p]));
  const can = (name: string, role: SpeechRole) => KIND_CAPABILITIES[byName.get(name)!.kind].includes(ROLE_CAPABILITY[role]);
  const known = (name: unknown, where: string): string => {
    if (typeof name !== "string" || !byName.has(name)) throw new Error(`${where}: ${String(name)} is not a provider in this file`);
    return name;
  };

  const def: SpeechConfig["default"] = {};
  if (raw.default !== undefined && raw.default !== null) {
    if (!isRecord(raw.default)) throw new Error(`${ctx}.default must map asr, tts and live to providers`);
    for (const [role, name] of Object.entries(raw.default)) {
      if (!(SPEECH_ROLES as readonly string[]).includes(role)) throw new Error(`${ctx}.default has unknown key "${role}"`);
      const p = known(name, `${ctx}.default.${role}`);
      // A reserved kind has no capabilities yet: it may be named, and is off.
      if (byName.get(p)!.kind !== "dashscope" && !can(p, role as SpeechRole)) throw new Error(`${ctx}.default.${role}: ${p} (${byName.get(p)!.kind}) cannot ${ROLE_CAPABILITY[role as SpeechRole]}`);
      def[role as SpeechRole] = p;
    }
  } else if (providers.length === 1) {
    const only = providers[0]!;
    for (const role of SPEECH_ROLES) if (can(only.name, role)) def[role] = only.name;
  } else throw new Error(`${ctx}.default is required with more than one provider`);
  // Live follows asr when the asr provider can stream.
  if (!def.live && def.asr && (byName.get(def.asr)!.kind === "dashscope" || can(def.asr, "live"))) def.live = def.asr;

  const fallback: SpeechConfig["fallback"] = {};
  if (raw.fallback !== undefined && raw.fallback !== null) {
    if (!isRecord(raw.fallback)) throw new Error(`${ctx}.fallback must map asr, tts and live to lists of providers`);
    for (const [role, list] of Object.entries(raw.fallback)) {
      const where = `${ctx}.fallback.${role}`;
      if (!(SPEECH_ROLES as readonly string[]).includes(role)) throw new Error(`${ctx}.fallback has unknown key "${role}"`);
      if (!Array.isArray(list) || list.length === 0) throw new Error(`${where} must be a non-empty list of providers`);
      const entries: string[] = [];
      for (const entry of list) {
        const p = known(entry, where);
        if (entries.includes(p)) throw new Error(`${where} lists ${p} twice`);
        if (byName.get(p)!.kind !== "dashscope" && !can(p, role as SpeechRole)) throw new Error(`${where}: ${p} (${byName.get(p)!.kind}) cannot ${ROLE_CAPABILITY[role as SpeechRole]}`);
        entries.push(p);
      }
      fallback[role as SpeechRole] = entries;
    }
  }
  if (!fallback.live && fallback.asr) {
    const live = fallback.asr.filter((p) => byName.get(p)!.kind !== "dashscope" && can(p, "live"));
    if (live.length) fallback.live = live;
  }

  const voices: SpeechConfig["voices"] = {};
  if (raw.voices !== undefined && raw.voices !== null) {
    if (!isRecord(raw.voices)) throw new Error(`${ctx}.voices must map a voice name to each provider's own voice`);
    for (const [voice, map] of Object.entries(raw.voices)) {
      const where = `${ctx}.voices.${voice}`;
      if (!VOICE_PATTERN.test(voice) || voice.includes("/")) throw new Error(`${ctx}.voices: invalid voice name "${voice}"`);
      if (byName.has(voice)) throw new Error(`${where}: a voice may not be named like a provider`);
      if (!isRecord(map) || Object.keys(map).length === 0) throw new Error(`${where} must map providers to their own voice names`);
      const out: Record<string, string> = {};
      for (const [p, own] of Object.entries(map)) {
        known(p, where);
        if (!KIND_CAPABILITIES[byName.get(p)!.kind].includes("speak") && byName.get(p)!.kind !== "dashscope") throw new Error(`${where}: ${p} (${byName.get(p)!.kind}) cannot speak`);
        if (typeof own !== "string" || !VOICE_PATTERN.test(own.trim())) throw new Error(`${where}.${p} must be a voice name`);
        out[p] = own.trim();
      }
      voices[voice] = out;
    }
  }
  return { config: { providers, default: def, fallback, voices, off }, warnings };
}

function parseProvider(name: string, kind: SpeechKind, raw: Record<string, unknown>, env: Record<string, string | undefined>): { spec: ProviderSpec; off?: string } {
  const ctx = `${PROVIDERS_FILE}: speech provider ${name}`;
  const allowed: Record<SpeechKind, string[]> = {
    "voice-studio": ["kind", "app", "machine"],
    "openai-compatible": ["kind", "url", "apiKeyEnv", "asrModel", "ttsModel", "voice", "voices", "selfHosted", "responseFormat", "price"],
    dashscope: ["kind", "apiKeyEnv", "url", "asrModel", "ttsModel", "voice", "voices", "price"],
  };
  for (const key of Object.keys(raw)) if (!allowed[kind].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  switch (kind) {
    case "voice-studio": {
      const app = optionalString(raw.app, `${ctx}: app`) ?? "voice-studio";
      if (!PROVIDER_NAME_PATTERN.test(app)) throw new Error(`${ctx}: app must be an app name`);
      const machine = optionalString(raw.machine, `${ctx}: machine`);
      if (machine !== undefined && !PROVIDER_NAME_PATTERN.test(machine)) throw new Error(`${ctx}: machine must be a peer name`);
      return { spec: { name, kind, app, ...(machine ? { machine } : {}) } };
    }
    case "openai-compatible": {
      const url = (optionalString(raw.url, `${ctx}: url`) ?? OPENAI_URL).replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s/]+/.test(url)) throw new Error(`${ctx}: url must be an http(s) URL`);
      const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
      if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${ctx}: apiKeyEnv must name an environment variable`);
      const apiKey = apiKeyEnv ? env[apiKeyEnv]?.trim() || undefined : undefined;
      const model = (key: string, fallback: string) => {
        const v = optionalString(raw[key], `${ctx}: ${key}`) ?? fallback;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v)) throw new Error(`${ctx}: ${key} must name a model`);
        return v;
      };
      const voice = optionalString(raw.voice, `${ctx}: voice`);
      if (voice !== undefined && !VOICE_PATTERN.test(voice)) throw new Error(`${ctx}: voice must be a voice name`);
      let voices: string[] | undefined;
      if (raw.voices !== undefined) {
        if (!Array.isArray(raw.voices) || !raw.voices.every((v) => typeof v === "string" && VOICE_PATTERN.test(v.trim()))) throw new Error(`${ctx}: voices must be a list of voice names`);
        voices = (raw.voices as string[]).map((v) => v.trim());
        if (voice && !voices.includes(voice)) throw new Error(`${ctx}: voice ${voice} is not in its voices list`);
      }
      if (raw.selfHosted !== undefined && typeof raw.selfHosted !== "boolean") throw new Error(`${ctx}: selfHosted must be true or false`);
      const responseFormat = optionalString(raw.responseFormat, `${ctx}: responseFormat`);
      if (responseFormat !== undefined && responseFormat !== "json" && responseFormat !== "verbose_json") throw new Error(`${ctx}: responseFormat must be json or verbose_json`);
      const price = parsePrice(raw.price, ctx);
      const spec: OpenAiSpec = {
        name, kind, url, asrModel: model("asrModel", "whisper-1"), ttsModel: model("ttsModel", "tts-1"),
        selfHosted: raw.selfHosted === true,
        ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(apiKey ? { apiKey } : {}), ...(voice ? { voice } : {}), ...(voices ? { voices } : {}),
        ...(responseFormat ? { responseFormat: responseFormat as OpenAiSpec["responseFormat"] } : {}), ...(price ? { price } : {}),
      };
      return { spec, ...(apiKeyEnv && !apiKey ? { off: `${apiKeyEnv} is not set` } : {}) };
    }
    case "dashscope": {
      const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
      return { spec: { name, kind, ...(apiKeyEnv ? { apiKeyEnv } : {}) }, off: "the dashscope kind is not built yet (docs/speech.md#later)" };
    }
  }
}

function parsePrice(raw: unknown, ctx: string): Price | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`${ctx}: price must be a mapping`);
  const out: Price = {};
  for (const [key, v] of Object.entries(raw)) {
    if (key !== "transcribePerMinute" && key !== "speakPerMillionChars") throw new Error(`${ctx}: price has unknown key "${key}"`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${ctx}: price.${key} must be a number of USD`);
    out[key] = v;
  }
  return out;
}

/** The file when it has a `speech:` section, else the built-in single provider. */
export async function loadSpeech(workspaceHome: string, env: Record<string, string | undefined> = process.env): Promise<LoadedSpeech> {
  const file = Bun.file(join(workspaceHome, PROVIDERS_FILE));
  if (!(await file.exists())) return { config: builtinSpeech(), source: "builtin", warnings: [] };
  const { config, warnings, source } = parseProvidersYaml(await file.text(), env);
  return { config, source, warnings };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown, ctx: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${ctx} must be a string`);
  return v.trim() || undefined;
}
