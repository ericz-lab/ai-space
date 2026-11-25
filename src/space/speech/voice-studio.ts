import type { FailureKind } from "../model/failure.ts";
import { MAX_CALL_BODY_BYTES } from "../bus/types.ts";
import { ProviderError, type LiveTarget, type ProviderState, type SpeakInput, type SpeakResult, type SpeechAdapter, type SpeechCaller, type SpeechCapability, type TranscribeInput, type TranscribeResult, type VoiceStudioSpec } from "./types.ts";

/**
 * The self-hosted provider (docs/speech.md#kinds): the `voice-studio` app, on this space or on a peer,
 * reached the way the panel reached it before this layer. (A server reached at its own addresses, direct
 * mode, is `voice-studio-direct.ts`.) Files and text go through the bus as a
 * capability call (`transcribe`, `speak`; `bus_calls` records them as before), a live session opens the
 * app's own socket (`/api/asr/realtime`, here on loopback or through the peer's WebSocket bridge), and the
 * voices come from the app's `/api/voices`. Its live protocol is the Space's, so nothing is translated.
 */

/** What a peer link gives this adapter: `PeerClient` has all of it. */
export type StudioPeer = {
  name: string;
  config: { url: string };
  knownDown(): boolean;
  health(): "ok" | "down";
  provides(app: string, capability?: string): boolean;
  authHeaders(): Record<string, string>;
  /** A socket to the peer's `/api/peer/...` path, over HTTPS or its package connection (peers/client.ts). */
  socket?(path: string): WebSocket;
  forward(req: Request, path: string, opts?: { timeoutMs?: number; headers?: Record<string, string> }): Promise<Response>;
  snapshot?: { asOf: string };
};

export type StudioPeers = {
  get(name: string): StudioPeer | undefined;
  providerOf(app: string, capability?: string): { peer: StudioPeer } | { ambiguous: string[] } | undefined;
};

export type VoiceStudioDeps = {
  /** Whether this space's bus has the capability (`Bus.capability`). */
  hasLocal(app: string, capability: string): boolean;
  servicePort(app: string): number | undefined;
  /** The bus's own calls (`capabilityCaller` in bus/api.ts), so `bus_calls` keeps its rows. */
  callLocal(req: Request, caller: string, app: string, capability: string): Promise<Response>;
  callRemote(req: Request, caller: string, peer: StudioPeer, app: string, capability: string): Promise<Response>;
  peers?: StudioPeers;
  fetch?: typeof fetch;
  now?: () => number;
};

const VOICES_TTL_MS = 60_000;
const VOICES_TIMEOUT_MS = 8_000;
/** `voice-studio` reads at most this many speakers in one script. */
const MAX_SPEAKERS = 4;

type Place = { local: true } | { peer: StudioPeer };

export class VoiceStudioAdapter implements SpeechAdapter {
  readonly kind = "voice-studio" as const;
  readonly capabilities: ReadonlySet<SpeechCapability> = new Set<SpeechCapability>(["transcribe", "live", "speak"]);
  readonly selfHosted = true;
  readonly limits = { transcribeBytes: MAX_CALL_BODY_BYTES - 64 * 1024, speakVoices: MAX_SPEAKERS };
  private cachedVoices: { at: number; where: string; voices: string[] } | undefined;

  constructor(readonly spec: VoiceStudioSpec, private readonly deps: VoiceStudioDeps) {}

  get name(): string {
    return this.spec.name;
  }

  /** The bus capability a Space capability lives under: a live session is where files are transcribed. */
  private static capabilityOf(cap: SpeechCapability): string {
    return cap === "speak" ? "speak" : "transcribe";
  }

  /** Where the capability is now; throws a ProviderError saying why it is nowhere. */
  private place(cap: SpeechCapability): Place {
    const { app, machine } = this.spec;
    const name = VoiceStudioAdapter.capabilityOf(cap);
    if (machine) {
      const peer = this.deps.peers?.get(machine);
      if (!peer) throw failure(`${this.name}: no peer named ${machine} is configured (SPACE_PEER_${machine.toUpperCase().replace(/[.-]/g, "_")})`, 503, "other");
      if (!peer.provides(app, name)) throw failure(`${this.name}: peer ${machine} does not provide ${app}/${name}${peer.snapshot ? "" : " (no snapshot from it yet)"}`, 503, "transport");
      return { peer };
    }
    if (this.deps.hasLocal(app, name)) return { local: true };
    const at = this.deps.peers?.providerOf(app, name);
    if (at && "ambiguous" in at) throw failure(`${this.name}: ${app}/${name} is on several peers (${at.ambiguous.join(", ")}); name one with machine: in providers.yaml`, 503, "other");
    if (at) return { peer: at.peer };
    // Nothing here and no peer listing it: the machine that has it is off or not connected.
    throw failure(`${this.name}: no ${app}/${name} on this space or its peers`, 503, "transport");
  }

  state(cap: SpeechCapability = "transcribe"): ProviderState {
    try {
      const at = this.place(cap);
      if ("local" in at) {
        const port = this.deps.servicePort(this.spec.app);
        return { where: "", machine: "", located: true, reachable: Boolean(port), ...(port ? {} : { detail: `${this.spec.app} has no running service` }) };
      }
      const ok = at.peer.health() === "ok";
      return { where: at.peer.name, machine: at.peer.name, located: true, reachable: ok, ...(ok ? {} : { detail: `peer ${at.peer.name} is down` }) };
    } catch (e) {
      return { where: this.spec.machine ?? "", machine: this.spec.machine ?? "", located: false, reachable: false, detail: (e as Error).message };
    }
  }

  async transcribe(input: TranscribeInput, caller: SpeechCaller): Promise<TranscribeResult> {
    const form = new FormData();
    form.append("file", input.file, input.filename);
    if (input.language) form.append("language", input.language);
    if (input.context) form.append("context", input.context);
    const res = await this.call("transcribe", new Request("http://speech.invalid/", { method: "POST", body: form, ...(input.signal ? { signal: input.signal } : {}) }), caller);
    return transcriptOf(this.name, await res.json().catch(() => null), input.language);
  }

  async speak(input: SpeakInput, caller: SpeechCaller): Promise<SpeakResult> {
    const req = new Request("http://speech.invalid/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: input.text, voices: input.voices }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const res = await this.call("speak", req, caller);
    return { audio: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "audio/wav" };
  }

  /** The installed voices, from the app's `/api/voices` here or through the peer's app proxy; kept a minute. */
  async voices(signal?: AbortSignal): Promise<string[]> {
    const at = this.place("speak");
    const where = "local" in at ? "" : at.peer.name;
    const now = (this.deps.now ?? Date.now)();
    if (this.cachedVoices && this.cachedVoices.where === where && now - this.cachedVoices.at < VOICES_TTL_MS) return this.cachedVoices.voices;
    let res: Response;
    try {
      const timeout = AbortSignal.timeout(VOICES_TIMEOUT_MS);
      const s = signal ? AbortSignal.any([signal, timeout]) : timeout;
      if ("local" in at) {
        const port = this.deps.servicePort(this.spec.app);
        if (!port) throw failure(`${this.name}: HTTP 503: ${this.spec.app} has no running service`, 503, "transport");
        res = await (this.deps.fetch ?? fetch)(`http://127.0.0.1:${port}/api/voices`, { signal: s });
      } else {
        if (at.peer.knownDown()) throw failure(`${this.name}: HTTP 503: peer ${at.peer.name} is down`, 503, "transport");
        res = await at.peer.forward(new Request("http://speech.invalid/", { signal: s }), `/api/peer/apps/${encodeURIComponent(this.spec.app)}/proxy/api/voices`, { timeoutMs: VOICES_TIMEOUT_MS });
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw failure(`${this.name}: could not read its voices: unreachable: ${(e as Error).message}`, 502, "transport");
    }
    if (!res.ok) throw failure(`${this.name}: could not read its voices: ${await httpError(res)}`, 502);
    const body = (await res.json().catch(() => null)) as { voices?: unknown } | null;
    const voices = Array.isArray(body?.voices) ? body.voices.filter((v): v is string => typeof v === "string") : [];
    this.cachedVoices = { at: now, where, voices };
    return voices;
  }

  live(): LiveTarget {
    const at = this.place("live");
    if ("local" in at) {
      const port = this.deps.servicePort(this.spec.app);
      if (!port) throw failure(`${this.name}: HTTP 503: ${this.spec.app} has no running service`, 503, "transport");
      return { url: `ws://127.0.0.1:${port}/api/asr/realtime`, headers: {}, machine: "" };
    }
    if (at.peer.knownDown()) throw failure(`${this.name}: HTTP 503: peer ${at.peer.name} is down`, 503, "transport");
    const path = `/api/peer/apps/${encodeURIComponent(this.spec.app)}/proxy/api/asr/realtime`;
    const peer = at.peer;
    return { url: `${peer.config.url.replace(/^http/, "ws")}${path}`, headers: peer.authHeaders(), machine: peer.name, ...(peer.socket ? { open: () => peer.socket!(path) } : {}) };
  }

  /** Self-hosted: no price. */
  cost(): number | undefined {
    return undefined;
  }

  /** The capability call here or on the peer; a failed answer becomes a ProviderError with its status and words. */
  private async call(cap: "transcribe" | "speak", req: Request, caller: SpeechCaller): Promise<Response> {
    const at = this.place(cap);
    const res = "local" in at
      ? await this.deps.callLocal(req, caller.app, this.spec.app, cap)
      : await this.deps.callRemote(req, caller.app, at.peer, this.spec.app, cap);
    if (res.ok) return res;
    const text = await httpError(res);
    // The provider's own refusal of the request keeps its status; a failure of the provider or the link is a 502.
    throw failure(`${this.name}: ${text}`, res.status === 400 || res.status === 413 || res.status === 422 ? res.status : 502);
  }
}

/** voice-studio's `/api/asr` answer (`{ text, language, segments }`, the bus capability's body too) as a result. */
export function transcriptOf(name: string, raw: unknown, language: string): TranscribeResult {
  const body = raw as { text?: unknown; language?: unknown; segments?: unknown } | null;
  if (!body || typeof body.text !== "string") throw failure(`${name}: the answer has no text`, 502, "other");
  const segments = Array.isArray(body.segments)
    ? body.segments.flatMap((s) => {
        const seg = s as { start?: unknown; end?: unknown; text?: unknown };
        return typeof seg?.start === "number" && typeof seg.end === "number" && typeof seg.text === "string" ? [{ start: seg.start, end: seg.end, text: seg.text }] : [];
      })
    : [];
  const end = segments.reduce((m, s) => Math.max(m, s.end), 0);
  return { text: body.text, language: typeof body.language === "string" ? body.language : language, segments, ...(end > 0 ? { audioSeconds: end } : {}) };
}

/** `HTTP <status>: <what the body said>`: the shape `classifyFailure` reads a 5xx in as a link failure. */
export async function httpError(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  let said = text.trim();
  try {
    const body = JSON.parse(text) as { detail?: unknown; error?: unknown; message?: unknown };
    const e = body.error;
    said = typeof body.detail === "string" ? body.detail
      : typeof e === "string" ? e
      : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? `${(e as { message: string }).message}${typeof (e as { code?: unknown }).code === "string" ? ` (${(e as { code: string }).code})` : ""}`
      : typeof body.message === "string" ? body.message
      : said;
  } catch {
    /* not JSON: the text as it is */
  }
  const retry = res.headers.get("retry-after");
  const seconds = retry && /^\d+(?:\.\d+)?$/.test(retry.trim()) ? ` (retry after ${retry.trim()}s)` : "";
  return `HTTP ${res.status}${said ? `: ${said.slice(0, 300)}` : ""}${seconds}`;
}

function failure(message: string, status: number, kind?: FailureKind): ProviderError {
  return new ProviderError(message, status, kind);
}
