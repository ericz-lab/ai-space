import type { GatewayLink } from "../gateway/types.ts";
import { classifyFailure, type Failure, REST_KINDS } from "../model/failure.ts";
import { RuntimeHealth } from "../model/health.ts";
import { OpenAiAdapter } from "./openai.ts";
import type { SpeechStore, SpeechUsage, SpeechWindow } from "./store.ts";
import {
  type CandidateTrace,
  KIND_CAPABILITIES,
  ProviderError,
  ROLE_CAPABILITY,
  SPEECH_ROLES,
  SpeechError,
  type LiveTarget,
  type ProviderSpec,
  type SpeakResult,
  type SpeechAdapter,
  type SpeechCall,
  type SpeechCallInput,
  type SpeechCaller,
  type SpeechCapability,
  type SpeechConfig,
  type SpeechRole,
  type SpeechTotals,
  type SpeechTrace,
  type TranscribeResult,
  type TryTrace,
} from "./types.ts";
import { VoiceStudioAdapter, type VoiceStudioDeps } from "./voice-studio.ts";
import { wavSeconds } from "./wav.ts";

/**
 * The speech service (docs/speech.md): for one call, the provider that takes it and the ones after it,
 * each tried in turn on an account or link failure only, with one ledger row and a status cell per
 * provider. It reads failures and rests cells as the model service does (`model/failure.ts`,
 * `RuntimeHealth`), and never moves a call for a capability, a voice or a privacy rule: those skip a
 * fallback entry, or refuse the call when they rule out the first choice.
 */

export type SpeechServiceOptions = {
  /** Undefined when `providers.yaml` did not load: every call is then a 503 with `configError`. */
  config?: SpeechConfig;
  configError?: string;
  source?: "file" | "builtin";
  warnings?: string[];
  adapters: SpeechAdapter[];
  store: SpeechStore;
  health?: RuntimeHealth;
  /** The app's `speech: { local-only: true }` (docs/speech.md#privacy). */
  localOnly?: (app: string) => boolean;
  now?: () => number;
  log?: (line: string) => void;
};

/** One provider as `GET /api/speech` shows it. */
export type SpeechCell = {
  provider: string;
  kind: string;
  capabilities: SpeechCapability[];
  selfHosted: boolean;
  where: string;
  off?: string;
  located: boolean;
  reachable?: boolean;
  signedIn?: boolean;
  detail?: string;
  limitedUntil?: string;
  restKind?: string;
  restSaid?: boolean;
  lastError?: string;
  lastErrorKind?: string;
  lastOkAt?: string;
  /** Where the configuration uses it: `asr`, `tts fallback`, … */
  roles: string[];
  used: boolean;
  problem?: string;
};

type Candidate<T> = { adapter: SpeechAdapter; data: T };
type Plan<T> = { first: string; candidates: Candidate<T>[]; trace: CandidateTrace[] };
/** Why one candidate cannot take the call, and what status refusing the call answers when it is the first choice. */
type Skip = { skip: string; status: number; code?: string };

export const MAX_SPEAK_CHARS = 20_000;

export class SpeechService {
  private readonly adapters: Map<string, SpeechAdapter>;
  readonly health: RuntimeHealth;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: SpeechServiceOptions) {
    this.adapters = new Map(opts.adapters.map((a) => [a.name, a]));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((l) => console.log(`[speech] ${l}`));
    this.health = opts.health ?? new RuntimeHealth({ now: this.now, prober: async () => ({}) });
    this.health.seed(new Map([...opts.store.lastOk()].map(([provider, at]) => [`|${provider}`, at])));
  }

  get config(): SpeechConfig | undefined {
    return this.opts.config;
  }

  // ------------------------------------------------------------------------------------------- choosing

  /**
   * The candidates for one call: the first choice, then the role's fallback list without it (none when
   * the call is pinned), each one that cannot take the call skipped with its reason. A first choice that
   * cannot is a refusal; one that rests or cannot be reached is tried after the others.
   */
  private plan<T>(role: SpeechRole, caller: SpeechCaller, pinned: string | undefined, prepare: (a: SpeechAdapter, first: boolean) => Skip | { data: T }): Plan<T> {
    const config = this.opts.config;
    if (!config) throw new SpeechError(503, this.opts.configError ?? "speech is not configured", undefined, "unavailable");
    const capability = ROLE_CAPABILITY[role];
    const first = pinned ?? config.default[role];
    if (!first) throw new SpeechError(503, `no ${role} provider: set speech.default.${role} in providers.yaml`, undefined, "no_provider");
    if (!this.adapters.has(first)) throw new SpeechError(404, `no speech provider named ${first}`, undefined, "no_provider");
    const names = pinned ? [first] : [first, ...(config.fallback[role] ?? []).filter((n) => n !== first)];
    const localOnly = caller.app !== "space" && Boolean(this.opts.localOnly?.(caller.app));
    const trace: CandidateTrace[] = [];
    const ready: Candidate<T>[] = [];
    const later: Candidate<T>[] = [];
    for (const name of names) {
      const adapter = this.adapters.get(name)!;
      const isFirst = name === first;
      const reason: Skip | undefined =
        config.off[name] ? { skip: `off: ${config.off[name]}`, status: 503, code: "unavailable" }
        : !adapter.capabilities.has(capability) ? { skip: `cannot ${capability}`, status: 400, code: "invalid_request" }
        : localOnly && !adapter.selfHosted ? { skip: `local-only: ${caller.app} keeps its speech off cloud providers`, status: 403, code: "local_only" }
        : undefined;
      const prepared = reason ?? prepare(adapter, isFirst);
      if ("skip" in prepared) {
        if (isFirst) throw new SpeechError(prepared.status, `${name} (${adapter.kind}): ${prepared.skip}`, undefined, prepared.code);
        trace.push({ provider: name, skipped: prepared.skip });
        continue;
      }
      const resting = this.health.resting("", name);
      const state = adapter.state(capability);
      const why = resting ? `resting until ${resting.until}${resting.kind ? ` (${resting.kind})` : ""}` : state.reachable === false ? "unreachable" : state.signedIn === false ? "signed-out" : undefined;
      trace.push({ provider: name, ...(why ? { later: why } : {}) });
      (why ? later : ready).push({ adapter, data: prepared.data });
    }
    return { first, candidates: [...ready, ...later], trace };
  }

  /**
   * Try the candidates in turn. A failure moves on only for credit, quota, rate and transport (the
   * account or the link) and only while the caller has not gone; anything else ends the call there.
   */
  private async run<T, R>(plan: Plan<T>, capability: SpeechCapability, signal: AbortSignal | undefined, fn: (a: SpeechAdapter, data: T) => Promise<R>): Promise<{ ok: true; value: R; used: Candidate<T>; trace: SpeechTrace } | { ok: false; error: ProviderError; used: Candidate<T>; trace: SpeechTrace }> {
    const tries: TryTrace[] = [];
    let last: { error: ProviderError; used: Candidate<T> } | undefined;
    let stop: SpeechTrace["stop"] = "exhausted";
    for (const [i, c] of plan.candidates.entries()) {
      const started = this.now();
      const machine = c.adapter.state(capability).machine;
      try {
        const value = await fn(c.adapter, c.data);
        this.health.note("", c.adapter.name);
        tries.push({ provider: c.adapter.name, ...(machine ? { machine } : {}), ok: true, ms: this.now() - started });
        return { ok: true, value, used: c, trace: { candidates: plan.trace, tries, stop: "answered" } };
      } catch (e) {
        const error = e instanceof ProviderError ? e : new ProviderError(`${c.adapter.name}: ${(e as Error).message ?? String(e)}`, 502);
        if (signal?.aborted) {
          tries.push({ provider: c.adapter.name, ...(machine ? { machine } : {}), ok: false, ms: this.now() - started, error: "aborted", kind: "other" });
          last = { error: new ProviderError("aborted", 499, "other"), used: c };
          stop = "aborted";
          break;
        }
        const read = classifyFailure(error.message, this.now());
        const failure: Failure = error.kind ? { ...read, kind: error.kind } : read;
        this.health.note("", c.adapter.name, error.message, failure);
        tries.push({ provider: c.adapter.name, ...(machine ? { machine } : {}), ok: false, ms: this.now() - started, error: error.message.slice(0, 200), kind: failure.kind });
        last = { error, used: c };
        if (!REST_KINDS.has(failure.kind)) {
          stop = "not-switched";
          break;
        }
        const next = plan.candidates[i + 1];
        if (next) this.log(`${capability}: ${c.adapter.name} failed (${failure.kind}): trying ${next.adapter.name}`);
      }
    }
    if (!last) throw new SpeechError(503, `no ${capability} provider can take this call (${plan.trace.map((t) => `${t.provider}: ${t.skipped}`).join("; ")})`, undefined, "no_provider");
    return { ok: false, ...last, trace: { candidates: plan.trace, tries, stop } };
  }

  /** One ledger row; the trace only when there was more to the call than its row says. */
  private record(base: { caller: SpeechCaller; capability: SpeechCallInput["capability"]; first: string; startedAt: number; adapter: SpeechAdapter; trace: SpeechTrace }, rest: Partial<SpeechCallInput>): SpeechCall {
    const { trace } = base;
    const simple = trace.candidates.length === 1 && trace.tries.length === 1 && !trace.candidates[0]!.skipped && !trace.candidates[0]!.later;
    const machine = base.adapter.state(base.capability).machine;
    return this.opts.store.add({
      app: base.caller.app,
      tag: base.caller.tag,
      capability: base.capability,
      provider: base.adapter.name,
      kind: base.adapter.kind,
      ...(machine ? { machine } : {}),
      status: "ok",
      startedAt: base.startedAt,
      durationMs: this.now() - base.startedAt,
      ...(base.adapter.name !== base.first ? { fallbackFrom: base.first } : {}),
      tries: trace.tries.length,
      ...(simple ? {} : { trace }),
      ...rest,
    });
  }

  // ------------------------------------------------------------------------------------------- calls

  async transcribe(caller: SpeechCaller, input: { file: Blob; filename: string; language: string; context: string; provider?: string; signal?: AbortSignal }): Promise<{ result: TranscribeResult; call: SpeechCall }> {
    const startedAt = this.now();
    const plan = this.plan<null>("asr", caller, input.provider, (a) => {
      const limit = a.limits.transcribeBytes;
      return limit !== undefined && input.file.size > limit ? { skip: `the file is ${mb(input.file.size)}; at most ${mb(limit)}`, status: 413, code: "invalid_request" } : { data: null };
    });
    const out = await this.run(plan, "transcribe", input.signal, (a) => a.transcribe!({ file: input.file, filename: input.filename, language: input.language, context: input.context, ...(input.signal ? { signal: input.signal } : {}) }, caller));
    const base = { caller, capability: "transcribe" as const, first: plan.first, startedAt, adapter: out.used.adapter, trace: out.trace };
    if (!out.ok) {
      const call = this.record(base, { status: "error", error: out.error.message, inputBytes: input.file.size, ...(input.language ? { language: input.language } : {}) });
      throw new SpeechError(out.error.status >= 400 && out.error.status < 500 ? out.error.status : 502, out.error.message, call);
    }
    const r = out.value;
    const { priced, ...result } = r;
    const costUsd = priced ? priced.costUsd : out.used.adapter.cost?.("transcribe", { ...(r.audioSeconds !== undefined ? { audioSeconds: r.audioSeconds } : {}) });
    const call = this.record(base, {
      inputBytes: input.file.size, chars: [...r.text].length, ...(r.audioSeconds !== undefined ? { audioSeconds: r.audioSeconds } : {}),
      ...(r.language ? { language: r.language } : {}), ...(costUsd !== undefined ? { costUsd: Math.round(costUsd * 1e6) / 1e6 } : {}),
      ...(priced?.basis ? { priceBasis: priced.basis } : {}),
    });
    return { result, call };
  }

  /**
   * Speech from text. A voice is never carried to another provider under the same name
   * (docs/speech.md#voices): `provider/voice` pins the call, a name in `voices:` maps onto each
   * candidate, any other name is the first choice's own and skips the fallback entries.
   */
  async speak(caller: SpeechCaller, input: { text: string; voices: string[]; provider?: string; signal?: AbortSignal }): Promise<SpeakResult & { call: SpeechCall; voices: string[] }> {
    const startedAt = this.now();
    const config = this.opts.config;
    let pinned = input.provider;
    const asked = input.voices.map((v) => {
      const slash = v.indexOf("/");
      if (slash < 0) return { voice: v };
      const provider = v.slice(0, slash);
      if (pinned && pinned !== provider) throw new SpeechError(400, `voice ${v} names provider ${provider}, the request names ${pinned}`, undefined, "invalid_request");
      pinned = provider;
      return { voice: v.slice(slash + 1), own: true };
    });
    const chars = [...input.text].length;
    const plan = this.plan<string[]>("tts", caller, pinned, (a, first) => {
      if (a.limits.speakChars !== undefined && chars > a.limits.speakChars) return { skip: `the text is ${chars} characters; at most ${a.limits.speakChars}`, status: 413, code: "invalid_request" };
      if (a.limits.speakVoices !== undefined && asked.length > a.limits.speakVoices) return { skip: `${asked.length} voices; at most ${a.limits.speakVoices}`, status: 400, code: "invalid_request" };
      const own: string[] = [];
      for (const v of asked) {
        const mapped = !v.own ? config?.voices[v.voice] : undefined;
        if (mapped) {
          const name = mapped[a.name];
          if (!name) return { skip: `no voice ${v.voice} (voices: in providers.yaml maps it onto ${Object.keys(mapped).join(", ")})`, status: 400, code: "invalid_request" };
          own.push(name);
        } else if (first) own.push(v.voice);
        else return { skip: `voice ${v.voice} is ${pinned ?? config?.default.tts}'s own`, status: 400, code: "invalid_request" };
      }
      if (!own.length && !a.defaultVoice && a.kind === "openai-compatible") return { skip: "no voice named and no default voice", status: 400, code: "invalid_request" };
      return { data: own };
    });
    const out = await this.run(plan, "speak", input.signal, async (a, voices) => {
      // A voice the provider does not have is refused here: voice-studio would answer in its first voice instead.
      if (voices.length && a.voices) {
        const have = await a.voices(input.signal);
        const missing = have ? voices.filter((v) => !have.includes(v)) : [];
        if (missing.length) throw new ProviderError(`${a.name} has no voice ${missing.join(", ")} (voices: ${have!.slice(0, 20).join(", ") || "none"})`, 400, "other");
      }
      return { ...(await a.speak!({ text: input.text, voices, ...(input.signal ? { signal: input.signal } : {}) }, caller)), voices };
    });
    const base = { caller, capability: "speak" as const, first: plan.first, startedAt, adapter: out.used.adapter, trace: out.trace };
    const voice = (out.ok ? out.value.voices : out.used.data).join(",") || out.used.adapter.defaultVoice || "";
    if (!out.ok) {
      const call = this.record(base, { status: "error", error: out.error.message, chars, ...(voice ? { voice } : {}) });
      throw new SpeechError(out.error.status >= 400 && out.error.status < 500 ? out.error.status : 502, out.error.message, call);
    }
    const seconds = wavSeconds(out.value.audio);
    const priced = out.value.priced;
    const costUsd = priced ? priced.costUsd : out.used.adapter.cost?.("speak", { chars });
    const call = this.record(base, {
      chars, ...(seconds !== undefined ? { audioSeconds: seconds } : {}), ...(voice ? { voice } : {}), ...(costUsd !== undefined ? { costUsd: Math.round(costUsd * 1e6) / 1e6 } : {}),
      ...(priced?.basis ? { priceBasis: priced.basis } : {}),
    });
    return { audio: out.value.audio, contentType: out.value.contentType, voices: out.value.voices, call };
  }

  /**
   * A live session's providers, in order, for `live.ts`: it opens the first one's socket and moves to the
   * next only when the socket cannot be opened. `finish` writes the session's ledger row.
   */
  live(caller: SpeechCaller, opts: { provider?: string } = {}): LiveSession {
    const startedAt = this.now();
    const plan = this.plan<null>("live", caller, opts.provider, () => ({ data: null }));
    const tries: TryTrace[] = [];
    const service = this;
    return {
      first: plan.first,
      candidates: plan.candidates.map((c) => c.adapter),
      target(adapter: SpeechAdapter): LiveTarget {
        return adapter.live!();
      },
      failed(adapter: SpeechAdapter, message: string, kind?: Failure["kind"]): boolean {
        const read = classifyFailure(message, service.now());
        const failure = kind ? { ...read, kind } : read;
        service.health.note("", adapter.name, message, failure);
        tries.push({ provider: adapter.name, ok: false, ms: service.now() - startedAt, error: message.slice(0, 200), kind: failure.kind });
        return REST_KINDS.has(failure.kind);
      },
      opened(adapter: SpeechAdapter, machine: string): void {
        tries.push({ provider: adapter.name, ...(machine ? { machine } : {}), ok: true, ms: service.now() - startedAt });
      },
      finish(adapter: SpeechAdapter | undefined, end: { ok: boolean; error?: string; kind?: Failure["kind"]; audioSeconds: number; chars: number; language?: string; machine?: string }): SpeechCall {
        const used = adapter ?? plan.candidates[0]?.adapter ?? service.adapters.get(plan.first)!;
        if (adapter && end.ok) service.health.note("", adapter.name);
        else if (adapter && end.error && end.kind) service.health.note("", adapter.name, end.error, { kind: end.kind });
        const trace: SpeechTrace = { candidates: plan.trace, tries, stop: end.ok ? "answered" : adapter ? "not-switched" : "exhausted" };
        const costUsd = used.cost?.("live", { audioSeconds: end.audioSeconds });
        return service.record({ caller, capability: "live", first: plan.first, startedAt, adapter: used, trace }, {
          ...(end.machine ? { machine: end.machine } : {}),
          status: end.ok ? "ok" : "error", ...(end.error ? { error: end.error } : {}),
          audioSeconds: Math.round(end.audioSeconds * 1000) / 1000, chars: end.chars, ...(end.language ? { language: end.language } : {}),
          ...(costUsd !== undefined ? { costUsd } : {}),
        });
      },
    };
  }

  /** Why a live session with the default provider could not start now; undefined when one may. Checked before the socket is upgraded. */
  liveUnavailable(caller: SpeechCaller): string | undefined {
    try {
      const plan = this.plan<null>("live", caller, undefined, () => ({ data: null }));
      if (plan.candidates.some((c) => c.adapter.state("live").located)) return undefined;
      return `no live provider can be reached: ${plan.candidates.map((c) => c.adapter.state("live").detail ?? c.adapter.name).join("; ")}`;
    } catch (e) {
      return (e as Error).message;
    }
  }

  // ------------------------------------------------------------------------------------------- reads

  /** Whether a file could be transcribed now: the default ASR provider or a fallback is somewhere (`GET /api/voice`). */
  canTranscribe(): boolean {
    const config = this.opts.config;
    if (!config?.default.asr) return false;
    return [config.default.asr, ...(config.fallback.asr ?? [])].some((name) => {
      const a = this.adapters.get(name);
      return a && !config.off[name] && a.capabilities.has("transcribe") && a.state("transcribe").located;
    });
  }

  cells(): SpeechCell[] {
    const config = this.opts.config;
    if (!config) return [];
    const restingCells = new Map(this.health.list().map((c) => [c.runtime, c]));
    return config.providers.map((spec) => {
      const a = this.adapters.get(spec.name)!;
      const roles: string[] = [];
      for (const role of SPEECH_ROLES) {
        if (config.default[role] === spec.name) roles.push(role);
        if (config.fallback[role]?.includes(spec.name)) roles.push(`${role} fallback`);
      }
      const capabilities = [...a.capabilities];
      const off = config.off[spec.name];
      const state = a.state(capabilities.includes("transcribe") ? "transcribe" : capabilities[0]);
      const h = restingCells.get(spec.name);
      const used = roles.length > 0;
      const problem = !used ? undefined : off ? "off" : state.reachable === false ? "unreachable" : state.signedIn === false ? "not signed in" : h?.limitedUntil ? "limited" : undefined;
      return {
        provider: spec.name, kind: spec.kind, capabilities, selfHosted: a.selfHosted, where: state.where, located: state.located,
        ...(off ? { off } : {}),
        ...(state.reachable !== undefined ? { reachable: state.reachable } : {}), ...(state.signedIn !== undefined ? { signedIn: state.signedIn } : {}),
        ...(state.detail ? { detail: state.detail } : {}),
        ...(h?.limitedUntil ? { limitedUntil: h.limitedUntil } : {}), ...(h?.restKind ? { restKind: h.restKind } : {}), ...(h?.restSaid ? { restSaid: true } : {}),
        ...(h?.lastError ? { lastError: h.lastError } : {}), ...(h?.lastErrorKind ? { lastErrorKind: h.lastErrorKind } : {}), ...(h?.lastOkAt ? { lastOkAt: h.lastOkAt } : {}),
        roles, used, ...(problem ? { problem } : {}),
      };
    });
  }

  status(): {
    configured: boolean; source: string; configError?: string; warnings: string[];
    default: SpeechConfig["default"]; fallback: SpeechConfig["fallback"]; voices: SpeechConfig["voices"]; providers: SpeechCell[]; usage24h: SpeechTotals;
  } {
    const config = this.opts.config;
    return {
      configured: Boolean(config),
      source: this.opts.source ?? "builtin",
      ...(this.opts.configError ? { configError: this.opts.configError } : {}),
      warnings: this.opts.warnings ?? [],
      default: config?.default ?? {},
      fallback: config?.fallback ?? {},
      voices: config?.voices ?? {},
      providers: this.cells(),
      usage24h: this.opts.store.usage("24h", { now: this.now() }).totals,
    };
  }

  /** Each provider's own voices: asked of the ones that can say, errors kept per provider. */
  async voices(signal?: AbortSignal): Promise<{ provider: string; voices?: string[]; error?: string }[]> {
    const config = this.opts.config;
    if (!config) return [];
    return Promise.all(
      config.providers
        .filter((p) => !config.off[p.name] && this.adapters.get(p.name)!.capabilities.has("speak"))
        .map(async (p) => {
          const a = this.adapters.get(p.name)!;
          try {
            const voices = await a.voices?.(signal);
            return { provider: p.name, ...(voices ? { voices } : {}) };
          } catch (e) {
            return { provider: p.name, error: (e as Error).message };
          }
        }),
    );
  }

  calls(opts: { app?: string; limit?: number } = {}): SpeechCall[] {
    return this.opts.store.recent(opts);
  }

  usage(window: SpeechWindow, app?: string): SpeechUsage {
    return this.opts.store.usage(window, { ...(app ? { app } : {}), now: this.now() });
  }
}

export type LiveSession = {
  first: string;
  candidates: SpeechAdapter[];
  target(adapter: SpeechAdapter): LiveTarget;
  /** A socket that could not be opened; true when the next candidate may be tried. */
  failed(adapter: SpeechAdapter, message: string, kind?: Failure["kind"]): boolean;
  opened(adapter: SpeechAdapter, machine: string): void;
  finish(adapter: SpeechAdapter | undefined, end: { ok: boolean; error?: string; kind?: Failure["kind"]; audioSeconds: number; chars: number; language?: string; machine?: string }): SpeechCall;
};

/** One adapter per configured provider; a provider that is off still has one, for its cell and its refusals. */
/** `gateway`: the built-in model gateway, for an openai-compatible provider with `gateway: space`. */
export function buildAdapters(config: SpeechConfig, deps: { voiceStudio: VoiceStudioDeps; fetch?: typeof fetch; gateway?: GatewayLink }): SpeechAdapter[] {
  return config.providers.map((spec) => adapterFor(spec, deps));
}

function adapterFor(spec: ProviderSpec, deps: { voiceStudio: VoiceStudioDeps; fetch?: typeof fetch; gateway?: GatewayLink }): SpeechAdapter {
  switch (spec.kind) {
    case "voice-studio":
      return new VoiceStudioAdapter(spec, deps.voiceStudio);
    case "openai-compatible":
      return new OpenAiAdapter(spec, { ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.gateway ? { gateway: deps.gateway } : {}) });
    case "dashscope":
      return {
        name: spec.name, kind: "dashscope", capabilities: new Set(KIND_CAPABILITIES.dashscope), selfHosted: false, limits: {},
        state: () => ({ where: "dashscope", machine: "", located: false, reachable: false, detail: "not built yet" }),
      };
  }
}

function mb(bytes: number): string {
  return bytes < 1024 * 1024 ? `${bytes} bytes` : `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}
