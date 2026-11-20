import type { ServerWebSocket } from "bun";
import type { FailureKind } from "../model/failure.ts";
import type { WsAttachment, WsData } from "../terminal/service.ts";
import type { LiveSession, SpeechService } from "./service.ts";
import { ProviderError, SpeechError, TAG_PATTERN, PROVIDER_NAME_PATTERN, type SpeechAdapter, type SpeechCaller } from "./types.ts";

/**
 * One live dictation session (docs/speech.md#live-protocol) between the client's socket and a
 * provider's. The client's `start` is checked and the provider chosen from it; a provider whose socket
 * cannot be opened is a link failure and the next one is tried before anything reached the client;
 * once one answered, the session stays with it. Frames then pass through: binary PCM up (counted for the
 * ledger), JSON events down (`ready` gains `provider`). The session's ledger row is written when it ends.
 */

/** Frames held while the provider's socket opens: about a minute of 100 ms frames, as voice-studio holds. */
export const MAX_HELD_FRAMES = 640;
const START_DEADLINE_MS = 10_000;
/** Version 1 of the protocol fixes the audio format. */
const FORMAT = { format: "pcm_s16le", sample_rate: 16000, channels: 1 } as const;
const BYTES_PER_SECOND = FORMAT.sample_rate * 2 * FORMAT.channels;

export type Connect = (url: string, headers: Record<string, string>) => WebSocket;

const defaultConnect: Connect = (url, headers) => new WebSocket(url, { headers } as unknown as string[]);

/** Close codes the Space itself sends, with the event before them. */
const CLOSE: Record<string, number> = { invalid_request: 4400, local_only: 4403, no_provider: 4404, unavailable: 4503 };

export function liveAttachment(opts: { service: SpeechService; caller: SpeechCaller; connect?: Connect; log?: (line: string) => void }): WsAttachment {
  const connect = opts.connect ?? defaultConnect;
  let client: ServerWebSocket<WsData> | undefined;
  let session: LiveSession | undefined;
  let start: { type: "start"; language: string } & typeof FORMAT;
  let caller = opts.caller;
  let index = 0;
  let up: WebSocket | undefined;
  let upOpen = false;
  let adapter: SpeechAdapter | undefined;
  let machine = "";
  let held: (string | Uint8Array)[] = [];
  let audioBytes = 0;
  let language = "";
  const finals = new Map<number, number>();
  let providerError: { message: string; kind: FailureKind } | undefined;
  let done = false;
  let ended = false;
  let startTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (event: Record<string, unknown>) => {
    if (client?.readyState === 1) client.send(JSON.stringify(event));
  };
  /** The Space's own refusal: an error event, then the close. */
  const refuse = (code: string, message: string) => {
    send({ type: "error", code, message });
    if (client?.readyState === 1) client.close(CLOSE[code] ?? 4503, message.slice(0, 120));
  };
  const finish = () => {
    if (ended || !session) return;
    ended = true;
    clearTimeout(startTimer);
    const chars = [...finals.values()].reduce((a, b) => a + b, 0);
    session.finish(upOpen ? adapter : undefined, {
      ok: !providerError && upOpen,
      ...(providerError ? { error: providerError.message, kind: providerError.kind } : !upOpen ? { error: "the client left before a provider answered" } : {}),
      audioSeconds: audioBytes / BYTES_PER_SECOND,
      chars,
      ...(language ? { language } : {}),
      ...(machine ? { machine } : {}),
    });
  };

  /** The session cannot go on: the error event, the close and the row. */
  const fail = (message: string, kind: FailureKind) => {
    providerError = { message, kind };
    refuse("unavailable", message);
    finish();
  };

  /** Open the next candidate's socket; when none is left, refuse the session with the last reason. */
  const next = (reason?: string): void => {
    if (!session || !client || client.readyState !== 1) return finish();
    const candidate = session.candidates[index++];
    if (!candidate) return fail(reason ?? "no live provider could be reached", "transport");
    adapter = candidate;
    /** A socket that never opened: the next candidate when it was a link failure, else the end. */
    const notOpened = (message: string, kind?: FailureKind) => (session!.failed(candidate, message, kind) ? next(message) : fail(message, kind ?? "other"));
    let target;
    try {
      target = session.target(candidate);
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError((e as Error).message);
      return notOpened(err.message, err.kind);
    }
    machine = target.machine;
    let socket: WebSocket;
    try {
      socket = up = connect(target.url, target.headers);
    } catch (e) {
      return notOpened(`${candidate.name}: unreachable: ${(e as Error).message}`, "transport");
    }
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (up !== socket) return;
      upOpen = true;
      session!.opened(candidate, machine);
      socket.send(JSON.stringify(start));
      for (const frame of held) socket.send(frame);
      held = [];
    };
    socket.onmessage = (e) => {
      if (up !== socket || typeof e.data !== "string") return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(e.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof event.language === "string" && event.language) language = event.language;
      if (event.type === "ready") event = { ...event, provider: candidate.name };
      else if (event.type === "final" && Number.isInteger(event.segment_id) && typeof event.text === "string") finals.set(event.segment_id as number, [...event.text].length);
      else if (event.type === "done") done = true;
      else if (event.type === "error") {
        const code = typeof event.code === "string" ? event.code : "error";
        const message = `${candidate.name}: ${code}: ${typeof event.message === "string" ? event.message : "live transcription failed"}`;
        // A busy GPU is a capacity limit, like a rate limit: the cell rests a minute.
        providerError = { message, kind: code === "busy" ? "rate" : "other" };
      }
      send(event);
    };
    socket.onclose = (e) => {
      if (up !== socket) return;
      if (!upOpen) {
        // Never opened: the machine is off or the peer refused. Nothing reached the client, so the next one may answer.
        up = undefined;
        return notOpened(`${candidate.name}: could not open its live socket (${e.code}${e.reason ? ` ${e.reason}` : ""})`, "transport");
      }
      if (!done && !providerError && client?.readyState === 1) providerError = { message: `${candidate.name}: the live socket closed before done (${e.code}${e.reason ? ` ${e.reason}` : ""})`, kind: e.code === 1006 ? "transport" : "other" };
      if (client?.readyState === 1) {
        const code = e.code === 1000 || (e.code >= 3000 && e.code <= 4999) ? e.code : 4002;
        client.close(code, (e.reason || (done ? "done" : "provider closed")).slice(0, 120));
      }
      finish();
    };
    socket.onerror = () => {
      /* onclose follows with the code */
    };
  };

  return {
    open(ws) {
      client = ws;
      startTimer = setTimeout(() => {
        if (!session) refuse("invalid_request", "send start within 10 s");
      }, START_DEADLINE_MS);
    },
    message(ws, m) {
      client = ws;
      if (!session) {
        if (typeof m !== "string") return refuse("invalid_request", "send start before audio");
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(m) as Record<string, unknown>;
        } catch {
          return refuse("invalid_request", "start must be JSON");
        }
        if (msg.type !== "start") return refuse("invalid_request", "the first message must be start");
        for (const [k, v] of Object.entries(FORMAT)) if (msg[k] !== undefined && msg[k] !== v) return refuse("invalid_request", `${k} must be ${v}`);
        const lang = msg.language ?? "";
        if (typeof lang !== "string" || !/^[A-Za-z-]{0,16}$/.test(lang)) return refuse("invalid_request", "language must be a language code");
        if (msg.tag !== undefined) {
          if (typeof msg.tag !== "string" || !TAG_PATTERN.test(msg.tag)) return refuse("invalid_request", "tag must be a short name");
          caller = { ...caller, tag: msg.tag };
        }
        if (msg.provider !== undefined && (typeof msg.provider !== "string" || !PROVIDER_NAME_PATTERN.test(msg.provider))) return refuse("invalid_request", "provider must be a provider name");
        start = { type: "start", ...FORMAT, language: lang };
        try {
          session = opts.service.live(caller, typeof msg.provider === "string" ? { provider: msg.provider } : {});
        } catch (e) {
          if (e instanceof SpeechError) return refuse(e.code ?? "unavailable", e.message);
          return refuse("unavailable", (e as Error).message);
        }
        clearTimeout(startTimer);
        return next();
      }
      if (ended) return;
      if (typeof m === "string") {
        let type: unknown;
        try {
          type = (JSON.parse(m) as { type?: unknown }).type;
        } catch {
          return;
        }
        if (type !== "stop" && type !== "cancel") return;
        if (up && upOpen) up.send(JSON.stringify({ type }));
        else if (held.length < MAX_HELD_FRAMES) held.push(JSON.stringify({ type }));
        return;
      }
      const frame = new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
      audioBytes += frame.byteLength;
      if (up && upOpen) up.send(frame);
      else if (held.length < MAX_HELD_FRAMES) held.push(frame.slice());
      else refuse("invalid_request", "too much audio before the provider was ready");
    },
    close() {
      held = [];
      const socket = up;
      up = undefined;
      if (socket) {
        try {
          socket.close(1000, "client left");
        } catch {
          /* already closed */
        }
      }
      finish();
    },
  };
}
