import { OPERATOR, bearer, identify, isOwner, sameOrigin } from "../auth.ts";
import { wantsWebSocket } from "../terminal/api.ts";
import { type Connect, liveAttachment } from "./live.ts";
import { MAX_SPEAK_CHARS, type SpeechService } from "./service.ts";
import { SPEECH_WINDOWS, type SpeechWindow } from "./store.ts";
import { languageHint, MAX_CONTEXT_CHARS, PROVIDER_NAME_PATTERN, SpeechError, speechContext, TAG_PATTERN, VOICE_PATTERN, type SpeechCaller } from "./types.ts";

/**
 * HTTP surface of the speech layer (docs/speech.md#contract):
 *
 *   GET  /api/speech                    providers, defaults, fallback lists, voice table, status cells, the last day's totals
 *   POST /api/speech/transcribe         multipart file (+ language, context, tag, provider) → { ok, text, language, segments, provider, call }
 *   POST /api/speech/speak              { text, voice | voices, tag?, provider? } → audio/wav
 *   GET  /api/speech/voices             each provider's own voices and the voice table
 *   GET  /api/speech/live               WebSocket: live dictation in the Space's protocol
 *   GET  /api/speech/calls?app&limit    the ledger, newest first
 *   GET  /api/speech/usage?window&app   totals, by provider and by app
 *
 * and the panel's older routes, now through the same layer (docs/speech.md#compatibility):
 *
 *   GET  /api/voice                     { ok, transcribe }
 *   POST /api/voice/transcribe          as /api/speech/transcribe, tag voice-input, the Space's terms in its context
 *   GET  /api/voice/realtime            as /api/speech/live, tag voice-input
 *
 * An app's `SPACE_APP_TOKEN` calls as that app; the operator token, the owner's session and the panel
 * (no token: its writes are held to its own origin by `guardBrowserWrites`) call as `space`.
 */

export type SpeechApiOptions = {
  service: SpeechService;
  token?: string;
  appForToken?: (token: string) => Promise<string | undefined>;
  /** Opens a provider's live socket; tests replace it. */
  connect?: Connect;
};

/** OpenAI's limit, the largest a provider here takes. */
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
export { MAX_CONTEXT_CHARS };
const MAX_VOICES = 8;
const SPEAK_VOICE = new RegExp(`^(?:[a-z0-9][a-z0-9._-]*/)?${VOICE_PATTERN.source.slice(1, -1)}$`, "u");

type Handler = (req: Request & { params: Record<string, string> }, server: Bun.Server<unknown>) => Response | undefined | Promise<Response | undefined>;
type Routes = Record<string, Partial<Record<"GET" | "POST", Handler>>>;

export function createSpeechRoutes(opts: SpeechApiOptions): Routes {
  const { service } = opts;
  const token = opts.token?.trim() ?? "";

  /** The calling app, `space` for the operator and the panel; undefined for a token that names nobody. */
  const callerOf = async (req: Request): Promise<string | undefined> => {
    if (isOwner(req) || !bearer(req)) return "space";
    const who = await identify(req, { token, ...(opts.appForToken ? { appForToken: opts.appForToken } : {}) });
    return who === undefined ? undefined : who === OPERATOR ? "space" : who.app;
  };

  /**
   * `terms`: the Space's terms join the caller's context (docs/speech.md#terms). Only for the person's
   * own dictation (`/api/voice/transcribe`, voice input's clip fallback); a file an app transcribes
   * through `/api/speech/transcribe` is not what the person said, so it gets only its own context.
   */
  const transcribe = (defaultTag: string, terms = false): Handler => async (req) => {
    const app = await callerOf(req);
    if (!app) return fail(401, "unauthorized");
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > MAX_TRANSCRIBE_BYTES + 64 * 1024) return fail(413, `the body is ${length} bytes; a file may be at most ${MAX_TRANSCRIBE_BYTES}`);
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return fail(400, "send a multipart form with a file field");
    }
    const file = form.get("file");
    if (!(file instanceof Blob)) return fail(400, "file is required");
    if (file.size === 0) return fail(400, "the file is empty");
    if (file.size > MAX_TRANSCRIBE_BYTES) return fail(413, `the file is ${file.size} bytes; at most ${MAX_TRANSCRIBE_BYTES}`);
    const field = (name: string) => {
      const v = form.get(name);
      return typeof v === "string" ? v.trim() : "";
    };
    const raw = field("language");
    if (!/^[A-Za-z-]{0,16}$/.test(raw)) return fail(400, "language must be a language code such as zh or en");
    const language = languageHint(raw);
    const own = field("context");
    if (own.length > MAX_CONTEXT_CHARS) return fail(400, `context is at most ${MAX_CONTEXT_CHARS} characters`);
    const context = terms ? speechContext(service.terms, own) : own;
    const tag = field("tag") || defaultTag;
    if (!TAG_PATTERN.test(tag)) return fail(400, "tag must be a short name");
    const provider = field("provider");
    if (provider && !PROVIDER_NAME_PATTERN.test(provider)) return fail(400, "provider must be a provider name");
    try {
      const { result, call } = await service.transcribe({ app, tag }, {
        file, filename: file instanceof File && file.name ? file.name : "audio", language, context, signal: req.signal, ...(provider ? { provider } : {}),
      });
      return json({ ok: true, text: result.text, language: result.language, segments: result.segments, provider: call.provider, call });
    } catch (e) {
      return speechFailure(e);
    }
  };

  const live = (defaultTag: string): Handler => async (req, server) => {
    if (!sameOrigin(req)) return fail(403, "cross-origin request refused");
    if (!wantsWebSocket(req)) return fail(426, "websocket required");
    const app = await callerOf(req);
    if (!app) return fail(401, "unauthorized");
    const caller: SpeechCaller = { app, tag: defaultTag };
    const why = service.liveUnavailable(caller);
    if (why) return fail(503, why);
    if (server.upgrade(req, { data: { attachment: liveAttachment({ service, caller, ...(opts.connect ? { connect: opts.connect } : {}) }) } })) return undefined;
    return fail(400, "websocket upgrade failed");
  };

  return {
    "/api/speech": {
      GET: () => json({ ok: true, ...service.status() }),
    },
    "/api/speech/transcribe": { POST: transcribe("other") },
    "/api/speech/speak": {
      POST: async (req) => {
        const app = await callerOf(req);
        if (!app) return fail(401, "unauthorized");
        const body = (await req.json().catch(() => null)) as { text?: unknown; voice?: unknown; voices?: unknown; tag?: unknown; provider?: unknown } | null;
        if (!body || typeof body !== "object") return fail(400, "send JSON with text");
        if (typeof body.text !== "string" || !body.text.trim()) return fail(400, "text is required");
        if ([...body.text].length > MAX_SPEAK_CHARS) return fail(413, `text is at most ${MAX_SPEAK_CHARS} characters`);
        if (body.voice !== undefined && body.voices !== undefined) return fail(400, "send voice or voices, not both");
        const voices = body.voices !== undefined ? body.voices : body.voice !== undefined ? [body.voice] : [];
        if (!Array.isArray(voices) || voices.length > MAX_VOICES || !voices.every((v) => typeof v === "string" && SPEAK_VOICE.test(v.trim()))) return fail(400, `voice must be a voice name (or provider/voice); voices a list of at most ${MAX_VOICES}`);
        const tag = body.tag === undefined ? "other" : body.tag;
        if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) return fail(400, "tag must be a short name");
        if (body.provider !== undefined && (typeof body.provider !== "string" || !PROVIDER_NAME_PATTERN.test(body.provider))) return fail(400, "provider must be a provider name");
        try {
          const out = await service.speak({ app, tag }, { text: body.text, voices: (voices as string[]).map((v) => v.trim()), signal: req.signal, ...(typeof body.provider === "string" ? { provider: body.provider } : {}) });
          return new Response(out.audio, {
            headers: {
              "content-type": out.contentType,
              "cache-control": "no-store",
              "x-speech-provider": out.call.provider,
              "x-speech-voice": encodeURIComponent(out.call.voice ?? ""),
              "x-speech-call-id": String(out.call.id),
            },
          });
        } catch (e) {
          return speechFailure(e);
        }
      },
    },
    "/api/speech/voices": {
      GET: async (req) => json({ ok: true, providers: await service.voices(req.signal), mapped: service.config?.voices ?? {} }),
    },
    "/api/speech/live": { GET: live("other") },
    "/api/speech/calls": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const limit = Number(q.get("limit") ?? 50);
        return json({ ok: true, calls: service.calls({ ...(q.get("app") ? { app: q.get("app")! } : {}), limit: Number.isFinite(limit) ? limit : 50 }) });
      },
    },
    "/api/speech/usage": {
      GET: (req) => {
        const q = new URL(req.url).searchParams;
        const window = (q.get("window") ?? "24h") as SpeechWindow;
        if (!(window in SPEECH_WINDOWS)) return fail(400, `window must be one of ${Object.keys(SPEECH_WINDOWS).join(", ")}`);
        return json({ ok: true, ...service.usage(window, q.get("app") ?? undefined) });
      },
    },

    "/api/voice": {
      GET: () => json({ ok: true, transcribe: service.canTranscribe() }),
    },
    "/api/voice/transcribe": { POST: transcribe("voice-input", true) },
    "/api/voice/realtime": { GET: live("voice-input") },
  };
}

function speechFailure(e: unknown): Response {
  if (e instanceof SpeechError) return json({ ok: false, error: e.message, ...(e.call ? { call: e.call } : {}) }, e.status);
  return fail(500, (e as Error).message ?? String(e));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function fail(status: number, error: string): Response {
  return json({ ok: false, error }, status);
}
