import { describe, expect, test } from "bun:test";
import { classifyFailure } from "../model/failure.ts";
import { parseProvidersYaml } from "./config.ts";
import { languageCode, OpenAiAdapter } from "./openai.ts";
import { costOf, priceFor } from "./prices.ts";
import { SpeechService, buildAdapters } from "./service.ts";
import { SpeechStore } from "./store.ts";
import { wav } from "./testing.ts";
import { ProviderError, SpeechError, type OpenAiSpec } from "./types.ts";
import { wavSeconds } from "./wav.ts";

/** Every test here answers from a stub: no request leaves the process. */
type Sent = { url: string; headers: Record<string, string>; form?: Record<string, string>; json?: Record<string, unknown> };

function stub(answer: (sent: Sent) => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const s: Sent = { url: req.url, headers: Object.fromEntries(req.headers) };
    if (req.headers.get("content-type")?.startsWith("multipart/")) {
      const form = await req.formData();
      s.form = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `<file ${(v as File).name} ${(v as File).size}>`]));
    } else s.json = (await req.json()) as Record<string, unknown>;
    sent.push(s);
    return answer(s);
  }) as typeof fetch;
  return { fetch: f, sent };
}

const SPEC: OpenAiSpec = { name: "openai", kind: "openai-compatible", url: "https://api.openai.com/v1", apiKeyEnv: "K", apiKey: "sk-test", asrModel: "whisper-1", ttsModel: "tts-1", selfHosted: false, voice: "alloy" };
const FILE = { file: new File(["abc"], "voice.m4a"), filename: "voice.m4a", language: "", context: "AI Space" };

describe("openai-compatible", () => {
  test("transcribes with verbose_json for whisper: segments, the duration and the language's code", async () => {
    const s = stub(() => Response.json({ task: "transcribe", language: "chinese", duration: 12.5, text: " 你好。 ", segments: [{ id: 0, start: 0, end: 12.5, text: " 你好。", avg_logprob: -0.2 }] }));
    const a = new OpenAiAdapter(SPEC, { fetch: s.fetch });
    expect(await a.transcribe(FILE)).toEqual({ text: "你好。", language: "zh", segments: [{ start: 0, end: 12.5, text: "你好。" }], audioSeconds: 12.5 });
    expect(s.sent[0]).toMatchObject({ url: "https://api.openai.com/v1/audio/transcriptions", headers: { authorization: "Bearer sk-test" }, form: { file: "<file voice.m4a 3>", model: "whisper-1", response_format: "verbose_json", prompt: "AI Space" } });
    expect(s.sent[0]!.form).not.toHaveProperty("language");
    // Whisper at $0.006 a minute, from OpenAI's own host only.
    expect(a.cost("transcribe", { audioSeconds: 12.5 })).toBe(0.00125);
  });

  test("a gpt-4o transcription model is asked for json, which has neither segments nor always a duration", async () => {
    const s = stub(() => Response.json({ text: "hello", usage: { type: "tokens", input_tokens: 10, output_tokens: 2 } }));
    const a = new OpenAiAdapter({ ...SPEC, asrModel: "gpt-4o-mini-transcribe" }, { fetch: s.fetch });
    expect(await a.transcribe({ ...FILE, language: "en" })).toEqual({ text: "hello", language: "en", segments: [] });
    expect(s.sent[0]!.form).toMatchObject({ response_format: "json", language: "en" });
    const d = stub(() => Response.json({ text: "hello", usage: { type: "duration", seconds: 4 } }));
    expect((await new OpenAiAdapter({ ...SPEC, asrModel: "gpt-4o-transcribe" }, { fetch: d.fetch }).transcribe(FILE)).audioSeconds).toBe(4);
  });

  test("speaks as WAV with the voice asked for, else its default; more than one voice is not its kind", async () => {
    const s = stub(() => new Response(wav(1, 24000), { headers: { "content-type": "audio/wav" } }));
    const a = new OpenAiAdapter(SPEC, { fetch: s.fetch });
    const out = await a.speak({ text: "hello", voices: ["nova"] });
    expect(wavSeconds(out.audio)).toBe(1);
    expect(s.sent[0]).toMatchObject({ url: "https://api.openai.com/v1/audio/speech", json: { model: "tts-1", input: "hello", voice: "nova", response_format: "wav" } });
    await a.speak({ text: "x", voices: [] });
    expect(s.sent[1]!.json!.voice).toBe("alloy");
    expect(a.cost("speak", { chars: 1_000_000 })).toBe(15);
    expect(a.limits.speakVoices).toBe(1);
    const noVoice = new OpenAiAdapter({ ...SPEC, voice: undefined }, { fetch: s.fetch });
    expect(noVoice.speak({ text: "x", voices: [] })).rejects.toThrow("openai needs a voice");
  });

  test("errors read as the model layer reads them: credit, rate with its retry time, auth, a 5xx link failure", async () => {
    const cases: [Response, string, string][] = [
      [Response.json({ error: { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" } }, { status: 429 }), "openai: HTTP 429: You exceeded your current quota (insufficient_quota)", "credit"],
      [Response.json({ error: { message: "Rate limit reached for whisper-1 on requests per min (RPM): Limit 50, Used 50" } }, { status: 429, headers: { "retry-after": "20" } }), "openai: HTTP 429: Rate limit reached for whisper-1 on requests per min (RPM): Limit 50, Used 50 (retry after 20s)", "rate"],
      [Response.json({ error: { message: "Incorrect API key provided", code: "invalid_api_key" } }, { status: 401 }), "openai: HTTP 401: Incorrect API key provided (invalid_api_key)", "auth"],
      [new Response("upstream connect error", { status: 503 }), "openai: HTTP 503: upstream connect error", "transport"],
    ];
    for (const [res, message, kind] of cases) {
      const a = new OpenAiAdapter(SPEC, { fetch: stub(() => res).fetch });
      const e = (await a.transcribe(FILE).catch((x) => x)) as ProviderError;
      expect(e.message).toBe(message);
      expect(e.status).toBe(502);
      expect(classifyFailure(e.message).kind).toBe(kind as never);
    }
    const refused = new OpenAiAdapter(SPEC, { fetch: stub(() => Response.json({ error: { message: "Invalid file format." } }, { status: 400 })).fetch });
    expect(((await refused.transcribe(FILE).catch((x) => x)) as ProviderError).status).toBe(400);
    const down = new OpenAiAdapter(SPEC, { fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch });
    expect(((await down.transcribe(FILE).catch((x) => x)) as ProviderError)).toMatchObject({ message: "openai: unreachable: fetch failed", kind: "transport" });
  });

  test("a self-hosted server is not priced by OpenAI's table, and sends no key it was not given", async () => {
    const s = stub(() => Response.json({ text: "ok", duration: 60 }));
    const local = new OpenAiAdapter({ ...SPEC, url: "http://127.0.0.1:8000/v1", apiKey: undefined, apiKeyEnv: undefined, selfHosted: true }, { fetch: s.fetch });
    await local.transcribe(FILE);
    expect(s.sent[0]!.headers).not.toHaveProperty("authorization");
    expect(local.cost("transcribe", { audioSeconds: 60 })).toBeUndefined();
    expect(local.selfHosted).toBe(true);
    expect(local.state()).toEqual({ where: "127.0.0.1:8000", machine: "", located: true });
    expect(new OpenAiAdapter(SPEC).state()).toEqual({ where: "api.openai.com", machine: "", located: true, signedIn: true });
  });
});

describe("prices", () => {
  test("the provider's own price wins; the table covers OpenAI's host and dated snapshots; token-priced models have none", () => {
    expect(priceFor({ url: "https://api.openai.com/v1", asrModel: "gpt-4o-transcribe-2025-03-20", ttsModel: "tts-1-hd" })).toEqual({ transcribePerMinute: 0.006, speakPerMillionChars: 30 });
    expect(priceFor({ url: "https://api.openai.com/v1", asrModel: "whisper-1", ttsModel: "gpt-4o-mini-tts" })).toEqual({ transcribePerMinute: 0.006 });
    expect(priceFor({ url: "https://gateway.example/v1", asrModel: "whisper-1", ttsModel: "tts-1" })).toBeUndefined();
    expect(priceFor({ url: "https://gateway.example/v1", asrModel: "whisper-1", ttsModel: "tts-1", price: { speakPerMillionChars: 2 } })).toEqual({ speakPerMillionChars: 2 });
    expect(costOf({ transcribePerMinute: 0.006 }, "transcribe", {})).toBeUndefined();
    expect(costOf({ transcribePerMinute: 0.006 }, "live", { audioSeconds: 30 })).toBe(0.003);
  });

  test("Whisper's language names become codes", () => {
    expect(["Chinese", "english", "cantonese", "klingon"].map(languageCode)).toEqual(["zh", "en", "yue", "klingon"]);
  });

  test("a WAV's length comes from its header; anything else has none", () => {
    expect(wavSeconds(wav(2.5))).toBe(2.5);
    expect(wavSeconds(new TextEncoder().encode("not a wav file at all").buffer as ArrayBuffer)).toBeUndefined();
  });
});

describe("the fallback to a cloud API", () => {
  test("voice-studio down, the API answers; the ledger has the provider, the cost and where it came from", async () => {
    const { config } = parseProvidersYaml(`
speech:
  default: { asr: gpu, tts: gpu }
  providers:
    gpu: { kind: voice-studio, machine: gpu-box }
    openai: { kind: openai-compatible, apiKeyEnv: K, voice: alloy }
  fallback: { asr: [openai], tts: [openai] }
  voices: { narrator: { gpu: en-Frank_man, openai: onyx } }
`, { K: "sk-test" });
    const s = stub((sent) => (sent.url.endsWith("/audio/speech") ? new Response(wav(0.5, 24000)) : Response.json({ text: "from the api", language: "english", duration: 30, segments: [] })));
    // The peer's last snapshot was fine; the link drops on the call.
    let health: "ok" | "down" = "ok";
    const downPeer = {
      name: "gpu-box", config: { url: "https://peer.invalid" }, knownDown: () => health === "down", health: () => health, provides: () => true, authHeaders: () => ({}),
      forward: async () => new Response(null, { status: 599 }), snapshot: { asOf: new Date(Date.now() - 3600_000).toISOString() },
    };
    const store = new SpeechStore(":memory:");
    const service = new SpeechService({
      config, store, log: () => {},
      adapters: buildAdapters(config, {
        fetch: s.fetch,
        voiceStudio: {
          hasLocal: () => false, servicePort: () => undefined,
          callLocal: async () => new Response(null, { status: 500 }),
          // What the bus answers when the peer cannot be reached.
          callRemote: async () => Response.json({ ok: false, error: "peer gpu-box unreachable: Unable to connect" }, { status: 502 }),
          peers: { get: () => downPeer, providerOf: () => ({ peer: downPeer }) },
        },
      }),
    });
    const { result, call } = await service.transcribe({ app: "notes", tag: "dictation" }, { file: new Blob(["abc"]), filename: "a.wav", language: "", context: "" });
    expect(result).toEqual({ text: "from the api", language: "en", segments: [], audioSeconds: 30 });
    expect(call).toMatchObject({ provider: "openai", kind: "openai-compatible", fallbackFrom: "gpu", tries: 2, audioSeconds: 30, costUsd: 0.003 });
    expect(call.trace?.tries.map((t) => [t.provider, t.ok, t.kind])).toEqual([["gpu", false, "transport"], ["openai", true, undefined]]);
    expect(call.trace?.tries[0]?.error).toBe("gpu: HTTP 502: peer gpu-box unreachable: Unable to connect");

    // Once the peer is known down, the API is asked first and the gpu is not waited on.
    health = "down";
    const next = await service.transcribe({ app: "notes", tag: "dictation" }, { file: new Blob(["abc"]), filename: "a.wav", language: "", context: "" });
    expect(next.call).toMatchObject({ provider: "openai", fallbackFrom: "gpu", tries: 1 });
    expect(next.call.trace?.candidates[0]).toEqual({ provider: "gpu", later: expect.stringContaining("resting until") });

    // The voice moves under each provider's own name: onyx at the API, never en-Frank_man.
    const spoken = await service.speak({ app: "notes", tag: "read" }, { text: "hello", voices: ["narrator"] });
    expect(s.sent.at(-1)!.json).toMatchObject({ voice: "onyx" });
    expect(spoken.call).toMatchObject({ provider: "openai", voice: "onyx", chars: 5, audioSeconds: 0.5, costUsd: 0.000075 });
    // A voice of the gpu's own does not go to the API at all.
    const own = (await service.speak({ app: "notes", tag: "read" }, { text: "hello", voices: ["zh-Xinran_woman"] }).catch((x) => x)) as SpeechError;
    expect(own.call?.trace?.candidates.find((c) => c.provider === "openai")?.skipped).toBe("voice zh-Xinran_woman is gpu's own");
  });
});
