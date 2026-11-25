import { join } from "node:path";
import { parseHeaders } from "../peers/config.ts";
import { MAGPIE_CALLER_KEY, magpieAddress } from "../runtimes/magpie.ts";
import {
  KIND_CAPABILITIES,
  PROVIDER_NAME_PATTERN,
  ROLE_CAPABILITY,
  SPEECH_KINDS,
  SPEECH_ROLES,
  VOICE_PATTERN,
  type MinimaxSpec,
  type OpenAiSpec,
  type Price,
  type ProviderSpec,
  type SpeechConfig,
  type SpeechKind,
  type SpeechRole,
  type VoiceStudioAddress,
  type VoiceStudioSpec,
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
/** MiniMax's two sites: a key from one is refused at the other (docs/speech.md#kinds). */
export const MINIMAX_SITES = { cn: "https://api.minimaxi.com", intl: "https://api.minimax.io" } as const;
export const MINIMAX_DEFAULT_MODELS = { asr: "asr-1.0", tts: "speech-2.8-turbo" } as const;

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
    "voice-studio": ["kind", "app", "machine", "url", "urls", "apiKeyEnv"],
    "openai-compatible": ["kind", "url", "apiKeyEnv", "asrModel", "ttsModel", "voice", "voices", "selfHosted", "responseFormat", "price", "gateway", "provider"],
    minimax: ["kind", "url", "site", "apiKeyEnv", "asrModel", "ttsModel", "voice", "voices", "price", "gateway", "provider"],
    dashscope: ["kind", "apiKeyEnv", "url", "asrModel", "ttsModel", "voice", "voices", "price"],
  };
  for (const key of Object.keys(raw)) if (!allowed[kind].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  switch (kind) {
    case "voice-studio": {
      if (raw.url !== undefined || raw.urls !== undefined || raw.apiKeyEnv !== undefined) return parseVoiceStudioDirect(name, raw, ctx, env);
      const app = optionalString(raw.app, `${ctx}: app`) ?? "voice-studio";
      if (!PROVIDER_NAME_PATTERN.test(app)) throw new Error(`${ctx}: app must be an app name`);
      const machine = optionalString(raw.machine, `${ctx}: machine`);
      if (machine !== undefined && !PROVIDER_NAME_PATTERN.test(machine)) throw new Error(`${ctx}: machine must be a peer name`);
      return { spec: { name, kind, app, ...(machine ? { machine } : {}) } };
    }
    case "openai-compatible": {
      const via = parseGatewayShorthand(raw, ctx);
      let url = (optionalString(raw.url, `${ctx}: url`) ?? OPENAI_URL).replace(/\/+$/, "");
      // magpie is found where setup finds it; the built-in gateway's address is known once ai-space listens (buildAdapters).
      if (via?.via === "magpie") url = `${magpieAddress({ env }).url}/v1`;
      if (via?.via === "space") url = "";
      if (!via && !/^https?:\/\/[^\s/]+/.test(url)) throw new Error(`${ctx}: url must be an http(s) URL`);
      const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
      if (apiKeyEnv !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${ctx}: apiKeyEnv must name an environment variable`);
      const apiKey = via?.via === "magpie" ? MAGPIE_CALLER_KEY : apiKeyEnv ? env[apiKeyEnv]?.trim() || undefined : undefined;
      const model = (key: string, fallback: string) => {
        const v = optionalString(raw[key], `${ctx}: ${key}`) ?? fallback;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(v)) throw new Error(`${ctx}: ${key} must name a model`);
        // Through a gateway a model is the gateway's id for it: `<provider>/<model>`.
        return via ? `${via.provider}/${v}` : v;
      };
      const { voice, voices } = parseVoices(raw, ctx);
      if (raw.selfHosted !== undefined && typeof raw.selfHosted !== "boolean") throw new Error(`${ctx}: selfHosted must be true or false`);
      const responseFormat = optionalString(raw.responseFormat, `${ctx}: responseFormat`);
      if (responseFormat !== undefined && responseFormat !== "json" && responseFormat !== "verbose_json") throw new Error(`${ctx}: responseFormat must be json or verbose_json`);
      const price = parsePrice(raw.price, ctx);
      const spec: OpenAiSpec = {
        name, kind, url, asrModel: model("asrModel", "whisper-1"), ttsModel: model("ttsModel", "tts-1"),
        selfHosted: raw.selfHosted === true,
        ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(apiKey ? { apiKey } : {}), ...(voice ? { voice } : {}), ...(voices ? { voices } : {}),
        ...(responseFormat ? { responseFormat: responseFormat as OpenAiSpec["responseFormat"] } : {}), ...(price ? { price } : {}),
        ...(via ? { gateway: via } : {}),
      };
      return { spec, ...(apiKeyEnv && !apiKey ? { off: `${apiKeyEnv} is not set` } : {}) };
    }
    case "minimax":
      return parseMinimax(name, raw, ctx, env);
    case "dashscope": {
      const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
      return { spec: { name, kind, ...(apiKeyEnv ? { apiKeyEnv } : {}) }, off: "the dashscope kind is not built yet (docs/speech.md#later)" };
    }
  }
}

/**
 * `kind: voice-studio` in direct mode (docs/speech.md#direct): a voice-studio server at its own
 * addresses, with its token in the environment.
 *
 *   gpu:
 *     kind: voice-studio
 *     urls:
 *       - http://192.168.3.48:8920                            # home: the LAN address, preferred
 *       - { url: https://voice.example.com, headersEnv: VOICE_ACCESS }   # away: the tunnel, behind Cloudflare Access
 *     apiKeyEnv: VOICE_STUDIO_TOKEN
 *
 * `url:` is the one-address form. `machine:` (a peer) and `app:` (an app on this space or a peer) do
 * not apply. Each address is an http(s) base URL, optionally with a path prefix, no credentials, no
 * query; plain http only for a host `isLocalHost` accepts, since the token travels in a header.
 */
function parseVoiceStudioDirect(name: string, raw: Record<string, unknown>, ctx: string, env: Record<string, string | undefined>): { spec: VoiceStudioSpec; off?: string } {
  if (raw.machine !== undefined) throw new Error(`${ctx}: machine (a peer) and url/urls (the server's own addresses) are two ways to reach it; give one`);
  if (raw.app !== undefined) throw new Error(`${ctx}: app does not apply to a server reached at its own address; drop it`);
  if (raw.url !== undefined && raw.urls !== undefined) throw new Error(`${ctx}: give url (one address) or urls (a list), not both`);
  const list: unknown[] = raw.urls !== undefined ? (Array.isArray(raw.urls) ? raw.urls : [null]) : raw.url !== undefined ? [raw.url] : [];
  if (raw.urls !== undefined && (!Array.isArray(raw.urls) || raw.urls.length === 0)) throw new Error(`${ctx}: urls must be a non-empty list of addresses`);
  if (!list.length) throw new Error(`${ctx}: apiKeyEnv is the token of a server reached at its own address; add url or urls`);
  const addresses = list.map((entry, i) => parseAddress(entry, `${ctx}: ${raw.urls !== undefined ? `urls[${i}]` : "url"}`, env));
  const seen = new Set<string>();
  for (const a of addresses) {
    if (seen.has(a.url)) throw new Error(`${ctx}: ${a.url} is listed twice`);
    seen.add(a.url);
  }
  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
  if (!apiKeyEnv || !ENV_NAME.test(apiKeyEnv)) throw new Error(`${ctx}: apiKeyEnv must name the environment variable that holds the server's token`);
  const token = env[apiKeyEnv]?.trim() || undefined;
  const spec: VoiceStudioSpec = { name, kind: "voice-studio", app: "voice-studio", direct: { addresses, apiKeyEnv, ...(token ? { token } : {}) } };
  const off = !token ? `${apiKeyEnv} is not set`
    : addresses.every((a) => a.off) ? addresses.map((a) => `${a.host}: ${a.off}`).join("; ")
    : undefined;
  return { spec, ...(off ? { off } : {}) };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Headers the adapter sets itself; an access layer's headers may not replace them. */
const OWN_HEADERS = new Set(["authorization", "host", "cookie", "content-type", "content-length", "transfer-encoding", "connection", "upgrade"]);

function parseAddress(entry: unknown, ctx: string, env: Record<string, string | undefined>): VoiceStudioAddress {
  let raw: unknown = entry;
  let headersEnv: string | undefined;
  if (isRecord(entry)) {
    for (const key of Object.keys(entry)) if (key !== "url" && key !== "headersEnv") throw new Error(`${ctx} has unknown key "${key}"`);
    raw = entry.url;
    headersEnv = optionalString(entry.headersEnv, `${ctx}: headersEnv`);
    if (headersEnv !== undefined && !ENV_NAME.test(headersEnv)) throw new Error(`${ctx}: headersEnv must name an environment variable`);
  }
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`${ctx} must be an address (http://host:port) or { url, headersEnv }`);
  const text = raw.trim();
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`${ctx}: ${text} is not a URL`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`${ctx}: ${text} must be http:// or https://`);
  if (u.username || u.password) throw new Error(`${ctx}: ${text} carries credentials; the token goes in apiKeyEnv`);
  if (u.search || u.hash || text.includes("?") || text.includes("#")) throw new Error(`${ctx}: ${text} must not carry a query or a fragment`);
  const local = isLocalHost(u.hostname);
  if (u.protocol === "http:" && !local) throw new Error(`${ctx}: ${text}: plain http only for a loopback, private-range, link-local, .local or .home.arpa host; use https://, the token travels in a header`);
  if (headersEnv && u.protocol !== "https:") throw new Error(`${ctx}: headersEnv (an access layer's credentials) is sent to https:// addresses only`);
  const url = `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
  let headers: Record<string, string> | undefined;
  let off: string | undefined;
  if (headersEnv) {
    const value = env[headersEnv]?.trim();
    if (!value) off = `${headersEnv} is not set`;
    else {
      try {
        headers = parseHeaders(value);
        const own = Object.keys(headers).find((h) => OWN_HEADERS.has(h.toLowerCase()) || h.toLowerCase().startsWith("sec-websocket-"));
        if (own) throw new Error(`${own} is set by the adapter itself`);
      } catch (e) {
        headers = undefined;
        off = `${headersEnv}: ${(e as Error).message}`;
      }
    }
  }
  return { url, host: u.host, local, ...(headersEnv ? { headersEnv } : {}), ...(headers ? { headers } : {}), ...(off ? { off } : {}) };
}

/**
 * Hosts plain http may go to (docs/speech.md#direct), by the name as written, without resolving it:
 * IPv4 loopback 127/8, RFC 1918 (10/8, 172.16/12, 192.168/16) and link-local 169.254/16; IPv6 loopback
 * ::1, link-local fe80::/10 and unique-local fc00::/7; the names `localhost`, `*.local` (mDNS) and
 * `*.home.arpa` (RFC 8375). Not 100.64/10 (carrier-grade NAT is shared with strangers), not a bare
 * single-label name (it resolves through whatever search domain the network hands out).
 */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".home.arpa")) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h.includes(":")) {
    if (h === "::1") return true;
    const first = parseInt(h.split(":")[0] || "0", 16);
    return (first & 0xffc0) === 0xfe80 || (first & 0xfe00) === 0xfc00;
  }
  return false;
}

function parseVoices(raw: Record<string, unknown>, ctx: string): { voice?: string; voices?: string[] } {
  const voice = optionalString(raw.voice, `${ctx}: voice`);
  if (voice !== undefined && !VOICE_PATTERN.test(voice)) throw new Error(`${ctx}: voice must be a voice name`);
  let voices: string[] | undefined;
  if (raw.voices !== undefined) {
    if (!Array.isArray(raw.voices) || !raw.voices.every((v) => typeof v === "string" && VOICE_PATTERN.test(v.trim()))) throw new Error(`${ctx}: voices must be a list of voice names`);
    voices = (raw.voices as string[]).map((v) => v.trim());
    if (voice && !voices.includes(voice)) throw new Error(`${ctx}: voice ${voice} is not in its voices list`);
  }
  return { ...(voice ? { voice } : {}), ...(voices ? { voices } : {}) };
}

/**
 * `kind: minimax`: either `gateway: space` with `provider:` (the key and the host are that
 * gateway.yaml provider's), or a hand-written entry with `apiKeyEnv` and `site: cn | intl` or `url`.
 * Models are MiniMax's own ids, never `<provider>/<model>`: nothing goes through the gateway.
 */
function parseMinimax(name: string, raw: Record<string, unknown>, ctx: string, env: Record<string, string | undefined>): { spec: MinimaxSpec; off?: string } {
  const via = optionalString(raw.gateway, `${ctx}: gateway`);
  const provider = optionalString(raw.provider, `${ctx}: provider`);
  const model = (key: string, fallback: string) => {
    const v = optionalString(raw[key], `${ctx}: ${key}`) ?? fallback;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)) throw new Error(`${ctx}: ${key} must name a model`);
    return v;
  };
  const { voice, voices } = parseVoices(raw, ctx);
  const price = parsePrice(raw.price, ctx);
  const common = {
    name, kind: "minimax" as const, asrModel: model("asrModel", MINIMAX_DEFAULT_MODELS.asr), ttsModel: model("ttsModel", MINIMAX_DEFAULT_MODELS.tts),
    ...(voice ? { voice } : {}), ...(voices ? { voices } : {}), ...(price ? { price } : {}),
  };
  if (via !== undefined || provider !== undefined) {
    if (via !== "space") throw new Error(`${ctx}: a minimax provider takes its key from the built-in model gateway only: gateway: space`);
    if (!provider || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) throw new Error(`${ctx}: gateway: space needs provider: the gateway's provider name`);
    if (raw.url !== undefined || raw.site !== undefined || raw.apiKeyEnv !== undefined) throw new Error(`${ctx}: through a gateway provider the host and the key are its own; drop url, site and apiKeyEnv`);
    return { spec: { ...common, url: "", gateway: { via: "space", provider } } };
  }
  const site = optionalString(raw.site, `${ctx}: site`);
  if (site !== undefined && site !== "cn" && site !== "intl") throw new Error(`${ctx}: site must be cn (api.minimaxi.com) or intl (api.minimax.io)`);
  const given = optionalString(raw.url, `${ctx}: url`);
  if (given !== undefined && site !== undefined) throw new Error(`${ctx}: give url or site, not both`);
  if (given === undefined && site === undefined) throw new Error(`${ctx}: name the site (site: cn or site: intl): a key from one is refused at the other`);
  const url = (given ?? MINIMAX_SITES[site as "cn" | "intl"]).replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+$/.test(url)) throw new Error(`${ctx}: url must be the API's origin (https://api.minimaxi.com), without a path`);
  const apiKeyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`);
  if (!apiKeyEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new Error(`${ctx}: apiKeyEnv must name the environment variable that holds the key`);
  const apiKey = env[apiKeyEnv]?.trim() || undefined;
  return { spec: { ...common, url, apiKeyEnv, ...(apiKey ? { apiKey } : {}) }, ...(apiKey ? {} : { off: `${apiKeyEnv} is not set` }) };
}

/**
 * `gateway: space | magpie` with `provider: <name>` on an openai-compatible provider: it then
 * speaks to that model gateway's `/v1/audio/*` as that provider, with no url or key of its own.
 */
function parseGatewayShorthand(raw: Record<string, unknown>, ctx: string): OpenAiSpec["gateway"] {
  const via = optionalString(raw.gateway, `${ctx}: gateway`);
  const provider = optionalString(raw.provider, `${ctx}: provider`);
  if (via === undefined) {
    if (provider !== undefined) throw new Error(`${ctx}: provider names a model gateway's provider; add gateway: space or gateway: magpie`);
    return undefined;
  }
  if (via !== "space" && via !== "magpie") throw new Error(`${ctx}: gateway must be space or magpie`);
  if (!provider || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) throw new Error(`${ctx}: gateway: ${via} needs provider: the gateway's provider name`);
  if (raw.url !== undefined || raw.apiKeyEnv !== undefined) throw new Error(`${ctx}: through a model gateway the url and the key are the gateway's; drop url and apiKeyEnv`);
  if (raw.selfHosted !== undefined) throw new Error(`${ctx}: selfHosted does not apply through a model gateway`);
  return { via, provider };
}

/**
 * Speech providers that name a provider of the built-in model gateway it does not have, or one
 * without the base they need (`openai` for openai-compatible, either for minimax), or one that is off: turned off with the reason (a warning each), as a
 * provider whose key is missing is.
 */
export function checkGatewayProviders(config: SpeechConfig, has: (provider: string) => { off?: string; openai: boolean; messages?: boolean } | undefined, configured: boolean): string[] {
  const warnings: string[] = [];
  for (const p of config.providers) {
    if ((p.kind !== "openai-compatible" && p.kind !== "minimax") || p.gateway?.via !== "space" || config.off[p.name]) continue;
    const g = has(p.gateway.provider);
    // A minimax provider needs only a host to read: either base names it.
    const why = !configured ? "the built-in model gateway is off (no gateway.yaml)"
      : !g ? `${p.gateway.provider} is not a provider of gateway.yaml`
      : p.kind === "openai-compatible" && !g.openai ? `the model gateway's provider ${p.gateway.provider} has no openai base`
      : p.kind === "minimax" && !g.openai && !g.messages ? `the model gateway's provider ${p.gateway.provider} has no base to read the host from`
      : g.off ? `the model gateway's provider ${p.gateway.provider} is off (${g.off})`
      : undefined;
    if (why) {
      config.off[p.name] = why;
      warnings.push(`speech provider ${p.name} is off: ${why}`);
    }
  }
  return warnings;
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
