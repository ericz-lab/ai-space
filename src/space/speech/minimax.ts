import { costOf as gatewayCost, pricedAnswer } from "../prices/price.ts";
import type { GatewayLink } from "../gateway/types.ts";
import type { FailureKind } from "../model/failure.ts";
import { costOf, minimaxPriceFor } from "./prices.ts";
import { ProviderError, type GatewayPriced, type MinimaxSpec, type ProviderState, type SpeakInput, type SpeakResult, type SpeechAdapter, type SpeechCapability, type TranscribeInput, type TranscribeResult } from "./types.ts";
import { pcm16Wav, splitWav, wavLayout } from "./wav.ts";

/**
 * The `minimax` kind (docs/speech.md#kinds): MiniMax's own speech API, which is not OpenAI's shape.
 *
 *   POST {root}/v1/t2a_v2          JSON model, text, voice_setting.voice_id, audio_setting.format wav,
 *                                  output_format hex: the audio comes back hex-encoded inside JSON
 *   POST {root}/v1/speech_to_text  multipart model, file, response_format verbose_json; the language
 *                                  hint is a `language` header
 *
 * Through a provider of the built-in model gateway (`gateway: space`, `provider:`) the key and the
 * root are that provider's, read when a call is made (its openai base without `/v1`, else its
 * messages base without `/anthropic`); the call goes straight to MiniMax, not through the gateway,
 * which forwards without translating (docs/model-gateway.md#speech).
 *
 * Errors: t2a_v2 answers HTTP 200 with `base_resp.status_code` other than 0; speech_to_text answers
 * the real HTTP status with `error.message` ending in the code, `… (1004)`. Both codes are sorted
 * into the layer's failure kinds (`CODE_KINDS`, from https://platform.minimax.io/docs/api-reference/errorcode.md).
 *
 * Transcription takes at most 500 seconds and 50 MB per request: a longer WAV is cut into pieces on
 * sample boundaries and transcribed in turn, its segments moved to their place; another format is
 * sent whole, and MiniMax refuses one over 500 seconds (a 400). It has no prompt, so `context` is unused.
 */

export const MINIMAX_LIMITS = { transcribeBytes: 50 * 1024 * 1024, speakChars: 9_999, speakVoices: 1 };
/** A piece stays under MiniMax's 500 s, with room for its own rounding. */
const PIECE_SECONDS = 480;
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const SPEAK_TIMEOUT_MS = 5 * 60_000;
/** The sample rate asked of t2a_v2 (one of 8000, 16000, 22050, 24000, 32000, 44100). */
const SAMPLE_RATE = 32_000;

/** The hint values speech_to_text documents for its `language` header; another code means mixed recognition. */
export const MINIMAX_ASR_LANGUAGES = ["zh", "yue", "en", "ja", "ko", "th", "vi", "id", "ms", "fil", "ar", "tr", "fr", "de", "es", "it", "pt", "pl", "ru", "uk"];

/** MiniMax's status codes, by the layer's failure kinds; a code not here is the request's own failure. */
export const CODE_KINDS: Record<number, FailureKind> = {
  1004: "auth", 2049: "auth",
  1008: "credit", 2053: "credit",
  2056: "quota", 2067: "quota",
  1002: "rate", 1039: "rate", 1041: "rate", 1045: "rate", 2045: "rate", 2046: "rate", 2047: "rate", 2062: "rate", 2064: "rate",
  1000: "transport", 1001: "transport", 1024: "transport", 1033: "transport", 2066: "transport", 2160: "transport",
};
/** Content flagged as sensitive: refused as unprocessable. */
const SENSITIVE = new Set([1026, 1027, 1040]);

/** A MiniMax code and message as a ProviderError the service sorts: account and link failures move on, the rest end the call. */
export function minimaxFailure(name: string, code: number, message: string, httpStatus?: number): ProviderError {
  const kind = CODE_KINDS[code] ?? "other";
  const said = `${name}: ${httpStatus ? `HTTP ${httpStatus}: ` : ""}${message || "failed"}${message.includes(`(${code})`) ? "" : ` (${code})`}`;
  if (kind !== "other") return new ProviderError(said, 502, kind);
  const status = SENSITIVE.has(code) ? 422 : httpStatus === 413 ? 413 : 400;
  return new ProviderError(said, status, "other");
}

type Root = { root: string; apiKey: string; served?: string };

export class MinimaxAdapter implements SpeechAdapter {
  readonly kind = "minimax" as const;
  readonly capabilities: ReadonlySet<SpeechCapability> = new Set<SpeechCapability>(["transcribe", "speak"]);
  readonly limits = MINIMAX_LIMITS;
  readonly selfHosted = false;

  constructor(readonly spec: MinimaxSpec, private readonly deps: { fetch?: typeof fetch; gateway?: GatewayLink } = {}) {}

  get name(): string {
    return this.spec.name;
  }

  get defaultVoice(): string | undefined {
    return this.spec.voice;
  }

  /** The root URL and the key: the spec's own, or its gateway provider's as gateway.yaml has them now. */
  private where(): { root?: string; apiKey?: string; problem?: string } {
    const via = this.spec.gateway;
    if (!via) return { root: this.spec.url, ...(this.spec.apiKey ? { apiKey: this.spec.apiKey } : { problem: `${this.spec.apiKeyEnv} is not set` }) };
    const p = this.deps.gateway?.provider(via.provider);
    if (!this.deps.gateway) return { problem: "this space has no built-in model gateway" };
    if (!p) return { problem: `${via.provider} is not a provider of gateway.yaml` };
    const root = p.openai ? p.openai.replace(/\/v1\/?$/, "") : p.messages ? p.messages.replace(/\/anthropic\/?$/, "") : undefined;
    if (!root) return { problem: `the model gateway's provider ${via.provider} has no base to read the host from` };
    if (p.disabled) return { root, problem: `the model gateway's provider ${via.provider} is turned off` };
    if (!p.apiKey) return { root, problem: `the model gateway's provider ${via.provider} has no key (${p.apiKeyEnv ?? "no apiKeyEnv"})` };
    return { root: root.replace(/\/+$/, ""), apiKey: p.apiKey };
  }

  private endpoint(): Root {
    const w = this.where();
    if (!w.root || !w.apiKey) throw new ProviderError(`${this.name}: ${w.problem ?? "no key"}`, 502, "auth");
    return { root: w.root, apiKey: w.apiKey };
  }

  state(): ProviderState {
    const w = this.where();
    let host = w.root ?? "";
    try {
      host = new URL(host).host;
    } catch {
      /* no root yet */
    }
    const via = this.spec.gateway;
    const where = via ? `${via.provider}${host ? ` (${host})` : ""}` : host;
    // Nothing is probed: a call costs money. Signed in means a key is there.
    return { where, machine: "", located: Boolean(w.root), signedIn: Boolean(w.apiKey), ...(w.problem ? { detail: w.problem } : {}) };
  }

  /**
   * The cost of a call: the built-in gateway's price for `<provider>/<model>` when the key is its
   * provider's (gateway-prices.yaml), else a `price:` or MiniMax's list price for that host; through a
   * gateway provider the answer is kept (`basis`) unless the list price priced it, so a price set later applies.
   */
  private priced(root: string, capability: "transcribe" | "speak", model: string, figures: { audioSeconds?: number; chars?: number }): GatewayPriced | undefined {
    const listed = costOf(minimaxPriceFor({ url: root, asrModel: this.spec.asrModel, ttsModel: this.spec.ttsModel, ...(this.spec.price ? { price: this.spec.price } : {}) }), capability, figures);
    const via = this.spec.gateway;
    if (!via || !this.deps.gateway || this.spec.price) return listed !== undefined ? { costUsd: listed } : undefined;
    const answer = pricedAnswer(`${via.provider}/${model}`, undefined, figures);
    const price = this.deps.gateway.price(answer.m);
    const usd = price ? gatewayCost(price, answer) : undefined;
    if (usd !== undefined) return { costUsd: usd, basis: [answer] };
    return listed !== undefined ? { costUsd: listed } : { basis: [answer] };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const at = this.endpoint();
    const whole = await input.file.arrayBuffer();
    const pieces = wavLayout(whole) ? splitWav(whole, PIECE_SECONDS, MINIMAX_LIMITS.transcribeBytes) : undefined;
    const language = hintOf(input.language);
    const parts = pieces ?? [{ start: 0, audio: whole }];
    const texts: string[] = [];
    const segments: TranscribeResult["segments"] = [];
    let seconds = 0;
    let told = true;
    for (const [i, part] of parts.entries()) {
      const name = pieces ? input.filename.replace(/(\.[^.]*)?$/, `-${i + 1}.wav`) : input.filename;
      const file = pieces ? new Blob([part.audio], { type: "audio/wav" }) : input.file;
      const r = await this.transcribeOne(at, file, name, language, input.signal);
      if (r.text) texts.push(r.text);
      for (const s of r.segments) segments.push({ start: round(s.start + part.start), end: round(s.end + part.start), text: s.text });
      if (r.duration === undefined) told = false;
      else seconds += r.duration;
    }
    const audioSeconds = told && seconds > 0 ? round(seconds) : undefined;
    const priced = this.priced(at.root, "transcribe", this.spec.asrModel, audioSeconds !== undefined ? { audioSeconds } : {});
    return {
      text: texts.join(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]$/u.test(texts[0] ?? "") ? "" : " ").trim(),
      // MiniMax does not say which language it heard: the hint, when there was one.
      language: input.language,
      segments,
      ...(audioSeconds !== undefined ? { audioSeconds } : {}),
      ...(priced ? { priced } : {}),
    };
  }

  private async transcribeOne(at: Root, file: Blob, filename: string, language: string | undefined, signal?: AbortSignal): Promise<{ text: string; segments: { start: number; end: number; text: string }[]; duration?: number }> {
    const form = new FormData();
    form.append("model", this.spec.asrModel);
    form.append("file", file, filename);
    form.append("response_format", "verbose_json");
    const res = await this.post(at, "/v1/speech_to_text", form, TRANSCRIBE_TIMEOUT_MS, signal, language ? { language } : {});
    const body = (await res.json().catch(() => null)) as { text?: unknown; duration?: unknown; segments?: unknown; base_resp?: unknown } | null;
    checkBase(this.name, body?.base_resp);
    if (!body || typeof body.text !== "string") throw new ProviderError(`${this.name}: the answer has no text`, 502, "other");
    const segments = Array.isArray(body.segments)
      ? body.segments.flatMap((s) => {
          const seg = s as { start?: unknown; end?: unknown; text?: unknown };
          return typeof seg?.start === "number" && typeof seg.end === "number" && typeof seg.text === "string" ? [{ start: seg.start, end: seg.end, text: seg.text.trim() }] : [];
        })
      : [];
    return { text: body.text.trim(), segments, ...(typeof body.duration === "number" && body.duration > 0 ? { duration: body.duration } : {}) };
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    const voice = input.voices[0] ?? this.spec.voice;
    if (!voice) throw new ProviderError(`${this.name} needs a voice: name one, or set voice: in providers.yaml`, 400, "other");
    const at = this.endpoint();
    const request = {
      model: this.spec.ttsModel,
      text: input.text,
      stream: false,
      output_format: "hex",
      voice_setting: { voice_id: voice },
      audio_setting: { format: "wav", sample_rate: SAMPLE_RATE, channel: 1 },
    };
    const res = await this.post(at, "/v1/t2a_v2", JSON.stringify(request), SPEAK_TIMEOUT_MS, input.signal, { "content-type": "application/json" });
    const body = (await res.json().catch(() => null)) as { data?: { audio?: unknown } | null; extra_info?: Record<string, unknown>; base_resp?: unknown } | null;
    if (!body) throw new ProviderError(`${this.name}: the answer is not JSON`, 502, "other");
    checkBase(this.name, body.base_resp);
    const hex = body.data?.audio;
    if (typeof hex !== "string" || !hex || hex.length % 2 || !/^[0-9a-f]+$/i.test(hex)) throw new ProviderError(`${this.name}: the answer has no audio`, 502, "other");
    const bytes = Buffer.from(hex, "hex");
    const extra = body.extra_info ?? {};
    let audio: ArrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (!isWave(bytes)) {
      // Asked for wav; raw PCM (16-bit) is wrapped, anything else is not what the layer answers.
      const format = typeof extra.audio_format === "string" ? extra.audio_format : "";
      if (format !== "pcm") throw new ProviderError(`${this.name}: the answer is not WAV audio${format ? ` (${format})` : ""}`, 502, "other");
      const rate = typeof extra.audio_sample_rate === "number" ? extra.audio_sample_rate : SAMPLE_RATE;
      const channels = typeof extra.audio_channel === "number" ? extra.audio_channel : 1;
      audio = pcm16Wav(new Uint8Array(audio), rate, channels);
    }
    // MiniMax bills its own count (a Chinese character is 2); the text's length when it does not say.
    const chars = typeof extra.usage_characters === "number" && extra.usage_characters > 0 ? extra.usage_characters : [...input.text].length;
    const priced = this.priced(at.root, "speak", this.spec.ttsModel, { chars });
    return { audio, contentType: "audio/wav", ...(priced ? { priced } : {}) };
  }

  /** The configured list; without one, MiniMax itself refuses a voice it does not have. */
  async voices(): Promise<string[] | undefined> {
    return this.spec.voices;
  }

  cost(capability: SpeechCapability, figures: { audioSeconds?: number; chars?: number }): number | undefined {
    const root = this.where().root ?? "";
    return costOf(minimaxPriceFor({ url: root, asrModel: this.spec.asrModel, ttsModel: this.spec.ttsModel, ...(this.spec.price ? { price: this.spec.price } : {}) }), capability, figures);
  }

  private async post(at: Root, path: string, body: FormData | string, timeoutMs: number, signal: AbortSignal | undefined, headers: Record<string, string>): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${at.root}${path}`, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${at.apiKey}` },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError(`aborted`, 499, "other");
      if (timeout.aborted) throw new ProviderError(`timed out after ${Math.round(timeoutMs / 1000)}s`, 504, "other");
      throw new ProviderError(`${this.name}: unreachable: ${(e as Error).message}`, 502, "transport");
    }
    if (res.ok) return res;
    throw await httpFailure(this.name, res);
  }
}

/** An answer whose `base_resp` says it failed, even under HTTP 200. */
function checkBase(name: string, base: unknown): void {
  if (!base || typeof base !== "object") return;
  const b = base as { status_code?: unknown; status_msg?: unknown };
  const code = typeof b.status_code === "number" ? b.status_code : Number(b.status_code);
  if (!Number.isFinite(code) || code === 0) return;
  throw minimaxFailure(name, code, typeof b.status_msg === "string" ? b.status_msg : "");
}

/** A non-2xx answer: its code (`… (1004)`, or `base_resp`) when it has one, else what its status means. */
async function httpFailure(name: string, res: Response): Promise<ProviderError> {
  const text = await res.text().catch(() => "");
  let message = text.trim().slice(0, 300);
  let code: number | undefined;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; base_resp?: { status_code?: unknown; status_msg?: unknown } };
    const said = typeof body.error === "string" ? body.error : typeof body.error?.message === "string" ? body.error.message : typeof body.base_resp?.status_msg === "string" ? body.base_resp.status_msg : undefined;
    if (said) message = said;
    if (typeof body.base_resp?.status_code === "number" && body.base_resp.status_code !== 0) code = body.base_resp.status_code;
  } catch {
    /* not JSON */
  }
  code ??= Number(/\((\d{4,5})\)\s*$/.exec(message)?.[1]) || undefined;
  if (code !== undefined && (CODE_KINDS[code] || res.status < 500)) return minimaxFailure(name, code, message, res.status);
  const kind: FailureKind = res.status === 401 || res.status === 403 ? "auth" : res.status === 402 ? "credit" : res.status === 429 ? "rate" : res.status >= 500 ? "transport" : "other";
  const said = `${name}: HTTP ${res.status}: ${message || res.statusText}`;
  return new ProviderError(said, kind === "other" && (res.status === 400 || res.status === 413 || res.status === 422) ? res.status : kind === "other" ? 400 : 502, kind);
}

/** The `language` header for a code (`zh`, `zh-CN`, `en-US`): its primary tag when MiniMax documents it. */
function hintOf(language: string): string | undefined {
  const primary = language.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return MINIMAX_ASR_LANGUAGES.includes(primary) ? primary : undefined;
}

/** A RIFF/WAVE header: what the layer answers (its length is read where it can be, wav.ts). */
const isWave = (b: Uint8Array) => b.byteLength >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WAVE";

const round = (n: number) => Math.round(n * 1000) / 1000;
