import { VOICE_LANGUAGES, voiceLanguage } from "../../../../src/web/voice.ts";

/**
 * Voice input's rules without GTK, so `bun test` runs them (docs/linux-desktop.md#voice-input).
 * They are the Mac's (`LiveVoice.swift`, `DictationRules.swift`, `VoiceLanguage` in
 * `SpaceModels.swift`) and the iPhone's (`VoiceTranscript`, `VoicePCMFrames`): the language sent,
 * the live protocol's messages (docs/speech.md#live-protocol), frames of at most 100 ms, the
 * transcript built from `partial` and `final` events, a WAV for the upload, and `LiveSession`, the
 * state of one recording from the first sample to the text. The app's side (`app/voice.ts`) records
 * with GStreamer and talks to the Space with libsoup, and only feeds this class and does what it says.
 */

/** 16 kHz mono signed 16-bit PCM: 32,000 bytes a second. */
export const BYTES_PER_SECOND = 32_000;
/** The live socket takes at most 100 ms of PCM per binary message. */
export const FRAME_BYTES = 3_200;
/** Recording ends by itself after this long, as if the person had stopped it. */
export const MAX_SECONDS = 90;
/** What is held while the transcriber loads (about 15 s cold); recording stops when it is full. */
export const MAX_BACKLOG_BYTES = 50 * BYTES_PER_SECOND;
/** After the stop: how long the last finals may take before the session gives up. */
export const FINISH_SECONDS = 70;

// Language

/** The setting: "" the app's language (the default), "auto" detect, or one of the codes. */
export type VoiceLanguageSetting = "" | "auto" | (typeof VOICE_LANGUAGES)[number]["code"];
export const VOICE_CODES: readonly string[] = VOICE_LANGUAGES.map((l) => l.code);
export { VOICE_LANGUAGES };

/** The setting as saved, anything unknown read as the default. */
export function voiceSetting(saved: unknown): VoiceLanguageSetting {
  return saved === "auto" || (typeof saved === "string" && VOICE_CODES.includes(saved)) ? (saved as VoiceLanguageSetting) : "";
}

/** The `language` sent for a setting and the app's language; empty lets the provider detect it (the web panel's rule). */
export function voiceCode(setting: unknown, appLang: string): string {
  return voiceLanguage(voiceSetting(setting), appLang);
}

/** The live protocol's `start` message. */
export function startMessage(language: string): string {
  return JSON.stringify({ type: "start", format: "pcm_s16le", sample_rate: 16000, channels: 1, language: VOICE_CODES.includes(language) ? language : "" });
}

/** The multipart fields of a clip sent to `POST /api/voice/transcribe`: none when detecting. */
export function uploadFields(language: string): Record<string, string> {
  return VOICE_CODES.includes(language) ? { language } : {};
}

// Which Space

/**
 * The one Space that transcribes: the one named under Transcribe with while it is still saved,
 * else the selected one. Never another: a Space that cannot transcribe is said so, not replaced.
 */
export function voiceSpace(saved: readonly string[], pinned: string | undefined, selected: string | undefined): string | undefined {
  if (pinned && saved.includes(pinned)) return pinned;
  return selected && saved.includes(selected) ? selected : undefined;
}

/** `GET /api/voice`'s answer: whether the Space's speech provider can transcribe. */
export function canTranscribe(body: unknown): boolean {
  return Boolean(body && typeof body === "object" && (body as { transcribe?: unknown }).transcribe === true);
}

// Text

/** CJK ideographs, kana, and their punctuation and full-width forms. */
function wide(c: string | undefined): boolean {
  if (!c) return false;
  const v = c.codePointAt(0)!;
  return (v >= 0x2e80 && v <= 0x9fff) || (v >= 0xf900 && v <= 0xfaff) || (v >= 0xff00 && v <= 0xffef);
}

/**
 * Segments are joined by a space, which is wrong inside Chinese or Japanese text: a space between
 * two such characters is dropped, one beside a Latin word or a digit stays (the Mac's `tidy`).
 */
export function tidy(text: string): string {
  const chars = [...text];
  let out = "";
  chars.forEach((c, i) => {
    if (c === " " && i > 0 && i + 1 < chars.length && wide(chars[i - 1]) && wide(chars[i + 1])) return;
    out += c;
  });
  return out;
}

/** A transcript after what a field already holds: a space between them, none between Chinese characters. */
export function appendTranscript(field: string, text: string): string {
  const kept = field.trimEnd();
  const heard = text.trim();
  if (!kept) return heard;
  if (!heard) return kept;
  return wide([...kept].at(-1)) && wide([...heard][0]) ? kept + heard : `${kept} ${heard}`;
}

/** The end of a long live transcript, which is what is being said, cut at a word when one ends near the cut. */
export function tail(text: string, limit = 120): string {
  const trimmed = text.trim();
  const chars = [...trimmed];
  if (chars.length <= limit) return trimmed;
  let kept = chars.slice(-limit);
  const space = kept.slice(0, Math.floor(limit / 6)).indexOf(" ");
  if (space >= 0) kept = kept.slice(space + 1);
  return `…${kept.join("")}`;
}

/** Provisional text replaces its segment; a final one commits it once, even when empty. */
export class VoiceTranscript {
  private readonly segments = new Map<number, { text: string; final: boolean }>();
  update(id: number, text: string, final: boolean): string {
    if (!this.segments.get(id)?.final) this.segments.set(id, { text, final });
    return this.text();
  }
  text(): string {
    return tidy(
      [...this.segments]
        .sort(([a], [b]) => a - b)
        .map(([, s]) => s.text.trim())
        .filter(Boolean)
        .join(" "),
    );
  }
}

// Audio

/** Captured PCM in frames of at most 100 ms (3,200 bytes); `finish` gives what is left. */
export class PcmFrames {
  private pending = new Uint8Array(0);
  append(data: Uint8Array): Uint8Array[] {
    const all = new Uint8Array(this.pending.length + data.length);
    all.set(this.pending, 0);
    all.set(data, this.pending.length);
    const frames: Uint8Array[] = [];
    let at = 0;
    for (; all.length - at >= FRAME_BYTES; at += FRAME_BYTES) frames.push(all.slice(at, at + FRAME_BYTES));
    this.pending = all.slice(at);
    return frames;
  }
  finish(): Uint8Array | undefined {
    if (!this.pending.length) return undefined;
    const rest = this.pending;
    this.pending = new Uint8Array(0);
    return rest;
  }
}

/** Mono 16-bit PCM as a WAV file: the recording sent as a clip when the live route does not answer. */
export function wav(pcm: Uint8Array, sampleRate = 16000): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

// The live protocol's events

export type VoiceEvent =
  | { type: "loading" }
  | { type: "ready" }
  | { type: "partial" | "final"; segment_id: number; text: string }
  | { type: "done" }
  | { type: "error"; code?: string; message?: string };

/** One text message from the socket, or undefined for one this client does not read. */
export function decodeVoiceEvent(text: string): VoiceEvent | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  switch (o.type) {
    case "loading":
    case "ready":
    case "done":
      return { type: o.type };
    case "partial":
    case "final":
      return typeof o.segment_id === "number" && typeof o.text === "string" ? { type: o.type, segment_id: o.segment_id, text: o.text } : undefined;
    case "error":
      return { type: "error", ...(typeof o.code === "string" ? { code: o.code } : {}), ...(typeof o.message === "string" ? { message: o.message } : {}) };
    default:
      return undefined;
  }
}

// One recording

export type VoiceState = "idle" | "starting" | "recording" | "finishing";

/** Why a recording ended without text; the app words it. */
export type VoiceFailure = { kind: "failed"; detail: string } | { kind: "timedOut" };

/** What `LiveSession` asks the app to do. */
export type VoiceIO = {
  /** A text message on the live socket (the stop). */
  sendText(text: string): void;
  /** A binary frame on the live socket, at most 100 ms. */
  sendFrame(frame: Uint8Array): void;
  /** The live socket is no longer wanted. */
  closeSocket(): void;
  /** Stop recording and let the microphone go. */
  releaseMic(): void;
  /** Send the whole recording as a WAV to `POST /api/voice/transcribe`; answer with `uploaded` or `uploadFailed`. */
  upload(clip: Uint8Array): void;
  /** Call `timeout` after this many seconds, replacing an earlier timer; 0 clears it. */
  arm(seconds: number): void;
  /** The state or the live text changed. */
  changed(): void;
  /** The final text, once, never empty. */
  deliver(text: string): void;
  failed(why: VoiceFailure): void;
};

/**
 * One recording, the Mac's LiveVoice without its threads. Recording starts at once; what is said
 * before the transcriber answers `ready` is held (up to 50 s) and sent first. Until `ready` the
 * whole recording is also kept, so when the live socket is refused, fails or never gets ready, it
 * goes up on the stop as a WAV clip instead. The stop sends what is left and `stop`; the text goes
 * out once, after `done`. Every call after the end is ignored.
 */
export class LiveSession {
  state: VoiceState = "starting";
  /** The live text so far: the final segments and the current one's draft. */
  text = "";
  private ready = false;
  private clipOnly = false;
  private ended = false;
  private held: Uint8Array[] = [];
  private heldBytes = 0;
  private clip: Uint8Array[] | undefined = [];
  private clipBytes = 0;
  private readonly frames = new PcmFrames();
  private readonly transcript = new VoiceTranscript();

  constructor(private readonly io: VoiceIO) {}

  get done(): boolean {
    return this.ended;
  }

  /** The microphone is open: recording, for at most 90 seconds. */
  micOpen(): void {
    if (this.ended || this.state !== "starting") return;
    this.state = "recording";
    this.io.arm(MAX_SECONDS);
    this.io.changed();
  }

  /** The microphone could not be opened, or the person cancelled: nothing to keep. */
  abort(why?: VoiceFailure): void {
    if (this.ended) return;
    if (why) this.fail(why);
    else this.end();
  }

  /** Captured PCM, in any size. */
  audio(data: Uint8Array): void {
    if (this.ended || this.state !== "recording" || !data.length) return;
    if (this.clip && this.clipBytes + data.length <= MAX_SECONDS * BYTES_PER_SECOND) {
      this.clip.push(data);
      this.clipBytes += data.length;
    }
    if (this.clipOnly) return;
    if (this.ready) {
      for (const f of this.frames.append(data)) this.io.sendFrame(f);
      return;
    }
    if (this.heldBytes + data.length > MAX_BACKLOG_BYTES) {
      // Held as long as allowed while the model loads: stop recording and keep what there is.
      this.stop();
      return;
    }
    this.held.push(data);
    this.heldBytes += data.length;
  }

  /** The person stopped (or the 90 seconds ran out). Before the microphone opened there is nothing to keep. */
  stop(): void {
    if (this.ended) return;
    if (this.state === "starting") return this.end();
    if (this.state !== "recording") return;
    this.state = "finishing";
    this.io.releaseMic();
    this.io.changed();
    if (this.clipOnly) return this.upload();
    this.io.arm(FINISH_SECONDS);
    if (this.ready) this.flushAndStop();
  }

  /** A text message from the live socket. */
  message(text: string): void {
    if (this.ended || this.clipOnly) return;
    const e = decodeVoiceEvent(text);
    if (!e) return;
    switch (e.type) {
      case "ready":
        if (this.ready) return;
        this.ready = true;
        // The live route answers: the copy kept for an upload is not needed any more.
        this.clip = undefined;
        for (const d of this.held) for (const f of this.frames.append(d)) this.io.sendFrame(f);
        this.held = [];
        this.heldBytes = 0;
        if (this.state === "finishing") this.flushAndStop();
        return;
      case "partial":
      case "final":
        this.text = this.transcript.update(e.segment_id, e.text, e.type === "final");
        this.io.changed();
        return;
      case "done":
        return this.finish(this.transcript.text());
      case "error":
        if (this.ready) return this.fail({ kind: "failed", detail: e.message || e.code || "error" });
        return this.fallBack();
      case "loading":
        return;
    }
  }

  /** The socket was refused, dropped, or closed before `done`. */
  socketFailed(detail: string): void {
    if (this.ended || this.clipOnly) return;
    if (this.ready) this.fail({ kind: "failed", detail });
    else this.fallBack();
  }

  /** The timer `arm` set ran out. */
  timeout(): void {
    if (this.ended) return;
    if (this.state === "recording") this.stop();
    else if (this.state === "finishing" && !this.clipOnly) {
      if (this.ready) this.fail({ kind: "timedOut" });
      else this.fallBack();
    }
  }

  uploaded(body: unknown): void {
    if (this.ended) return;
    const text = body && typeof body === "object" && typeof (body as { text?: unknown }).text === "string" ? (body as { text: string }).text : "";
    this.finish(text);
  }

  uploadFailed(detail: string): void {
    if (this.ended) return;
    this.fail({ kind: "failed", detail });
  }

  private flushAndStop(): void {
    const rest = this.frames.finish();
    if (rest) this.io.sendFrame(rest);
    this.io.sendText(JSON.stringify({ type: "stop" }));
  }

  /** The live route will not answer: the recording, whole, goes up as a clip on the stop. */
  private fallBack(): void {
    if (this.clipOnly) return;
    this.clipOnly = true;
    this.held = [];
    this.heldBytes = 0;
    this.io.closeSocket();
    if (this.state === "finishing") this.upload();
  }

  private upload(): void {
    this.io.arm(0);
    const pcm = this.clip ? concat(this.clip) : new Uint8Array(0);
    this.clip = undefined;
    if (!pcm.length) return this.finish("");
    this.io.upload(wav(pcm));
  }

  private finish(final: string): void {
    const text = tidy(final.trim());
    this.end();
    if (text) this.io.deliver(text);
  }

  private fail(why: VoiceFailure): void {
    this.end();
    this.io.failed(why);
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.io.arm(0);
    this.io.releaseMic();
    this.io.closeSocket();
    this.held = [];
    this.clip = undefined;
    this.state = "idle";
    this.text = "";
    this.io.changed();
  }
}

// The overlay of `ai-space --dictate`

/** What the app tells the overlay process (src/hud/hud.ts), one JSON line each. */
export type ToHud = { type: "show"; kind: "listening" | "working" | "note"; text: string; dark?: boolean } | { type: "hide" } | { type: "quit" };

export function decodeToHud(line: string): ToHud | undefined {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (o.type === "hide" || o.type === "quit") return { type: o.type };
  if (o.type === "show" && typeof o.text === "string" && (o.kind === "listening" || o.kind === "working" || o.kind === "note")) {
    return { type: "show", kind: o.kind, text: o.text, ...(typeof o.dark === "boolean" ? { dark: o.dark } : {}) };
  }
  return undefined;
}

/** How long a note (the clipboard, a failure) stays on the overlay. */
export const NOTE_SECONDS = 4;
