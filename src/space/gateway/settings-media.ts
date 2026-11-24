import { stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../model/inventory.ts";
import { gatewayImage } from "../runtimes/anthropic-api.ts";
import { PROVIDERS_FILE, builtinSpeech } from "../speech/config.ts";
import { OpenAiAdapter } from "../speech/openai.ts";
import { KIND_CAPABILITIES, ROLE_CAPABILITY, type ProviderSpec, type SpeechConfig, type SpeechRole } from "../speech/types.ts";
import { GATEWAY_FILE, parseGatewayYaml, splitModelId } from "./config.ts";
import { GatewayEditError } from "./edit.ts";
import { documentedIds, kindOf, servesOf, voicesFor } from "./kinds.ts";
import type { ModelGateway } from "./service.ts";
import { MANAGED_PREFIX, chainOf, isManaged, setSpeechText, speechEditProblem, visibleSpeech, type BuiltinPresence, type ChainItem, type SpeechOrder } from "./speech-edit.ts";
import { GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN, type GatewayConfig, type GatewayKind, type GatewayProvider } from "./types.ts";
import { VENDORS, redact } from "./vendors.ts";

/**
 * Settings → Gateway's Speech and Image groups (docs/model-gateway.md#speech-group): every speech
 * provider in one list (the gateway's that can, and the space's own from `providers.yaml`, shown as
 * custom), the order ASR and TTS try them in (`providers.yaml`, edited by speech-edit.ts), which of
 * the gateway's providers draw, and a test of each that spends a little.
 *
 * With no `providers.yaml` the built-in default's provider (voice-studio) is listed only when it is
 * really there: the app on this machine or its capability on a peer, as the running speech service
 * locates it (`SpeechService.cells`). Otherwise the page shows and writes none of it.
 *
 *   GET  /api/model/gateway/speech          the providers, the orders, live, the gateway's offers
 *   PUT  /api/model/gateway/speech          {asr: ChainItem[], tts: ChainItem[], dryRun?}: save (or only preview) the orders
 *   POST /api/model/gateway/speech/test     {role, provider, model, voice?, text?, audio?} through the gateway,
 *                                           or {role, speech: name, audio?} for a provider of the speech configuration
 *   POST /api/model/gateway/image/test      {model?}: one small picture through the gateway
 *
 * Operator only, through the same guard as the other gateway routes (settings.ts).
 */

export type MediaOptions = {
  gateway: ModelGateway;
  home: string;
  env: Record<string, string | undefined>;
  /** The speech service as it runs: what answers now. */
  speech?: {
    config(): SpeechConfig | undefined;
    source(): string;
    configError(): string | undefined;
    /** Where each running provider is (located, machine); no network probe. */
    cells?(): { provider: string; located: boolean; where: string; off?: string }[];
    /** A test call to one provider of the running configuration, as the operator. */
    speak?(provider: string, text: string): Promise<{ audio: ArrayBuffer; contentType: string }>;
    transcribe?(provider: string, audio: Blob): Promise<{ text: string }>;
  };
  /** Read providers.yaml again into the running speech service. */
  reloadSpeech?: () => Promise<void>;
  fetch?: typeof fetch;
  log?: (line: string) => void;
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const ROLES = ["asr", "tts"] as const;
const TEST_TEXT = "Hello from ai-space.";
const MAX_TEST_AUDIO = 5 * 1024 * 1024;

export function createGatewayMediaRoutes(o: MediaOptions, guarded: (h: (req: Request) => Promise<Response>) => (req: Request) => Promise<Response>) {
  const file = join(o.home, PROVIDERS_FILE);
  const log = o.log ?? ((l: string) => console.log(`[model-gateway] ${l}`));

  const readSpeech = async (): Promise<string | undefined> => {
    const f = Bun.file(file);
    return (await f.exists()) ? await f.text() : undefined;
  };
  const gatewayConfig = async (): Promise<GatewayConfig | undefined> => {
    const f = Bun.file(join(o.home, GATEWAY_FILE));
    if (!(await f.exists())) return undefined;
    try {
      return parseGatewayYaml(await f.text(), o.env).config;
    } catch {
      return undefined;
    }
  };

  /** A provider as the groups offer it: what it serves (or why not), and its models of each kind. */
  function offer(p: GatewayProvider, off: string | undefined) {
    const serves = servesOf(p);
    const of = (kind: GatewayKind) => [...new Set([...p.models.filter((m) => kindOf(p, m) === kind), ...documentedIds(p.preset, kind)])];
    const tts = of("tts");
    return {
      name: p.name,
      label: (p.preset && VENDORS[p.preset]?.label) || p.name,
      ...(off ? { off } : {}),
      serves: { asr: serves.asr, tts: serves.tts, image: serves.image },
      asrModels: of("asr"),
      ttsModels: tts,
      imageModels: of("image"),
      // Documented voices per TTS model (the vendor's list); empty where it documents none.
      voices: Object.fromEntries(tts.map((m) => [m, voicesFor(p.preset, m)])),
    };
  }

  /**
   * Whether the built-in default's provider is here: every provider of the built-in configuration
   * located by the running speech service. Read only while the service runs that configuration;
   * without one to ask, assumed present (today's behaviour: the default is written out, never dropped).
   */
  function builtinPresence(): BuiltinPresence {
    const cells = o.speech?.cells?.();
    if (!cells || o.speech?.source() !== "builtin") return "present";
    return builtinSpeech().providers.every((p) => cells.some((c) => c.provider === p.name && c.located)) ? "present" : "absent";
  }

  const chains = (c: SpeechConfig) => ({ asr: chainOf(c, "asr"), tts: chainOf(c, "tts"), live: chainOf(c, "live") });
  const serves = (p: ProviderSpec) => ({ asr: KIND_CAPABILITIES[p.kind].includes(ROLE_CAPABILITY.asr), tts: KIND_CAPABILITIES[p.kind].includes(ROLE_CAPABILITY.tts), live: KIND_CAPABILITIES[p.kind].includes(ROLE_CAPABILITY.live) });

  /** An order as the page edits it: the page's providers as their gateway provider and model, the rest by name. */
  function orderOf(config: SpeechConfig): SpeechOrder {
    const item = (name: string, role: "asr" | "tts"): ChainItem => {
      const p = config.providers.find((x) => x.name === name);
      if (!p || !isManaged(p) || p.kind !== "openai-compatible" || !p.gateway) return { provider: name };
      const g = p.gateway.provider;
      const model = (role === "asr" ? p.asrModel : p.ttsModel).slice(g.length + 1);
      return { gateway: g, model, ...(role === "tts" && p.voice ? { voice: p.voice } : {}) };
    };
    return { asr: chainOf(config, "asr").map((n) => item(n, "asr")), tts: chainOf(config, "tts").map((n) => item(n, "tts")) };
  }

  async function speechView(): Promise<Response> {
    const text = await readSpeech();
    const builtin = builtinPresence();
    let config: SpeechConfig | undefined;
    let source: "file" | "builtin" = text === undefined ? "builtin" : "file";
    let error: string | undefined;
    try {
      ({ config, source } = visibleSpeech(text, o.env, builtin));
    } catch (e) {
      error = (e as Error).message;
    }
    const readOnly = text !== undefined ? speechEditProblem(text, o.env) : undefined;
    const cells = new Map((o.speech?.cells?.() ?? []).map((c) => [c.provider, c]));
    const g = await gatewayConfig();
    const custom = (config?.providers ?? []).filter((p) => !isManaged(p));
    const live = config ? chainOf(config, "live") : [];
    return json({
      ok: true,
      file,
      exists: text !== undefined,
      ...(readOnly ? { readOnly } : {}),
      ...(error ? { problem: error } : {}),
      source,
      // Every speech provider that is not the page's own: custom, with what it serves and where it is.
      custom: custom.map((p) => {
        const c = cells.get(p.name);
        const machine = p.kind === "voice-studio" ? (c?.where || p.machine || "") : undefined;
        return {
          name: p.name,
          kind: p.kind,
          serves: serves(p),
          ...(machine !== undefined ? { machine } : {}),
          ...(c ? { located: c.located } : {}),
          ...(config!.off[p.name] ? { off: config!.off[p.name] } : {}),
          testable: Boolean(o.speech?.speak && cells.has(p.name)),
        };
      }),
      order: config ? orderOf(config) : { asr: [], tts: [] },
      // Live is not edited here (it never goes through the gateway); listed only when a provider can do it.
      ...(config && config.providers.some((p) => serves(p).live) ? { live } : {}),
      providers: (g?.providers ?? []).map((p) => offer(p, g!.off[p.name])),
      ...(o.reloadSpeech ? {} : { restart: true }),
    });
  }

  /** The orders in a request; a gateway provider is checked against gateway.yaml. */
  async function orderFrom(body: Record<string, unknown>): Promise<SpeechOrder | Response> {
    const g = await gatewayConfig();
    const out: SpeechOrder = { asr: [], tts: [] };
    for (const role of ROLES) {
      const list = body[role];
      if (!Array.isArray(list) || list.length > 16) return json({ ok: false, error: `${role} must be a list of providers` }, 400);
      for (const raw of list as Record<string, unknown>[]) {
        if (!raw || typeof raw !== "object") return json({ ok: false, error: `${role}: each entry is {provider} or {gateway, model}` }, 400);
        if (typeof raw.provider === "string") {
          out[role].push({ provider: raw.provider });
          continue;
        }
        const provider = typeof raw.gateway === "string" ? raw.gateway : "";
        const model = typeof raw.model === "string" ? raw.model.trim() : "";
        const p = g?.providers.find((x) => x.name === provider);
        if (!GATEWAY_NAME_PATTERN.test(provider) || !p) return json({ ok: false, error: `${role}: ${provider || "a provider"} is not a provider of ${GATEWAY_FILE}` }, 400);
        const can = servesOf(p)[role];
        if (can !== true) return json({ ok: false, error: `${role}: ${provider} cannot (${can})` }, 400);
        if (!GATEWAY_MODEL_PATTERN.test(model)) return json({ ok: false, error: `${role}: pick a model for ${provider}` }, 400);
        if (role === "tts") {
          const voice = typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : undefined;
          const documented = voicesFor(p.preset, model);
          out.tts.push({ gateway: provider, model, ...(voice ? { voice } : {}), ...(documented.length ? { voices: documented } : {}) });
        } else out.asr.push({ gateway: provider, model });
      }
    }
    return out;
  }

  async function saveSpeech(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ ok: false, error: "the body must be JSON" }, 400);
    const order = await orderFrom(body);
    if (order instanceof Response) return order;
    const text = await readSpeech();
    if (text !== undefined) {
      const why = speechEditProblem(text, o.env);
      if (why) return json({ ok: false, error: `${PROVIDERS_FILE} cannot be edited here: ${why}` }, 409);
    }
    let next: ReturnType<typeof setSpeechText>;
    try {
      next = setSpeechText(text, order, o.env, builtinPresence());
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, e instanceof GatewayEditError ? 409 : 400);
    }
    const after = chains(next.after);
    if (body.dryRun === true) return json({ ok: true, dryRun: true, after });
    if (!next.changed) return json({ ok: true, after, applied: true, created: false, unchanged: true });
    let mode: number | undefined;
    try {
      mode = (await stat(file)).mode & 0o777;
    } catch { /* a new file */ }
    await writeAtomic(file, next.text, mode);
    let applied = false;
    if (o.reloadSpeech) {
      await o.reloadSpeech();
      applied = true;
    }
    log(`speech orders saved from Settings: asr ${after.asr.join(" > ") || "none"}, tts ${after.tts.join(" > ") || "none"}`);
    return json({ ok: true, after, applied, created: text === undefined, ...(applied ? {} : { restart: true }) });
  }

  /** A speech adapter through the gateway for one test, as the speech shorthand would make it. */
  function adapterFor(provider: string, model: string, role: SpeechRole, voice?: string): OpenAiAdapter {
    return new OpenAiAdapter(
      {
        name: `${MANAGED_PREFIX}test`, kind: "openai-compatible", url: "", selfHosted: false,
        asrModel: role === "asr" ? `${provider}/${model}` : `${provider}/whisper-1`,
        ttsModel: role === "tts" ? `${provider}/${model}` : `${provider}/tts-1`,
        ...(voice ? { voice } : {}),
        gateway: { via: "space", provider },
      },
      { gateway: o.gateway.link, ...(o.fetch ? { fetch: o.fetch } : {}) },
    );
  }

  async function testSpeech(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const role = body?.role;
    if (role !== "asr" && role !== "tts") return json({ ok: false, error: "role must be asr or tts" }, 400);
    if (typeof body!.speech === "string") return testOwn(role, body!.speech, body!);
    const provider = typeof body!.provider === "string" ? body!.provider : "";
    const model = typeof body!.model === "string" ? body!.model.trim() : "";
    const g = await gatewayConfig();
    const p = g?.providers.find((x) => x.name === provider);
    if (!p) return json({ ok: false, error: `${provider || "a provider"} is not a provider of ${GATEWAY_FILE}` }, 400);
    if (!GATEWAY_MODEL_PATTERN.test(model)) return json({ ok: false, error: "pick a model" }, 400);
    const key = p.apiKeyEnv ? o.env[p.apiKeyEnv] : undefined;
    const started = Date.now();
    try {
      if (role === "tts") {
        const voice = typeof body!.voice === "string" && body!.voice.trim() ? body!.voice.trim() : voicesFor(p.preset, model)[0];
        const text = typeof body!.text === "string" && body!.text.trim() ? body!.text.trim().slice(0, 200) : TEST_TEXT;
        const r = await adapterFor(provider, model, "tts", voice).speak({ text, voices: voice ? [voice] : [] });
        return json({ ok: true, role, ms: Date.now() - started, text, contentType: r.contentType, audio: Buffer.from(r.audio).toString("base64"), bytes: r.audio.byteLength });
      }
      const b64 = typeof body!.audio === "string" ? body!.audio : "";
      const audio = Buffer.from(b64, "base64");
      if (!audio.length) return json({ ok: false, error: "send the clip to transcribe (run the TTS test first)" }, 400);
      if (audio.length > MAX_TEST_AUDIO) return json({ ok: false, error: "the test clip is too large" }, 413);
      const r = await adapterFor(provider, model, "asr").transcribe({ file: new Blob([audio], { type: "audio/wav" }), filename: "test.wav", language: "", context: "" });
      return json({ ok: true, role, ms: Date.now() - started, text: r.text });
    } catch (e) {
      // The vendor's error as text; never the key.
      return json({ ok: true, role, ms: Date.now() - started, failed: true, error: redact((e as Error).message, key) });
    }
  }

  /** A test of a provider of the speech configuration itself (a custom one), through the running speech service. */
  async function testOwn(role: "asr" | "tts", name: string, body: Record<string, unknown>): Promise<Response> {
    const running = o.speech?.config();
    if (!running?.providers.some((p) => p.name === name) || !o.speech?.speak || !o.speech.transcribe) return json({ ok: false, error: `${name} is not a running speech provider here` }, 400);
    const started = Date.now();
    try {
      if (role === "tts") {
        const r = await o.speech.speak(name, TEST_TEXT);
        return json({ ok: true, role, ms: Date.now() - started, text: TEST_TEXT, contentType: r.contentType, audio: Buffer.from(r.audio).toString("base64"), bytes: r.audio.byteLength });
      }
      const audio = Buffer.from(typeof body.audio === "string" ? body.audio : "", "base64");
      if (!audio.length) return json({ ok: false, error: "send the clip to transcribe (run the TTS test first)" }, 400);
      if (audio.length > MAX_TEST_AUDIO) return json({ ok: false, error: "the test clip is too large" }, 413);
      const r = await o.speech.transcribe(name, new Blob([audio], { type: "audio/wav" }));
      return json({ ok: true, role, ms: Date.now() - started, text: r.text });
    } catch (e) {
      return json({ ok: true, role, ms: Date.now() - started, failed: true, error: (e as Error).message });
    }
  }

  async function testImage(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => ({}))) as { model?: unknown };
    const g = await gatewayConfig();
    const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : g?.tiers.image;
    if (!model || !GATEWAY_MODEL_PATTERN.test(model)) return json({ ok: false, error: "pick the image model first" }, 400);
    const base = o.gateway.link.base();
    if (!base) return json({ ok: false, error: `the built-in model gateway is off: ${o.gateway.link.problem() ?? ""}` }, 409);
    const split = splitModelId(model);
    const p = split ? g?.providers.find((x) => x.name === split.provider) : undefined;
    const key = p?.apiKeyEnv ? o.env[p.apiKeyEnv] : undefined;
    const started = Date.now();
    const grant = o.gateway.link.issue();
    const r = await gatewayImage(
      { prompt: "A small red circle on a white background, flat, simple.", system: "", model, tag: "gateway-test", files: [], timeoutMs: 120_000 },
      { base: `${base}/v1`, token: grant.token, fetch: o.fetch ?? fetch },
    );
    const served = o.gateway.link.trace(grant.run)?.served;
    if (!r.ok) return json({ ok: true, ms: Date.now() - started, failed: true, error: redact(r.error ?? "failed", key), ...(served ? { served } : {}) });
    const img = r.images![0]!;
    return json({ ok: true, ms: Date.now() - started, type: img.type, image: Buffer.from(img.bytes).toString("base64"), bytes: img.bytes.byteLength, ...(served ? { served } : {}) });
  }

  return {
    "/api/model/gateway/speech": { GET: guarded(speechView), PUT: guarded(saveSpeech) },
    "/api/model/gateway/speech/test": { POST: guarded(testSpeech) },
    "/api/model/gateway/image/test": { POST: guarded(testImage) },
  };
}
