import type { GatewayKind, GatewayProvider } from "./types.ts";

/**
 * What a provider's model is for (docs/model-gateway.md#kinds). In order: the provider's `kinds:`
 * in gateway.yaml (what the owner set in Settings → Gateway, or accepted from the vendor's list),
 * then a rule the vendor documents for its own ids (the table below, each with its page), else
 * text. A kind is never guessed from how a name looks: a model no rule covers is text until the
 * owner says otherwise.
 */

const ids = (kind: GatewayKind, list: string[]) => Object.fromEntries(list.map((m) => [m, kind] as const));

/**
 * Model ids a vendor's own documentation names for speech or pictures, by preset, with the pages
 * (read 2026-11-24). Only ids written out there; a family named with a wildcard is left to the owner.
 */
export const DOCUMENTED_KINDS: Record<string, { kinds: Record<string, GatewayKind>; source: string[] }> = {
  openai: {
    kinds: {
      ...ids("asr", ["whisper-1", "gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-mini-transcribe-2025-12-15", "gpt-4o-transcribe-diarize"]),
      ...ids("tts", ["tts-1", "tts-1-hd", "gpt-4o-mini-tts", "gpt-4o-mini-tts-2025-12-15"]),
      ...ids("image", ["gpt-image-2.6-sunburst", "gpt-image-2.6-flare", "gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini", "chatgpt-image-latest", "dall-e-2", "dall-e-3"]),
    },
    source: [
      "https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create",
      "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create",
      "https://developers.openai.com/api/reference/resources/images",
    ],
  },
  groq: {
    kinds: { ...ids("asr", ["whisper-large-v3", "whisper-large-v3-turbo"]), ...ids("tts", ["canopylabs/orpheus-v1-english", "canopylabs/orpheus-arabic-saudi"]) },
    source: ["https://console.groq.com/docs/speech-to-text", "https://console.groq.com/docs/text-to-speech/orpheus"],
  },
  zhipu: {
    kinds: { ...ids("asr", ["glm-asr-2512"]), ...ids("tts", ["glm-tts"]), ...ids("image", ["glm-image", "cogview-4-250304", "cogview-4", "cogview-3-flash"]) },
    source: [
      "https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E8%AF%AD%E9%9F%B3%E8%BD%AC%E6%96%87%E6%9C%AC",
      "https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%9C%AC%E8%BD%AC%E8%AF%AD%E9%9F%B3",
      "https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%9B%BE%E5%83%8F%E7%94%9F%E6%88%90",
    ],
  },
  zai: {
    kinds: { ...ids("asr", ["glm-asr-2512"]), ...ids("image", ["glm-image"]) },
    source: ["https://docs.z.ai/api-reference/audio/audio-transcriptions", "https://docs.z.ai/api-reference/image/generate-image"],
  },
  minimax: {
    kinds: ids("image", ["MiniMax-H3-Image", "MiniMax-H3-Image-Highspeed"]),
    source: ["https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md"],
  },
  // Pay-as-you-go takes the dated Model IDs of Ark's model list (checked 2026-11-24).
  ark: {
    kinds: ids("image", ["doubao-seedream-5-5-261028", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260915", "doubao-seedream-4-0-260415"]),
    source: ["https://www.volcengine.com/docs/82379/1330310", "https://docs.volcengine.com/docs/82379/1541523"],
  },
  "ark-plan": {
    kinds: ids("image", ["doubao-seedream-5.5", "doubao-seedream-5.0-pro", "doubao-seedream-5.0-flash"]),
    source: ["https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models?lang=zh"],
  },
};

/** The documented ids of one kind for a preset (what the Speech and Image groups offer before any list). */
export function documentedIds(preset: string | undefined, kind: GatewayKind): string[] {
  const k = preset ? DOCUMENTED_KINDS[preset]?.kinds : undefined;
  return k ? Object.entries(k).filter(([, v]) => v === kind).map(([m]) => m) : [];
}

/** TTS voices a vendor documents, per preset (and per model where they differ). */
export const DOCUMENTED_VOICES: Record<string, { voices: string[]; byModel?: Record<string, string[]>; source: string }> = {
  openai: { voices: ["alloy", "ash", "ballad", "coral", "echo", "fable", "onyx", "nova", "sage", "shimmer", "verse", "marin", "cedar"], source: "https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create" },
  groq: {
    voices: ["autumn", "diana", "hannah", "austin", "daniel", "troy"],
    byModel: { "canopylabs/orpheus-v1-english": ["autumn", "diana", "hannah", "austin", "daniel", "troy"], "canopylabs/orpheus-arabic-saudi": ["abdullah", "fahad", "sultan", "lulwa", "noura", "aisha"] },
    source: "https://console.groq.com/docs/text-to-speech/orpheus",
  },
  zhipu: { voices: ["tongtong", "chuichui", "xiaochen", "jam", "kazi", "douji", "luodo"], source: "https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%96%87%E6%9C%AC%E8%BD%AC%E8%AF%AD%E9%9F%B3" },
};

export function voicesFor(preset: string | undefined, model: string | undefined): string[] {
  const v = preset ? DOCUMENTED_VOICES[preset] : undefined;
  if (!v) return [];
  return (model && v.byModel?.[model]) || v.voices;
}

/**
 * Vendors that document an OpenAI-style base for speech or pictures that their preset does not
 * carry, because the docs do not say the key that works on the messages base works there too (a
 * coding plan's key often does not). The page offers it as a base to add, and the Test says
 * whether the key works. Per site where the vendor has two.
 */
export const OPENAI_OFFERS: Record<string, { intl?: string; cn?: string; note: string; source: string }> = {
  zhipu: { cn: "https://open.bigmodel.cn/api/paas/v4", note: "speech, transcription and pictures; a GLM Coding Plan key works only on the coding endpoints", source: "https://docs.z.ai/devpack/faq" },
  zai: { intl: "https://api.z.ai/api/paas/v4", note: "transcription and pictures; a GLM Coding Plan key works only on the coding endpoints", source: "https://docs.z.ai/devpack/faq" },
  minimax: { intl: "https://api.minimax.io/v1", cn: "https://api.minimaxi.com/v1", note: "pictures only (its speech has its own shape)", source: "https://platform.minimax.io/docs/api-reference/image-generation-h3-generations.md" },
  ark: { cn: "https://ark.cn-beijing.volces.com/api/v3", note: "pictures (Seedream) only", source: "https://docs.volcengine.com/docs/82379/1541523" },
  "ark-plan": { cn: "https://ark.cn-beijing.volces.com/api/plan/v3", note: "pictures (Seedream) only, with the Agent Plan key", source: "https://docs.volcengine.com/docs/ark/agent-plan-personal-visual-models?lang=zh" },
};

/** The kind a documented rule gives `model` on a provider of `preset`, if one does. */
export function documentedKind(preset: string | undefined, model: string): GatewayKind | undefined {
  return preset ? DOCUMENTED_KINDS[preset]?.kinds[model] : undefined;
}

export function kindOf(p: Pick<GatewayProvider, "kinds" | "preset">, model: string): GatewayKind {
  return p.kinds?.[model] ?? documentedKind(p.preset, model) ?? "text";
}

/**
 * What a provider can serve through the gateway: text on a `messages` base; speech and pictures on
 * an `openai` base, unless its preset says the vendor has no such endpoint in the shape the
 * gateway forwards (`PRESET_LACKS`), with the reason the page shows.
 */
export type Serves = Record<GatewayKind, true | string>;

/** Per preset, the OpenAI-style operations its vendor does not offer in the forwarded shape, and why (docs/model-gateway.md#presets). */
const NONE = "the vendor documents none";
export const PRESET_LACKS: Record<string, Partial<Record<Exclude<GatewayKind, "text">, string>>> = {
  anthropic: { asr: NONE, tts: NONE, image: NONE },
  deepseek: { asr: "its transcription is /v1/tools/asr, a shape the gateway does not forward", tts: "its speech is /v1/tools/tts, a shape the gateway does not forward", image: NONE },
  kimi: { asr: NONE, tts: NONE, image: NONE },
  dashscope: { asr: "its transcription runs through chat completions, not /audio/transcriptions", tts: "its speech is DashScope's own API", image: "its pictures are DashScope's own API (no OpenAI-compatible mode)" },
  minimax: { asr: "its transcription is /v1/speech_to_text, a shape the gateway does not forward", tts: "its speech (t2a_v2) answers JSON with hex audio, not the forwarded shape" },
  zai: { tts: NONE },
  groq: { image: NONE },
  openrouter: { tts: "its speech answers mp3 or pcm, and ai-space's speech asks for wav", image: "its pictures are POST /api/v1/images, not /images/generations" },
  ark: { asr: "Doubao speech is on openspeech.bytedance.com with its own protocol", tts: "Doubao speech is on openspeech.bytedance.com with its own protocol" },
  "ark-plan": { asr: "Doubao speech is on openspeech.bytedance.com with its own protocol", tts: "Doubao speech is on openspeech.bytedance.com with its own protocol" },
  "ark-coding": { asr: "a Coding Plan key is for coding tools only", tts: "a Coding Plan key is for coding tools only", image: "a Coding Plan key is for coding tools only" },
};

export function servesOf(p: Pick<GatewayProvider, "messages" | "openai" | "preset">): Serves {
  const lacks = (p.preset && PRESET_LACKS[p.preset]) || {};
  const noOpenai = "no openai base: add the vendor's OpenAI-style base to use it for speech or pictures";
  const on = (k: Exclude<GatewayKind, "text">): true | string => lacks[k] ?? (!p.openai ? noOpenai : true);
  return { text: p.messages ? true : "no messages base", asr: on("asr"), tts: on("tts"), image: on("image") };
}
