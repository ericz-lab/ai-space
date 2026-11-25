import { createHmac, timingSafeEqual } from "node:crypto";
import type { FailureKind } from "../model/failure.ts";
import { ProviderError, type LiveTarget, type ProviderState, type SpeakInput, type SpeakResult, type SpeechAdapter, type SpeechCapability, type SpeechServerAddress, type SpeechServerSpec, type TranscribeInput, type TranscribeResult } from "./types.ts";
import { httpError, transcriptOf } from "./voice-studio.ts";

/**
 * The `speech-server` kind (docs/speech.md#speech-server): a server that speaks the speech-server
 * interface, reached at its own addresses rather than through this space's bus or a peer. The voice-studio
 * app is the implementation that exists. `POST /api/asr`, `POST /api/tts`, `GET /api/voices` and
 * `WS /api/asr/realtime` under a base URL, each with the server's token as a bearer.
 *
 * Several addresses name one server (a LAN address at home, a tunnel hostname elsewhere). Before any
 * of them gets the token or a byte of audio it must pass the identity probe: `GET /api/identity?nonce=`
 * with a fresh random nonce, answered with HMAC-SHA256(token, "voice-studio-identity:" + nonce). The
 * token itself never goes to an address that has not answered it: on someone else's network another
 * machine may sit at the same private IP. The first address in list order that passes is remembered;
 * a call that cannot reach it chooses again and is retried once, and while a later address is in use
 * the earlier ones are probed again now and then (on a call, never on a timer) so a laptop that came
 * home moves back to the LAN.
 */

/**
 * How long one identity probe may take. An address on the LAN answers in milliseconds or not at all
 * (the machine is off, or this is another network); a tunnel crosses the internet and an access layer.
 */
export const PROBE_TIMEOUT_MS = { local: 1_500, remote: 6_000 } as const;
/** How long a later address stays in use before the earlier ones are probed again, on the next call. */
export const RECHECK_MS = 5 * 60_000;
/** As the bus capability declares for transcribe and speak. */
const CALL_TIMEOUT_MS = 15 * 60_000;
const VOICES_TTL_MS = 60_000;
const VOICES_TIMEOUT_MS = 8_000;
/** The Space's own per-file limit; no bus in between to hold it to 4 MB. */
export const DIRECT_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
/** The interface reads at most this many speakers in one script (voice-studio's limit). */
const MAX_SPEAKERS = 4;
/** An identity answer is a few hundred bytes; anything longer is not one. */
const MAX_IDENTITY_BYTES = 16 * 1024;
const NONCE_BYTES = 32;

/** The proof a speech server answers the probe with: lowercase hex HMAC-SHA256 keyed by the token. The prefix is the interface's, whatever the server is called. */
export function identityProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`voice-studio-identity:${nonce}`).digest("hex");
}

export type SpeechServerDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  /** For tests: shorter probe timeouts. */
  probeTimeoutMs?: { local: number; remote: number };
};

export class SpeechServerAdapter implements SpeechAdapter {
  readonly kind = "speech-server" as const;
  readonly capabilities: ReadonlySet<SpeechCapability> = new Set<SpeechCapability>(["transcribe", "live", "speak"]);
  readonly selfHosted = true;
  readonly limits = { transcribeBytes: DIRECT_TRANSCRIBE_BYTES, speakVoices: MAX_SPEAKERS };
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  /** The address in use and when it was chosen or last confirmed by a probe. */
  private chosen: { address: SpeechServerAddress; at: number } | undefined;
  /** The last choice that found none, and why. */
  private failed: { at: number; detail: string } | undefined;
  private choosing: Promise<SpeechServerAddress | undefined> | undefined;
  private rechecking: Promise<void> | undefined;
  private cachedVoices: { at: number; url: string; voices: string[] } | undefined;

  constructor(readonly spec: SpeechServerSpec, private readonly deps: SpeechServerDeps = {}) {
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  get name(): string {
    return this.spec.name;
  }

  /** The addresses that may be tried, in order of preference. */
  private get usable(): SpeechServerAddress[] {
    return this.spec.addresses.filter((a) => !a.off);
  }

  /** From what calls and earlier probes learned; never probes (docs/speech.md#status). */
  state(): ProviderState {
    const at = this.chosen?.address ?? this.usable[0] ?? this.spec.addresses[0]!;
    const base = { where: at.host, machine: at.host, located: true };
    if (this.chosen) return { ...base, reachable: true };
    if (this.failed) return { ...base, reachable: false, detail: this.failed.detail };
    return base;
  }

  /** For tests: wait for a choice or a re-check running in the background. */
  async settled(): Promise<void> {
    await this.choosing;
    await this.rechecking;
  }

  // ------------------------------------------------------------------------------------------- choosing

  /**
   * One identity probe; undefined when the address proved it is the server, else why not. No token
   * goes with it; an access layer's headers do, to an https address only. A redirect is not followed.
   */
  private async probe(a: SpeechServerAddress, signal: AbortSignal): Promise<string | undefined> {
    const token = this.spec.token;
    if (!token) return "no token";
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))).toString("hex");
    const limits = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    const ms = a.local ? limits.local : limits.remote;
    const timeout = AbortSignal.timeout(ms);
    try {
      const res = await this.fetch(`${a.url}/api/identity?nonce=${nonce}`, { redirect: "manual", headers: accessHeaders(a), signal: AbortSignal.any([signal, timeout]) });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => {});
        return `HTTP ${res.status}: redirected${res.headers.get("location") ? " (an access layer's login?)" : ""}`;
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        return `HTTP ${res.status}`;
      }
      const text = await readCapped(res, MAX_IDENTITY_BYTES);
      if (text === undefined) return "the answer is too long to be an identity";
      let body: { ok?: unknown; app?: unknown; proof?: unknown };
      try {
        body = JSON.parse(text) as typeof body;
      } catch {
        return "the answer is not JSON";
      }
      // `app` names the implementation (voice-studio says "voice-studio"); only the proof authenticates.
      if (body?.ok !== true) return "it does not answer as a speech server";
      if (typeof body.proof !== "string" || !/^[0-9a-f]{64}$/.test(body.proof)) return "no proof in the answer";
      const ok = timingSafeEqual(Buffer.from(body.proof, "hex"), Buffer.from(identityProof(token, nonce), "hex"));
      return ok ? undefined : "the proof is wrong (another server, or another token)";
    } catch (e) {
      if (timeout.aborted) return `timed out after ${ms} ms`;
      if (signal.aborted) return "not needed";
      return `unreachable: ${(e as Error).message}`;
    }
  }

  /**
   * Probe the addresses at once and take the earliest in list order that passes, without waiting for a
   * later one once an earlier one has passed (the rest are aborted). Concurrent callers share one choice.
   */
  private choose(): Promise<SpeechServerAddress | undefined> {
    this.choosing ??= this.pick(this.usable)
      .then(({ found, why }) => {
        if (found) {
          this.chosen = { address: found, at: this.now() };
          this.failed = undefined;
          return found;
        }
        const off = this.spec.addresses.filter((a) => a.off).map((a) => `${a.host}: ${a.off}`);
        this.chosen = undefined;
        this.failed = { at: this.now(), detail: `no address answered as the speech server (${[...why, ...off].join("; ") || "none to try"})` };
        return undefined;
      })
      .finally(() => {
        this.choosing = undefined;
      });
    return this.choosing;
  }

  /** The earliest of `list` that passes the probe, or why each one did not. */
  private async pick(list: SpeechServerAddress[]): Promise<{ found?: SpeechServerAddress; why: string[] }> {
    const stop = new AbortController();
    const probes = list.map((a) => this.probe(a, stop.signal));
    const why: string[] = [];
    try {
      for (const [i, p] of probes.entries()) {
        const no = await p;
        if (no === undefined) return { found: list[i]!, why };
        why.push(`${list[i]!.host}: ${no}`);
      }
      return { why };
    } finally {
      stop.abort();
    }
  }

  /**
   * While a later address is in use, the earlier ones are probed again once `RECHECK_MS` has passed,
   * in the background of the call that noticed: that call goes on where it is, the next ones move.
   */
  private recheck(): void {
    const c = this.chosen;
    if (!c || this.rechecking || this.now() - c.at < RECHECK_MS) return;
    const i = this.usable.findIndex((a) => a.url === c.address.url);
    if (i <= 0) return;
    this.rechecking = this.pick(this.usable.slice(0, i))
      .then(({ found }) => {
        if (this.chosen !== c) return;
        if (found) this.chosen = { address: found, at: this.now() };
        else c.at = this.now();
      })
      .finally(() => {
        this.rechecking = undefined;
      });
  }

  /** The address to use now: the remembered one, else a fresh choice; none is a link failure. */
  private async address(): Promise<SpeechServerAddress> {
    if (this.chosen) {
      this.recheck();
      return this.chosen.address;
    }
    const a = await this.choose();
    if (!a) throw failure(`${this.name}: unreachable: ${this.failed?.detail ?? "no address answered as the speech server"}`, 503, "transport");
    return a;
  }

  private forget(a: SpeechServerAddress): void {
    if (this.chosen?.address.url === a.url) this.chosen = undefined;
  }

  /** The token and, to an https address, the access layer's headers: only ever for an address that passed the probe. */
  private headersFor(a: SpeechServerAddress): Record<string, string> {
    return { ...accessHeaders(a), authorization: `Bearer ${this.spec.token}` };
  }

  /**
   * One HTTP call to the server. A call that does not reach it (refused, reset, unresolved, a redirect:
   * not the server) forgets the address, chooses again and is sent once more when another one passed.
   */
  private async request(path: string, init: { method: string; body?: BodyInit; headers?: Record<string, string> }, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<{ res: Response; address: SpeechServerAddress }> {
    let a = await this.address();
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let why: string;
      try {
        const res = await this.fetch(`${a.url}${path}`, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), ...this.headersFor(a) }, signal });
        if (res.status < 300 || res.status >= 400) return { res, address: a };
        await res.body?.cancel().catch(() => {});
        why = `HTTP ${res.status}: redirected`;
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        if (timeout.aborted) throw failure(`${this.name}: timed out after ${Math.round(opts.timeoutMs / 1000)} s at ${a.host}`, 504, "other");
        why = (e as Error).message;
      }
      this.forget(a);
      const next = attempt === 0 ? await this.choose() : undefined;
      if (!next || next.url === a.url) throw failure(`${this.name}: unreachable: ${a.host}: ${why}`, 502, "transport");
      a = next;
    }
  }

  /** A failed answer as a ProviderError: the server's refusal of the request keeps its status, anything else is a 502. */
  private async refused(res: Response): Promise<ProviderError> {
    const text = await httpError(res);
    return failure(`${this.name}: ${text}`, res.status === 400 || res.status === 413 || res.status === 422 ? res.status : 502);
  }

  // ------------------------------------------------------------------------------------------- calls

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    const form = new FormData();
    form.append("file", input.file, input.filename);
    if (input.language) form.append("language", input.language);
    if (input.context) form.append("context", input.context);
    const { res } = await this.request("/api/asr", { method: "POST", body: form }, { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: CALL_TIMEOUT_MS });
    if (!res.ok) throw await this.refused(res);
    return transcriptOf(this.name, await res.json().catch(() => null), input.language);
  }

  async speak(input: SpeakInput): Promise<SpeakResult> {
    const { res } = await this.request(
      "/api/tts",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: input.text, voices: input.voices }) },
      { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: CALL_TIMEOUT_MS },
    );
    if (!res.ok) throw await this.refused(res);
    return { audio: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "audio/wav" };
  }

  /** The installed voices from the server's `/api/voices`; kept a minute. */
  async voices(signal?: AbortSignal): Promise<string[]> {
    const now = this.now();
    const c = this.cachedVoices;
    if (c && this.chosen?.address.url === c.url && now - c.at < VOICES_TTL_MS) return c.voices;
    const { res, address } = await this.request("/api/voices", { method: "GET" }, { ...(signal ? { signal } : {}), timeoutMs: VOICES_TIMEOUT_MS });
    if (!res.ok) throw failure(`${this.name}: could not read its voices: ${await httpError(res)}`, 502);
    const body = (await res.json().catch(() => null)) as { voices?: unknown } | null;
    const voices = Array.isArray(body?.voices) ? body.voices.filter((v): v is string => typeof v === "string") : [];
    this.cachedVoices = { at: now, url: address.url, voices };
    return voices;
  }

  /** The server's live socket at the address in use; when it cannot be opened, `reroute` chooses again once. */
  async live(): Promise<LiveTarget> {
    const a = await this.address();
    return {
      ...this.socketAt(a),
      reroute: async () => {
        this.forget(a);
        const next = await this.choose();
        return next && next.url !== a.url ? this.socketAt(next) : undefined;
      },
    };
  }

  private socketAt(a: SpeechServerAddress): LiveTarget {
    return { url: `${a.url.replace(/^http/, "ws")}/api/asr/realtime`, headers: this.headersFor(a), machine: a.host };
  }

  /** Self-hosted: no price. */
  cost(): number | undefined {
    return undefined;
  }
}

/** An access layer's headers go to an https address only, whatever the file said. */
function accessHeaders(a: SpeechServerAddress): Record<string, string> {
  return a.headers && a.url.startsWith("https://") ? { ...a.headers } : {};
}

/** The body as text when it is at most `max` bytes; undefined (and the rest dropped) when longer. */
async function readCapped(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function failure(message: string, status: number, kind?: FailureKind): ProviderError {
  return new ProviderError(message, status, kind);
}
