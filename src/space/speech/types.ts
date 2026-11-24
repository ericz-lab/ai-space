import type { FailureKind } from "../model/failure.ts";

/**
 * The speech layer's data model (docs/speech.md): one Space contract, providers registered by kind in
 * `providers.yaml`, one adapter per kind that declares what it can do.
 */

/** What a provider can do. `clone` is declared by kinds that can, and has no Space route yet. */
export const SPEECH_CAPABILITIES = ["transcribe", "live", "speak", "clone"] as const;
export type SpeechCapability = (typeof SPEECH_CAPABILITIES)[number];

/** The capabilities a default and a fallback list are given for; `live` falls back to `asr`'s when not set. */
export const SPEECH_ROLES = ["asr", "tts", "live"] as const;
export type SpeechRole = (typeof SPEECH_ROLES)[number];
export const ROLE_CAPABILITY: Record<SpeechRole, SpeechCapability> = { asr: "transcribe", tts: "speak", live: "live" };

export const SPEECH_KINDS = ["voice-studio", "openai-compatible", "dashscope"] as const;
export type SpeechKind = (typeof SPEECH_KINDS)[number];

/** The capabilities of each kind, known without calling it, so the file can be checked when it loads. */
export const KIND_CAPABILITIES: Record<SpeechKind, readonly SpeechCapability[]> = {
  "voice-studio": ["transcribe", "live", "speak"],
  "openai-compatible": ["transcribe", "speak"],
  // Reserved: a file naming it loads, the provider is off (docs/speech.md#later).
  dashscope: [],
};

export const PROVIDER_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A voice as a provider names it: `zh-Xinran_woman`, `alloy`. */
export const VOICE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,79}$/u;

export type Price = { transcribePerMinute?: number; speakPerMillionChars?: number };

export type VoiceStudioSpec = {
  name: string;
  kind: "voice-studio";
  /** The app that provides `transcribe` and `speak`; default `voice-studio`. */
  app: string;
  /** The peer it runs on; absent: this space when the app is here, else the one peer that provides it. */
  machine?: string;
};

export type OpenAiSpec = {
  name: string;
  kind: "openai-compatible";
  /** Base URL, without a trailing slash; `/audio/transcriptions` and `/audio/speech` are under it. */
  url: string;
  apiKeyEnv?: string;
  /** The key read from `apiKeyEnv` at load; never written anywhere. */
  apiKey?: string;
  asrModel: string;
  ttsModel: string;
  voice?: string;
  voices?: string[];
  selfHosted: boolean;
  responseFormat?: "json" | "verbose_json";
  price?: Price;
  /**
   * Through a model gateway (docs/model-gateway.md#speech): the built-in one (`space`) or magpie,
   * and the provider behind it; the models are then `<provider>/<model>`, and the address and the
   * key are the gateway's, so a key is configured once, in gateway.yaml (or magpie).
   */
  gateway?: { via: "space" | "magpie"; provider: string };
};

export type DashscopeSpec = { name: string; kind: "dashscope"; apiKeyEnv?: string };

export type ProviderSpec = VoiceStudioSpec | OpenAiSpec | DashscopeSpec;

export type SpeechConfig = {
  providers: ProviderSpec[];
  /** Per role, the provider a call goes to when it names none; a role without one has no provider. */
  default: Partial<Record<SpeechRole, string>>;
  /** Per role, the providers tried after the first choice, in order. */
  fallback: Partial<Record<SpeechRole, string[]>>;
  /** One voice name, each provider's own voice: `narrator: { gpu: en-Frank_man, openai: onyx }`. */
  voices: Record<string, Record<string, string>>;
  /** Providers kept in the file but off, with the reason (a missing key, a kind not built yet). */
  off: Record<string, string>;
};

/** Who is calling, for the ledger and the bus record: an app, or `space` for the operator and the panel. */
export type SpeechCaller = { app: string; tag: string };

export type Segment = { start: number; end: number; text: string };

export type TranscribeInput = {
  file: Blob;
  filename: string;
  language: string;
  context: string;
  signal?: AbortSignal;
};

export type TranscribeResult = {
  text: string;
  language: string;
  segments: Segment[];
  /** The input's length as the provider reported it; undefined when it did not say. */
  audioSeconds?: number;
};

export type SpeakInput = {
  text: string;
  /** The provider's own voice names; empty means its default. */
  voices: string[];
  signal?: AbortSignal;
};

export type SpeakResult = { audio: ArrayBuffer; contentType: string };

/** Where a live session's provider socket is, speaking the Space's live protocol (docs/speech.md#live-protocol). */
/** Where a live session's socket goes; `open`, when given, makes it (a peer's socket over a package connection) instead of `url` with `headers`. */
export type LiveTarget = { url: string; headers: Record<string, string>; machine: string; open?: () => WebSocket };

/** What a provider's cell shows before any call: whether it can be reached at all. */
export type ProviderState = {
  /** This machine, a peer's name, or an API's host. */
  where: string;
  /** The peer it runs on, for the ledger; "" for this machine and for an API. */
  machine: string;
  /** False when it is nowhere at all (no app here, no peer listing it); true otherwise, even while it is down. */
  located: boolean;
  reachable?: boolean;
  signedIn?: boolean;
  detail?: string;
};

/** Limits a request is checked against before a provider is tried. */
export type ProviderLimits = { transcribeBytes?: number; speakChars?: number; speakVoices?: number };

export interface SpeechAdapter {
  readonly name: string;
  readonly kind: SpeechKind;
  readonly capabilities: ReadonlySet<SpeechCapability>;
  /** Runs on the operator's own machines: a local-only app may use it. */
  readonly selfHosted: boolean;
  readonly limits: ProviderLimits;
  /** The voice used when a request names none, when the kind has one to name. */
  readonly defaultVoice?: string;
  state(capability?: SpeechCapability): ProviderState;
  transcribe?(input: TranscribeInput, caller: SpeechCaller): Promise<TranscribeResult>;
  speak?(input: SpeakInput, caller: SpeechCaller): Promise<SpeakResult>;
  /** The voices it has; undefined when it cannot say (an API without a list). Throws when it cannot be asked. */
  voices?(signal?: AbortSignal): Promise<string[] | undefined>;
  /** Where to open a live session; throws a ProviderError when it cannot be reached. */
  live?(): LiveTarget;
  /** USD for one call, from its figures; undefined without a price. */
  cost?(capability: SpeechCapability, figures: { audioSeconds?: number; chars?: number }): number | undefined;
}

/**
 * A provider failed: the message is what its HTTP status and body or the link said, written so the
 * model layer's reading of failures (`classifyFailure`) sorts it: `HTTP 503: …`, `unreachable: …`.
 */
export class ProviderError extends Error {
  /** `kind`: how the failure counts when the words alone would not say (nothing to reach is a link failure). */
  constructor(message: string, readonly status = 502, readonly kind?: FailureKind) {
    super(message);
  }
}

/** A request the Space refuses before or instead of a provider, with the HTTP status to answer. */
export class SpeechError extends Error {
  constructor(readonly status: number, message: string, readonly call?: SpeechCall, readonly code?: string) {
    super(message);
  }
}

export type CandidateTrace = { provider: string; skipped?: string; later?: string };
export type TryTrace = { provider: string; machine?: string; ok: boolean; ms: number; error?: string; kind?: FailureKind };
export type SpeechTrace = { candidates: CandidateTrace[]; tries: TryTrace[]; stop: "answered" | "not-switched" | "exhausted" | "aborted" };

export type SpeechCallInput = {
  app: string;
  tag: string;
  capability: Exclude<SpeechCapability, "clone">;
  provider: string;
  kind: string;
  machine?: string;
  status: "ok" | "error";
  error?: string;
  startedAt: number;
  durationMs: number;
  inputBytes?: number;
  audioSeconds?: number;
  chars?: number;
  voice?: string;
  language?: string;
  costUsd?: number;
  fallbackFrom?: string;
  tries?: number;
  trace?: SpeechTrace;
};

export type SpeechCall = SpeechCallInput & { id: number };

export type SpeechTotals = { calls: number; errors: number; audioSeconds: number; chars: number; costUsd: number; durationMs: number };
