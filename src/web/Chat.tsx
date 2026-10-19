import { mdHtml, BARE_URL, trimUrl } from "./chat-markdown.ts";
import { readChatImages, imageURL, type ChatImage } from "./chat-images.ts";
import { ChatSteps, submitsChat, type ChatStep } from "./chat-steps.ts";
import { browserZone } from "./shortcuts.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { agentBase, type AgentInfo, type ChatSession, getJson, isImgIcon, relTime, type ChatRun } from "./api.ts";
import { queuedChatTurn, type QueuedChatTurn } from "./chat-request.ts";
import { localized, useLang } from "./i18n.ts";

// Chat window (a floating panel). The server streams the runtime's stream-json events over SSE.
// - Every turn is a background run on the server (docs/panel.md#chat): closing or refreshing the page
//   does not stop it. On load, each agent's running or recently ended run is restored and followed.
// - Mounted permanently (closing only slides it away) so conversations and session ids survive.
// - Conversations are keyed by agent id and run in parallel: each has its own queue and in-flight turn;
//   the bookmark bar on the left switches between them, a busy one shows a pulsing dot.
// - Text and tool events render independently, in order, without collapsing repeated tools.
// - A message sent while a turn runs goes into that turn (docs/runtimes.md#live-chat): the agent reads
//   it after its current step. A runtime that cannot take it (no live chat, or the turn just ended)
//   gets it queued in the page and sent next, in order. ⏹ stops the current run.
// - An action the permission tier does not cover waits for the person: an approval card in the reply.
// - Model and write-permission tier are picked in the header and remembered in localStorage.

// User messages render as text; URLs inside become links without HTML injection.
const linkNodes = (text: string) =>
  String(text)
    .split(new RegExp(`(${BARE_URL.source})`))
    .map((part, i) =>
      i % 2 ? (
        <a key={i} href={trimUrl(part)} target="_blank" rel="noopener noreferrer">
          {part}
        </a>
      ) : (
        part
      ),
    );

type Tool = { name: string; hint: string };
const toolHint = (input: Record<string, unknown> = {}) => {
  const v = input.command || input.file_path || input.pattern || input.url || input.path || input.query || "";
  return String(v).replace(/\s+/g, " ").slice(0, 42);
};

const Ava = ({ icon, fallback = "✨" }: { icon?: string; fallback?: string }) => (isImgIcon(icon) ? <img src={icon} alt="" /> : <>{icon || fallback}</>);

type Msg = { role: "user"; text: string; images?: ChatImage[] } | { role: "ai"; text: string; tools: Tool[]; denied: string[]; steps?: ChatStep[]; note?: string; status?: string | null; live?: boolean; pending?: string[] };
type Conv = { agent: AgentInfo | null; msgs: Msg[]; sid: string | null; busy: boolean; queued: number };
const EMPTY_CONV: Conv = { agent: null, msgs: [], sid: null, busy: false, queued: 0 };
/** The turn a conversation is following: its run (once the server named it) and the stream's abort. */
type Active = { ctrl: AbortController; typer: { target: string }; base: string; runId: string | null; stopRequested: boolean };
type Runner = { queue: QueuedChatTurn[]; running: boolean; active: Active | null };
type TurnSource = { kind: "new"; turn: QueuedChatTurn } | { kind: "attach"; runId: string };
const RECONNECT_TRIES = 5;
/** Runs that ended this long ago (seconds) still come back after a page load. */
const RESTORE_RECENT_S = 1800;

/** Stop a run on the server; before the server has named it, the stop is sent as soon as it does. */
async function stopRun(a: Active): Promise<void> {
  if (!a.runId) {
    a.stopRequested = true;
    return;
  }
  await fetch(`${a.base}/runs/${encodeURIComponent(a.runId)}/stop`, { method: "POST" }).catch(() => {});
}

/** A question from the home screen's box; a new `id` sends `text` once. */
export type Ask = { id: number; text: string; intentId?: string };

export default function Chat({ open, agent, agents = [], onClose, onSwitch, ask, onTurnSettled }: { open: boolean; agent: AgentInfo; agents?: AgentInfo[]; onClose: () => void; onSwitch?: (a: AgentInfo) => void; ask?: Ask | null; onTurnSettled?: () => void }) {
  const { lang, t } = useLang();
  // Status lines are written into the message state while a turn streams, so they read `t` through a
  // ref: a language change mid-turn applies from the next status on.
  const tRef = useRef(t);
  tRef.current = t;
  const settledRef = useRef(onTurnSettled);
  settledRef.current = onTurnSettled;
  const [convs, setConvs] = useState<Record<string, Conv>>({});
  const [input, setInput] = useState("");
  const [imageDrafts, setImageDrafts] = useState<Record<string, ChatImage[]>>({});
  const [imageError, setImageError] = useState("");
  const [readingImages, setReadingImages] = useState(false);
  const readingImagesRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [stick, setStick] = useState(true); // stick to the bottom unless the user scrolled up
  const [model, setModel] = useState(localStorage.getItem("chat-model") || "");
  const [baseChoices, setBaseChoices] = useState<Record<string, string>>({});
  const choicesRef = useRef<Record<string, string>>({});
  const baseChoice = (id: string) => choicesRef.current[id] ?? localStorage.getItem(`chat-base-model:${id}`) ?? "";
  const saveBaseChoice = (id: string, value: string) => {
    choicesRef.current[id] = value;
    setBaseChoices({ ...choicesRef.current });
    localStorage.setItem(`chat-base-model:${id}`, value);
  };
  const [perm, setPerm] = useState(localStorage.getItem("chat-perm") || ""); // '' read-only | acceptEdits | bypassPermissions
  const [hist, setHist] = useState<ChatSession[] | null>(null); // null = history panel closed
  const modelRef = useRef(model);
  const permRef = useRef(perm);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    permRef.current = perm;
  }, [perm]);
  const convsRef = useRef(convs);
  useEffect(() => {
    convsRef.current = convs;
  }, [convs]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input || !open) return;
    const resize = () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(160, input.scrollHeight + 2)}px`;
    };
    resize();
    let width = input.clientWidth;
    const observer = new ResizeObserver(() => {
      if (input.clientWidth !== width) { width = input.clientWidth; resize(); }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, [input, open]);
  const runnersRef = useRef<Record<string, Runner>>({});
  const runner = (k: string): Runner => (runnersRef.current[k] ||= { queue: [], running: false, active: null });

  const key = agent.id;
  const images = imageDrafts[key] ?? [];
  const addImages = async (files: File[]) => {
    if (!files.length || readingImagesRef.current) return;
    readingImagesRef.current = true;
    setReadingImages(true);
    setImageError("");
    try {
      const next = await readChatImages(files, images);
      setImageDrafts((drafts) => ({ ...drafts, [key]: next }));
    } catch { setImageError(t("chat.imageError")); }
    finally { readingImagesRef.current = false; setReadingImages(false); }
  };
  const conv = convs[key] || EMPTY_CONV;
  const patch = (k: string, fn: (v: Conv) => Conv) => setConvs((c) => ({ ...c, [k]: fn(c[k] || { ...EMPTY_CONV }) }));
  const base = agentBase(agent);
  const selectedBaseModel = baseChoices[key] ?? baseChoice(key);
  const pickBaseModel = (value: string) => {
    const previousRuntime = (selectedBaseModel || agent.runtime).split("/")[0];
    const nextRuntime = (value || agent.runtime).split("/")[0];
    if (previousRuntime !== nextRuntime) {
      patch(key, (v) => ({ ...v, msgs: [], sid: null }));
      setHist(null);
    }
    saveBaseChoice(key, value);
  };

  useEffect(() => {
    patch(key, (v) => ({ ...v, agent }));
  }, [agent]);

  useEffect(() => {
    setHist(null);
    setStick(true);
    inputRef.current?.focus();
  }, [key]);

  useEffect(() => {
    if (stick) bodyRef.current?.scrollTo(0, 1e9);
  }, [conv.msgs, stick]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (el) setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  };
  const toLatest = () => {
    bodyRef.current?.scrollTo({ top: 1e9, behavior: "smooth" });
    setStick(true);
  };
  const pickModel = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setModel(e.target.value);
    modelRef.current = e.target.value;
    localStorage.setItem("chat-model", e.target.value);
  };
  const pickPerm = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPerm(e.target.value);
    permRef.current = e.target.value;
    localStorage.setItem("chat-perm", e.target.value);
  };

  // One turn: append an AI bubble to the agent's conversation and fill it from the run's SSE stream.
  // The turn is a background run on the server: a new one is started by POST /chat, a restored one
  // is attached by id. A dropped stream reattaches after the last event seen; only ⏹ stops the run.
  const runTurn = async (turnKey: string, chatBase: string, source: TurnSource) => {
    let aiIdx = -1;
    patch(turnKey, (v) => {
      aiIdx = v.msgs.length;
      return { ...v, msgs: [...v.msgs, { role: "ai", text: "", tools: [], denied: [], status: tRef.current(source.kind === "new" ? "chat.starting" : "chat.reconnecting"), live: true }] };
    });
    const upd = (fn: (m: Extract<Msg, { role: "ai" }>) => Msg) =>
      patch(turnKey, (v) => {
        const cur = v.msgs[aiIdx];
        if (aiIdx < 0 || !cur || cur.role !== "ai") return v;
        const m = v.msgs.slice();
        m[aiIdx] = fn(cur);
        return { ...v, msgs: m };
      });
    const typer = { target: "" };
    const steps = new ChatSteps();
    const setTarget = (text: string) => {
      typer.target = text;
      upd((x) => ({ ...x, text, status: null }));
    };
    const setNote = (note: string) => upd((x) => ({ ...x, note }));
    const ctrl = new AbortController();
    const active: Active = { ctrl, typer, base: chatBase, runId: source.kind === "attach" ? source.runId : null, stopRequested: false };
    runner(turnKey).active = active;
    const setSid = (sid: string) => patch(turnKey, (v) => ({ ...v, sid }));
    let acc = ""; // finished text of this turn (tool calls split it into several assistant messages)
    let streamed = ""; // delta of the current message
    let lastSeq = 0; // the run's last event seen, to reattach after it
    let finished = false; // the stream said "done"
    const seenTools = new Set<string>();
    const toolNames = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (ev: any) => {
      steps.apply(ev);
      const snapshot = steps.snapshot();
      upd((x) => ({ ...x, steps: snapshot }));
      if (ev.type === "steer") {
        // The agent read a message added to the turn: it is a step now, no longer waiting.
        upd((x) => {
          const pending = x.pending ?? [];
          const at = pending.findIndex((p) => p.trim() === String(ev.text ?? "").trim());
          return { ...x, pending: pending.filter((_, i) => i !== (at >= 0 ? at : 0)) };
        });
      } else if (ev.type === "approval_request") {
        upd((x) => ({ ...x, status: tRef.current("chat.waitingApproval") }));
      } else if (ev.type === "system" && ev.subtype === "init") {
        setSid(ev.session_id);
        upd((x) => ({ ...x, status: tRef.current("chat.thinkingModel", { model: ev.model || "claude" }) }));
      } else if (ev.type === "stream_event" && ev.event?.delta?.type === "text_delta") {
        streamed += ev.event.delta.text;
        setTarget(acc + streamed);
      } else if (ev.type === "assistant") {
        const blocks: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[] = ev.message?.content || [];
        const txt = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (txt) {
          acc += (acc ? "\n\n" : "") + txt;
          streamed = "";
          setTarget(acc);
        }
        for (const b of blocks)
          if (b.type === "tool_use" && b.id && !seenTools.has(b.id)) {
            seenTools.add(b.id);
            toolNames.set(b.id, b.name || "tool");
            upd((x) => ({ ...x, status: tRef.current("chat.running", { name: b.name || "tool" }), tools: [...x.tools, { name: b.name || "tool", hint: toolHint(b.input) }] }));
          }
      } else if (ev.type === "user") {
        // Tool results: a call the headless run was not allowed to make comes back as an error; show it.
        // The CLI words it as "requires approval" for commands and "permission … denied" for edits.
        for (const b of ev.message?.content || []) {
          if (b.type !== "tool_result" || !b.is_error) continue;
          const rtxt = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text || "").join(" ") : "";
          if (/requires approval|permission|granted|denied/i.test(rtxt)) {
            const name = toolNames.get(b.tool_use_id) || "tool";
            upd((x) => (x.denied.includes(name) ? x : { ...x, denied: [...x.denied, name] }));
          }
        }
      } else if (ev.type === "result") {
        if (ev.session_id) setSid(ev.session_id);
        if (ev.is_error) setNote(String(ev.result || ev.subtype || tRef.current("chat.wentWrong")));
      } else if (ev.type === "error") {
        const note = ev.status === "stopped" ? tRef.current("chat.interrupted") : `⚠️ ${ev.error}`;
        setNote(note);
      } else if (ev.type === "done") finished = true;
    };
    const open = async (): Promise<Response> => {
      if (!active.runId && source.kind === "new") {
        return fetch(`${chatBase}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...source.turn, sessionId: convsRef.current[turnKey]?.sid || undefined }),
          signal: ctrl.signal,
        });
      }
      return fetch(`${chatBase}/runs/${encodeURIComponent(active.runId!)}/events?after=${lastSeq}`, { signal: ctrl.signal });
    };
    let retries = 0;
    try {
      while (!finished) {
        let r: Response;
        try {
          r = await open();
        } catch (e) {
          // The network blinked before the stream opened: reattach to a run we know of, a few times.
          if ((e as Error).name === "AbortError" || !active.runId || retries >= RECONNECT_TRIES) throw e;
          retries++;
          upd((x) => ({ ...x, status: tRef.current("chat.reconnecting") }));
          await new Promise((res) => setTimeout(res, 1000 * retries));
          continue;
        }
        if (!r.ok || !r.body) {
          const j = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `HTTP ${r.status}`);
        }
        active.runId ||= r.headers.get("x-run-id");
        if (active.stopRequested) void stopRun(active);
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let seq: number | null = null;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            retries = 0;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const raw of lines) {
              if (raw.startsWith("id: ")) seq = Number(raw.slice(4));
              if (!raw.startsWith("data: ")) continue;
              let ev: unknown;
              try {
                ev = JSON.parse(raw.slice(6));
              } catch {
                continue;
              }
              if (seq !== null && Number.isFinite(seq)) {
                if (seq <= lastSeq) { seq = null; continue; }
                lastSeq = seq;
              }
              seq = null;
              handle(ev);
            }
          }
        } catch (e) {
          if ((e as Error).name === "AbortError" || !active.runId || retries >= RECONNECT_TRIES) throw e;
        }
        // Ended without "done": the connection dropped, the run goes on; reattach after the last event.
        if (!finished) {
          if (!active.runId || retries >= RECONNECT_TRIES) throw new Error(tRef.current("chat.streamLost"));
          retries++;
          upd((x) => ({ ...x, status: tRef.current("chat.reconnecting") }));
          await new Promise((res) => setTimeout(res, 500 * retries));
        }
      }
    } catch (e) {
      const err = e as Error;
      if (err.name === "AbortError") setNote(tRef.current("chat.detached"));
      else setNote(`⚠️ ${err.message || err}`);
    }
    steps.finish();
    const snapshot = steps.snapshot();
    if (!typer.target && !snapshot.length) typer.target = tRef.current("chat.noOutput");
    upd((x) => ({ ...x, text: typer.target, steps: snapshot, status: null, live: false, pending: [] }));
    if (runner(turnKey).active === active) runner(turnKey).active = null;
    settledRef.current?.();
  };

  const drain = async (k: string, chatBase: string, first?: TurnSource) => {
    const r = runner(k);
    if (r.running) return;
    r.running = true;
    patch(k, (v) => ({ ...v, busy: true }));
    if (first) await runTurn(k, chatBase, first);
    while (r.queue.length) {
      const turn = r.queue.shift()!;
      const queued = r.queue.length; // read before the lazy state update runs
      patch(k, (v) => ({ ...v, queued }));
      await runTurn(k, chatBase, { kind: "new", turn });
    }
    r.running = false;
    patch(k, (v) => ({ ...v, busy: false, queued: 0 }));
  };

  // After a page load: the latest run of each agent that is still going, or ended in the last half
  // hour, comes back as that agent's conversation: the session's earlier turns from its transcript,
  // the run's message, then its events replayed and followed live.
  const restoreRuns = async (list: AgentInfo[]) => {
    const peers = [...new Set(list.map((a) => a.peer).filter((p): p is string => !!p))];
    const sources = [undefined, ...peers];
    const found = await Promise.all(
      sources.map((peer) =>
        getJson<{ runs: ChatRun[] }>(`${peer ? `/api/peers/${encodeURIComponent(peer)}` : "/api"}/agents/runs?recent=${RESTORE_RECENT_S}`)
          .then((j) => j.runs.map((run) => ({ peer, run })))
          .catch(() => []),
      ),
    );
    const latest = new Map<string, { agent: AgentInfo; run: ChatRun }>();
    for (const { peer, run } of found.flat()) {
      const a = list.find((x) => (x.peer ?? undefined) === peer && `${x.app}/${x.name}` === run.agent);
      if (a && !latest.has(a.id)) latest.set(a.id, { agent: a, run }); // newest first
    }
    for (const { agent: a, run } of latest.values()) {
      const k = a.id;
      if (runner(k).running || convsRef.current[k]?.msgs.length) continue;
      const b = agentBase(a);
      let history: Msg[] = [];
      if (run.sessionId) {
        try {
          const j = await getJson<{ messages: ({ role: "user"; text: string; images?: ChatImage[] } | { role: "ai"; text: string; tools: Tool[] })[] }>(`${b}/sessions/${encodeURIComponent(run.sessionId)}`);
          history = j.messages.map((m) => (m.role === "ai" ? { denied: [], ...m } : m));
          // The transcript may already hold this turn: cut it at the run's own message.
          const last = history.findLastIndex((m) => m.role === "user");
          if (last >= 0 && history[last]!.text.trim() === run.message.trim()) history = history.slice(0, last);
        } catch {
          /* no transcript: the run alone */
        }
      }
      if (runner(k).running || convsRef.current[k]?.msgs.length) continue;
      patch(k, (v) => ({ ...v, agent: v.agent || a, msgs: [...history, { role: "user", text: run.message }], sid: run.sid ?? run.sessionId }));
      void drain(k, b, { kind: "attach", runId: run.id });
    }
  };
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !agents.length) return;
    restoredRef.current = true;
    void restoreRuns(agents);
  }, [agents]);

  const send = (text: string, intentId?: string, images?: ChatImage[]) => {
    patch(key, (v) => ({ ...v, agent: agent || v.agent, msgs: [...v.msgs, { role: "user", text, images }] }));
    runner(key).queue.push({ ...queuedChatTurn(agent, text, modelRef.current, baseChoice(key), permRef.current, intentId ? { intentId, timezone: browserZone() } : undefined), images });
    drain(key, base);
  };
  // A question from the box starts a new conversation, unless the current one is still working:
  // then it waits in that conversation's queue rather than stopping what runs.
  const askedRef = useRef(0);
  useEffect(() => {
    if (!ask || ask.id === askedRef.current) return;
    askedRef.current = ask.id;
    if (!runner(key).running) {
      patch(key, (v) => ({ ...v, msgs: [], sid: null }));
      setHist(null);
    }
    setStick(true);
    send(ask.text, ask.intentId);
  }, [ask]);

  const submit = () => {
    const text = input.trim();
    if ((!text && !images.length) || readingImagesRef.current) return;
    setInput("");
    setImageDrafts((drafts) => ({ ...drafts, [key]: [] }));
    setImageError("");
    setStick(true);
    const r = runner(key);
    if (r.active?.runId && !r.active.stopRequested && !r.queue.length) void steer(key, r.active, text, images);
    else send(text, undefined, images);
  };

  // A message for the running turn: shown in its reply as waiting until the agent reads it (a
  // `steer` event). A turn that cannot take it (runtime without live chat, the turn just ended)
  // gets it as the next message instead.
  const steer = async (k: string, a: Active, text: string, images: ChatImage[]) => {
    const label = text || `🖼 ×${images.length}`;
    const mark = (fn: (pending: string[]) => string[]) =>
      patch(k, (v) => {
        const at = v.msgs.findLastIndex((m) => m.role === "ai" && m.live);
        const cur = v.msgs[at];
        if (at < 0 || !cur || cur.role !== "ai") return v;
        const msgs = v.msgs.slice();
        msgs[at] = { ...cur, pending: fn(cur.pending ?? []) };
        return { ...v, msgs };
      });
    mark((p) => [...p, label]);
    let ok = false;
    try {
      const r = await fetch(`${a.base}/runs/${encodeURIComponent(a.runId!)}/steer`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text, images }) });
      ok = r.ok;
    } catch {
      /* network: send it as the next message */
    }
    if (ok) return;
    mark((p) => { const i = p.lastIndexOf(label); return i < 0 ? p : p.filter((_, j) => j !== i); });
    if (runner(k).active === a || runner(k).running) {
      patch(k, (v) => ({ ...v, msgs: [...v.msgs, { role: "user", text, images }] }));
      runner(k).queue.push({ ...queuedChatTurn(agent, text, modelRef.current, baseChoice(k), permRef.current), images });
      patch(k, (v) => ({ ...v, queued: runner(k).queue.length }));
      void drain(k, a.base);
    } else send(text, undefined, images);
  };

  // The person's answer to an approval card of the running turn; the run's stream then reports it.
  const answer = async (k: string, id: string, decision: "allow" | "deny"): Promise<string | null> => {
    const a = runner(k).active;
    if (!a?.runId) return t("chat.approval.failed", { error: "no run" });
    try {
      const r = await fetch(`${a.base}/runs/${encodeURIComponent(a.runId)}/approvals/${encodeURIComponent(id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
      if (r.ok) return null;
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      return t("chat.approval.failed", { error: j.error || `HTTP ${r.status}` });
    } catch (e) {
      return t("chat.approval.failed", { error: (e as Error).message });
    }
  };

  // ⏹ stops the run on the server; its stream then ends with the "stopped" error and "done".
  const stop = () => {
    const a = runner(key).active;
    if (a) void stopRun(a);
  };
  // Leaving a conversation (new one, a past session) stops its running turn and detaches.
  const leave = (k: string) => {
    const r = runner(k);
    r.queue = [];
    if (r.active) {
      void stopRun(r.active);
      r.active.ctrl.abort();
    }
  };

  const reset = () => {
    leave(key);
    patch(key, (v) => ({ ...v, msgs: [], sid: null }));
    setHist(null);
    inputRef.current?.focus();
  };

  // After a refusal: raise the tier the refused tool needs (commands need every permission, edits just
  // "edit files") and ask the agent to redo the refused step in the same session.
  const retryWithPerm = (denied: string[]) => {
    const v = denied.includes("Bash") || permRef.current === "acceptEdits" ? "bypassPermissions" : "acceptEdits";
    setPerm(v);
    permRef.current = v;
    localStorage.setItem("chat-perm", v);
    send(t("chat.retryMessage"));
  };

  const toggleHist = async () => {
    if (hist) return setHist(null);
    try {
      const j = await getJson<{ sessions: ChatSession[] }>(`${base}/sessions`);
      setHist(j.sessions);
    } catch {
      setHist([]);
    }
  };
  // Pick a past session: restore its transcript and resume it; without a transcript the session still resumes.
  const pickSession = async (s: ChatSession) => {
    setHist(null);
    if (agent.modelOptions) {
      const runtime = s.runtime ?? agent.runtime;
      const option = agent.modelOptions.find((o) => o.runtime === runtime && o.model === s.model);
      saveBaseChoice(key, option?.value ?? (s.model ? `${runtime}/${s.model}` : ""));
    }
    leave(key);
    let msgs: Msg[];
    try {
      const j = await getJson<{ messages: ({ role: "user"; text: string; images?: ChatImage[] } | { role: "ai"; text: string; tools: Tool[] })[] }>(`${base}/sessions/${encodeURIComponent(s.sid)}`);
      msgs = j.messages.map((m) => (m.role === "ai" ? { denied: [], ...m } : m));
    } catch (e) {
      msgs = [{ role: "ai", text: t("chat.transcriptUnavailable", { error: (e as Error).message }), tools: [], denied: [] }];
    }
    patch(key, (v) => ({ ...v, sid: s.sid, msgs }));
    setStick(true);
    inputRef.current?.focus();
  };

  const tabs = Object.entries(convs);
  const shown = localized(lang, agent);

  return (
    // Always mounted so conversations survive closing; the overlay is hidden, not removed.
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="chat" role="dialog" aria-label={shown.title}>
      {tabs.length > 1 && (
        <div className="chat-tabs">
          {tabs.map(([k, v]) => (
            <button
              key={k}
              className={`chat-tab ${k === key ? "on" : ""}`}
              title={v.agent ? localized(lang, v.agent).title : k}
              onClick={() => {
                if (k !== key && v.agent) onSwitch?.(v.agent);
              }}
            >
              <Ava icon={v.agent?.avatar} />
              {v.busy && <i className="tab-busy" />}
            </button>
          ))}
        </div>
      )}
      <div className="chat-main">
        <div className="chat-head">
          <div className="chat-head-top">
            <span className="chat-ava">
              <Ava icon={agent.avatar} />
            </span>
            <b>{shown.title}</b>
            <span className="chat-sub">{conv.busy ? `${t("chat.thinking")}${conv.queued ? t("chat.queued", { n: conv.queued }) : ""}` : conv.sid ? t("chat.inSession") : t("chat.newSession")}</span>
            {conv.busy && (
              <button className="chat-hbtn" title={t("chat.interrupt")} onClick={stop}>
                ⏹
              </button>
            )}
            <button className="chat-hbtn" title={t("chat.history")} onClick={toggleHist}>
              🕘
            </button>
            <button className="chat-hbtn" title={t("chat.newConversation")} onClick={reset}>
              ↺
            </button>
            <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="chat-opts">
            {agent.modelOptions ? (
              <select className="chat-model" value={selectedBaseModel} disabled={conv.busy} onChange={(e) => pickBaseModel(e.target.value)} title={t("chat.runtimeModelTitle")} aria-label={t("chat.runtimeModelTitle")}>
                <option value="">{t("chat.modelDefault")} · {agent.runtime}</option>
                {selectedBaseModel && !agent.modelOptions.some((o) => o.value === selectedBaseModel) && <option value={selectedBaseModel}>{selectedBaseModel}</option>}
                {[...new Set(agent.modelOptions.map((o) => o.runtime))].map((runtime) => (
                  <optgroup key={runtime} label={runtime}>
                    {agent.modelOptions!.filter((o) => o.runtime === runtime).map((o) => <option key={o.value} value={o.value}>{runtime} · {t(`modelTier.${o.tier}`)} · {o.model}</option>)}
                  </optgroup>
                ))}
              </select>
            ) : (
              <select className="chat-model" value={model} onChange={pickModel} title={t("chat.modelTitle")} aria-label={t("chat.modelTitle")}>
                <option value="">{t("chat.modelDefault")}</option>
                <option value="haiku">{t("chat.modelHaiku")}</option>
                <option value="sonnet">{t("chat.modelSonnet")}</option>
                <option value="opus">{t("chat.modelOpus")}</option>
                <option value="fable">{t("chat.modelFable")}</option>
              </select>
            )}
            <label className="chat-permission">{t("chat.permTitle")}
            <select className="chat-model" value={perm} onChange={pickPerm} title={t("chat.permTitle")} aria-label={t("chat.permTitle")}>
              <option value="">{t("chat.permRead")}</option>
              <option value="acceptEdits">{t("chat.permEdit")}</option>
              <option value="bypassPermissions">{t("chat.permAll")}</option>
            </select></label>
          </div>
          {hist && (
            <div className="chat-hist">
              {hist.length === 0 && <p className="hist-empty">{t("chat.noSessions")}</p>}
              {hist.map((s) => (
                <button key={s.sid} className="hist-item" onClick={() => pickSession(s)}>
                  <span className="hist-title">{s.title || t("chat.untitled")}</span>
                  <span className="hist-time">{relTime(s.ts, lang)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="chat-body" ref={bodyRef} onScroll={onScroll}>
          {conv.msgs.length === 0 && (
            <div className="chat-hello">
              <span className="hello-ava">
                <Ava icon={agent.avatar} />
              </span>
              <b>{shown.title}</b>
              <br />
              {shown.description || (agent.app === "space" ? t("chat.helloSpace") : agent.id)}
            </div>
          )}
          {conv.msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "ai" ? <>
                {m.steps?.length ? m.steps.map((step) => step.kind === "text" ?
                  <div key={step.id} className={`md ${step.state === "running" ? "live" : ""}`} dangerouslySetInnerHTML={{ __html: mdHtml(step.text) }} /> :
                  step.kind === "approval" ? <ApprovalStep key={step.id} step={step} onAnswer={m.live ? (decision) => answer(key, step.id.slice("approval:".length), decision) : undefined} /> :
                  step.kind === "steer" ? <div key={step.id} className="chat-steer"><b>↳ {t("chat.steerYou")}</b> {linkNodes(step.text)}</div> :
                  <WorkStep key={step.id} step={step} />
                ) : <>
                  {m.tools.map((tool, index) => <WorkStep key={index} step={{ id: String(index), kind: "tool", name: tool.name, text: tool.hint, output: "", state: "incomplete" }} />)}
                  <div className={`md ${m.live ? "live" : ""}`} dangerouslySetInnerHTML={{ __html: mdHtml(m.text) }} />
                </>}
                {m.pending?.map((p, j) => <div key={`pending:${j}`} className="chat-steer pending"><b>↳ {t("chat.steerYou")}</b> {linkNodes(p)} <small>· {t("chat.steerPending")}</small></div>)}
                {m.note && <div className="msg-note" role="status">{m.note}</div>}
              </> : <><div className="chat-images">{m.images?.map((image, i) => <a key={i} href={imageURL(image)} download={image.name}><img src={imageURL(image)} alt={image.name} /></a>)}</div>{linkNodes(m.text)}</>}
              {m.role === "ai" && m.denied.length > 0 && !m.steps?.some((step) => step.kind === "approval") && (
                <span className="msg-denied">
                  {t("chat.denied", { tools: m.denied.join(", ") })}
                  {!m.live && <button onClick={() => retryWithPerm(m.denied)}>{t("chat.grantRetry")}</button>}
                </span>
              )}
              {m.role === "ai" && m.live && m.status && <span className="msg-status">{m.status}</span>}
            </div>
          ))}
        </div>
        {!stick && conv.msgs.length > 0 && (
          <button className="chat-down" title={t("chat.latest")} onClick={toLatest}>
            ↓
          </button>
        )}
        {imageError && <div className="msg-note" role="alert">{imageError}</div>}
        {!!images.length && <div className="chat-images chat-image-drafts">{images.map((image, index) => <div key={index}>
          <img src={imageURL(image)} alt={image.name} />
          <button aria-label={t("chat.removeImage")} disabled={readingImages} onClick={() => setImageDrafts((drafts) => ({ ...drafts, [key]: images.filter((_, i) => i !== index) }))}>×</button>
        </div>)}</div>}
        <div className="chat-input" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={(e) => {
          if (e.dataTransfer.files.length) { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)); }
        }}>
          <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(e) => { void addImages(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <button className="chat-attach" title={t("chat.addImages")} aria-label={t("chat.addImages")} disabled={readingImages || images.length >= 4} onClick={() => fileRef.current?.click()}>＋</button>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            aria-label={t("chat.inputLabel")}
            placeholder={conv.busy ? t("chat.placeholderBusy") : t("chat.placeholder")}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.items).filter((item) => item.type.startsWith("image/")).flatMap((item) => { const file = item.getAsFile(); return file ? [file] : []; });
              if (files.length) { e.preventDefault(); void addImages(files); }
            }}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={() => { composingRef.current = false; }}
            onKeyDown={(e) => {
              if (submitsChat(e.key, e.shiftKey, composingRef.current || e.nativeEvent.isComposing, e.nativeEvent.keyCode)) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button className="chat-send" disabled={readingImages || (!input.trim() && !images.length)} onClick={submit}>
            ↑
          </button>
        </div>
      </div>
      </aside>
    </div>
  );
}

/** An action the agent waits on: what it wants to do, and the person's answer while the turn runs. */
function ApprovalStep({ step, onAnswer }: { step: ChatStep; onAnswer?: (decision: "allow" | "deny") => Promise<string | null> }) {
  const { t } = useLang();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const reply = async (decision: "allow" | "deny") => {
    setSending(true);
    setError("");
    const failed = await onAnswer!(decision);
    setSending(false);
    if (failed) setError(failed);
  };
  const waiting = step.state === "waiting" && !!onAnswer;
  return <section className={`chat-work chat-approval ${step.state}`} aria-label={step.name}>
    <div className="chat-work-head"><span className="chat-work-icon" aria-hidden="true">?</span><strong>{step.name}</strong><span className="chat-work-state">{t(`chat.step.${step.state}`)}</span></div>
    {step.text && <pre className="chat-work-input">{step.text}</pre>}
    {step.output && <p className="chat-approval-why">{step.output}</p>}
    {waiting && <div className="chat-approval-actions">
      <button className="primary" disabled={sending} onClick={() => void reply("allow")}>{t("chat.approval.allow")}</button>
      <button disabled={sending} onClick={() => void reply("deny")}>{t("chat.approval.deny")}</button>
    </div>}
    {error && <small role="alert">{error}</small>}
  </section>;
}

function WorkStep({ step }: { step: ChatStep }) {
  const { t } = useLang();
  const icon = /bash|exec|command/i.test(step.name) ? "⌘" : /read|edit|write|patch/i.test(step.name) ? "▤" : "⚙";
  return <section className={`chat-work ${step.state}`} aria-label={step.name}>
    <div className="chat-work-head"><span className="chat-work-icon" aria-hidden="true">{icon}</span><strong>{step.name}</strong><span className="chat-work-state">{t(`chat.step.${step.state}`)}</span></div>
    {step.text && <pre className="chat-work-input">{step.text}</pre>}
    {step.output && <details><summary>{t("chat.step.details")}</summary><pre>{step.output}</pre>{step.output.length >= 12000 && <small>{t("chat.step.truncated")}</small>}</details>}
  </section>;
}
