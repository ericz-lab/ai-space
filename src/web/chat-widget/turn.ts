/**
 * One turn as the widget sends and follows it, kept apart from the DOM so it
 * can be tested: the body a turn posts, and the reading of its event stream,
 * including coming back to a stream the network cut.
 */
import { readSse } from "./sse.ts";

export type Attachment = { id: number; name: string; type: string; size: number; url: string };
export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  error?: string;
  /** Why a failed answer has no end: the person stopped it, or ai-space restarted under it. */
  state?: "stopped" | "interrupted";
  /** On a person's message: how many earlier images of the thread the model was not given on that turn. */
  omitted?: number;
  attachments: Attachment[];
  backend?: string;
  costUsd?: number | null;
  model?: string;
  /** Still being written. */
  live?: boolean;
};
export type Thread = { id: number; scope: string; title: string; createdAt: string; updatedAt: string };

/** What the app's `context()` returns for one turn; every field but the three texts overrides the mount option of the same name. */
export type Context = { system?: string; text?: string; ack?: string; tools?: string[]; model?: string; thinking?: number; timeoutMs?: number };
export type TurnDefaults = { model?: string; tools?: string[]; thinking?: number; timeoutMs?: number };

/** The body of `POST /threads/:id/turn`: what the app's context says for this turn wins over the mount options. */
export function turnBody(message: string, attachments: number[], requestId: string, ctx: Context, defaults: TurnDefaults): Record<string, unknown> {
  const model = ctx.model ?? defaults.model;
  const tools = ctx.tools ?? defaults.tools;
  const thinking = ctx.thinking ?? defaults.thinking;
  const timeoutMs = ctx.timeoutMs ?? defaults.timeoutMs;
  return {
    message, attachments, requestId,
    context: { ...(ctx.system ? { system: ctx.system } : {}), ...(ctx.text !== undefined ? { text: ctx.text } : {}), ...(ctx.ack ? { ack: ctx.ack } : {}) },
    ...(model ? { model } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  };
}

/** A key that names one turn, so posting it again after a cut connection is the same turn and not a second one. */
export function newRequestId(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** How the service says a turn ended. Without `user` and `assistant` nothing could be stored. */
export type Final = { ok: boolean; error?: string; user?: Message; assistant?: Message; thread?: Thread };

export type StreamEnd =
  /** The turn is over and this is its result. */
  | { kind: "final"; final: Final }
  /** The connection failed or ended early; the turn may well still be running. */
  | { kind: "lost"; error: string }
  /** The service answered with a refusal instead of a stream: nothing was started by this request. */
  | { kind: "refused"; status: number; error: string }
  /** The reader's own signal ended it. */
  | { kind: "left" };

export type StreamHandlers = {
  /** The stream (re)starts: the text that follows is the whole answer from its first character. */
  start?: (info: { user?: Message }) => void;
  /** The whole answer so far. */
  text: (full: string) => void;
  /** The connection was lost and another attempt follows. */
  lost?: (attempt: number) => void;
};

/** Open a turn's event stream once and read it to its end. */
export async function readTurn(open: () => Promise<Response>, signal: AbortSignal, on: StreamHandlers): Promise<StreamEnd> {
  let res: Response;
  try {
    res = await open();
  } catch (e) {
    return signal.aborted ? { kind: "left" } : { kind: "lost", error: (e as Error).message || "network error" };
  }
  if (!res.ok || !res.headers.get("content-type")?.startsWith("text/event-stream")) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    const error = j.error ?? `HTTP ${res.status}`;
    // A gateway between the page and the service failing is the network's doing, not the service's refusal.
    return res.status >= 500 ? { kind: "lost", error } : { kind: "refused", status: res.status, error };
  }
  let text = "";
  let final: Final | null = null;
  try {
    for await (const ev of readSse(res.body!)) {
      if (ev.event === "start") {
        text = "";
        on.start?.(JSON.parse(ev.data) as { user?: Message });
      } else if (ev.event === "delta") {
        text += (JSON.parse(ev.data) as { text: string }).text;
        on.text(text);
      } else if (ev.event === "done" || ev.event === "error") final = JSON.parse(ev.data) as Final;
    }
  } catch (e) {
    return signal.aborted ? { kind: "left" } : { kind: "lost", error: (e as Error).message || "network error" };
  }
  if (final) return { kind: "final", final };
  return signal.aborted ? { kind: "left" } : { kind: "lost", error: "the stream ended without an answer" };
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Follow a turn to its end, opening the stream again after each loss: the
 * same request (it carries the turn's request id, so the service joins the
 * turn it already has) or the thread's running turn. Gives up after
 * `delays.length` further attempts and reports the loss.
 */
export async function followTurn(open: () => Promise<Response>, signal: AbortSignal, on: StreamHandlers, delays: number[] = [1_000, 2_500, 5_000], sleep = wait): Promise<StreamEnd> {
  for (let attempt = 0; ; attempt++) {
    const end = await readTurn(open, signal, on);
    if (end.kind !== "lost" || attempt >= delays.length) return end;
    on.lost?.(attempt + 1);
    await sleep(delays[attempt]!, signal);
    if (signal.aborted) return { kind: "left" };
  }
}
