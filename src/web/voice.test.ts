import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { captureProcessor, VoiceTranscript } from "./voice.ts";

test("partials replace drafts, finals commit once, empty finals clear drafts", () => {
  const transcript = new VoiceTranscript("Existing text ");
  expect(transcript.update(0, "hel", false)).toBe("Existing text hel");
  expect(transcript.update(0, "hello", false)).toBe("Existing text hello");
  expect(transcript.update(0, "Hello.", true)).toBe("Existing text Hello.");
  expect(transcript.update(0, "stale", false)).toBe("Existing text Hello.");
  expect(transcript.update(1, "noise", false)).toBe("Existing text Hello. noise");
  expect(transcript.update(1, "", true)).toBe("Existing text Hello.");
  expect(transcript.update(2, "Next.", true)).toBe("Existing text Hello. Next.");
  expect(transcript.update(2, "Next.", true)).toBe("Existing text Hello. Next.");
  expect(new VoiceTranscript("").update(0, "Fresh", true)).toBe("Fresh");
});

test("capture emits bounded little-endian PCM and flushes its tail before stop", () => {
  const messages: (ArrayBuffer | string)[] = [];
  let Capture: any;
  runInNewContext(captureProcessor, {
    AudioWorkletProcessor: class { port = { postMessage: (data: ArrayBuffer | string) => messages.push(data), onmessage: undefined }; },
    registerProcessor: (_: string, ctor: unknown) => { Capture = ctor; },
  });
  const node = new Capture();
  for (let i = 0; i < 13; i++) node.process([[new Float32Array(128).fill(i % 2 ? -1 : 1)]]);
  expect(messages.length).toBe(1);
  expect((messages[0] as ArrayBuffer).byteLength).toBe(3200);
  const view = new DataView(messages[0] as ArrayBuffer);
  expect(view.getInt16(0, true)).toBe(32767);
  expect(view.getInt16(256, true)).toBe(-32768);
  node.port.onmessage();
  expect((messages[1] as ArrayBuffer).byteLength).toBe(128);
  expect(messages[2]).toBe("stopped");
  expect(node.process([[new Float32Array(128)]])).toBe(false);
  expect(messages.length).toBe(3);
});

test("disposing during microphone permission releases a late stream without updating UI", async () => {
  const { LiveVoice } = await import("./voice.ts");
  const contextDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let grant!: (stream: MediaStream) => void;
  let stopped = 0;
  let closed = 0;
  const states: string[] = [];
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class {
    state = "running";
    resume() { return Promise.resolve(); }
    close() { closed++; this.state = "closed"; return Promise.resolve(); }
  } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => new Promise<MediaStream>((resolve) => { grant = resolve; }) } } });
  const session = new LiveVoice("", () => { throw new Error("unexpected text"); }, (state) => states.push(state), () => { throw new Error("unexpected error"); });
  try {
    const started = session.start();
    await Promise.resolve();
    session.dispose();
    grant({ getTracks: () => [{ stop: () => stopped++ }] } as unknown as MediaStream);
    await started;
    expect(stopped).toBe(1);
    expect(closed).toBe(1);
    expect(states).toEqual(["connecting"]);
  } finally {
    session.dispose();
    if (contextDescriptor) Object.defineProperty(globalThis, "AudioContext", contextDescriptor);
    else Reflect.deleteProperty(globalThis, "AudioContext");
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});
