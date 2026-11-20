import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinSpeech, loadSpeech, parseProvidersYaml } from "./config.ts";
import { parseAppSpeechSpec } from "./spec.ts";
import { parseManifest } from "../scheduler/manifest.ts";

const FULL = `
speech:
  default: { asr: gpu, tts: gpu }
  providers:
    gpu: { kind: voice-studio, machine: gpu-box }
    openai:
      kind: openai-compatible
      apiKeyEnv: TEST_SPEECH_KEY
      voice: alloy
      price: { transcribePerMinute: 0.01 }
  fallback:
    asr: [gpu, openai]
    tts: [openai]
  voices:
    narrator: { gpu: en-Frank_man, openai: onyx }
`;

describe("providers.yaml", () => {
  test("without a speech section the space has the one voice-studio provider it always had", async () => {
    const dir = await mkdtemp(join(tmpdir(), "speech-config-"));
    try {
      expect(await loadSpeech(dir, {})).toEqual({ config: builtinSpeech(), source: "builtin", warnings: [] });
      await writeFile(join(dir, "providers.yaml"), "# nothing yet\n");
      expect((await loadSpeech(dir, {})).source).toBe("builtin");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(builtinSpeech()).toMatchObject({ default: { asr: "voice-studio", tts: "voice-studio", live: "voice-studio" }, fallback: {} });
  });

  test("a full section: kinds, defaults, live following asr, fallback lists, the voice table", () => {
    const { config, warnings } = parseProvidersYaml(FULL, { TEST_SPEECH_KEY: "sk-test" });
    expect(warnings).toEqual([]);
    expect(config.default).toEqual({ asr: "gpu", tts: "gpu", live: "gpu" });
    // Live keeps only the entries that can stream; openai cannot.
    expect(config.fallback).toEqual({ asr: ["gpu", "openai"], tts: ["openai"], live: ["gpu"] });
    expect(config.voices).toEqual({ narrator: { gpu: "en-Frank_man", openai: "onyx" } });
    expect(config.providers).toEqual([
      { name: "gpu", kind: "voice-studio", app: "voice-studio", machine: "gpu-box" },
      { name: "openai", kind: "openai-compatible", url: "https://api.openai.com/v1", apiKeyEnv: "TEST_SPEECH_KEY", apiKey: "sk-test", asrModel: "whisper-1", ttsModel: "tts-1", voice: "alloy", selfHosted: false, price: { transcribePerMinute: 0.01 } },
    ]);
  });

  test("a provider whose key variable is empty stays, off, with a warning; dashscope is reserved", () => {
    const { config, warnings } = parseProvidersYaml(FULL.replace("gpu: { kind: voice-studio, machine: gpu-box }", "gpu: { kind: voice-studio }\n    bailian: { kind: dashscope, apiKeyEnv: DASHSCOPE_API_KEY }"), {});
    expect(config.off).toEqual({ openai: "TEST_SPEECH_KEY is not set", bailian: "the dashscope kind is not built yet (docs/speech.md#later)" });
    expect(warnings).toEqual(["speech provider bailian is off: the dashscope kind is not built yet (docs/speech.md#later)", "speech provider openai is off: TEST_SPEECH_KEY is not set"]);
    expect(config.providers.find((p) => p.name === "openai")).not.toHaveProperty("apiKey");
  });

  test("one provider is the default for everything it can do", () => {
    const { config } = parseProvidersYaml("speech:\n  providers:\n    api: { kind: openai-compatible, url: http://127.0.0.1:8000/v1, selfHosted: true }\n", {});
    expect(config.default).toEqual({ asr: "api", tts: "api" });
  });

  test.each([
    ["speech:\n  providers:\n    a: { kind: voice-studio }\n  extra: 1\n", 'unknown key "extra"'],
    ["other: {}\n", 'unknown key "other"'],
    ["speech:\n  providers: {}\n", "providers must be a non-empty mapping"],
    ["speech:\n  providers:\n    A: { kind: voice-studio }\n", 'invalid provider name "A"'],
    ["speech:\n  providers:\n    a: { kind: whisper }\n", "kind must be one of"],
    ["speech:\n  providers:\n    a: { kind: voice-studio, url: x }\n", 'unknown key "url"'],
    ["speech:\n  providers:\n    a: { kind: voice-studio }\n    b: { kind: voice-studio }\n", "default is required"],
    ["speech:\n  default: { asr: c }\n  providers:\n    a: { kind: voice-studio }\n", "c is not a provider"],
    ["speech:\n  default: { live: o }\n  providers:\n    o: { kind: openai-compatible }\n", "o (openai-compatible) cannot live"],
    ["speech:\n  default: { asr: a }\n  providers:\n    a: { kind: voice-studio }\n  fallback: { asr: [a, a] }\n", "lists a twice"],
    ["speech:\n  default: { asr: a }\n  providers:\n    a: { kind: voice-studio }\n  voices: { x: { b: v } }\n", "b is not a provider"],
    ["speech:\n  providers:\n    a: { kind: openai-compatible, apiKeyEnv: 'not a name' }\n", "apiKeyEnv must name an environment variable"],
    ["speech:\n  providers:\n    a: { kind: openai-compatible, voice: nova, voices: [alloy] }\n", "voice nova is not in its voices list"],
    ["speech:\n  providers:\n    a: { kind: openai-compatible, price: { perHour: 1 } }\n", 'price has unknown key "perHour"'],
  ])("refuses %#", (yaml, message) => {
    expect(() => parseProvidersYaml(yaml, {})).toThrow(message);
  });
});

describe("the manifest's speech section", () => {
  test("local-only is a boolean, and the section is strict", () => {
    expect(parseAppSpeechSpec({ "local-only": true })).toEqual({ localOnly: true });
    expect(parseAppSpeechSpec({})).toEqual({ localOnly: false });
    expect(() => parseAppSpeechSpec({ localOnly: true })).toThrow('unknown key "localOnly"');
    expect(() => parseAppSpeechSpec({ "local-only": "yes" })).toThrow("must be true or false");
    expect(parseManifest("name: notes\nspeech: { local-only: true }\n", "/apps/notes").speech).toEqual({ localOnly: true });
    expect(parseManifest("name: notes\n", "/apps/notes").speech).toBeUndefined();
  });
});
