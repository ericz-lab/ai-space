import { stat } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "../model/inventory.ts";
import { gatewayImage } from "../runtimes/anthropic-api.ts";
import { PROVIDERS_FILE, builtinSpeech, parseProvidersYaml } from "../speech/config.ts";
import { OpenAiAdapter } from "../speech/openai.ts";
import type { SpeechConfig, SpeechRole } from "../speech/types.ts";
import { GATEWAY_FILE, parseGatewayYaml, splitModelId } from "./config.ts";
import { GatewayEditError } from "./edit.ts";
import { documentedIds, kindOf, servesOf, voicesFor } from "./kinds.ts";
import type { ModelGateway } from "./service.ts";
import { MANAGED_PREFIX, chainOf, isManaged, setSpeechText, speechEditProblem, type SpeechChoice, type SpeechPlace } from "./speech-edit.ts";
import { GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN, type GatewayConfig, type GatewayKind, type GatewayProvider } from "./types.ts";
import { VENDORS, redact } from "./vendors.ts";

/**
 * Settings → Gateway's Speech and Image groups (docs/model-gateway.md#speech-group): which of the
 * built-in gateway's providers transcribe, speak and draw, where its speech sits next to the
 * space's own (`providers.yaml`, edited by speech-edit.ts), and a test of each that spends a little.
 *
 *   GET  /api/model/gateway/speech          what answers ASR, TTS and live now; the page's choice; the providers that can
 *   PUT  /api/model/gateway/speech          {asr, tts, dryRun?}: save (or only preview) where the gateway's speech sits
 *   POST /api/model/gateway/speech/test     {role: "tts", provider, model, voice?, text?} | {role: "asr", provider, model, audio}
 *   POST /api/model/gateway/image/test      {model?}: one small picture through the gateway
 *
 * Operator only, through the same guard as the other gateway routes (settings.ts).
 */

export type MediaOptions = {
  gateway: ModelGateway;
  home: string;
  env: Record<string, string | undefined>;
  /** The speech service as it runs: what answers now. */
  speech?: { config(): SpeechConfig | undefined; source(): string; configError(): string | undefined };
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

  /** The page's current choice, read back from the speech configuration. */
  function choiceOf(config: SpeechConfig): SpeechChoice {
    const out: SpeechChoice = { asr: { place: "off" }, tts: { place: "off" } };
    for (const role of ROLES) {
      const chain = chainOf(config, role);
      const name = chain.find((n) => n.startsWith(MANAGED_PREFIX) && config.providers.some((p) => p.name === n && isManaged(p)));
      if (!name) continue;
      const p = config.providers.find((x) => x.name === name)!;
      if (p.kind !== "openai-compatible" || !p.gateway) continue;
      const place: SpeechPlace = chain[0] === name ? "default" : "fallback";
      const model = (role === "asr" ? p.asrModel : p.ttsModel).slice(p.gateway.provider.length + 1);
      out[role] = { place, provider: p.gateway.provider, model, ...(role === "tts" && p.voice ? { voice: p.voice } : {}) };
    }
    return out;
  }

  const chains = (c: SpeechConfig | undefined) => (c ? { asr: chainOf(c, "asr"), tts: chainOf(c, "tts"), live: chainOf(c, "live") } : { asr: [], tts: [], live: [] });

  async function speechView(): Promise<Response> {
    const text = await readSpeech();
    let fileConfig: SpeechConfig | undefined;
    let error: string | undefined;
    try {
      fileConfig = text === undefined ? builtinSpeech() : parseProvidersYaml(text, o.env).config;
    } catch (e) {
      error = (e as Error).message;
    }
    const readOnly = text !== undefined ? speechEditProblem(text, o.env) : undefined;
    const running = o.speech?.config();
    const g = await gatewayConfig();
    return json({
      ok: true,
      file,
      exists: text !== undefined,
      ...(readOnly ? { readOnly } : {}),
      ...(error ? { problem: error } : {}),
      source: o.speech?.source() ?? (text === undefined ? "builtin" : "file"),
      // What answers now, as the running speech service has it.
      now: chains(running),
      kinds: Object.fromEntries((running?.providers ?? []).map((p) => [p.name, { kind: p.kind, selfHosted: p.kind === "voice-studio" || (p.kind === "openai-compatible" && p.selfHosted), ...(p.kind === "openai-compatible" && p.gateway ? { gateway: `${p.gateway.via}:${p.gateway.provider}` } : {}) }])),
      choice: fileConfig ? choiceOf(fileConfig) : { asr: { place: "off" }, tts: { place: "off" } },
      handWritten: (fileConfig?.providers ?? []).filter((p) => p.kind === "openai-compatible" && p.gateway?.via === "space" && !isManaged(p)).map((p) => p.name),
      providers: (g?.providers ?? []).map((p) => offer(p, g!.off[p.name])),
      ...(o.reloadSpeech ? {} : { restart: true }),
    });
  }

  /** The choice in a request, checked against the gateway's providers. */
  async function choiceFrom(body: Record<string, unknown>): Promise<SpeechChoice | Response> {
    const g = await gatewayConfig();
    const out = {} as SpeechChoice;
    for (const role of ROLES) {
      const r = body[role] as Record<string, unknown> | undefined;
      const place = r?.place;
      if (place !== "off" && place !== "fallback" && place !== "default") return json({ ok: false, error: `${role}.place must be off, fallback or default` }, 400);
      if (place === "off") {
        out[role] = { place };
        continue;
      }
      const provider = typeof r!.provider === "string" ? r!.provider : "";
      const model = typeof r!.model === "string" ? r!.model.trim() : "";
      const p = g?.providers.find((x) => x.name === provider);
      if (!GATEWAY_NAME_PATTERN.test(provider) || !p) return json({ ok: false, error: `${role}: ${provider || "a provider"} is not a provider of ${GATEWAY_FILE}` }, 400);
      const can = servesOf(p)[role];
      if (can !== true) return json({ ok: false, error: `${role}: ${provider} cannot (${can})` }, 400);
      if (!GATEWAY_MODEL_PATTERN.test(model)) return json({ ok: false, error: `${role}: pick a model` }, 400);
      if (role === "tts") {
        const voice = typeof r!.voice === "string" && r!.voice.trim() ? r!.voice.trim() : undefined;
        const documented = voicesFor(p.preset, model);
        out.tts = { place, provider, model, ...(voice ? { voice } : {}), ...(documented.length ? { voices: documented } : {}) };
      } else out.asr = { place, provider, model };
    }
    return out;
  }

  async function saveSpeech(req: Request): Promise<Response> {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return json({ ok: false, error: "the body must be JSON" }, 400);
    const choice = await choiceFrom(body);
    if (choice instanceof Response) return choice;
    const text = await readSpeech();
    if (text !== undefined) {
      const why = speechEditProblem(text, o.env);
      if (why) return json({ ok: false, error: `${PROVIDERS_FILE} cannot be edited here: ${why}` }, 409);
    }
    let next: ReturnType<typeof setSpeechText>;
    try {
      next = setSpeechText(text, choice, o.env);
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, e instanceof GatewayEditError ? 409 : 400);
    }
    const after = chains(next.after);
    if (body.dryRun === true) return json({ ok: true, dryRun: true, after });
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
    log(`speech through the model gateway saved from Settings: asr ${choice.asr.place}, tts ${choice.tts.place}`);
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
