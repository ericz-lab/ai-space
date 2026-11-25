import { describe, expect, test } from "bun:test";
import type { GatewayLink, GatewayProvider } from "../gateway/types.ts";
import { checkGatewayProviders, parseProvidersYaml } from "./config.ts";
import { MinimaxAdapter } from "./minimax.ts";
import { SpeechService, buildAdapters } from "./service.ts";
import { SpeechStore } from "./store.ts";
import { wav } from "./testing.ts";
import { ProviderError, SpeechError, type MinimaxSpec } from "./types.ts";
import { splitWav, wavSeconds } from "./wav.ts";

/**
 * The `minimax` kind against stand-ins built from MiniMax's documented shapes
 * (platform.minimax.io/docs/api-reference/speech-t2a-http.md, speech-to-text.md, errorcode.md).
 * No request leaves the process, and no key is a real one.
 */

type Sent = { url: string; headers: Record<string, string>; form?: Record<string, string>; json?: Record<string, unknown>; files?: Blob[] };

function stub(answer: (sent: Sent, i: number) => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const s: Sent = { url: req.url, headers: Object.fromEntries(req.headers) };
    if (req.headers.get("content-type")?.startsWith("multipart/")) {
      const form = await req.formData();
      s.files = [];
      s.form = Object.fromEntries([...form.entries()].map(([k, v]) => {
        if (typeof v === "string") return [k, v];
        s.files!.push(v as Blob);
        return [k, `<file ${(v as File).name} ${(v as File).size}>`];
      }));
    } else s.json = (await req.json()) as Record<string, unknown>;
    sent.push(s);
    return answer(s, sent.length - 1);
  }) as typeof fetch;
  return { fetch: f, sent };
}

const hex = (b: ArrayBuffer) => Buffer.from(b).toString("hex");
const ok = { status_code: 0, status_msg: "success" };
/** A t2a_v2 answer as documented: hex audio in `data.audio`, the figures in `extra_info`, `base_resp`. */
const t2a = (audio: ArrayBuffer, extra: Record<string, unknown> = {}) =>
  Response.json({ data: { audio: hex(audio), status: 2 }, extra_info: { audio_length: 500, audio_sample_rate: 32000, audio_size: audio.byteLength, word_count: 20, usage_characters: 20, audio_format: "wav", audio_channel: 1, ...extra }, trace_id: "t", base_resp: ok });

const SPEC: MinimaxSpec = { name: "mm", kind: "minimax", url: "https://api.minimax.io", apiKeyEnv: "MM", apiKey: "fake-key", asrModel: "asr-1.0", ttsModel: "speech-2.8-turbo", voice: "English_Graceful_Lady" };
const FILE = (audio: ArrayBuffer = wav(1), language = "") => ({ file: new File([audio], "clip.wav"), filename: "clip.wav", language, context: "AI Space" });

describe("minimax speak (t2a_v2)", () => {
  test("asks for wav as hex and answers the decoded WAV, priced on the international site by MiniMax's own count", async () => {
    const audio = wav(0.5, 32000);
    const s = stub(() => t2a(audio, { usage_characters: 40 }));
    const r = await new MinimaxAdapter(SPEC, { fetch: s.fetch }).speak({ text: "你好，ai-space。", voices: [] });
    expect(s.sent[0]).toMatchObject({ url: "https://api.minimax.io/v1/t2a_v2", headers: { authorization: "Bearer fake-key", "content-type": "application/json" } });
    expect(s.sent[0]!.json).toEqual({ model: "speech-2.8-turbo", text: "你好，ai-space。", stream: false, output_format: "hex", voice_setting: { voice_id: "English_Graceful_Lady" }, audio_setting: { format: "wav", sample_rate: 32000, channel: 1 } });
    expect(r.contentType).toBe("audio/wav");
    expect(new Uint8Array(r.audio)).toEqual(new Uint8Array(audio));
    expect(wavSeconds(r.audio)).toBe(0.5);
    // $60 per million billable characters for speech-2.8-turbo; 40 characters as MiniMax counted them.
    expect(r.priced).toEqual({ costUsd: 0.0024 });
  });

  test("the voice asked for wins; raw PCM is wrapped as a WAV", async () => {
    const pcm = new Uint8Array(32000); // 0.5 s of 16-bit mono at 32 kHz
    const s = stub(() => t2a(pcm.buffer, { audio_format: "pcm" }));
    const r = await new MinimaxAdapter(SPEC, { fetch: s.fetch }).speak({ text: "hi", voices: ["Chinese (Mandarin)_News_Anchor"] });
    expect((s.sent[0]!.json!.voice_setting as { voice_id: string }).voice_id).toBe("Chinese (Mandarin)_News_Anchor");
    expect(wavSeconds(r.audio)).toBe(0.5);
  });

  test("the China site is unpriced (its list is in CNY); a price: in providers.yaml applies", async () => {
    const cn = { ...SPEC, url: "https://api.minimaxi.com" };
    const s = stub(() => t2a(wav(0.1)));
    expect((await new MinimaxAdapter(cn, { fetch: s.fetch }).speak({ text: "hi", voices: [] })).priced).toBeUndefined();
    const priced = await new MinimaxAdapter({ ...cn, price: { speakPerMillionChars: 10 } }, { fetch: s.fetch }).speak({ text: "hi", voices: [] });
    expect(priced.priced).toEqual({ costUsd: 0.0002 });
  });

  test("an error inside HTTP 200 (base_resp) is sorted into the failure kinds", async () => {
    const cases: [number, string, ProviderError["kind"], number][] = [
      [1004, "login fail: Please carry the API secret key in the 'Authorization' field of the request header", "auth", 502],
      [1008, "insufficient balance", "credit", 502],
      [1002, "rate limit", "rate", 502],
      [2056, "usage limit exceeded", "quota", 502],
      [1000, "unknown error", "transport", 502],
      [2013, "invalid params", "other", 400],
      [2054, "voice id not exist", "other", 400],
      [1026, "input content flagged as sensitive", "other", 422],
    ];
    for (const [code, msg, kind, status] of cases) {
      const s = stub(() => Response.json({ data: null, trace_id: "t", base_resp: { status_code: code, status_msg: msg } }));
      const e = (await new MinimaxAdapter(SPEC, { fetch: s.fetch }).speak({ text: "hi", voices: [] }).catch((x) => x)) as ProviderError;
      expect(e).toBeInstanceOf(ProviderError);
      expect([code, e.kind, e.status]).toEqual([code, kind, status]);
      expect(e.message).toContain(`(${code})`);
      expect(e.message).not.toContain("fake-key");
    }
  });

  test("an answer without audio, or audio that is not WAV, is a failure", async () => {
    const none = stub(() => Response.json({ data: { audio: "", status: 2 }, base_resp: ok }));
    expect(await new MinimaxAdapter(SPEC, { fetch: none.fetch }).speak({ text: "hi", voices: [] }).catch((e) => e.message)).toContain("has no audio");
    const mp3 = stub(() => t2a(new Uint8Array([0x49, 0x44, 0x33, 4]).buffer, { audio_format: "mp3" }));
    expect(await new MinimaxAdapter(SPEC, { fetch: mp3.fetch }).speak({ text: "hi", voices: [] }).catch((e) => e.message)).toContain("not WAV audio (mp3)");
  });

  test("without a voice it says so before any call", async () => {
    const s = stub(() => t2a(wav(0.1)));
    const { voice: _, ...bare } = SPEC;
    expect(await new MinimaxAdapter(bare, { fetch: s.fetch }).speak({ text: "hi", voices: [] }).catch((e) => e.message)).toContain("needs a voice");
    expect(s.sent).toHaveLength(0);
  });
});

describe("minimax transcribe (speech_to_text)", () => {
  const answer = (over: Record<string, unknown> = {}) => Response.json({ text: "Hello everyone. Let me check the question.", duration: 12.744, n_speakers: 2, segments: [{ id: 0, start: 0.1, end: 1.66, speaker: "S1", text: "Hello everyone." }, { id: 1, start: 2, end: 6.1, speaker: "S2", text: "Let me check the question." }], trace_id: "t", ...over });

  test("multipart with verbose_json, the language as a header; segments, the duration, the price", async () => {
    const s = stub(() => answer());
    const r = await new MinimaxAdapter(SPEC, { fetch: s.fetch }).transcribe(FILE(wav(1), "en-US"));
    expect(s.sent[0]).toMatchObject({ url: "https://api.minimax.io/v1/speech_to_text", headers: { authorization: "Bearer fake-key", language: "en" }, form: { model: "asr-1.0", response_format: "verbose_json", file: expect.stringContaining("<file clip.wav") } });
    // No prompt field: MiniMax has none, so the context is not sent.
    expect(Object.keys(s.sent[0]!.form!)).toEqual(["model", "file", "response_format"]);
    expect(r).toMatchObject({ text: "Hello everyone. Let me check the question.", language: "en-US", audioSeconds: 12.744, segments: [{ start: 0.1, end: 1.66, text: "Hello everyone." }, { start: 2, end: 6.1, text: "Let me check the question." }] });
    // $0.38 an hour.
    expect(r.priced).toEqual({ costUsd: 0.001345 });
  });

  test("a language MiniMax does not document is left out: mixed recognition", async () => {
    const s = stub(() => answer());
    await new MinimaxAdapter(SPEC, { fetch: s.fetch }).transcribe(FILE(wav(1), "sv"));
    expect(s.sent[0]!.headers).not.toHaveProperty("language");
  });

  test("a WAV over 480 s goes in pieces, each segment moved to its place", async () => {
    const long = wav(1000, 100); // 1000 s at 100 Hz, 200 KB
    const s = stub((_, i) => Response.json({ text: `part ${i + 1}`, duration: i < 2 ? 480 : 40, segments: [{ id: 0, start: 1, end: 2, speaker: "S1", text: `part ${i + 1}` }] }));
    const r = await new MinimaxAdapter(SPEC, { fetch: s.fetch }).transcribe(FILE(long));
    expect(s.sent.map((x) => x.form!.file!.split(" ")[1])).toEqual(["clip-1.wav", "clip-2.wav", "clip-3.wav"]);
    const seconds = await Promise.all(s.sent.map(async (x) => wavSeconds(await x.files![0]!.arrayBuffer())));
    expect(seconds).toEqual([480, 480, 40]);
    expect(r.text).toBe("part 1 part 2 part 3");
    expect(r.segments.map((x) => x.start)).toEqual([1, 481, 961]);
    expect(r.audioSeconds).toBe(1000);
  });

  test("HTTP errors carry the code at the end of the message", async () => {
    const err = (status: number, type: string, message: string) => Response.json({ type: "error", error: { type, message, http_code: String(status) }, request_id: "r" }, { status });
    const cases: [Response, ProviderError["kind"], number][] = [
      [err(401, "authorized_error", "login fail: Please carry the API secret key in the 'Authorization' field of the request header (1004)"), "auth", 502],
      [err(402, "insufficient_balance_error", "insufficient balance (1008)"), "credit", 502],
      [err(429, "rate_limit_error", "rate limit, please retry later (1002)"), "rate", 502],
      [err(500, "server_error", "internal error (1000)"), "transport", 502],
      [err(400, "bad_request_error", "invalid params, audio duration 623.4s exceeds the limit of 500s (2013)"), "other", 400],
      [err(413, "invalid_request_error", "request body too large: 88200078 bytes exceeds limit of 52428800 bytes"), "other", 413],
      [err(422, "unprocessable_entity_error", "audio content contains sensitive content (1026)"), "other", 422],
      [new Response("bad gateway", { status: 502 }), "transport", 502],
    ];
    for (const [res, kind, status] of cases) {
      const s = stub(() => res);
      const e = (await new MinimaxAdapter(SPEC, { fetch: s.fetch }).transcribe(FILE()).catch((x) => x)) as ProviderError;
      expect([e.kind, e.status, e.message.startsWith("mm: HTTP ")]).toEqual([kind, status, true]);
    }
  });

  test("a link that fails is a transport failure", async () => {
    const f = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const e = (await new MinimaxAdapter(SPEC, { fetch: f }).transcribe(FILE()).catch((x) => x)) as ProviderError;
    expect([e.kind, e.message]).toEqual(["transport", "mm: unreachable: connect ECONNREFUSED"]);
  });
});

describe("splitting a WAV", () => {
  test("by seconds and by bytes, on sample boundaries; none when it fits or is not a WAV", () => {
    expect(splitWav(wav(10, 100), 480, 1e9)).toBeUndefined();
    expect(splitWav(new Uint8Array([1, 2, 3]).buffer, 480, 1e9)).toBeUndefined();
    const bySize = splitWav(wav(10, 100), 480, 1080)!; // room for a header: 1000 bytes of samples a piece
    expect(bySize.map((p) => [p.start, wavSeconds(p.audio)])).toEqual([[0, 5], [5, 5]]);
  });
});

/** A link with one gateway provider: the speech shorthand reads its key and its host. */
function link(p: Partial<GatewayProvider> | undefined, price?: (m: string) => ReturnType<GatewayLink["price"]>): GatewayLink {
  const provider = p ? ({ name: "minimax", auth: "bearer", models: [], preset: "minimax", ...p } as GatewayProvider) : undefined;
  return {
    base: () => "http://127.0.0.1:1/api/model-gateway",
    issue: () => ({ run: "r", token: "t" }),
    trace: () => undefined,
    price: (m) => (price ? price(m) : undefined),
    provider: (name) => (name === "minimax" ? provider : undefined),
    has: () => true,
    problem: () => undefined,
    tiers: () => ({}),
  };
}

const VIA: MinimaxSpec = { name: "gateway-minimax", kind: "minimax", url: "", asrModel: "asr-1.0", ttsModel: "speech-2.8-hd", voice: "English_Graceful_Lady", gateway: { via: "space", provider: "minimax" } };

describe("minimax through a gateway provider", () => {
  test("the key and the host are the provider's: its openai base, else its messages base", async () => {
    const s = stub(() => t2a(wav(0.1)));
    await new MinimaxAdapter(VIA, { fetch: s.fetch, gateway: link({ openai: "https://api.minimaxi.com/v1", messages: "https://api.minimaxi.com/anthropic", apiKeyEnv: "MINIMAX_KEY", apiKey: "fake-gw-key" }) }).speak({ text: "hi", voices: [] });
    await new MinimaxAdapter(VIA, { fetch: s.fetch, gateway: link({ messages: "https://relay.example/mm/anthropic", apiKey: "fake-gw-key" }) }).speak({ text: "hi", voices: [] });
    expect(s.sent.map((x) => [x.url, x.headers.authorization])).toEqual([
      ["https://api.minimaxi.com/v1/t2a_v2", "Bearer fake-gw-key"],
      ["https://relay.example/mm/v1/t2a_v2", "Bearer fake-gw-key"],
    ]);
  });

  test("its state names the provider and the host; without a key it is signed out and a call fails as auth", async () => {
    const good = new MinimaxAdapter(VIA, { gateway: link({ messages: "https://api.minimaxi.com/anthropic", apiKey: "fake-gw-key" }) });
    expect(good.state()).toEqual({ where: "minimax (api.minimaxi.com)", machine: "", located: true, signedIn: true });
    const keyless = new MinimaxAdapter(VIA, { fetch: stub(() => t2a(wav(0.1))).fetch, gateway: link({ messages: "https://api.minimaxi.com/anthropic", apiKeyEnv: "MINIMAX_KEY" }) });
    expect(keyless.state()).toMatchObject({ signedIn: false, detail: "the model gateway's provider minimax has no key (MINIMAX_KEY)" });
    const e = (await keyless.speak({ text: "hi", voices: [] }).catch((x) => x)) as ProviderError;
    expect(e.kind).toBe("auth");
    expect(new MinimaxAdapter(VIA, { gateway: link(undefined) }).state()).toMatchObject({ located: false, detail: "minimax is not a provider of gateway.yaml" });
  });

  test("a gateway price for provider/model wins and keeps the answer; otherwise the list price or the answer for later", async () => {
    const s = stub(() => t2a(wav(0.1), { usage_characters: 1000 }));
    const gp = { openai: "https://api.minimax.io/v1", apiKey: "fake-gw-key" };
    const priced = await new MinimaxAdapter(VIA, { fetch: s.fetch, gateway: link(gp, (m) => (m === "minimax/speech-2.8-hd" ? { perMillionChars: 50 } : undefined)) }).speak({ text: "hi", voices: [] });
    expect(priced.priced).toEqual({ costUsd: 0.05, basis: [{ m: "minimax/speech-2.8-hd", ch: 1000 }] });
    const listed = await new MinimaxAdapter(VIA, { fetch: s.fetch, gateway: link(gp) }).speak({ text: "hi", voices: [] });
    expect(listed.priced).toEqual({ costUsd: 0.1 });
    const cn = await new MinimaxAdapter(VIA, { fetch: s.fetch, gateway: link({ ...gp, openai: "https://api.minimaxi.com/v1" }) }).speak({ text: "hi", voices: [] });
    expect(cn.priced).toEqual({ basis: [{ m: "minimax/speech-2.8-hd", ch: 1000 }] });
  });
});

describe("minimax in providers.yaml", () => {
  test("the gateway shorthand and a hand-written entry", () => {
    const { config } = parseProvidersYaml(
      `speech:\n  default: { asr: gateway-minimax, tts: own }\n  providers:\n    gateway-minimax: { kind: minimax, gateway: space, provider: minimax, ttsModel: speech-2.8-hd, voice: "Chinese (Mandarin)_News_Anchor" }\n    own: { kind: minimax, site: cn, apiKeyEnv: MM }\n`,
      { MM: "fake" },
    );
    expect(config.providers).toEqual([
      { name: "gateway-minimax", kind: "minimax", url: "", asrModel: "asr-1.0", ttsModel: "speech-2.8-hd", voice: "Chinese (Mandarin)_News_Anchor", gateway: { via: "space", provider: "minimax" } },
      { name: "own", kind: "minimax", url: "https://api.minimaxi.com", apiKeyEnv: "MM", apiKey: "fake", asrModel: "asr-1.0", ttsModel: "speech-2.8-turbo" },
    ]);
    // Neither streams: live stays without a provider.
    expect(config.default).toEqual({ asr: "gateway-minimax", tts: "own" });
  });

  test("what it refuses, and a missing key turns it off", () => {
    const one = (p: string) => () => parseProvidersYaml(`speech:\n  providers:\n    m: { kind: minimax, ${p} }\n`, {});
    expect(one("apiKeyEnv: MM")).toThrow("name the site");
    expect(one("site: us, apiKeyEnv: MM")).toThrow("site must be cn");
    expect(one("site: cn, url: 'https://api.minimaxi.com', apiKeyEnv: MM")).toThrow("not both");
    expect(one("url: 'https://api.minimaxi.com/v1', apiKeyEnv: MM")).toThrow("without a path");
    expect(one("site: cn")).toThrow("apiKeyEnv must name");
    expect(one("gateway: magpie, provider: minimax")).toThrow("gateway: space");
    expect(one("gateway: space, provider: minimax, site: cn")).toThrow("drop url, site and apiKeyEnv");
    expect(one("gateway: space, provider: minimax, selfHosted: true")).toThrow('unknown key "selfHosted"');
    const off = parseProvidersYaml("speech:\n  providers:\n    m: { kind: minimax, site: intl, apiKeyEnv: MM }\n", {});
    expect(off.config.off).toEqual({ m: "MM is not set" });
  });

  test("a gateway provider without a base or that is off turns it off; either base will do", () => {
    const { config } = parseProvidersYaml("speech:\n  default: { asr: a, tts: a }\n  providers:\n    a: { kind: minimax, gateway: space, provider: minimax, voice: v }\n    b: { kind: minimax, gateway: space, provider: gone }\n", {});
    const warnings = checkGatewayProviders(config, (n) => (n === "minimax" ? { openai: false, messages: true } : undefined), true);
    expect(config.off).toEqual({ b: "gone is not a provider of gateway.yaml" });
    expect(warnings).toHaveLength(1);
    const { config: c2 } = parseProvidersYaml("speech:\n  providers:\n    a: { kind: minimax, gateway: space, provider: minimax, voice: v }\n", {});
    checkGatewayProviders(c2, () => ({ openai: false, messages: false }), true);
    expect(c2.off.a).toContain("has no base");
  });
});

describe("minimax in the speech service", () => {
  const yaml = `speech:\n  default: { asr: mm, tts: mm }\n  providers:\n    mm: { kind: minimax, site: intl, apiKeyEnv: MM, voice: English_Graceful_Lady }\n    other: { kind: openai-compatible, apiKeyEnv: OA, voice: alloy }\n  fallback: { asr: [other], tts: [other] }\n`;
  const env = { MM: "fake-mm", OA: "fake-oa" };

  function make(answer: (s: Sent) => Response, localOnly?: (app: string) => boolean) {
    const s = stub(answer);
    const { config } = parseProvidersYaml(yaml, env);
    const store = new SpeechStore(":memory:");
    const svc = new SpeechService({ config, adapters: buildAdapters(config, { voiceStudio: {} as never, fetch: s.fetch }), store, log: () => {}, ...(localOnly ? { localOnly } : {}) });
    return { svc, store, sent: s.sent };
  }

  test("an account failure inside HTTP 200 moves on to the next provider, and the ledger says so", async () => {
    const { svc, sent } = make((s) => (s.url.includes("minimax") ? Response.json({ data: null, base_resp: { status_code: 1008, status_msg: "insufficient balance" } }) : new Response(wav(0.2), { headers: { "content-type": "audio/wav" } })));
    const r = await svc.speak({ app: "notes", tag: "t" }, { text: "hi", voices: [] });
    expect(sent.map((x) => new URL(x.url).host)).toEqual(["api.minimax.io", "api.openai.com"]);
    expect(r.call).toMatchObject({ provider: "other", fallbackFrom: "mm", tries: 2 });
    expect(r.call.trace!.tries[0]).toMatchObject({ provider: "mm", ok: false, kind: "credit" });
  });

  test("a bad request ends the call there (no fallback), with its status", async () => {
    const { svc, sent } = make(() => Response.json({ data: null, base_resp: { status_code: 2054, status_msg: "voice id not exist" } }));
    const e = (await svc.speak({ app: "notes", tag: "t" }, { text: "hi", voices: [] }).catch((x) => x)) as SpeechError;
    expect([e.status, sent.length]).toEqual([400, 1]);
    expect(e.call).toMatchObject({ provider: "mm", status: "error", kind: "minimax" });
  });

  test("a transcription is a ledger row with its seconds and cost", async () => {
    const { svc } = make(() => Response.json({ text: "你好", duration: 60, segments: [{ id: 0, start: 0, end: 60, speaker: "S1", text: "你好" }] }));
    const { result, call } = await svc.transcribe({ app: "notes", tag: "t" }, FILE(wav(1), "zh"));
    expect(result).toEqual({ text: "你好", language: "zh", segments: [{ start: 0, end: 60, text: "你好" }], audioSeconds: 60 });
    expect(call).toMatchObject({ provider: "mm", kind: "minimax", audioSeconds: 60, costUsd: 0.006333 });
  });

  test("a local-only app is refused it: it is a cloud provider", async () => {
    const { svc, sent } = make(() => t2a(wav(0.1)), (app) => app === "diary");
    const e = (await svc.speak({ app: "diary", tag: "t" }, { text: "hi", voices: [] }).catch((x) => x)) as SpeechError;
    expect([e.status, e.code, sent.length]).toEqual([403, "local_only", 0]);
    expect((await svc.transcribe({ app: "diary", tag: "t" }, FILE()).catch((x) => x)).code).toBe("local_only");
  });
});
