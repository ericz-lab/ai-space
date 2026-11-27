import { mdHtml, BARE_URL, trimUrl } from "./chat-markdown.ts";
import { readChatImages, imageURL, type ChatImage } from "./chat-images.ts";
import { applyJobs, ChatSteps, historySteps, ReplyActivity, stepGroups, submitsChat, type ChatJob, type ChatStep, type HistoryStep } from "./chat-steps.ts";
import { Glyph, JobsBadge, NoticeStep, ToolGroup, WorkStep } from "./ChatToolRow.tsx";
import { ApprovalStep, DelegationResult, DelegationStep, QuestionStep } from "./ChatWork.tsx";
import { historyBeforeRun, postAnswer, SseParser } from "./run-follow.ts";
import { parseResultHeader } from "../space/agents/delegation-view.ts";
import { cardApp, ChatCards, type ShownCard } from "./ChatCards.tsx";
import type { Card } from "../space/agents/cards.ts";
import { browserZone } from "./shortcuts.ts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type AgentGroup, conversationTabs, groupAgents, groupKeyOf, groupOf, preferredMachine, rememberMachine } from "./agent-groups.ts";
import { agentBase, type AgentInfo, type AppInfo, type ChatSession, getJson, isImgIcon, relTime, sendJson, type ChatRun, type MachineInventory } from "./api.ts";
import { ChoiceOption, SavedChoice } from "./model-choices.tsx";
import { chatPermOfTeam, queuedChatTurn, teamMemberOf, teamPermOfChat, type QueuedChatTurn, type TeamPermissionMember } from "./chat-request.ts";
import { localized, useLang } from "./i18n.ts";
import { PAGE, chatHref, withDraft } from "./panel-link.ts";

// Chat window (a floating panel). The server streams the runtime's stream-json events over SSE.
// - Every turn is a background run on the server (docs/panel.md#chat): closing or refreshing the page
//   does not stop it. On load, each agent's running or recently ended run is restored and followed.
// - Mounted permanently (closing only slides it away) so conversations and session ids survive.
// - Conversations are keyed by agent id and run in parallel: each has its own queue and in-flight turn;
//   the sidebar lists the agents (a busy one shows a pulsing dot) and the shown agent's recent sessions;
//   on a phone it gives way to the avatar bar and the history button.
// - Text and tool events render independently, in order; a turn being followed shows every call,
//   while a past session restored from its transcript folds each run of calls into one line.
// - A message sent while a turn runs goes into that turn (docs/runtimes.md#live-chat): the agent reads
//   it after its current step. A runtime that cannot take it (no live chat, or the turn just ended)
//   gets it queued in the page and sent next, in order. ⏹ stops the current run.
// - An action the permission tier does not cover waits for the person: an approval card in the reply.
// - Model and write-permission tier are picked in the header and remembered in localStorage.
// - Background work (docs/runtimes.md#background-work): one stream per space (`GET …/agents/watch`) says
//   when an agent starts a turn by itself to answer a background job's report; the conversation it
//   belongs to attaches to it like to any run. The same stream carries each conversation's job list:
//   the header's badge, and the end of a Monitor or background command row.
// - A turn started elsewhere on a shown session (an order's, a delegation's result) is followed too,
//   after the session's transcript up to it is read again; one that ended unseen reloads the transcript.
// - For a member of the team (docs/orders.md#team) the permission menu is the team's setting.

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

type Msg = { role: "user"; text: string; images?: ChatImage[] } | { role: "ai"; text: string; tools: Tool[]; denied: string[]; steps?: ChatStep[]; note?: string; status?: string | null; live?: boolean; pending?: string[]; historic?: boolean; background?: boolean; cards?: ShownCard[] };
type Conv = { agent: AgentInfo | null; msgs: Msg[]; sid: string | null; busy: boolean; queued: number; jobs?: ChatJob[] };
/** A message of a restored transcript; `steps` keeps the assistant's text and tool calls in order. */
type HistoryMessage = { role: "user"; text: string; images?: ChatImage[] } | { role: "ai"; text: string; tools: Tool[]; steps?: HistoryStep[]; cards?: Card[] };
const fromHistory = (m: HistoryMessage): Msg => {
  if (m.role === "user") return m;
  const { steps, cards, ...rest } = m;
  // A restored card has no token: it shows its items' state, read-only (docs/chat-cards.md).
  return { ...rest, denied: [], historic: true, ...(steps?.length ? { steps: historySteps(steps) } : {}), ...(cards?.length ? { cards: cards.map((card, index) => ({ card, index })) } : {}) };
};
const EMPTY_CONV: Conv = { agent: null, msgs: [], sid: null, busy: false, queued: 0 };
/** The turn a conversation is following: its run (once the server named it) and the stream's abort. */
type Active = { ctrl: AbortController; typer: { target: string }; base: string; runId: string | null; stopRequested: boolean; elsewhere?: boolean };
/** `attach`: runs the agent started by itself while a turn was being followed, followed next. */
type Runner = { queue: QueuedChatTurn[]; attach: { base: string; source: TurnSource }[]; running: boolean; active: Active | null };
/**
 * A turn to follow: a new message, or a run on the server (`background`: one the agent started by
 * itself; `elsewhere`: one started outside this window, an order's say, which leaving the
 * conversation detaches from without stopping).
 */
type TurnSource = { kind: "new"; turn: QueuedChatTurn } | { kind: "attach"; runId: string; background?: boolean; elsewhere?: boolean };
/** What `GET …/watch` sends (docs/runtimes.md#background-work). */
type WatchNews = { type: "run"; run: ChatRun } | { type: "jobs"; agent?: string; sessionId: string; jobs: ChatJob[] };
const RECONNECT_TRIES = 5;
/** Runs that ended this long ago (seconds) still come back after a page load. */
const RESTORE_RECENT_S = 1800;

/** Stop a run on the server; before the server has named it, the stop is sent as soon as it does. */
/** Rejects when the stop did not reach the server: the caller that shows it says so. */
async function stopRun(a: Active): Promise<void> {
  if (!a.runId) {
    a.stopRequested = true;
    return;
  }
  await fetch(`${a.base}/runs/${encodeURIComponent(a.runId)}/stop`, { method: "POST" }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); });
}

/** A question from the home screen's box; a new `id` sends `text` once. */
export type Ask = { id: number; text: string; intentId?: string };
/** Text from a link into the panel (panel-link.ts); a new `id` adds it to the message field, unsent. */
export type Draft = { id: number; text: string };

export default function Chat({ open, agent, agents = [], apps = [], onClose, onSwitch, newTab, session, ask, draft, onTurnSettled }: { open: boolean; agent: AgentInfo; agents?: AgentInfo[]; /** The panel's apps, for the icon and name heading a chat card. */ apps?: AppInfo[]; onClose: () => void; onSwitch?: (a: AgentInfo) => void; /** Shows the button that opens this chat as a page in a new tab. */ newTab?: boolean; /** A session of the agent to resume once shown (a chat page opened from a conversation). */ session?: string; ask?: Ask | null; draft?: Draft | null; onTurnSettled?: () => void }) {
  const { lang, t } = useLang();
  // Status lines are written into the message state while a turn streams, so they read `t` through a
  // ref: a language change mid-turn applies from the next status on.
  const tRef = useRef(t);
  tRef.current = t;
  const settledRef = useRef(onTurnSettled);
  settledRef.current = onTurnSettled;
  const [convs, setConvs] = useState<Record<string, Conv>>({});
  // What is being typed belongs to its agent, as the attached pictures do: switching agent neither
  // carries a half-written message over nor loses it.
  const [inputDrafts, setInputDrafts] = useState<Record<string, string>>({});
  const input = inputDrafts[agent.id] ?? "";
  const setInput = (next: string | ((cur: string) => string)) => setInputDrafts((d) => ({ ...d, [agent.id]: typeof next === "function" ? next(d[agent.id] ?? "") : next }));
  // Which conversations were told to stop, and one whose stop did not reach the Space.
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [stopFailed, setStopFailed] = useState("");
  const [recentFailed, setRecentFailed] = useState(false);
  const [histFailed, setHistFailed] = useState(false);
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
  const histRef = useRef(hist);
  histRef.current = hist;
  // The sidebar's recent sessions of the shown agent; refreshed when it changes and when a turn ends.
  const [recent, setRecent] = useState<ChatSession[] | null>(null);
  const modelRef = useRef(model);
  const permRef = useRef(perm);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);
  useEffect(() => {
    permRef.current = perm;
  }, [perm]);
  // A member of the team (docs/orders.md#team) has one permission, the team's: the turns orders and
  // delegations start use it, so for such an agent the menu shows it, a change writes the team, and
  // a message typed here is sent with it. Unreadable (a caller that is not the owner): the menu alone.
  const [team, setTeam] = useState<TeamPermissionMember[] | null>(null);
  const teamRef = useRef(team);
  teamRef.current = team;
  const [permError, setPermError] = useState("");
  useEffect(() => {
    if (!open) return;
    let live = true;
    getJson<{ members: TeamPermissionMember[] }>("/api/team").then((d) => { if (live) setTeam(d.members); }).catch(() => {});
    return () => { live = false; };
  }, [open]);
  /** The permission mode a turn of `a` is sent with: the team's for a member, else the menu's. */
  const turnPerm = (a: AgentInfo) => {
    const m = teamMemberOf(teamRef.current, a);
    return m ? chatPermOfTeam(m.permission) : permRef.current;
  };
  /** Write a member's permission to the team; false when the team refused it (the reason is shown). */
  const setMemberPerm = async (m: TeamPermissionMember, mode: string): Promise<boolean> => {
    try {
      const d = await sendJson<{ members: TeamPermissionMember[] }>("PUT", "/api/team", { members: [{ role: m.role, permission: teamPermOfChat(mode) }] });
      teamRef.current = d.members;
      setTeam(d.members);
      setPermError("");
      return true;
    } catch (e) {
      setPermError(tRef.current("chat.permTeamFailed", { error: (e as Error).message }));
      return false;
    }
  };
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
  const runner = (k: string): Runner => (runnersRef.current[k] ||= { queue: [], attach: [], running: false, active: null });

  const key = agent.id;
  // The same agent on several machines: one entry in the agents list, and a machine menu in the
  // header; each machine keeps its own conversation under its own id (agent-groups.ts).
  const groups = useMemo(() => groupAgents(agents), [agents]);
  const group: AgentGroup = groupOf(groups, agent) ?? { key: groupKeyOf(agent), primary: agent, machines: [agent] };
  const machines = group.machines.some((m) => m.id === agent.id) ? group.machines : [agent, ...group.machines];
  // Which agent CLIs each machine has, for the machine menu (docs/model-machines.md#inventory); read when there is a choice.
  const [inventory, setInventory] = useState<MachineInventory[]>([]);
  const several = machines.length > 1;
  useEffect(() => {
    if (!several || !open) return;
    let live = true;
    getJson<{ machines: MachineInventory[] }>("/api/model/inventory").then((d) => { if (live) setInventory(d.machines); }).catch(() => {});
    return () => { live = false; };
  }, [several, open, group.key]);
  const machineLabel = (m: AgentInfo) => {
    const row = inventory.find((r) => r.machine === (m.peer ?? ""));
    const clis = row?.clis.filter((c) => c.installed && c.signedIn !== false).map((c) => c.cli) ?? [];
    return `${m.peer ?? t("chat.thisMachine")}${clis.length ? ` · ${clis.join(", ")}` : ""}${m.stale ? ` (${t("chat.machineOffline")})` : ""}`;
  };
  const pickMachine = (peer: string) => {
    const m = machines.find((x) => (x.peer ?? "") === peer);
    if (!m || m.id === key || m.stale) return;
    rememberMachine(group.key, m.peer);
    onSwitch?.(m);
  };
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
      patch(key, (v) => ({ ...v, msgs: [], sid: null, jobs: undefined }));
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
    const m = teamMemberOf(teamRef.current, agent);
    if (m) return void setMemberPerm(m, e.target.value);
    setPerm(e.target.value);
    permRef.current = e.target.value;
    localStorage.setItem("chat-perm", e.target.value);
  };

  // One turn: append an AI bubble to the agent's conversation and fill it from the run's SSE stream.
  // The turn is a background run on the server: a new one is started by POST /chat, a restored one
  // is attached by id. A dropped stream reattaches after the last event seen; only ⏹ stops the run.
  const runTurn = async (turnKey: string, chatBase: string, source: TurnSource) => {
    let aiIdx = -1;
    const background = source.kind === "attach" && !!source.background;
    patch(turnKey, (v) => {
      aiIdx = v.msgs.length;
      return { ...v, msgs: [...v.msgs, { role: "ai", text: "", tools: [], denied: [], status: tRef.current(source.kind === "new" ? "chat.starting" : background ? "chat.backgroundReply" : "chat.reconnecting"), live: true, ...(background ? { background } : {}) }] };
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
    const activity = new ReplyActivity();
    const setTarget = (text: string) => {
      typer.target = text;
      upd((x) => ({ ...x, text }));
    };
    const setNote = (note: string) => upd((x) => ({ ...x, note }));
    const ctrl = new AbortController();
    const active: Active = { ctrl, typer, base: chatBase, runId: source.kind === "attach" ? source.runId : null, stopRequested: false, elsewhere: source.kind === "attach" && !!source.elsewhere };
    runner(turnKey).active = active;
    const setSid = (sid: string) => patch(turnKey, (v) => ({ ...v, sid }));
    let acc = ""; // finished text of this turn (tool calls split it into several assistant messages)
    let streamed = ""; // delta of the current message
    const parser = new SseParser(); // its lastSeq is the run's last event seen, to reattach after it
    let finished = false; // the stream said "done"
    const seenTools = new Set<string>();
    const toolNames = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = (ev: any) => {
      steps.apply(ev);
      const snapshot = steps.snapshot();
      upd((x) => ({ ...x, steps: snapshot }));
      const status = activity.next(ev, snapshot);
      if (status !== undefined) upd((x) => ({ ...x, status: status && (status.key === "chat.running" ? tRef.current(status.key, { name: status.name }) : tRef.current(status.key)) }));
      if (ev.type === "cards" && Array.isArray(ev.cards)) {
        // What a tool did, checked by ai-space (docs/chat-cards.md); the token lets this reply's cards act.
        const shown: ShownCard[] = ev.cards.map((card: Card, index: number) => ({ card, index, ...(typeof ev.token === "string" ? { token: ev.token } : {}) }));
        upd((x) => ({ ...x, cards: [...(x.cards ?? []), ...shown] }));
      } else if (ev.type === "steer") {
        // The agent read a message added to the turn: it is a step now, no longer waiting.
        upd((x) => {
          const pending = x.pending ?? [];
          const at = pending.findIndex((p) => p.trim() === String(ev.text ?? "").trim());
          return { ...x, pending: pending.filter((_, i) => i !== (at >= 0 ? at : 0)) };
        });
      } else if (ev.type === "approval_request") {
        upd((x) => ({ ...x, status: tRef.current(ev.questions?.length ? "chat.waitingAnswer" : "chat.waitingApproval") }));
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
            upd((x) => ({ ...x, tools: [...x.tools, { name: b.name || "tool", hint: toolHint(b.input) }] }));
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
      return fetch(`${chatBase}/runs/${encodeURIComponent(active.runId!)}/events?after=${parser.lastSeq}`, { signal: ctrl.signal });
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
        // This window's own turn: its news on the watch stream is not a turn started elsewhere.
        if (active.runId) attachedRef.current.add(active.runId);
        if (active.stopRequested) void stopRun(active).catch(() => {});
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        parser.reset();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            retries = 0;
            for (const ev of parser.push(dec.decode(value, { stream: true }))) handle(ev);
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
    while (r.queue.length || r.attach.length) {
      // A turn the agent started by itself runs now; the person's next message would wait for it anyway.
      const attach = r.attach.shift();
      if (attach) {
        await runTurn(k, attach.base, attach.source);
        continue;
      }
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
          const j = await getJson<{ messages: HistoryMessage[] }>(`${b}/sessions/${encodeURIComponent(run.sessionId)}`);
          history = j.messages.map(fromHistory);
          // The transcript may already hold this turn: cut it at the run's own message.
          history = historyBeforeRun(history, run.message);
        } catch {
          /* no transcript: the run alone */
        }
      }
      if (runner(k).running || convsRef.current[k]?.msgs.length) continue;
      attachedRef.current.add(run.id);
      // A turn the agent started by itself has no message of the person's; one that has ended is in the transcript already.
      if (run.trigger === "background") {
        patch(k, (v) => ({ ...v, agent: v.agent || a, msgs: history, sid: run.sid ?? run.sessionId }));
        if (run.status === "running") void drain(k, b, { kind: "attach", runId: run.id, background: true });
        continue;
      }
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

  // Background work: the runs agents start by themselves, and their conversations' jobs.
  const attachedRef = useRef(new Set<string>());
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const onNews = (peer: string | undefined, news: WatchNews) => {
    const agentId = news.type === "run" ? news.run.agent : news.agent;
    const candidates = [...agentsRef.current, ...Object.values(convsRef.current).flatMap((c) => (c.agent ? [c.agent] : []))];
    const a = candidates.find((x) => (x.peer ?? undefined) === peer && `${x.app}/${x.name}` === agentId);
    if (!a) return;
    const k = a.id;
    const conv = convsRef.current[k];
    if (!conv?.sid) return;
    if (news.type === "jobs") {
      if (news.sessionId !== conv.sid) return;
      patch(k, (v) => ({ ...v, jobs: news.jobs, msgs: v.msgs.map((m) => (m.role === "ai" && m.steps && !m.live ? { ...m, steps: applyJobs(m.steps, news.jobs) } : m)) }));
      return;
    }
    const run = news.run;
    const sid = conv.sid;
    if (run.sessionId !== sid && run.sid !== sid) return;
    if (attachedRef.current.has(run.id)) return;
    const b = agentBase(a);
    if (run.status !== "running") {
      // A turn on this conversation that started and ended without this window following it (its
      // start went by unseen): the transcript, which now holds it, replaces what is shown.
      if (runner(k).running) return;
      attachedRef.current.add(run.id);
      void readTranscript(b, sid).then((history) => {
        if (history && convsRef.current[k]?.sid === sid && !runner(k).running) patch(k, (v) => ({ ...v, msgs: history }));
      });
      return;
    }
    // A turn of the person's while this window follows one is this window's own (the session runs one turn at a time).
    if (run.trigger !== "background" && run.trigger !== "delegation" && runner(k).running) return;
    attachedRef.current.add(run.id);
    void followElsewhere(k, b, sid, run);
  };

  /** A session's transcript as messages; null when it cannot be read. */
  const readTranscript = async (b: string, sid: string): Promise<Msg[] | null> => {
    try {
      return (await getJson<{ messages: HistoryMessage[] }>(`${b}/sessions/${encodeURIComponent(sid)}`)).messages.map(fromHistory);
    } catch {
      return null;
    }
  };
  // A turn started elsewhere on an open conversation's session: an order's (docs/orders.md), the
  // agent answering a background job, or a delegation's result delivered to it
  // (docs/orders.md#the-result-comes-back). What is shown may be older than the session (a turn
  // came and went unseen), so the transcript up to the run's own message is read first, then the
  // run's message and its events. A turn the agent started by itself has no message to cut the
  // transcript at; it, and a turn arriving while this window follows another, goes after what is shown.
  const followElsewhere = async (k: string, b: string, sid: string, run: ChatRun) => {
    const background = run.trigger === "background";
    const source: TurnSource = { kind: "attach", runId: run.id, background, elsewhere: !background };
    const history = background || runner(k).running ? null : await readTranscript(b, sid);
    if (convsRef.current[k]?.sid !== sid) return; // the conversation moved on meanwhile
    const own: Msg[] = background ? [] : [{ role: "user", text: run.message }];
    if (history && !runner(k).running) patch(k, (v) => ({ ...v, msgs: [...historyBeforeRun(history, run.message), ...own] }));
    else patch(k, (v) => ({ ...v, msgs: [...v.msgs, ...own] }));
    if (runner(k).running) runner(k).attach.push({ base: b, source });
    else void drain(k, b, source);
  };
  const newsRef = useRef(onNews);
  newsRef.current = onNews;
  // One stream for this space's agents for as long as the page is open; a peer's agent shown in the
  // chat gets its own, through the peer route.
  useEffect(() => {
    const es = new EventSource("/api/agents/watch");
    es.onmessage = (e) => {
      try { newsRef.current(undefined, JSON.parse(e.data) as WatchNews); } catch { /* a frame we do not know */ }
    };
    return () => es.close();
  }, []);
  const shownPeer = agent.peer;
  useEffect(() => {
    if (!shownPeer || !open) return;
    const es = new EventSource(`${agentBase(agent)}/watch`);
    es.onmessage = (e) => {
      try { newsRef.current(shownPeer, JSON.parse(e.data) as WatchNews); } catch { /* a frame we do not know */ }
    };
    return () => es.close();
  }, [shownPeer, open, key]);

  const send = (text: string, intentId?: string, images?: ChatImage[]) => {
    patch(key, (v) => ({ ...v, agent: agent || v.agent, msgs: [...v.msgs, { role: "user", text, images }] }));
    runner(key).queue.push({ ...queuedChatTurn(agent, text, modelRef.current, baseChoice(key), turnPerm(agent), intentId ? { intentId, timezone: browserZone() } : undefined), images });
    drain(key, base);
  };
  // A question from the box starts a new conversation, unless the current one is still working:
  // then it waits in that conversation's queue rather than stopping what runs.
  const askedRef = useRef(0);
  useEffect(() => {
    if (!ask || ask.id === askedRef.current) return;
    askedRef.current = ask.id;
    if (!runner(key).running) {
      patch(key, (v) => ({ ...v, msgs: [], sid: null, jobs: undefined }));
      setHist(null);
    }
    setStick(true);
    send(ask.text, ask.intentId);
  }, [ask]);

  const draftedRef = useRef(0);
  useEffect(() => {
    if (!draft || draft.id === draftedRef.current) return;
    draftedRef.current = draft.id;
    setInput((cur) => withDraft(cur, draft.text));
    inputRef.current?.focus();
  }, [draft]);

  const submit = () => {
    const text = input.trim();
    if ((!text && !images.length) || readingImagesRef.current || agent.stale) return;
    setInput("");
    setImageDrafts((drafts) => ({ ...drafts, [key]: [] }));
    setImageError("");
    setStick(true);
    const r = runner(key);
    if (r.active?.runId && !r.active.stopRequested && !r.queue.length) void steer(key, r.active, text, images);
    else send(text, undefined, images);
  };

  // A message for the running turn: shown in its reply as waiting until the agent reads it (a
  // `steer` event). A turn that cannot take it (runtime without live chat or steering, the turn just ended)
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
      runner(k).queue.push({ ...queuedChatTurn(agent, text, modelRef.current, baseChoice(k), turnPerm(agent)), images });
      patch(k, (v) => ({ ...v, queued: runner(k).queue.length }));
      void drain(k, a.base);
    } else send(text, undefined, images);
  };

  // The person's answer to an approval or question card of the running turn; the run's stream then reports it.
  const answer = async (k: string, id: string, decision: "allow" | "deny", answers?: Record<string, string[]>): Promise<string | null> => {
    const a = runner(k).active;
    if (!a?.runId) return t("chat.approval.failed", { error: "no run" });
    const error = await postAnswer(a.base, a.runId, id, decision, answers);
    return error === null ? null : t("chat.approval.failed", { error });
  };

  // ⏹ stops the run on the server; its stream then ends with the "stopped" error and "done".
  const stop = () => {
    const a = runner(key).active;
    if (!a || stopping[key]) return;
    const k = key;
    setStopFailed("");
    setStopping((s) => ({ ...s, [k]: true }));
    stopRun(a).catch((e) => {
      setStopping((s) => ({ ...s, [k]: false }));
      setStopFailed(t("chat.stopFailed", { error: (e as Error).message }));
    });
  };
  useEffect(() => {
    if (conv.busy) return;
    setStopping((s) => (s[key] ? { ...s, [key]: false } : s));
    setStopFailed("");
  }, [conv.busy, key]);
  // Escape closes the window, as it does the Inbox, Tasks and Settings; what is typed stays for next time.
  useEffect(() => {
    if (!open || PAGE) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (histRef.current) return setHist(null);
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  // Leaving a conversation (new one, a past session) stops its running turn and detaches; a turn
  // started elsewhere (an order's) is only detached from: it is not this window's to stop.
  const leave = (k: string) => {
    const r = runner(k);
    r.queue = [];
    r.attach = [];
    if (r.active) {
      if (!r.active.elsewhere) void stopRun(r.active).catch(() => {});
      r.active.ctrl.abort();
    }
  };

  const reset = () => {
    leave(key);
    patch(key, (v) => ({ ...v, msgs: [], sid: null, jobs: undefined }));
    setHist(null);
    inputRef.current?.focus();
  };

  // After a refusal: raise the tier the refused tool needs (commands need every permission, edits just
  // "edit files") and ask the agent to redo the refused step in the same session.
  const retryWithPerm = async (denied: string[]) => {
    const v = denied.includes("Bash") || turnPerm(agent) === "acceptEdits" ? "bypassPermissions" : "acceptEdits";
    const m = teamMemberOf(teamRef.current, agent);
    if (m) {
      if (await setMemberPerm(m, v)) send(t("chat.retryMessage"));
      return;
    }
    setPerm(v);
    permRef.current = v;
    localStorage.setItem("chat-perm", v);
    send(t("chat.retryMessage"));
  };

  useEffect(() => {
    if (!open || conv.busy) return;
    let live = true;
    getJson<{ sessions: ChatSession[] }>(`${base}/sessions`)
      .then((j) => { if (live) { setRecent(j.sessions); setRecentFailed(false); } })
      .catch(() => { if (live) { setRecent((cur) => cur ?? []); setRecentFailed(true); } });
    return () => { live = false; };
  }, [open, key, base, conv.busy, conv.sid]);

  const toggleHist = async () => {
    if (hist) return setHist(null);
    try {
      const j = await getJson<{ sessions: ChatSession[] }>(`${base}/sessions`);
      setHist(j.sessions);
      setHistFailed(false);
    } catch {
      setHist([]);
      setHistFailed(true);
    }
  };
  // Pick a past session: restore its transcript and resume it; without a transcript the session still resumes.
  const pickSession = async (s: ChatSession) => {
    setHist(null);
    // The conversation shown, with its turn followed: nothing to leave or load.
    if (s.sid === convsRef.current[key]?.sid && runner(key).running) return;
    if (agent.modelOptions) {
      const runtime = s.runtime ?? agent.runtime;
      const option = agent.modelOptions.find((o) => o.runtime === runtime && o.model === s.model);
      saveBaseChoice(key, option?.value ?? (s.model ? `${runtime}/${s.model}` : ""));
    }
    leave(key);
    let msgs: Msg[];
    try {
      const j = await getJson<{ messages: HistoryMessage[] }>(`${base}/sessions/${encodeURIComponent(s.sid)}`);
      msgs = j.messages.map(fromHistory);
    } catch (e) {
      msgs = [{ role: "ai", text: t("chat.transcriptUnavailable", { error: (e as Error).message }), tools: [], denied: [] }];
    }
    // Restored after a page load meanwhile (`restoreRuns`): it is followed already.
    if (s.sid === convsRef.current[key]?.sid && runner(key).running) return;
    // A turn running on the session (an order's, one in another window): the transcript up to it,
    // then the run followed, so the turn is shown once.
    const run = await getJson<{ runs: ChatRun[] }>(`${base}/runs?recent=0`)
      .then((j) => j.runs.find((r) => r.status === "running" && (r.sessionId === s.sid || r.sid === s.sid) && !attachedRef.current.has(r.id)))
      .catch(() => undefined);
    if (run && !runner(key).running) {
      attachedRef.current.add(run.id);
      const background = run.trigger === "background";
      patch(key, (v) => ({ ...v, sid: s.sid, msgs: [...historyBeforeRun(msgs, run.message), ...(background ? [] : [{ role: "user" as const, text: run.message }])], jobs: undefined }));
      void drain(key, base, { kind: "attach", runId: run.id, background, elsewhere: !background });
    } else patch(key, (v) => ({ ...v, sid: s.sid, msgs, jobs: undefined }));
    setStick(true);
    inputRef.current?.focus();
  };

  // A chat page opened from a conversation (panel-link.ts `chatHref`) resumes it, once.
  const resumed = useRef(false);
  useEffect(() => {
    if (!session || resumed.current) return;
    resumed.current = true;
    getJson<{ sessions: ChatSession[] }>(`${base}/sessions`)
      .then((j) => { const s = j.sessions.find((x) => x.sid === session); if (s) void pickSession(s); })
      .catch(() => {});
  }, [session]);

  const tabs = Object.entries(convs);
  // Every agent the sidebar can switch to, once whatever the machines: the catalogue, plus any open
  // conversation's agent outside it.
  const sideGroups = [...groups];
  for (const [, v] of tabs) if (v.agent && !groupOf(sideGroups, v.agent)) sideGroups.push({ key: groupKeyOf(v.agent), primary: v.agent, machines: [v.agent] });
  // The phone's avatar bar: the open conversations, one avatar per agent like the sidebar, the shown
  // agent's always among them (agent-groups.ts).
  const avatars = conversationTabs(tabs.flatMap(([, v]) => (v.agent ? [v.agent] : [])), agent);
  const shown = localized(lang, agent);
  const member = teamMemberOf(team, agent);

  return (
    // Always mounted so conversations survive closing; the overlay is hidden, not removed.
    <div className={`overlay${open ? "" : " off"}`} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="chat" role="dialog" aria-label={shown.title}>
      {/* Shown on a phone only (styles.css), and there always, a single conversation too: the agent's
          icon shows nowhere else on a phone. */}
      <div className="chat-tabs">
        {avatars.map((tab) => (
          <button
            key={tab.key}
            className={`chat-tab ${tab.key === group.key ? "on" : ""}`}
            title={`${localized(lang, tab.agent).title}${tab.agent.peer ? ` · ${tab.agent.peer}` : ""}`}
            aria-current={tab.key === group.key ? "true" : undefined}
            onClick={() => {
              if (tab.key !== group.key) onSwitch?.(tab.agent);
            }}
          >
            <Ava icon={tab.agent.avatar} />
            {tab.ids.some((id) => convs[id]?.busy) && <i className="tab-busy" />}
          </button>
        ))}
      </div>
      <nav className="chat-side" aria-label={t("chat.recent")}>
        <button className="chat-new" onClick={reset}>
          <Glyph name="compose" size={15} weight={1.3} />
          {t("chat.newConversation")}
        </button>
        {sideGroups.length > 1 && (
          <>
            <p className="chat-side-head">{t("chat.agents")}</p>
            <div className="chat-side-agents">
              {sideGroups.map((g) => (
                <button key={g.key} className={`chat-side-item${g.key === group.key ? " on" : ""}`} aria-current={g.key === group.key ? "true" : undefined} onClick={() => { if (g.key !== group.key) onSwitch?.(preferredMachine(g)); }}>
                  <span className="chat-side-ava"><Ava icon={g.primary.avatar} /></span>
                  <span className="chat-side-title">{localized(lang, g.primary).title}</span>
                  {g.machines.some((m) => convs[m.id]?.busy) && <i className="side-busy" aria-label={t("chat.thinking")} />}
                </button>
              ))}
            </div>
          </>
        )}
        <p className="chat-side-head">{t("chat.recent")}</p>
        <div className="chat-side-sessions">
          {recent?.length === 0 && <p className="hist-empty">{t(recentFailed ? "chat.sessionsFailed" : "chat.noSessions")}</p>}
          {recent?.map((s) => (
            <button key={s.sid} className={`chat-side-item${s.sid === conv.sid ? " on" : ""}`} title={s.title || t("chat.untitled")} onClick={() => pickSession(s)}>
              <span className="chat-side-title">{s.title || t("chat.untitled")}</span>
              <span className="hist-time">{relTime(s.ts, lang)}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="chat-main">
        <div className="chat-head">
          <div className="chat-head-top">
            <span className="chat-ava">
              <Ava icon={agent.avatar} />
            </span>
            {/* The name and the state: side by side, or one above the other on a phone (styles.css). */}
            <span className="chat-name">
              <b title={shown.title}>{shown.title}</b>
              <span className="chat-sub">{conv.busy ? `${t("chat.thinking")}${conv.queued ? t("chat.queued", { n: conv.queued }) : ""}` : conv.sid ? t("chat.inSession") : t("chat.newSession")}</span>
            </span>
            <JobsBadge jobs={conv.jobs ?? []} />
            {conv.busy && (
              <button className="chat-hbtn" title={t(stopping[key] ? "chat.stopping" : "chat.interrupt")} aria-label={t(stopping[key] ? "chat.stopping" : "chat.interrupt")} disabled={!!stopping[key]} aria-busy={!!stopping[key]} onClick={stop}>
                <Glyph name="stop" size={15} />
              </button>
            )}
            <button className={`chat-hbtn chat-narrow${hist ? " on" : ""}`} title={t("chat.history")} aria-label={t("chat.history")} aria-pressed={!!hist} onClick={toggleHist}>
              <Glyph name="history" size={16} weight={1.3} />
            </button>
            <button className="chat-hbtn chat-narrow" title={t("chat.newConversation")} aria-label={t("chat.newConversation")} onClick={reset}>
              <Glyph name="compose" size={16} weight={1.3} />
            </button>
            {newTab && (
              // The chat as a page of its own (docs/panel.md#built-in-pages), on this conversation; the floating one closes.
              <a className="chat-hbtn" href={chatHref(agent.id, conv.sid)} target="_blank" rel="noopener noreferrer" title={t("chat.openTab")} aria-label={t("chat.openTab")} onClick={onClose}>
                <Glyph name="popout" size={15} weight={1.3} />
              </a>
            )}
            <button className="chat-hbtn" title={t("common.close")} onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="chat-opts">
            {machines.length > 1 && (
              <label className="chat-permission">{t("chat.machine")}
              <select className="chat-model chat-machine" value={agent.peer ?? ""} onChange={(e) => pickMachine(e.target.value)} title={t("chat.machineTitle")} aria-label={t("chat.machineTitle")}>
                {machines.map((m) => <option key={m.id} value={m.peer ?? ""} disabled={m.stale && m.id !== agent.id}>{machineLabel(m)}</option>)}
              </select></label>
            )}
            {/* The model menu is named on a phone only, where the menus stand in rows under their names. */}
            <label className="chat-permission"><span className="chat-opt-name">{t("chat.model")}</span>
            {agent.modelOptions ? (
              <select className="chat-model" value={selectedBaseModel} disabled={conv.busy} onChange={(e) => pickBaseModel(e.target.value)} title={t("chat.runtimeModelTitle")} aria-label={t("chat.runtimeModelTitle")}>
                <option value="">{t("chat.modelDefault")} · {agent.runtime}</option>
                {selectedBaseModel && !agent.modelOptions.some((o) => o.value === selectedBaseModel) && <SavedChoice value={selectedBaseModel} t={t} />}
                {[...new Set(agent.modelOptions.map((o) => o.runtime))].map((runtime) => (
                  <optgroup key={runtime} label={runtime}>
                    {agent.modelOptions!.filter((o) => o.runtime === runtime).map((o) => <ChoiceOption key={o.value} o={o} label={`${runtime} · ${t(`modelTier.${o.tier}`)} · ${o.model}`} t={t} />)}
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
            )}</label>
            <label className="chat-permission">{t("chat.permTitle")}
            <select className="chat-model" value={member ? chatPermOfTeam(member.permission) : perm} onChange={pickPerm} title={member ? t("chat.permTeam") : t("chat.permTitle")} aria-label={t("chat.permTitle")}>
              <option value="">{t("chat.permRead")}</option>
              <option value="acceptEdits">{t("chat.permEdit")}</option>
              <option value="bypassPermissions">{t("chat.permAll")}</option>
            </select></label>
          </div>
          {member?.permission === "full" && <p className="chat-perm-warn">{t("orders.team.fullWarning", { name: (lang === "zh" && member.i18n?.zh?.title) || member.title })}</p>}
          {member && permError && <p className="chat-perm-warn">{permError}</p>}
          {hist && (
            <div className="chat-hist">
              {hist.length === 0 && <p className="hist-empty">{t(histFailed ? "chat.sessionsFailed" : "chat.noSessions")}</p>}
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
          {conv.msgs.map((m, i) => m.role === "user" && parseResultHeader(m.text) ? (
            // A delegation's result delivered into this conversation (docs/orders.md#the-result-comes-back): not a message of the person's.
            <div key={i} className="msg ai"><DelegationResult text={m.text} /></div>
          ) : (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "ai" ? <>
                {m.background && <div className="chat-bg-label"><Glyph name="notice" size={12} weight={1.3} />{t("chat.backgroundRun")}</div>}
                {m.steps?.length ? stepGroups(m.steps).map((step) => Array.isArray(step) ?
                  step.length > 1 && m.historic ?
                  <ToolGroup key={step[0]!.id} steps={step} folded /> :
                  <div key={step[0]!.id} className="chat-tools">{step.map((tool) => <WorkStep key={tool.id} step={tool} />)}</div> :
                  step.kind === "text" ?
                  <div key={step.id} className={`md ${step.state === "running" ? "live" : ""}`} dangerouslySetInnerHTML={{ __html: mdHtml(step.text) }} /> :
                  step.kind === "approval" && step.questions ? <QuestionStep key={step.id} step={step} onAnswer={m.live ? (answers) => answer(key, step.id.slice("approval:".length), answers ? "allow" : "deny", answers ?? undefined) : undefined} /> :
                  step.kind === "approval" ? <ApprovalStep key={step.id} step={step} onAnswer={m.live ? (decision) => answer(key, step.id.slice("approval:".length), decision) : undefined} /> :
                  step.kind === "notice" ? <NoticeStep key={step.id} step={step} /> :
                  step.kind === "delegation" ? <DelegationStep key={step.id} delegation={step.delegation} id={step.delegationId} /> :
                  parseResultHeader(step.text) ? <DelegationResult key={step.id} text={step.text} /> :
                  <div key={step.id} className="chat-steer"><b>↳ {t("chat.steerYou")}</b> {linkNodes(step.text)}</div>
                ) : <>
                  {m.tools.length > 0 && <div className="chat-tools">{m.tools.map((tool, index) => <WorkStep key={index} step={{ id: String(index), kind: "tool", name: tool.name, text: tool.hint, output: "", state: "incomplete" }} />)}</div>}
                  <div className={`md ${m.live ? "live" : ""}`} dangerouslySetInnerHTML={{ __html: mdHtml(m.text) }} />
                </>}
                {m.cards?.length ? <ChatCards cards={m.cards} apiBase={agent.peer ? `/api/peers/${encodeURIComponent(agent.peer)}` : "/api"} agent={`${agent.app}/${agent.name}`} app={cardApp(agent, apps, lang)} actionable={!conv.msgs.slice(i + 1).some((x) => x.role === "user")} /> : null}
                {m.pending?.map((p, j) => <div key={`pending:${j}`} className="chat-steer pending"><b>↳ {t("chat.steerYou")}</b> {linkNodes(p)} <small>· {t("chat.steerPending")}</small></div>)}
                {m.note && <div className="msg-note" role="status">{m.note}</div>}
              </> : <><div className="chat-images">{m.images?.map((image, i) => <a key={i} href={imageURL(image)} download={image.name}><img src={imageURL(image)} alt={image.name} /></a>)}</div>{linkNodes(m.text)}</>}
              {m.role === "ai" && m.denied.length > 0 && !m.steps?.some((step) => step.kind === "approval") && (
                <span className="msg-denied">
                  {t("chat.denied", { tools: m.denied.join(", ") })}
                  {!m.live && <button onClick={() => void retryWithPerm(m.denied)}>{t("chat.grantRetry")}</button>}
                </span>
              )}
              {m.role === "ai" && m.live && m.status && <span className="msg-status">{m.status}</span>}
            </div>
          ))}
        </div>
        {!stick && conv.msgs.length > 0 && (
          <button className="chat-down" title={t("chat.latest")} aria-label={t("chat.latest")} onClick={toLatest}>
            <Glyph name="down" size={18} weight={1.5} />
          </button>
        )}
        {imageError && <div className="msg-note" role="alert">{imageError}</div>}
        {stopFailed && <div className="msg-note" role="alert">{stopFailed}</div>}
        {agent.stale && <div className="msg-note" role="status">{t("chat.machineOfflineNote", { machine: agent.peer ?? t("chat.thisMachine") })}</div>}
        {!!images.length && <div className="chat-images chat-image-drafts">{images.map((image, index) => <div key={index}>
          <img src={imageURL(image)} alt={image.name} />
          <button aria-label={t("chat.removeImage")} disabled={readingImages} onClick={() => setImageDrafts((drafts) => ({ ...drafts, [key]: images.filter((_, i) => i !== index) }))}>×</button>
        </div>)}</div>}
        <div className="chat-input" onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }} onDrop={(e) => {
          if (e.dataTransfer.files.length) { e.preventDefault(); void addImages(Array.from(e.dataTransfer.files)); }
        }}>
          <input ref={fileRef} type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" multiple onChange={(e) => { void addImages(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <button className="chat-attach" title={t("chat.addImages")} aria-label={t("chat.addImages")} disabled={readingImages || images.length >= 4} onClick={() => fileRef.current?.click()}><Glyph name="attach" size={18} weight={1.3} /></button>
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            disabled={agent.stale}
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
          <button className="chat-send" title={t("chat.send")} aria-label={t("chat.send")} disabled={readingImages || agent.stale || (!input.trim() && !images.length)} onClick={submit}>
            <Glyph name="send" size={17} weight={1.9} />
          </button>
        </div>
      </div>
      </aside>
    </div>
  );
}
