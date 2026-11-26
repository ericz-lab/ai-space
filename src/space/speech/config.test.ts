import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinSpeech, loadSpeech, parseProvidersYaml } from "./config.ts";
import { parseAppSpeechSpec } from "./spec.ts";
import { speechContext } from "./types.ts";
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
    ["speech:\n  providers:\n    a: { kind: voice-studio, url: x }\n", 'unknown key "url" (a speech server reached at its own address is kind: speech-server)'],
    ["speech:\n  providers:\n    a: { kind: voice-studio, urls: [x], apiKeyEnv: T }\n", 'unknown key "urls" (a speech server reached at its own address is kind: speech-server)'],
    ["speech:\n  providers:\n    a: { kind: voice-studio, token: x }\n", 'unknown key "token"'],
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

describe("a speech server at its own addresses (docs/speech.md#speech-server)", () => {
  const server = (body: string) => `speech:\n  providers:\n    gpu:\n      kind: speech-server\n${body}`;
  const ENV = { STUDIO_TOKEN: " tok ", VOICE_ACCESS: "CF-Access-Client-Id: id; CF-Access-Client-Secret: secret" };

  test("urls in order, the token and an https address's access headers from the environment", () => {
    const { config, warnings } = parseProvidersYaml(server("      urls:\n        - http://192.168.3.48:8920/\n        - { url: 'https://voice.example.com/studio/', headersEnv: VOICE_ACCESS }\n      apiKeyEnv: STUDIO_TOKEN\n"), ENV);
    expect(warnings).toEqual([]);
    expect(config.providers).toEqual([{
      name: "gpu", kind: "speech-server", apiKeyEnv: "STUDIO_TOKEN", token: "tok",
      addresses: [
        { url: "http://192.168.3.48:8920", host: "192.168.3.48:8920", local: true },
        { url: "https://voice.example.com/studio", host: "voice.example.com", local: false, headersEnv: "VOICE_ACCESS", headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": "secret" } },
      ],
    }]);
    expect(config.default).toEqual({ asr: "gpu", tts: "gpu", live: "gpu" });
    // url: is the one-address form.
    const one = parseProvidersYaml(server("      url: https://voice.example.com\n      apiKeyEnv: STUDIO_TOKEN\n"), ENV).config.providers[0];
    expect(one).toMatchObject({ addresses: [{ url: "https://voice.example.com", host: "voice.example.com", local: false }] });
  });

  test("an empty token turns it off; an address whose headers are missing is skipped, all of them turns it off", () => {
    const yaml = server("      urls: [http://10.0.0.5:8920, { url: https://voice.example.com, headersEnv: VOICE_ACCESS }]\n      apiKeyEnv: STUDIO_TOKEN\n");
    expect(parseProvidersYaml(yaml, {}).config.off).toEqual({ gpu: "STUDIO_TOKEN is not set" });
    const partly = parseProvidersYaml(yaml, { STUDIO_TOKEN: "t" }).config;
    expect(partly.off).toEqual({});
    expect(partly.providers[0]).toMatchObject({ addresses: [{ host: "10.0.0.5:8920" }, { host: "voice.example.com", off: "VOICE_ACCESS is not set" }] });
    const only = parseProvidersYaml(server("      urls: [{ url: https://voice.example.com, headersEnv: VOICE_ACCESS }]\n      apiKeyEnv: STUDIO_TOKEN\n"), { STUDIO_TOKEN: "t", VOICE_ACCESS: "Authorization: Bearer x" }).config;
    expect(only.off).toEqual({ gpu: "voice.example.com: VOICE_ACCESS: Authorization is set by the adapter itself" });
  });

  test.each([
    ["      url: http://10.0.0.5:8920\n      apiKeyEnv: T\n      machine: box\n", 'unknown key "machine" (the voice-studio app on this space or a peer is kind: voice-studio)'],
    ["      url: http://10.0.0.5:8920\n      apiKeyEnv: T\n      app: voice-studio\n", 'unknown key "app" (the voice-studio app'],
    ["      url: http://10.0.0.5:8920\n      urls: [http://10.0.0.6:8920]\n      apiKeyEnv: T\n", "give url (one address) or urls"],
    ["      urls: []\n      apiKeyEnv: T\n", "urls must be a non-empty list"],
    ["      urls: http://10.0.0.5:8920\n      apiKeyEnv: T\n", "urls must be a non-empty list"],
    ["      apiKeyEnv: T\n", "give the server's address"],
    ["      url: http://10.0.0.5:8920\n", "apiKeyEnv must name"],
    ["      url: http://10.0.0.5:8920\n      apiKeyEnv: 'no such'\n", "apiKeyEnv must name"],
    ["      url: ftp://10.0.0.5\n      apiKeyEnv: T\n", "must be http:// or https://"],
    ["      url: not a url\n      apiKeyEnv: T\n", "is not a URL"],
    ["      url: https://me:pw@voice.example.com\n      apiKeyEnv: T\n", "carries credentials"],
    ["      url: https://voice.example.com/?a=1\n      apiKeyEnv: T\n", "must not carry a query"],
    ["      url: http://voice.example.com\n      apiKeyEnv: T\n", "plain http only for a loopback"],
    ["      url: http://8.8.8.8:8920\n      apiKeyEnv: T\n", "plain http only for a loopback"],
    ["      url: http://100.100.1.2:8920\n      apiKeyEnv: T\n", "plain http only for a loopback"],
    ["      url: http://172.32.0.1:8920\n      apiKeyEnv: T\n", "plain http only for a loopback"],
    ["      url: http://david:8920\n      apiKeyEnv: T\n", "plain http only for a loopback"],
    ["      urls: [{ url: http://10.0.0.5:8920, headersEnv: VOICE_ACCESS }]\n      apiKeyEnv: T\n", "sent to https:// addresses only"],
    ["      urls: [{ url: https://a.example.com, token: x }]\n      apiKeyEnv: T\n", 'unknown key "token"'],
    ["      urls: [http://10.0.0.5:8920, 'http://10.0.0.5:8920/']\n      apiKeyEnv: T\n", "is listed twice"],
  ])("refuses %#", (body, message) => {
    expect(() => parseProvidersYaml(server(body), {})).toThrow(message);
  });

  test("plain http goes to loopback, private-range, link-local and local names only", () => {
    for (const host of ["127.0.0.1", "localhost", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.3.48", "169.254.1.1", "[::1]", "[fe80::1]", "[fd12:3456::1]", "studio.local", "david.home.arpa"])
      expect(() => parseProvidersYaml(server(`      url: http://${host}:8920\n      apiKeyEnv: T\n`), {})).not.toThrow();
    for (const host of ["[2001:db8::1]", "[::ffff:192.168.1.1]", "voice.example.com", "11.0.0.1", "192.169.0.1"])
      expect(() => parseProvidersYaml(server(`      url: http://${host}:8920\n      apiKeyEnv: T\n`), {})).toThrow("plain http only");
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

describe("terms (docs/speech.md#terms)", () => {
  const ONE = "speech:\n  providers:\n    gpu: { kind: voice-studio }\n";
  const parse = (terms: string) => parseProvidersYaml(`${ONE}  terms: ${terms}\n`, {}).config;

  test("a list of words, trimmed; missing, null or empty is none; the built-in default has none", () => {
    expect(parse("[skill, ' ai-space ', agent, Claude Code, \"2049\"]").terms).toEqual(["skill", "ai-space", "agent", "Claude Code", "2049"]);
    expect(parseProvidersYaml(`${ONE}  terms:\n    - skill\n    - 随手改\n`, {}).config.terms).toEqual(["skill", "随手改"]);
    expect(parseProvidersYaml(ONE, {}).config).not.toHaveProperty("terms");
    expect(parse("[]")).not.toHaveProperty("terms");
    expect(parse("null")).not.toHaveProperty("terms");
    expect(builtinSpeech()).not.toHaveProperty("terms");
  });

  test("bad shapes and the 300-character limit are refused with the reason", () => {
    expect(() => parse("skill")).toThrow("providers.yaml: speech.terms must be a list of words");
    expect(() => parse("[skill, '']")).toThrow('speech.terms: "" must be a word or a name');
    expect(() => parse("[skill, 3090]")).toThrow("speech.terms: 3090 must be a word or a name (quote it");
    expect(() => parse("[skill, { a: b }]")).toThrow("must be a word or a name");
    expect(() => parse("['skill, agent']")).toThrow('speech.terms: "skill, agent" holds a comma or a line break; give each term as its own entry');
    expect(() => parse('["two\\nlines"]')).toThrow("holds a comma or a line break");
    expect(() => parse("[Skill, skill]")).toThrow("speech.terms lists skill twice");
    // 30 terms of 8 characters: 30 * 8 + 29 * 2 = 298 fits, a 31st does not.
    const words = Array.from({ length: 31 }, (_, i) => `word${String(i).padStart(4, "0")}`);
    expect(parse(`[${words.slice(0, 30).join(", ")}]`).terms).toHaveLength(30);
    expect(() => parse(`[${words.join(", ")}]`)).toThrow("speech.terms is 308 characters joined; at most 300: keep it to the words that actually go wrong");
  });
});

describe("speechContext: the Space's terms and the client's context", () => {
  test("nothing gives nothing; either alone is itself", () => {
    expect(speechContext([], "")).toBe("");
    expect(speechContext([], "  ")).toBe("");
    expect(speechContext(["skill", "ai-space"], "")).toBe("skill, ai-space");
    expect(speechContext([], "a meeting about GPUs")).toBe("a meeting about GPUs");
  });

  test("the terms first, then the client's context without the terms it repeats", () => {
    expect(speechContext(["skill", "ai-space"], "Claude Code")).toBe("skill, ai-space, Claude Code");
    expect(speechContext(["skill", "ai-space"], "AI-Space, Claude Code，SKILL")).toBe("skill, ai-space, Claude Code");
    expect(speechContext(["skill"], "Skill")).toBe("skill");
  });

  test("never longer than the limit: the terms whole, the client's part cut at a separator", () => {
    const terms = ["a".repeat(100), "b".repeat(100)]; // 202 characters joined
    const merged = speechContext(terms, `one, two, ${"c".repeat(90)}, three`);
    expect(merged).toBe(`${terms.join(", ")}, one, two`);
    // A part that does not fit is taken by whole words, never cut inside one.
    expect(speechContext(terms, "alpha beta gamma " + "d".repeat(90))).toBe(`${terms.join(", ")}, alpha beta gamma`);
    expect(speechContext(terms, "e".repeat(120))).toBe(terms.join(", "));
    for (const own of ["x ".repeat(150), "y, ".repeat(100), "z".repeat(300)]) expect(speechContext(terms, own).length).toBeLessThanOrEqual(300);
    // Terms that fill the limit leave no room for the client's part.
    const full = Array.from({ length: 30 }, (_, i) => `word${String(i).padStart(4, "0")}`);
    expect(speechContext(full, "more")).toBe(full.join(", "));
    expect(speechContext([], "f".repeat(301))).toBe("");
  });
});
