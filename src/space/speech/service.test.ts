import { describe, expect, test } from "bun:test";
import { builtinSpeech, parseProvidersYaml } from "./config.ts";
import { SpeechService } from "./service.ts";
import { SpeechStore } from "./store.ts";
import { ProviderError, SpeechError, type SpeechAdapter, type SpeechCapability, type SpeechKind } from "./types.ts";
import { wav } from "./testing.ts";

type Fake = SpeechAdapter & { calls: string[]; fail?: string | ProviderError; voiceList?: string[] };

function fake(name: string, opts: { kind?: SpeechKind; caps?: SpeechCapability[]; selfHosted?: boolean; fail?: string | ProviderError; voices?: string[]; reachable?: boolean; limits?: SpeechAdapter["limits"]; price?: number } = {}): Fake {
  const a: Fake = {
    name,
    kind: opts.kind ?? "voice-studio",
    capabilities: new Set(opts.caps ?? ["transcribe", "live", "speak"]),
    selfHosted: opts.selfHosted ?? true,
    limits: opts.limits ?? {},
    calls: [],
    ...(opts.fail ? { fail: opts.fail } : {}),
    ...(opts.voices ? { voiceList: opts.voices } : {}),
    state: () => ({ where: "", machine: "", located: true, ...(opts.reachable !== undefined ? { reachable: opts.reachable } : {}) }),
    async transcribe(input) {
      a.calls.push(`transcribe ${input.language}`);
      if (a.fail) throw typeof a.fail === "string" ? new ProviderError(a.fail) : a.fail;
      return { text: `heard by ${name}`, language: input.language || "zh", segments: [{ start: 0, end: 2.5, text: "heard" }], audioSeconds: 2.5 };
    },
    async speak(input) {
      a.calls.push(`speak ${input.voices.join(",")}`);
      if (a.fail) throw typeof a.fail === "string" ? new ProviderError(a.fail) : a.fail;
      return { audio: wav(0.5), contentType: "audio/wav" };
    },
    voices: opts.voices ? async () => opts.voices : undefined,
    cost: (cap, f) => (opts.price !== undefined && cap !== "speak" && f.audioSeconds !== undefined ? (f.audioSeconds / 60) * opts.price : undefined),
  };
  return a;
}

const FILE = { file: new Blob(["audio"]), filename: "a.webm", language: "zh", context: "" };
const SPACE = { app: "space", tag: "other" };

function service(yaml: string, adapters: SpeechAdapter[], extra: { localOnly?: (app: string) => boolean; now?: () => number } = {}) {
  const { config } = parseProvidersYaml(yaml, { KEY: "k" });
  const store = new SpeechStore(":memory:");
  return { svc: new SpeechService({ config, adapters, store, log: () => {}, ...extra }), store };
}

const TWO = `
speech:
  default: { asr: gpu, tts: gpu }
  providers:
    gpu: { kind: voice-studio }
    cloud: { kind: openai-compatible, apiKeyEnv: KEY }
  fallback: { asr: [cloud], tts: [cloud] }
  voices:
    narrator: { gpu: en-Frank_man, cloud: onyx }
`;

describe("choosing a provider", () => {
  test("the default answers, and the ledger has one plain row", async () => {
    const gpu = fake("gpu");
    const { svc, store } = service("speech:\n  providers:\n    gpu: { kind: voice-studio }\n", [gpu]);
    const { result, call } = await svc.transcribe(SPACE, FILE);
    expect(result.text).toBe("heard by gpu");
    expect(call).toMatchObject({ app: "space", tag: "other", capability: "transcribe", provider: "gpu", status: "ok", audioSeconds: 2.5, chars: 12, inputBytes: 5, tries: 1 });
    expect(call).not.toHaveProperty("trace");
    expect(call).not.toHaveProperty("fallbackFrom");
    expect(store.recent()).toHaveLength(1);
  });

  test("a link failure moves on to the fallback, and the row says so", async () => {
    const gpu = fake("gpu", { fail: "gpu: HTTP 503: peer gpu-box is down" });
    const cloud = fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"], price: 0.006 });
    const { svc } = service(TWO, [gpu, cloud]);
    const { result, call } = await svc.transcribe(SPACE, FILE);
    expect(result.text).toBe("heard by cloud");
    expect(call).toMatchObject({ provider: "cloud", fallbackFrom: "gpu", tries: 2, costUsd: 0.00025 });
    expect(call.trace).toMatchObject({ stop: "answered", tries: [{ provider: "gpu", ok: false, kind: "transport" }, { provider: "cloud", ok: true }] });
    // The failure rests the gpu's cell: the next call tries it last.
    expect(svc.cells().find((c) => c.provider === "gpu")).toMatchObject({ restKind: "transport", problem: "limited" });
    const again = await svc.transcribe(SPACE, FILE);
    expect(again.call.trace?.candidates).toEqual([{ provider: "gpu", later: expect.stringMatching(/^resting until .* \(transport\)$/) }, { provider: "cloud" }]);
    expect(again.call).toMatchObject({ provider: "cloud", fallbackFrom: "gpu", tries: 1 });
    expect(gpu.calls).toHaveLength(1);
  });

  test("a refused key or a bad request ends the call where it is", async () => {
    for (const fail of ["gpu: HTTP 401: invalid api key", "gpu: HTTP 400: ffmpeg could not read the file"]) {
      const cloud = fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] });
      const { svc, store } = service(TWO, [fake("gpu", { fail }), cloud]);
      const e = (await svc.transcribe(SPACE, FILE).catch((x) => x)) as SpeechError;
      expect(e).toBeInstanceOf(SpeechError);
      expect(e.message).toBe(fail);
      expect(cloud.calls).toEqual([]);
      expect(store.recent()[0]).toMatchObject({ status: "error", provider: "gpu", error: fail, tries: 1 });
      expect(e.call?.trace?.stop).toBe("not-switched");
    }
  });

  test("a call pinned to a provider has no fallback; an unknown one is a 404", async () => {
    const cloud = fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] });
    const { svc } = service(TWO, [fake("gpu", { fail: "gpu: HTTP 503: down" }), cloud]);
    const e = (await svc.transcribe(SPACE, { ...FILE, provider: "gpu" }).catch((x) => x)) as SpeechError;
    expect(e.status).toBe(502);
    expect(cloud.calls).toEqual([]);
    expect(((await svc.transcribe(SPACE, { ...FILE, provider: "nobody" }).catch((x) => x)) as SpeechError).status).toBe(404);
  });

  test("a capability the first choice lacks is a 400, never a quiet move", async () => {
    const yaml = "speech:\n  default: { asr: cloud, live: gpu }\n  providers:\n    gpu: { kind: voice-studio }\n    cloud: { kind: openai-compatible }\n";
    const { svc } = service(yaml, [fake("gpu"), fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] })]);
    expect(() => svc.live(SPACE, { provider: "cloud" })).toThrow("cloud (openai-compatible): cannot live");
    expect(svc.live(SPACE).candidates.map((a) => a.name)).toEqual(["gpu"]);
    // No tts default in the file: a speech call says what to set.
    const e = (await svc.speak(SPACE, { text: "hi", voices: [] }).catch((x) => x)) as SpeechError;
    expect([e.status, e.message]).toEqual([503, "no tts provider: set speech.default.tts in providers.yaml"]);
  });

  test("an unreachable or off fallback entry is tried last or skipped; a first choice over its limit is refused", async () => {
    const yaml = `${TWO.replace("fallback: { asr: [cloud], tts: [cloud] }", "fallback: { asr: [cloud, spare], tts: [cloud] }").replace("    cloud: { kind: openai-compatible, apiKeyEnv: KEY }", "    cloud: { kind: openai-compatible, apiKeyEnv: KEY }\n    spare: { kind: openai-compatible, apiKeyEnv: NONE }")}`;
    const gpu = fake("gpu", { fail: "gpu: HTTP 503: down", limits: { transcribeBytes: 4 } });
    const cloud = fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"], reachable: false });
    const spare = fake("spare", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] });
    const { svc } = service(yaml, [gpu, cloud, spare]);
    const e = (await svc.transcribe(SPACE, FILE).catch((x) => x)) as SpeechError;
    expect([e.status, e.message]).toEqual([413, "gpu (voice-studio): the file is 5 bytes; at most 4 bytes"]);
    const small = await svc.transcribe(SPACE, { ...FILE, file: new Blob(["ab"]) });
    expect(small.call.trace?.candidates).toEqual([{ provider: "gpu" }, { provider: "cloud", later: "unreachable" }, { provider: "spare", skipped: "off: NONE is not set" }]);
    expect(small.call.provider).toBe("cloud");
  });
});

describe("voices", () => {
  test("a mapped voice is each provider's own; another name is the first choice's own and skips the fallback", async () => {
    const gpu = fake("gpu", { fail: "gpu: HTTP 502: unreachable: fetch failed", voices: ["en-Frank_man", "zh-Xinran_woman"] });
    const cloud = fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] });
    const { svc } = service(TWO, [gpu, cloud]);
    const mapped = await svc.speak(SPACE, { text: "hello", voices: ["narrator"] });
    expect([gpu.calls, cloud.calls]).toEqual([["speak en-Frank_man"], ["speak onyx"]]);
    expect(mapped.call).toMatchObject({ provider: "cloud", voice: "onyx", fallbackFrom: "gpu", chars: 5, audioSeconds: 0.5 });

    const own = (await svc.speak(SPACE, { text: "hello", voices: ["zh-Xinran_woman"] }).catch((x) => x)) as SpeechError;
    expect(own.status).toBe(502);
    expect(own.call?.trace?.candidates).toEqual([{ provider: "gpu", later: expect.stringContaining("resting") }, { provider: "cloud", skipped: "voice zh-Xinran_woman is gpu's own" }]);
    expect(cloud.calls).toEqual(["speak onyx"]);
  });

  test("provider/voice pins the provider; a voice it does not have is refused before the call", async () => {
    const gpu = fake("gpu", { voices: ["zh-Xinran_woman"] });
    const { svc } = service(TWO, [gpu, fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] })]);
    const ok = await svc.speak(SPACE, { text: "你好", voices: ["gpu/zh-Xinran_woman"] });
    expect(ok.call).toMatchObject({ provider: "gpu", voice: "zh-Xinran_woman", chars: 2 });
    const e = (await svc.speak(SPACE, { text: "hi", voices: ["gpu/Somebody"] }).catch((x) => x)) as SpeechError;
    expect([e.status, e.message]).toEqual([400, "gpu has no voice Somebody (voices: zh-Xinran_woman)"]);
    expect(gpu.calls).toEqual(["speak zh-Xinran_woman"]);
    expect(((await svc.speak(SPACE, { text: "hi", voices: ["gpu/a"], provider: "cloud" }).catch((x) => x)) as SpeechError).status).toBe(400);
  });

  test("a mapped voice the first choice has no mapping for is refused", async () => {
    const yaml = TWO.replace("narrator: { gpu: en-Frank_man, cloud: onyx }", "narrator: { cloud: onyx }");
    const { svc } = service(yaml, [fake("gpu"), fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] })]);
    const e = (await svc.speak(SPACE, { text: "hi", voices: ["narrator"] }).catch((x) => x)) as SpeechError;
    expect([e.status, e.message]).toEqual([400, "gpu (voice-studio): no voice narrator (voices: in providers.yaml maps it onto cloud)"]);
  });
});

describe("privacy", () => {
  test("a local-only app never reaches a cloud provider: skipped as a fallback, refused as the first choice", async () => {
    const cloud = fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] });
    const { svc } = service(TWO, [fake("gpu", { fail: "gpu: HTTP 503: down" }), cloud], { localOnly: (app) => app === "notes" });
    const e = (await svc.transcribe({ app: "notes", tag: "dictation" }, FILE).catch((x) => x)) as SpeechError;
    expect(e.status).toBe(502);
    expect(e.call?.trace?.candidates).toEqual([{ provider: "gpu" }, { provider: "cloud", skipped: "local-only: notes keeps its speech off cloud providers" }]);
    expect(cloud.calls).toEqual([]);
    const pinned = (await svc.transcribe({ app: "notes", tag: "dictation" }, { ...FILE, provider: "cloud" }).catch((x) => x)) as SpeechError;
    expect(pinned.status).toBe(403);
    // Another app, and the operator, follow the configuration.
    expect((await svc.transcribe({ app: "other", tag: "x" }, FILE)).call.provider).toBe("cloud");
  });
});

describe("status", () => {
  test("cells say where each provider is used and what is wrong with it", () => {
    const yaml = TWO.replace("apiKeyEnv: KEY", "apiKeyEnv: MISSING");
    const { svc } = service(yaml, [fake("gpu", { reachable: false }), fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] })]);
    const cells = svc.cells();
    expect(cells.map((c) => [c.provider, c.roles, c.problem])).toEqual([
      ["gpu", ["asr", "tts", "live"], "unreachable"],
      ["cloud", ["asr fallback", "tts fallback"], "off"],
    ]);
    expect(svc.status()).toMatchObject({ configured: true, default: { asr: "gpu" }, usage24h: { calls: 0 } });
    expect(svc.canTranscribe()).toBe(true);
  });

  test("without a file the built-in provider counts only while it is somewhere", async () => {
    const config = builtinSpeech();
    let located = false;
    const studio = fake("voice-studio");
    studio.state = () => ({ where: "", machine: "", located });
    const svc = new SpeechService({ config, source: "builtin", adapters: [studio], store: new SpeechStore(":memory:"), log: () => {} });
    // Nowhere: no provider at all, and nothing names the app this space never had.
    const e = (await svc.transcribe(SPACE, FILE).catch((x) => x)) as SpeechError;
    expect([e.status, e.code]).toEqual([503, "no_provider"]);
    expect(e.message).toContain("no speech provider is set up");
    expect(e.message).not.toContain("voice-studio");
    expect(svc.status()).toMatchObject({ configured: true, source: "builtin", default: {}, providers: [] });
    expect(svc.canTranscribe()).toBe(false);
    // It appears (the app is installed, or a peer lists it): the default is back with no reload.
    located = true;
    expect((await svc.transcribe(SPACE, FILE)).result.text).toBe("heard by voice-studio");
    expect(svc.status().default).toEqual({ asr: "voice-studio", tts: "voice-studio", live: "voice-studio" });
    // A file that names it is the owner's: kept as written wherever it is.
    located = false;
    const written = new SpeechService({ config, source: "file", adapters: [studio], store: new SpeechStore(":memory:"), log: () => {} });
    expect(written.status().providers.map((c) => c.provider)).toEqual(["voice-studio"]);
  });

  test("a configuration that did not load refuses every call with its reason", async () => {
    const svc = new SpeechService({ configError: "providers.yaml: speech.default.asr: x is not a provider in this file", adapters: [], store: new SpeechStore(":memory:") });
    const e = (await svc.transcribe(SPACE, FILE).catch((x) => x)) as SpeechError;
    expect([e.status, e.message]).toEqual([503, "providers.yaml: speech.default.asr: x is not a provider in this file"]);
    expect(svc.status()).toMatchObject({ configured: false, configError: expect.stringContaining("not a provider"), providers: [] });
    expect(svc.canTranscribe()).toBe(false);
    expect(svc.liveUnavailable(SPACE)).toContain("not a provider");
  });

  test("usage sums seconds, characters and cost by provider and app", async () => {
    const { svc } = service(TWO, [fake("gpu", { price: 0.006 }), fake("cloud", { kind: "openai-compatible", selfHosted: false, caps: ["transcribe", "speak"] })]);
    await svc.transcribe({ app: "notes", tag: "dictation" }, FILE);
    await svc.speak({ app: "notes", tag: "read" }, { text: "hello", voices: [] });
    const u = svc.usage("24h");
    expect(u.totals).toMatchObject({ calls: 2, errors: 0, audioSeconds: 3, chars: 17, costUsd: 0.00025 });
    expect(u.byApp.map((r) => [r.app, r.tag, r.capability, r.calls])).toEqual([["notes", "dictation", "transcribe", 1], ["notes", "read", "speak", 1]]);
  });
});
