import { expect, test } from "bun:test";
import type { SpeechCell } from "./api.ts";
import { speechState } from "./SettingsStatus.tsx";

const cell = (over: Partial<SpeechCell> = {}): SpeechCell => ({
  provider: "gpu", kind: "voice-studio", capabilities: ["transcribe", "live", "speak"], selfHosted: true, where: "gpu-box", located: true, reachable: true, roles: ["asr"], used: true, ...over,
});

test("a speech provider's dot: red only when something uses it and it cannot answer", () => {
  expect(speechState(cell(), "en")).toEqual({ cls: "ok", key: "runtimes.ready" });
  expect(speechState(cell({ reachable: false, problem: "unreachable" }), "en")).toEqual({ cls: "down", key: "runtimes.unreachable" });
  expect(speechState(cell({ reachable: false, roles: [], used: false }), "en")).toEqual({ cls: "archived", key: "runtimes.unreachable" });
  expect(speechState(cell({ off: "KEY is not set", problem: "off" }), "en")).toEqual({ cls: "down", key: "speech.off" });
  expect(speechState(cell({ located: false, reachable: false, problem: "unreachable" }), "en")).toMatchObject({ cls: "down", key: "speech.notFound" });
  expect(speechState(cell({ kind: "openai-compatible", where: "api.example.com", reachable: undefined, signedIn: false, problem: "not signed in" }), "en")).toEqual({ cls: "down", key: "runtimes.notSignedIn" });
  // A resting provider is amber and says why it rests.
  expect(speechState(cell({ limitedUntil: "2026-11-19T12:00:00Z", restKind: "quota", problem: "limited" }), "zh")).toMatchObject({ cls: "paused", key: "runtimes.limited", text: expect.any(String) });
});
