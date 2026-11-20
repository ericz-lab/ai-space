import { costOf, priceFor } from "./prices.ts";
import { ProviderError, type OpenAiSpec, type Price, type ProviderState, type SpeakInput, type SpeakResult, type SpeechAdapter, type SpeechCapability, type TranscribeInput, type TranscribeResult } from "./types.ts";
import { httpError } from "./voice-studio.ts";

/**
 * The `openai-compatible` kind (docs/speech.md#kinds): OpenAI's audio API, or any server that speaks
 * it (a Whisper server the operator runs, another vendor's compatible endpoint).
 *
 *   POST {url}/audio/transcriptions   multipart file, model, language, prompt (the context), response_format
 *   POST {url}/audio/speech           JSON model, input, voice, response_format: wav
 *
 * The key travels as a bearer and is never logged. `verbose_json` (segments, the duration) is asked of
 * Whisper models; the `gpt-4o-*` transcription models only answer `json`.
 */

export const OPENAI_LIMITS = { transcribeBytes: 25 * 1024 * 1024, speakChars: 4096, speakVoices: 1 };
const TRANSCRIBE_TIMEOUT_MS = 10 * 60_000;
const SPEAK_TIMEOUT_MS = 5 * 60_000;

export class OpenAiAdapter implements SpeechAdapter {
  readonly kind = "openai-compatible" as const;
  readonly capabilities: ReadonlySet<SpeechCapability> = new Set<SpeechCapability>(["transcribe", "speak"]);
  readonly limits = OPENAI_LIMITS;
  private readonly price: Price | undefined;

  constructor(readonly spec: OpenAiSpec, private readonly deps: { fetch?: typeof fetch } = {}) {
    this.price = priceFor(spec);
  }

  get name(): string {
    return this.spec.name;
  }

  get selfHosted(): boolean {
    return this.spec.selfHosted;
  }

  get defaultVoice(): string | undefined {
    return this.spec.voice;
  }

  state(): ProviderState {
    let host = this.spec.url;
    try {
      host = new URL(this.spec.url).host;
    } catch {
      /* checked at load */
    }
    // Nothing is probed: a call costs money. Signed in means a key is set when one is named.
    return { where: host, machine: "", located: true, ...(this.spec.apiKeyEnv ? { signedIn: Boolean(this.spec.apiKey) } : {}) };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const format = this.spec.responseFormat ?? (/^whisper/i.test(this.spec.asrModel) ? "verbose_json" : "json");
    const form = new FormData();
    form.append("file", input.file, input.filename);
    form.append("model", this.spec.asrModel);
    form.append("response_format", format);
    if (input.language) form.append("language", input.language);
    if (input.context) form.append("prompt", input.context);
    const res = await this.post("/audio/transcriptions", form, TRANSCRIBE_TIMEOUT_MS, input.signal);
    const body = (await res.json().catch(() => null)) as {
      text?: unknown; language?: unknown; duration?: unknown; segments?: unknown; usage?: { type?: unknown; seconds?: unknown };
    } | null;
    if (!body || typeof body.text !== "string") throw new ProviderError(`${this.name}: the answer has no text`, 502, "other");
    const segments = Array.isArray(body.segments)
      ? body.segments.flatMap((s) => {
          const seg = s as { start?: unknown; end?: unknown; text?: unknown };
          return typeof seg?.start === "number" && typeof seg.end === "number" && typeof seg.text === "string" ? [{ start: seg.start, end: seg.end, text: seg.text.trim() }] : [];
        })
      : [];
    const seconds = typeof body.duration === "number" ? body.duration : body.usage?.type === "duration" && typeof body.usage.seconds === "number" ? body.usage.seconds : undefined;
    return {
      text: body.text.trim(),
      language: typeof body.language === "string" && body.language ? languageCode(body.language) : input.language,
      segments,
      ...(seconds !== undefined && seconds > 0 ? { audioSeconds: seconds } : {}),
    };
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    const voice = input.voices[0] ?? this.spec.voice;
    if (!voice) throw new ProviderError(`${this.name} needs a voice: name one, or set voice: in providers.yaml`, 400, "other");
    const res = await this.post("/audio/speech", JSON.stringify({ model: this.spec.ttsModel, input: input.text, voice, response_format: "wav" }), SPEAK_TIMEOUT_MS, input.signal, "application/json");
    return { audio: await res.arrayBuffer(), contentType: "audio/wav" };
  }

  /** The configured list; without one, the API itself refuses a voice it does not have. */
  async voices(): Promise<string[] | undefined> {
    return this.spec.voices;
  }

  cost(capability: SpeechCapability, figures: { audioSeconds?: number; chars?: number }): number | undefined {
    return costOf(this.price, capability, figures);
  }

  private async post(path: string, body: FormData | string, timeoutMs: number, signal?: AbortSignal, contentType?: string): Promise<Response> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${this.spec.url}${path}`, {
        method: "POST",
        headers: { ...(contentType ? { "content-type": contentType } : {}), ...(this.spec.apiKey ? { authorization: `Bearer ${this.spec.apiKey}` } : {}) },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      if (signal?.aborted) throw new ProviderError(`aborted`, 499, "other");
      if (timeout.aborted) throw new ProviderError(`timed out after ${Math.round(timeoutMs / 1000)}s`, 504, "other");
      throw new ProviderError(`${this.name}: unreachable: ${(e as Error).message}`, 502, "transport");
    }
    if (res.ok) return res;
    const text = await httpError(res);
    // A refused request keeps its status; the account, the key and the link are the provider's failure (502).
    throw new ProviderError(`${this.name}: ${text}`, res.status === 400 || res.status === 413 || res.status === 422 ? res.status : 502);
  }
}

/** Whisper's `verbose_json` names the language in full; the contract answers its code. */
const LANGUAGES: Record<string, string> = {
  chinese: "zh", english: "en", japanese: "ja", korean: "ko", french: "fr", german: "de", spanish: "es", portuguese: "pt",
  italian: "it", russian: "ru", arabic: "ar", hindi: "hi", turkish: "tr", vietnamese: "vi", thai: "th", indonesian: "id",
  dutch: "nl", polish: "pl", ukrainian: "uk", swedish: "sv", cantonese: "yue", malay: "ms", hebrew: "he", greek: "el",
};

export function languageCode(language: string): string {
  const l = language.trim().toLowerCase();
  return LANGUAGES[l] ?? l;
}
