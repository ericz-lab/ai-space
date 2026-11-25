import { describe, expect, test } from "bun:test";
import {
  BYTES_PER_SECOND, FRAME_BYTES, LiveSession, MAX_BACKLOG_BYTES, MAX_SECONDS, PcmFrames, type VoiceFailure, type VoiceIO, VoiceTranscript, appendTranscript, canTranscribe, decodeToHud,
  decodeVoiceEvent, startMessage, tail, tidy, uploadFields, voiceCode, voiceSetting, voiceSpace, wav,
} from "./voice.ts";

describe("voice language (the Mac's VoiceLanguage, the web's voiceLanguage)", () => {
  test("same as the app by default, its primary subtag when it is one of the four", () => {
    expect(voiceCode(undefined, "zh")).toBe("zh");
    expect(voiceCode("", "en")).toBe("en");
    expect(voiceCode("", "zh-Hans")).toBe("zh");
    expect(voiceCode("", "fr")).toBe("");
  });
  test("detect sends nothing; an explicit code wins over the app's language", () => {
    expect(voiceCode("auto", "zh")).toBe("");
    expect(voiceCode("ja", "zh")).toBe("ja");
    expect(voiceCode("ko", "en")).toBe("ko");
  });
  test("an unknown saved value is the default", () => {
    expect(voiceSetting("de")).toBe("");
    expect(voiceSetting(42)).toBe("");
    expect(voiceSetting("auto")).toBe("auto");
    expect(voiceCode("de", "en")).toBe("en");
  });
  test("the start message and the upload's fields", () => {
    expect(JSON.parse(startMessage("zh"))).toEqual({ type: "start", format: "pcm_s16le", sample_rate: 16000, channels: 1, language: "zh" });
    expect(JSON.parse(startMessage("")).language).toBe("");
    expect(JSON.parse(startMessage("zh-CN")).language).toBe("");
    expect(uploadFields("en")).toEqual({ language: "en" });
    expect(uploadFields("")).toEqual({});
  });
});

describe("which Space transcribes", () => {
  test("the one named under Transcribe with, else the selected one, never another", () => {
    expect(voiceSpace(["a", "b"], "b", "a")).toBe("b");
    expect(voiceSpace(["a", "b"], undefined, "a")).toBe("a");
    expect(voiceSpace(["a", "b"], "gone", "a")).toBe("a");
    expect(voiceSpace([], undefined, undefined)).toBeUndefined();
    expect(voiceSpace(["a"], undefined, "removed")).toBeUndefined();
  });
  test("GET /api/voice says yes only with transcribe: true", () => {
    expect(canTranscribe({ ok: true, transcribe: true })).toBe(true);
    expect(canTranscribe({ ok: true, transcribe: false })).toBe(false);
    expect(canTranscribe({ ok: true })).toBe(false);
    expect(canTranscribe(null)).toBe(false);
  });
});

describe("transcript text", () => {
  test("no space between Chinese segments, one beside Latin words and digits", () => {
    expect(tidy("你好 世界")).toBe("你好世界");
    expect(tidy("你好 world")).toBe("你好 world");
    expect(tidy("版本 2 发布")).toBe("版本 2 发布");
    expect(tidy("こんにちは 世界。 次")).toBe("こんにちは世界。次");
    expect(tidy("hello world")).toBe("hello world");
  });
  test("segments: a draft replaces its segment, a final commits once, in segment order", () => {
    const t = new VoiceTranscript();
    expect(t.update(0, "今天", false)).toBe("今天");
    expect(t.update(0, "今天天气", true)).toBe("今天天气");
    expect(t.update(0, "ignored", false)).toBe("今天天气");
    expect(t.update(2, "不错", false)).toBe("今天天气不错");
    expect(t.update(1, "很好", true)).toBe("今天天气很好不错");
    const e = new VoiceTranscript();
    e.update(0, "Hello", true);
    expect(e.update(1, " there ", false)).toBe("Hello there");
    expect(e.update(1, "", true)).toBe("Hello");
  });
  test("a transcript after what the field holds", () => {
    expect(appendTranscript("", "hello")).toBe("hello");
    expect(appendTranscript("ask ", "hello")).toBe("ask hello");
    expect(appendTranscript("问一下", "明天天气")).toBe("问一下明天天气");
    expect(appendTranscript("问一下", "Linux")).toBe("问一下 Linux");
    expect(appendTranscript("kept", "  ")).toBe("kept");
  });
  test("the overlay shows the end of a long transcript", () => {
    expect(tail("short")).toBe("short");
    const words = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    const shown = tail(words, 40);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown.endsWith("w59")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(41);
    expect(shown[1]).not.toBe(" ");
    expect(tail("字".repeat(200), 120)).toBe(`…${"字".repeat(120)}`);
  });
});

describe("audio", () => {
  test("frames of at most 100 ms, the rest on finish", () => {
    const f = new PcmFrames();
    expect(f.append(new Uint8Array(1000))).toHaveLength(0);
    const frames = f.append(new Uint8Array(FRAME_BYTES * 2 + 500));
    expect(frames.map((x) => x.length)).toEqual([FRAME_BYTES, FRAME_BYTES]);
    expect(f.finish()?.length).toBe(1500);
    expect(f.finish()).toBeUndefined();
  });
  test("bytes keep their order across frames", () => {
    const f = new PcmFrames();
    const data = Uint8Array.from({ length: 5000 }, (_, i) => i % 251);
    const out = [...f.append(data.slice(0, 2000)), ...f.append(data.slice(2000)), f.finish()!];
    const joined = Uint8Array.from(out.flatMap((x) => [...x]));
    expect(joined).toEqual(data);
  });
  test("a WAV header for mono 16 kHz PCM16", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const w = wav(pcm);
    const v = new DataView(w.buffer);
    const text = (at: number) => String.fromCharCode(...w.slice(at, at + 4));
    expect(w.length).toBe(48);
    expect(text(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(40);
    expect(text(8)).toBe("WAVE");
    expect(text(12)).toBe("fmt ");
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(28, true)).toBe(32000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(text(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(4);
    expect([...w.slice(44)]).toEqual([1, 2, 3, 4]);
  });
  test("the live socket's events", () => {
    expect(decodeVoiceEvent('{"type":"ready","sample_rate":16000}')).toEqual({ type: "ready" });
    expect(decodeVoiceEvent('{"type":"partial","segment_id":3,"text":"hi"}')).toEqual({ type: "partial", segment_id: 3, text: "hi" });
    expect(decodeVoiceEvent('{"type":"final","text":"no id"}')).toBeUndefined();
    expect(decodeVoiceEvent('{"type":"error","code":"busy"}')).toEqual({ type: "error", code: "busy" });
    expect(decodeVoiceEvent("not json")).toBeUndefined();
    expect(decodeVoiceEvent('{"type":"other"}')).toBeUndefined();
  });
});

/** A session with every request it makes written down. */
function session() {
  const log: string[] = [];
  const frames: Uint8Array[] = [];
  const out: { delivered?: string; failed?: VoiceFailure; clip?: Uint8Array; armed: number[] } = { armed: [] };
  const io: VoiceIO = {
    sendText: (t) => log.push(`text ${t}`),
    sendFrame: (f) => {
      frames.push(f);
      log.push(`frame ${f.length}`);
    },
    closeSocket: () => log.push("close"),
    releaseMic: () => log.push("release"),
    upload: (clip) => {
      out.clip = clip;
      log.push("upload");
    },
    arm: (s) => out.armed.push(s),
    changed: () => {},
    deliver: (t) => (out.delivered = t),
    failed: (w) => (out.failed = w),
  };
  const s = new LiveSession(io);
  return { s, log, frames, out };
}

const pcm = (bytes: number, fill = 1) => new Uint8Array(bytes).fill(fill);

describe("one recording (the Mac's LiveVoice)", () => {
  test("audio before ready is held and sent first, in frames; the stop sends the rest and stop; done delivers once", () => {
    const { s, log, frames, out } = session();
    s.micOpen();
    expect(s.state).toBe("recording");
    expect(out.armed).toEqual([MAX_SECONDS]);
    s.audio(pcm(5000, 7));
    expect(frames).toHaveLength(0);
    s.message('{"type":"loading"}');
    s.message('{"type":"ready"}');
    expect(frames.map((f) => f.length)).toEqual([FRAME_BYTES]);
    s.audio(pcm(2000, 8));
    expect(frames.map((f) => f.length)).toEqual([FRAME_BYTES, FRAME_BYTES]);
    s.message('{"type":"partial","segment_id":0,"text":"你好"}');
    expect(s.text).toBe("你好");
    s.stop();
    expect(s.state).toBe("finishing");
    expect(log.slice(-2)).toEqual(["frame 600", 'text {"type":"stop"}']);
    expect(log).toContain("release");
    s.message('{"type":"final","segment_id":0,"text":"你好"}');
    s.message('{"type":"final","segment_id":1,"text":"世界"}');
    s.message('{"type":"done"}');
    expect(out.delivered).toBe("你好世界");
    expect(s.state).toBe("idle");
    expect(s.done).toBe(true);
    s.message('{"type":"done"}');
    s.audio(pcm(10));
    expect(out.failed).toBeUndefined();
  });

  test("stopped before ready: waits, then sends what it held and stop", () => {
    const { s, log } = session();
    s.micOpen();
    s.audio(pcm(4000));
    s.stop();
    expect(log.filter((l) => l.startsWith("frame"))).toHaveLength(0);
    expect(log).not.toContain('text {"type":"stop"}');
    s.message('{"type":"ready"}');
    expect(log.filter((l) => l.startsWith("frame") || l.startsWith("text"))).toEqual(["frame 3200", "frame 800", 'text {"type":"stop"}']);
  });

  test("a refused socket: the whole recording goes up as a WAV on the stop", () => {
    const { s, log, out } = session();
    s.micOpen();
    s.audio(pcm(1000, 1));
    s.socketFailed("503");
    expect(log).toContain("close");
    s.audio(pcm(1000, 2));
    expect(log).not.toContain("upload");
    s.stop();
    expect(log).toContain("upload");
    expect(out.clip!.length).toBe(44 + 2000);
    expect(out.clip![44]).toBe(1);
    expect(out.clip![44 + 1999]).toBe(2);
    s.uploaded({ ok: true, text: " 你好 世界 " });
    expect(out.delivered).toBe("你好世界");
  });

  test("refused after the stop: the upload goes at once", () => {
    const { s, log } = session();
    s.micOpen();
    s.audio(pcm(500));
    s.stop();
    s.message('{"type":"error","code":"no_provider"}');
    expect(log).toContain("upload");
  });

  test("never ready within the time after the stop: the clip goes up", () => {
    const { s, log } = session();
    s.micOpen();
    s.audio(pcm(500));
    s.stop();
    s.timeout();
    expect(log).toContain("upload");
  });

  test("an error after ready fails, and nothing is uploaded", () => {
    const { s, log, out } = session();
    s.micOpen();
    s.message('{"type":"ready"}');
    s.audio(pcm(500));
    s.message('{"type":"error","code":"transcription_failed","message":"model crashed"}');
    expect(out.failed).toEqual({ kind: "failed", detail: "model crashed" });
    expect(log).not.toContain("upload");
    expect(s.state).toBe("idle");
  });

  test("a dropped socket after ready fails; a stop that never finishes times out", () => {
    const a = session();
    a.s.micOpen();
    a.s.message('{"type":"ready"}');
    a.s.socketFailed("closed");
    expect(a.out.failed).toEqual({ kind: "failed", detail: "closed" });
    const b = session();
    b.s.micOpen();
    b.s.message('{"type":"ready"}');
    b.s.stop();
    b.s.timeout();
    expect(b.out.failed).toEqual({ kind: "timedOut" });
  });

  test("the 90 seconds run out: stopped as if by hand", () => {
    const { s, log } = session();
    s.micOpen();
    s.message('{"type":"ready"}');
    s.timeout();
    expect(s.state).toBe("finishing");
    expect(log).toContain('text {"type":"stop"}');
  });

  test("a transcriber that takes more than 50 s to get ready: recording stops, what was held is kept", () => {
    const { s, log } = session();
    s.micOpen();
    const second = pcm(BYTES_PER_SECOND);
    for (let i = 0; i < 50; i++) s.audio(second);
    expect(s.state).toBe("recording");
    s.audio(second);
    expect(s.state).toBe("finishing");
    s.message('{"type":"ready"}');
    const sent = log.filter((l) => l.startsWith("frame")).length;
    expect(sent).toBe(MAX_BACKLOG_BYTES / FRAME_BYTES);
  });

  test("the clip kept for an upload stops at 90 seconds", () => {
    const { s, out } = session();
    s.micOpen();
    s.socketFailed("refused");
    for (let i = 0; i < MAX_SECONDS + 5; i++) s.audio(pcm(BYTES_PER_SECOND));
    s.stop();
    expect(out.clip!.length).toBe(44 + MAX_SECONDS * BYTES_PER_SECOND);
  });

  test("an empty recording or an empty answer delivers nothing", () => {
    const a = session();
    a.s.micOpen();
    a.s.socketFailed("refused");
    a.s.stop();
    expect(a.log).not.toContain("upload");
    expect(a.out.delivered).toBeUndefined();
    expect(a.s.done).toBe(true);
    const b = session();
    b.s.micOpen();
    b.s.message('{"type":"ready"}');
    b.s.stop();
    b.s.message('{"type":"done"}');
    expect(b.out.delivered).toBeUndefined();
  });

  test("stopped before the microphone opened: nothing kept, nothing sent", () => {
    const { s, log, out } = session();
    s.stop();
    expect(s.done).toBe(true);
    expect(log).toEqual(["release", "close"]);
    expect(out.delivered).toBeUndefined();
    expect(out.failed).toBeUndefined();
  });

  test("an upload that fails says so", () => {
    const { s, out } = session();
    s.micOpen();
    s.audio(pcm(100));
    s.socketFailed("refused");
    s.stop();
    s.uploadFailed("503 no speech provider");
    expect(out.failed).toEqual({ kind: "failed", detail: "503 no speech provider" });
  });
});

describe("the overlay's messages", () => {
  test("decoded, anything else dropped", () => {
    expect(decodeToHud('{"type":"show","kind":"listening","text":"hi","dark":true}')).toEqual({ type: "show", kind: "listening", text: "hi", dark: true });
    expect(decodeToHud('{"type":"show","kind":"shout","text":"hi"}')).toBeUndefined();
    expect(decodeToHud('{"type":"quit"}')).toEqual({ type: "quit" });
    expect(decodeToHud("nope")).toBeUndefined();
  });
});
