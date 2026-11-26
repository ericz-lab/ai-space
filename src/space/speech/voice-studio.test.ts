import { describe, expect, test } from "bun:test";
import { ProviderError } from "./types.ts";
import { VoiceStudioAdapter, type StudioPeer, type VoiceStudioDeps } from "./voice-studio.ts";

/**
 * File transcription as a job (voice-studio's `transcribe-start` and `transcribe-result`): the adapter's
 * side of it, with the capability calls answered by a script.
 */

type Call = { cap: string; where: "local" | "peer"; body: unknown };
type Answer = Response | Error | (() => Response);

const DONE = { status: "done", text: "hello there", language: "en", segments: [{ start: 0, end: 2.5, text: "hello there" }], elapsed: 1.2 };
const caller = { app: "notes", tag: "" };
const input = (signal?: AbortSignal) => ({ file: new Blob(["sound"]), filename: "a.mp3", language: "en", context: "AI Space", ...(signal ? { signal } : {}) });

function studio(opts: { at?: "local" | "peer"; caps: string[]; answers: Answer[]; clock?: { t: number } }) {
  const calls: Call[] = [];
  const slept: number[] = [];
  const answers = [...opts.answers];
  const answer = async (where: Call["where"], req: Request, cap: string): Promise<Response> => {
    const type = req.headers.get("content-type") ?? "";
    calls.push({ cap, where, body: type.includes("json") ? await req.json() : type.includes("multipart") ? Object.fromEntries([...(await req.formData()).entries()].map(([k, v]) => [k, typeof v === "string" ? v : "file"])) : null });
    const next = answers.shift();
    if (!next) throw new Error(`no answer scripted for ${cap}`);
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  const peer: StudioPeer = {
    name: "gpu-box",
    config: { url: "https://peer.invalid" },
    knownDown: () => false,
    health: () => "ok",
    provides: (app, cap) => app === "voice-studio" && (!cap || opts.caps.includes(cap)),
    authHeaders: () => ({}),
    forward: async () => new Response(null, { status: 500 }),
  };
  const local = opts.at === "local";
  const deps: VoiceStudioDeps = {
    hasLocal: (app, cap) => local && app === "voice-studio" && opts.caps.includes(cap),
    servicePort: () => (local ? 8920 : undefined),
    callLocal: (req, _caller, _app, cap) => answer("local", req, cap),
    callRemote: (req, _caller, _peer, _app, cap) => answer("peer", req, cap),
    peers: { get: () => undefined, providerOf: (app, cap) => (!local && peer.provides(app, cap) ? { peer } : undefined) },
    sleep: async (ms) => {
      slept.push(ms);
      if (opts.clock) opts.clock.t += ms;
    },
    ...(opts.clock ? { now: () => opts.clock!.t } : {}),
  };
  return { adapter: new VoiceStudioAdapter({ name: "voice-studio", kind: "voice-studio", app: "voice-studio" }, deps), calls, slept };
}

const JOBS = ["transcribe", "speak", "transcribe-start", "transcribe-result"];
const started = () => Response.json({ id: "j1", status: "queued" }, { status: 202 });
const failed = async (p: Promise<unknown>): Promise<ProviderError> => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    return e as ProviderError;
  }
  throw new Error("expected a ProviderError");
};

describe("voice-studio file transcription", () => {
  test("a peer that declares the job capabilities is asked for the result until it is done", async () => {
    const s = studio({ caps: JOBS, answers: [started(), Response.json({ id: "j1", status: "queued" }), Response.json({ id: "j1", status: "running" }), Response.json({ id: "j1", ...DONE })] });
    const out = await s.adapter.transcribe(input(), caller);
    expect(out).toEqual({ text: "hello there", language: "en", segments: [{ start: 0, end: 2.5, text: "hello there" }], audioSeconds: 2.5 });
    expect(s.calls).toEqual([
      { cap: "transcribe-start", where: "peer", body: { file: "file", language: "en", context: "AI Space" } },
      { cap: "transcribe-result", where: "peer", body: { id: "j1", wait: 25 } },
      { cap: "transcribe-result", where: "peer", body: { id: "j1", wait: 25 } },
      { cap: "transcribe-result", where: "peer", body: { id: "j1", wait: 25 } },
    ]);
    // The scripted answers did not wait, so each pending one is followed by a pause.
    expect(s.slept).toEqual([1000, 1000]);
  });

  test("the app on this space is asked the same way", async () => {
    const s = studio({ at: "local", caps: JOBS, answers: [started(), Response.json({ id: "j1", ...DONE })] });
    expect((await s.adapter.transcribe(input(), caller)).text).toBe("hello there");
    expect(s.calls.map((c) => [c.where, c.cap])).toEqual([["local", "transcribe-start"], ["local", "transcribe-result"]]);
  });

  test("an app without the job capabilities gets the one call it had before", async () => {
    const s = studio({ caps: ["transcribe", "speak"], answers: [Response.json({ text: "old way", language: "en", segments: [] })] });
    expect((await s.adapter.transcribe(input(), caller)).text).toBe("old way");
    expect(s.calls.map((c) => c.cap)).toEqual(["transcribe"]);
    // Half of the pair is not enough.
    const half = studio({ caps: ["transcribe", "speak", "transcribe-start"], answers: [Response.json({ text: "old way", language: "en", segments: [] })] });
    await half.adapter.transcribe(input(), caller);
    expect(half.calls.map((c) => c.cap)).toEqual(["transcribe"]);
  });

  test("a job that ends in error reads like the direct call's answer", async () => {
    const refused = studio({ caps: JOBS, answers: [started(), Response.json({ id: "j1", status: "error", code: 400, detail: "ffmpeg could not read the file" })] });
    const bad = await failed(refused.adapter.transcribe(input(), caller));
    expect(bad.status).toBe(400);
    expect(bad.message).toBe("voice-studio: HTTP 400: ffmpeg could not read the file");
    const busy = studio({ caps: JOBS, answers: [started(), Response.json({ id: "j1", status: "error", code: 503, detail: "the card is taken" })] });
    const down = await failed(busy.adapter.transcribe(input(), caller));
    expect(down.status).toBe(502);
    expect(down.message).toBe("voice-studio: HTTP 503: the card is taken");
  });

  test("a refused upload ends the call before any result is asked for", async () => {
    const s = studio({ caps: JOBS, answers: [Response.json({ detail: "context is too long" }, { status: 400 })] });
    const e = await failed(s.adapter.transcribe(input(), caller));
    expect(e.status).toBe(400);
    expect(s.calls.map((c) => c.cap)).toEqual(["transcribe-start"]);
  });

  test("one lost result request does not lose the job; three in a row do", async () => {
    const lost = () => Response.json({ ok: false, error: "peer gpu-box unreachable: Unable to connect" }, { status: 502 });
    const s = studio({ caps: JOBS, answers: [started(), lost(), new Error("socket hang up"), Response.json({ id: "j1", ...DONE })] });
    expect((await s.adapter.transcribe(input(), caller)).text).toBe("hello there");
    expect(s.calls.length).toBe(4);
    const gone = studio({ caps: JOBS, answers: [started(), lost(), lost(), lost()] });
    const e = await failed(gone.adapter.transcribe(input(), caller));
    expect(e.message).toContain("HTTP 502");
    expect(gone.calls.length).toBe(4);
  });

  test("a job the app no longer knows is a link failure at once", async () => {
    const s = studio({ caps: JOBS, answers: [started(), Response.json({ detail: "unknown job" }, { status: 404 })] });
    const e = await failed(s.adapter.transcribe(input(), caller));
    expect(e.kind).toBe("transport");
    expect(e.message).toBe("voice-studio: HTTP 404: unknown job");
    expect(s.calls.length).toBe(2);
  });

  test("a job that never ends is given up at the bus's call limit", async () => {
    const clock = { t: 0 };
    const pending = () => Response.json({ id: "j1", status: "running" });
    const s = studio({ caps: JOBS, clock, answers: [started(), ...Array.from({ length: 1000 }, () => () => { clock.t += 25_000; return pending(); })] });
    const e = await failed(s.adapter.transcribe(input(), caller));
    expect(e.kind).toBe("transport");
    expect(e.message).toBe("voice-studio: no transcript within 900s");
    expect(s.calls.length).toBe(38);
    expect(s.slept).toEqual([]);
  });

  test("a caller that went away stops the asking", async () => {
    const gone = new AbortController();
    const s = studio({ caps: JOBS, answers: [started(), () => { gone.abort(); return Response.json({ id: "j1", status: "running" }); }] });
    const e = await failed(s.adapter.transcribe(input(gone.signal), caller));
    expect(e.status).toBe(499);
    expect(s.calls.length).toBe(2);
  });
});
