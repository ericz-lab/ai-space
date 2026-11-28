import { useEffect, useRef, useState } from "react";
import { ChatSteps, type ChatStep } from "./chat-steps.ts";

/**
 * Following an agent's run from outside its chat window (docs/panel.md#chat): the run's events
 * as server-sent events (`GET <base>/runs/<id>/events?after=<seq>`, `id:` lines carry the seq,
 * `data:` lines one JSON event, `{"type":"done"}` last), read again after the last seq seen when
 * the connection drops. The chat window reads its streams with the same parser; the Orders page
 * follows the Director's and the delegates' runs with `useLiveRun`.
 */

/**
 * The event stream's lines to events. `lastSeq` outlives a connection, so a reconnect after it
 * skips what was already seen; `reset` starts the next connection's buffer.
 */
export class SseParser {
  lastSeq = 0;
  private buf = "";
  private seq: number | null = null;

  /** A new connection: whatever half line the last one left is dropped. */
  reset() {
    this.buf = "";
    this.seq = null;
  }

  /** The events a chunk of text completes, without those whose seq was seen already. */
  push(chunk: string): unknown[] {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    const out: unknown[] = [];
    for (const raw of lines) {
      if (raw.startsWith("id: ")) this.seq = Number(raw.slice(4));
      if (!raw.startsWith("data: ")) continue;
      let ev: unknown;
      try {
        ev = JSON.parse(raw.slice(6));
      } catch {
        continue;
      }
      if (this.seq !== null && Number.isFinite(this.seq)) {
        if (this.seq <= this.lastSeq) { this.seq = null; continue; }
        this.lastSeq = this.seq;
      }
      this.seq = null;
      out.push(ev);
    }
    return out;
  }
}

const RECONNECT_TRIES = 5;

/**
 * Follow a run until its `done` event: every event to `onEvent`, a dropped connection reattached
 * after the last seq up to five times in a row. Rejects when the run is unknown or the stream
 * cannot be had again; an abort rejects with an `AbortError`.
 */
export async function followRun(base: string, runId: string, onEvent: (ev: Record<string, unknown>) => void, signal?: AbortSignal): Promise<void> {
  const parser = new SseParser();
  let finished = false;
  let retries = 0;
  while (!finished) {
    let r: Response;
    try {
      r = await fetch(`${base}/runs/${encodeURIComponent(runId)}/events?after=${parser.lastSeq}`, { signal });
    } catch (e) {
      if ((e as Error).name === "AbortError" || retries >= RECONNECT_TRIES) throw e;
      retries++;
      await new Promise((res) => setTimeout(res, 1000 * retries));
      continue;
    }
    if (!r.ok || !r.body) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    parser.reset();
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        retries = 0;
        for (const ev of parser.push(dec.decode(value, { stream: true }))) {
          if (!ev || typeof ev !== "object") continue;
          onEvent(ev as Record<string, unknown>);
          if ((ev as { type?: unknown }).type === "done") finished = true;
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError" || retries >= RECONNECT_TRIES) throw e;
    }
    if (!finished) {
      if (retries >= RECONNECT_TRIES) throw new Error("the run's stream was lost");
      retries++;
      await new Promise((res) => setTimeout(res, 500 * retries));
    }
  }
}

/** Stop a running turn; rejects when the stop did not reach the Space. */
export async function stopRunAt(base: string, runId: string): Promise<void> {
  const r = await fetch(`${base}/runs/${encodeURIComponent(runId)}/stop`, { method: "POST" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

/** Answer a run's approval or question; null when it went through, else why not. */
export async function postAnswer(base: string, runId: string, requestId: string, decision: "allow" | "deny", answers?: Record<string, string[]>): Promise<string | null> {
  try {
    const r = await fetch(`${base}/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, ...(answers ? { answers } : {}) }) });
    if (r.ok) return null;
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return j.error || `HTTP ${r.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

/** The route base of `<app>/<agent>` on this Space, or on the peer `machine` names. */
export const agentPath = (agent: string, machine?: string | null) => {
  const [app = "", name = ""] = agent.split("/");
  return `${machine ? `/api/peers/${encodeURIComponent(machine)}` : "/api"}/agents/${encodeURIComponent(app)}/${encodeURIComponent(name)}`;
};

/**
 * A session's transcript up to a turn that is still running on it: the transcript is written as
 * the turn goes, so it may already hold the turn, from its own message on, and showing both would
 * show the turn twice. The cut is at the last of the person's messages that holds the run's message
 * (the runtime may have been given a note before it, docs/chat-cards.md); a transcript without it
 * is the history before the turn, whole. An empty message (a turn the agent started by itself) cuts nothing.
 */
export function historyBeforeRun<M extends { role: string; text: string }>(history: M[], message: string | null | undefined): M[] {
  const own = (message ?? "").trim();
  if (!own) return history;
  const at = history.findLastIndex((m) => m.role === "user" && m.text.includes(own));
  return at >= 0 ? history.slice(0, at) : history;
}

/** What `useLiveRun` knows of a run: its steps so far, whether it still runs, and its message (to cut a transcript at). */
export type LiveRun = { steps: ChatStep[]; live: boolean; message: string | null; error: string };

/**
 * Follow a run while `active` and it is running on the server (`GET <base>/runs/<id>` says so):
 * its events become `ChatSteps`. `onEnd` is called once when it ends while followed.
 */
export function useLiveRun(base: string | null, runId: string | null, active: boolean, onEnd?: () => void): LiveRun {
  const [state, setState] = useState<LiveRun>({ steps: [], live: false, message: null, error: "" });
  const endRef = useRef(onEnd);
  endRef.current = onEnd;
  useEffect(() => {
    setState({ steps: [], live: false, message: null, error: "" });
    if (!base || !runId || !active) return;
    const ctrl = new AbortController();
    let gone = false;
    (async () => {
      const r = await fetch(`${base}/runs/${encodeURIComponent(runId)}`, { signal: ctrl.signal });
      const j = (await r.json().catch(() => ({}))) as { run?: { status?: string; message?: string } };
      if (gone || j.run?.status !== "running") return;
      const steps = new ChatSteps();
      setState({ steps: [], live: true, message: j.run.message ?? null, error: "" });
      await followRun(base, runId, (ev) => {
        steps.apply(ev as Parameters<ChatSteps["apply"]>[0]);
        if (!gone) setState((s) => ({ ...s, steps: steps.snapshot() }));
      }, ctrl.signal);
      steps.finish();
      if (gone) return;
      setState((s) => ({ ...s, steps: steps.snapshot(), live: false }));
      endRef.current?.();
    })().catch((e) => {
      if (gone || (e as Error).name === "AbortError") return;
      setState((s) => ({ ...s, live: false, error: (e as Error).message || String(e) }));
    });
    return () => {
      gone = true;
      ctrl.abort();
    };
  }, [base, runId, active]);
  return state;
}
