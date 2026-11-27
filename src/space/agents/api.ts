import { chatBody, parseChatImages } from "./images.ts";
import { bearer, tokenEquals } from "../auth.ts";
import { intents } from "../shortcuts/resolve.ts";
import type { Action } from "../shortcuts/types.ts";
import { matchAgentIntents, parseAgentIntent, type AgentIntentView } from "../shortcuts/agent-intents.ts";
import { SYSTEM as INTERPRET_SYSTEM, buildPrompt as interpretPrompt, parseInterpretation, wantsInterpretation } from "../shortcuts/interpret.ts";
import type { ShortcutStore } from "../shortcuts/store.ts";
import { isTimezone } from "../shortcuts/time.ts";
import { skillContext } from "./skill-context.ts";
import { agentSkillsPrompt, resolveAgentSkills } from "../skills.ts";
import { Database } from "bun:sqlite";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppCapabilities } from "../bus/bus.ts";
import { capabilitiesPrompt } from "../bus/prompt.ts";
import { type IconPacks, applyToAgent } from "../panel/icons.ts";
import { type LayoutStore, orderBy } from "../panel/layout.ts";
import type { AppRegistry } from "../panel/registry.ts";
import { type AgentView, agentView } from "../panel/view.ts";
import type { PeerHub } from "../peers/hub.ts";
import type { RuntimeRegistry } from "../runtimes/registry.ts";
import { APPROVAL_DECISIONS, CHAT_EFFORTS, MODEL_TIERS, type ApprovalDecision, type ChatEffort, type QuestionAnswers, type RuntimeKind } from "../runtimes/types.ts";
import type { Manifest, ManifestAgent } from "../scheduler/manifest.ts";
import { loadAppEnv } from "../scheduler/targets.ts";
import type { Workspace } from "../workspace.ts";
import { MODEL_RE, SESSION_ID_RE, runResponse, watchResponse } from "./runtime.ts";
import { splitMachine } from "../runtimes/registry.ts";
import { RunBusyError, RunClosedError, RunRegistry, RunStateError } from "./runs.ts";
import type { SessionStore } from "./sessions.ts";
import { readTranscript } from "./transcript.ts";
import { CardBook, parseCard, parseItemStates, transcriptCards, withoutChangesNote } from "./cards.ts";
import { resolveLink } from "../panel/view.ts";
import { fixerSystemPrompt } from "../feedback/prompt.ts";
import { DIRECTOR_AGENT, ENGINEER_AGENT, type RosterMember, directorSystemPrompt, engineerSystemPrompt } from "../orders/prompt.ts";
import type { RunTokens } from "./delegations.ts";
import type { RunTrigger } from "./runs.ts";

/**
 * HTTP surface for agents, shaped as a Bun.serve `routes` table.
 *
 *   GET  /api/agents                              every agent of every visible app, plus the space's own (Space Assistant,
 *                                                 the Director, the Engineer, the Fix Engineer), then the peers' agents
 *   POST /api/agents/:app/:agent/chat             { message, sessionId?, model?, permissionMode?, effort?, interactive? } → SSE of a new background run (x-run-id)
 *   GET  /api/agents/runs?recent=<s>&agent=        runs newest first: running ones and those that ended in the last `recent` seconds
 *   GET  /api/agents/:app/:agent/runs              the agent's runs (same query)
 *   GET  /api/agents/:app/:agent/runs/:id          one run
 *   GET  /api/agents/:app/:agent/runs/:id/events?after=<seq>   SSE: replay after `seq`, then live
 *   POST /api/agents/:app/:agent/runs/:id/stop     stop a running turn
 *   POST /api/agents/:app/:agent/runs/:id/steer    { message, images? } add a message to a running interactive turn
 *   POST /api/agents/:app/:agent/runs/:id/approvals/:rid  { decision: allow|deny } answer the turn's approval request
 *   GET  /api/agents/watch                         SSE: the same as below, for every agent on this space
 *   GET  /api/agents/:app/:agent/watch             SSE: the agent's runs starting and ending (also those it starts by itself) and its conversations' background jobs
 *   GET  /api/agents/:app/:agent/sessions         recent sessions
 *   GET  /api/agents/:app/:agent/sessions/:sid    restored transcript; an `ai` message carries the `cards` of its tool outputs
 *   POST /api/shortcuts/interpret                 { text, timezone } → a basic-tier model's guess: one action with its form filled, or one agent intent; never runs
 *   POST /api/agents/cards/state                   { agent, card } → the card's items as its app answers them now (docs/chat-cards.md)
 *   POST /api/agents/cards/action                  { token, card, action, items? } → run a card's action, while its turn is the conversation's latest
 *
 * Like the panel routes these carry no bearer token; see docs/panel.md.
 */

export type AgentsApiOptions = {
  ws: Workspace;
  shortcuts?: ShortcutStore;
  actionCatalogue?: () => Action[];
  /**
   * One basic-tier model call for the command box's last layer (docs/shortcuts.md#model-interpretation):
   * the answer text, or undefined when the call failed. Absent, `/api/shortcuts/interpret` answers 503.
   */
  interpret?: (prompt: string, system: string, signal: AbortSignal) => Promise<string | undefined>;
  registry: AppRegistry;
  layout: LayoutStore;
  sessions: SessionStore;
  /** The configured runtimes; every agent may chat on any of them that can chat. */
  runtimes: RuntimeRegistry;
  /** Model when neither the request nor the manifest names one (SPACE_CHAT_MODEL). */
  defaultModel?: string;
  /** Live workspace preference: Space Assistant's default, and every agent's last fallback. */
  baseDefaultModel?: () => string;
  /**
   * An app's model layers that also pick its agents' model for a new chat: the panel's app-wide
   * override and the manifest's `model.default` (docs/panel.md#agent-models).
   */
  appModel?: (app: string) => { override?: string; manifest?: string };
  /** Provisioned variables for an app, merged into the session environment. */
  envFor?: (app: string) => Promise<Record<string, string>>;
  /** Hold installed code for the complete background turn, even after its browser disconnects. */
  holdApp?: (app: string) => Promise<(() => void) | undefined>;
  /** Home directory for transcripts; default: the process's. */
  home?: string;
  /** Other machines whose agents this panel lists; chat with them is forwarded by the peer routes. */
  peers?: PeerHub;
  /** The panel's icon packs: the active one's icons replace avatars and corner icons in the list. */
  icons?: IconPacks;
  /** The bus catalogue (local apps and peers'), appended to every agent's system prompt (docs/events.md). */
  capabilities?: () => (AppCapabilities & { peer?: string })[];
  /** ai-space's shared skills directory, for agents' `space:<skill>` references. */
  sharedSkills?: string;
  /**
   * Who is calling, for the routes an app may reach with its own token (docs/panel.md#apps-and-their-agents):
   * `null` for the owner (a session, a device, the operator token, or no gate at all), an app's name for its
   * token, `""` for any other credential. Absent: everyone is the owner.
   */
  callerApp?: (req: Request) => Promise<string | null>;
  /** Apps the operator lets reach every app's agents with their own token (SPACE_AGENT_CALLERS); not Space Assistant. */
  agentCallers?: readonly string[];
  /** Chat turns as background runs; default: a registry over an in-memory database. */
  runs?: RunRegistry;
  /** SSE keepalive interval (tests). */
  heartbeatMs?: number;
  /**
   * Call an app's capability as `space` (the bus), for the chat cards' state and actions
   * (docs/chat-cards.md); absent: cards are shown as they were printed and have no actions.
   */
  cardCall?: (app: string, capability: string, body: string) => Promise<{ status: number; body: string }>;
  /**
   * A built-in team member's model from its team row (docs/orders.md#team), by agent id (`space/director`,
   * `space/engineer`): a new conversation with it runs on this; absent or undefined, the default.
   */
  teamModel?: (agent: string) => string | null | undefined;
  /**
   * The run tokens of agents that may delegate (docs/orders.md#who-may-call): a turn of such an agent gets
   * `SPACE_RUN_TOKEN` and `SPACE_API_URL` (`apiUrl`) in its environment. Absent: no turn delegates.
   */
  runTokens?: RunTokens;
  /** This Space's API on loopback, for a turn's `space` commands (`http://127.0.0.1:8700`). */
  apiUrl?: string;
  /** The team, for the Director's prompt (its roles and summaries). */
  teamRoster?: () => RosterMember[];
};

/**
 * What the Director may run without an approval besides reading (Claude Code's allowed-tools syntax):
 * its own delegation commands. What a delegate may do is the delegate's permission setting.
 */
export const DIRECTOR_TOOLS = ["Bash(space delegate:*)"] as const;

/** The space's own agent: the default chat identity, working in the workspace root. */
export const SPACE_APP = "space";
export const SPACE_AGENT = "assistant";

export function spaceAgentView(runtimes?: RuntimeRegistry, defaultModel?: string): AgentView {
  return {
    id: `${SPACE_APP}/${SPACE_AGENT}`,
    app: SPACE_APP,
    name: SPACE_AGENT,
    title: "Space Assistant",
    description: "The workspace assistant: knows the apps, reads their manifests and files, helps operate the space.",
    i18n: { zh: { title: "空间助手", description: "工作区助手：了解各个应用，读取它们的清单和文件，协助运维这个空间。" } },
    avatar: "/assistant.svg",
    appIcon: "✨",
    runtime: runtimes ? baseRuntime(runtimes, defaultModel) : "claude",
    ...(runtimes ? { modelOptions: chatOptions(runtimes) } : {}),
  };
}

/**
 * The space's Fix Engineer (docs/feedback.md): fixes an app from feedback sent with the button on its
 * page. It works in the workspace root and changes one app's source checkout per run; the feedback
 * service starts it, and the person can chat with it like any agent.
 */
export const FIXER_AGENT = "ui-fixer";

export function fixerAgentView(runtimes?: RuntimeRegistry, defaultModel?: string): AgentView {
  return {
    id: `${SPACE_APP}/${FIXER_AGENT}`,
    app: SPACE_APP,
    name: FIXER_AGENT,
    title: "Fix Engineer",
    description: "Fixes apps from what people send with the Fix this button on their pages: changes only that app's source, runs its checks, deploys, and hands the result back for review.",
    i18n: { zh: { title: "修复工程师", description: "处理 app 页面上「随手改」按钮发来的问题：只改这个 app 的源码，跑检查、部署，再交回给你验收。" } },
    avatar: "/assistant.svg",
    appIcon: "🛠",
    runtime: runtimes ? baseRuntime(runtimes, defaultModel) : "claude",
    ...(runtimes ? { modelOptions: chatOptions(runtimes) } : {}),
  };
}

/**
 * The space's Director (docs/orders.md#the-built-in-director): takes every order, spoken or typed,
 * one conversation per topic. The orders service starts its turns; the person can chat with it too.
 */
export { DIRECTOR_AGENT };

export function directorAgentView(runtimes?: RuntimeRegistry, defaultModel?: string): AgentView {
  return {
    id: `${SPACE_APP}/${DIRECTOR_AGENT}`,
    app: SPACE_APP,
    name: DIRECTOR_AGENT,
    title: "Director",
    description: "Takes your orders, spoken or typed, one conversation per topic: answers, looks things up, records to-dos, and asks you when an order needs more.",
    i18n: { zh: { title: "总管", description: "接你的口谕（说的或打的），一个话题一个对话：回答、查资料、记待办，需要你拿主意时会问你。" } },
    avatar: "/assistant.svg",
    appIcon: "📜",
    runtime: runtimes ? baseRuntime(runtimes, defaultModel) : "claude",
    ...(runtimes ? { modelOptions: chatOptions(runtimes) } : {}),
  };
}

/**
 * The space's Engineer (docs/orders.md#built-in-members): changes an app's source in app-src/<app>/,
 * runs its checks and deploys it through the app's own channel, briefed by the Director.
 */
export { ENGINEER_AGENT };

export function engineerAgentView(runtimes?: RuntimeRegistry, defaultModel?: string): AgentView {
  return {
    id: `${SPACE_APP}/${ENGINEER_AGENT}`,
    app: SPACE_APP,
    name: ENGINEER_AGENT,
    title: "Engineer",
    description: "Changes an app's source in app-src/<app>/ as the Director briefs it, runs the app's checks and deploys it through the app's own channel.",
    i18n: { zh: { title: "工程师", description: "按总管的交代改一个 app 的源码（app-src/<app>/），跑它的检查，再按它自己的渠道部署。" } },
    avatar: "/assistant.svg",
    appIcon: "🧰",
    runtime: runtimes ? baseRuntime(runtimes, defaultModel) : "claude",
    ...(runtimes ? { modelOptions: chatOptions(runtimes) } : {}),
  };
}

/** The space's own agents, in the order the agent list shows them. */
export function builtinAgentViews(runtimes?: RuntimeRegistry, defaultModel?: string): AgentView[] {
  return [spaceAgentView(runtimes, defaultModel), directorAgentView(runtimes, defaultModel), engineerAgentView(runtimes, defaultModel), fixerAgentView(runtimes, defaultModel)];
}

/** The runtime/tier values any agent's chat may pick. */
function chatOptions(runtimes: RuntimeRegistry): NonNullable<AgentView["modelOptions"]> {
  return runtimes.tierOptions().filter((o) => o.capabilities.chat).map(({ value, runtime, tier, model, unavailable }) => ({ value, runtime, tier, model, ...(unavailable ? { unavailable } : {}) }));
}

function baseRuntime(runtimes: RuntimeRegistry, defaultModel?: string): string {
  if (defaultModel?.includes("/")) return defaultModel.split("/")[0]!;
  return runtimes.get("claude")?.capabilities.chat ? "claude" : runtimes.list().find((r) => r.capabilities.chat)?.name ?? runtimes.default?.name ?? runtimes.list()[0]!.name;
}

function spaceAgentPrompt(ws: Workspace): string {
  return [
    `You are the assistant of an ai-space workspace at ${ws.home}.`,
    "Apps live under apps/<name>/, each with a space.yaml manifest (spec in core/docs/app-spec.md when ai-space is deployed here). Runtime data is under data/<name>/. Answer questions about the space, inspect manifests and files, and help operate apps.",
    "Apps made inside this Space have their source in app-src/<name>/: change the files there and run `space app build <name>` to install the change (the app-studio skill says how). `space app create <name>` makes a new one from the template.",
    "Be honest: say when you cannot find or verify something instead of guessing.",
  ].join("\n");
}

type ResolvedAgent = {
  id: string;
  /** The manifest's declaration, for an app agent. */
  runtime?: string;
  model?: string;
  cwd: string;
  appDir?: string;
  systemPrompt?: string;
  tools: string[];
  app: string;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

const MAX_MESSAGE = 20_000;
const MAX_CONTEXT = 24_000;

/**
 * Whether a chat turn may carry images. Claude Code and Codex take them on every turn;
 * DeepSeek Harness only through its live ACP process, which advertises an image-capable route.
 */
export function supportsChatImages(kind: RuntimeKind, interactive: boolean): boolean {
  if (kind === "claude-code" || kind === "codex-cli") return true;
  return kind === "deepseek-harness" && interactive;
}

/**
 * The `callerApp` of a space: the owner (`null`) for no token, the operator's, the hub's (it arrives
 * through `/api/peer/agents/*`, already checked there, and acts for the hub's owner) or a device's;
 * else the app the token belongs to, or `""` for an unknown one.
 */
export async function callerAppOf(
  req: Request,
  opts: { operatorToken: string; hubToken: string; isDevice: (token: string) => boolean; appForToken: (token: string) => Promise<string | undefined> },
): Promise<string | null> {
  const t = bearer(req);
  if (!t || tokenEquals(t, opts.operatorToken) || tokenEquals(t, opts.hubToken) || opts.isDevice(t)) return null;
  return (await opts.appForToken(t)) ?? "";
}

export function createAgentRoutes(opts: AgentsApiOptions): Routes {
  const { registry, layout, sessions } = opts;
  const runs = opts.runs ?? new RunRegistry(new Database(":memory:"));
  /** The `recent` and `limit` query of a run listing. */
  const listQuery = (req: Request) => {
    const q = new URL(req.url).searchParams;
    const recent = Number(q.get("recent"));
    const limit = Number(q.get("limit"));
    return { ...(q.get("recent") !== null && Number.isFinite(recent) && recent >= 0 ? { recentMs: recent * 1000 } : {}), ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}) };
  };
  /** The run `:id` of the agent `:app/:agent`, or a 404. */
  const runOf = (req: Request & { params: Record<string, string> }) => {
    const run = runs.get(req.params.id ?? "");
    if (!run || run.agent !== `${req.params.app}/${req.params.agent}`) throw new NotFound(`unknown run: ${req.params.id}`);
    return run;
  };
  const baseDefault = () => opts.baseDefaultModel?.() ?? opts.defaultModel;
  /** The app an agent's cards belong to: an app on this space, never Space Assistant's. */
  const cardApp = (agent: string): string | null => {
    const app = agent.split("/")[0] ?? "";
    return app && app !== SPACE_APP && registry.get(app) ? app : null;
  };
  const cardLink = (app: string) => (url: string) => {
    const m = registry.get(app)?.manifest;
    return m ? resolveLink(m, url) : "";
  };
  const cards = new CardBook(runs, { appOf: cardApp, resolve: (app, url) => cardLink(app)(url) });
  /** One card call through the bus: the app's JSON answer, or an error response. */
  const callCard = async (app: string, capability: string, body: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; res: Response }> => {
    if (!opts.cardCall) return { ok: false, res: error(501, "cards cannot reach apps on this space") };
    let r: { status: number; body: string };
    try {
      r = await opts.cardCall(app, capability, JSON.stringify(body));
    } catch (e) {
      const status = typeof (e as { status?: unknown }).status === "number" ? (e as { status: number }).status : 502;
      return { ok: false, res: error(status, (e as Error).message) };
    }
    let data: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(r.body) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    if (r.status < 200 || r.status >= 300 || !data || data.ok === false) {
      return { ok: false, res: error(r.status >= 400 ? r.status : 502, typeof data?.error === "string" ? data.error : `${app}/${capability} answered ${r.status}`) };
    }
    return { ok: true, data };
  };

  /** `runtime/model` for a value: a bare tier on `tierRuntime`, another bare model on `runtime` (else the space's default runtime). */
  const qualify = (value: string | undefined, tierRuntime: string, runtime?: string): string | undefined => {
    if (!value || value.includes("/")) return value;
    const owner = (MODEL_TIERS as readonly string[]).includes(value) ? tierRuntime : runtime ?? opts.runtimes.default?.name;
    // No runtime for a bare model: left bare, so resolving it says which runtime to name.
    return owner ? `${owner}/${value}` : value;
  };
  /** A qualified value a chat can run: a configured runtime that chats, and a model it knows (a tier it lacks means its own default). */
  const chatRunnable = (value: string): boolean => {
    const name = value.slice(0, value.indexOf("/"));
    if (!opts.runtimes.get(name)?.capabilities.chat) return false;
    if ((MODEL_TIERS as readonly string[]).includes(value.slice(name.length + 1))) return true;
    try {
      opts.runtimes.resolve(value);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * What a new chat with an app agent runs on when the request names no model. First runnable wins:
   * the panel's override for the app, the agent's own `runtime`/`model`, the app's `model.default`,
   * then Space Assistant's default. A layer this space cannot chat on (a runtime it lacks or that is not
   * logged in as a chat runtime) falls through, as the app-model layers do for model calls.
   */
  const agentDefault = (app: string, agent: { runtime?: string; model?: string }): string => {
    const base = baseDefault();
    const baseRt = baseRuntime(opts.runtimes, base);
    const layers = opts.appModel?.(app);
    const declared = agent.model || agent.runtime ? qualify(agent.model ?? "intermediate", agent.runtime ?? baseRt, agent.runtime) : undefined;
    for (const value of [qualify(layers?.override, baseRt), declared, qualify(layers?.manifest, baseRt)]) if (value && chatRunnable(value)) return value;
    return base?.includes("/") ? base : `${baseRt}/${base && opts.runtimes.get(baseRt)?.kind === "claude-code" ? base : "intermediate"}`;
  };

  const wrap =
    (h: Handler): Handler =>
    async (req) => {
      try {
        // An app's token reaches only its own agents, or every app's when the operator lists it in SPACE_AGENT_CALLERS;
        // an agent route without `:app` stays the owner's.
        if (opts.callerApp) {
          const caller = await opts.callerApp(req);
          const target = req.params?.app;
          const granted = !!caller && !!target && target !== SPACE_APP && !!opts.agentCallers?.includes(caller);
          if (caller !== null && (!caller || (caller !== target && !granted))) return error(403, "an app may reach only its own agents");
        }
        return await h(req);
      } catch (e) {
        return e instanceof NotFound ? error(404, e.message) : error(400, (e as Error).message ?? String(e));
      }
    };

  const withCatalogue = (prompt: string | undefined, app: string): string | undefined => {
    const section = opts.capabilities ? capabilitiesPrompt(opts.capabilities(), { self: app, operator: app === SPACE_APP }) : undefined;
    return section ? [prompt, section].filter(Boolean).join("\n\n") : prompt;
  };

  const resolveAgent = async (app: string, name: string): Promise<ResolvedAgent> => {
    if (app === SPACE_APP && name === SPACE_AGENT) {
      return { id: `${SPACE_APP}/${SPACE_AGENT}`, runtime: baseRuntime(opts.runtimes, baseDefault()), cwd: opts.ws.home, systemPrompt: withCatalogue(spaceAgentPrompt(opts.ws), SPACE_APP), tools: [], app: SPACE_APP };
    }
    if (app === SPACE_APP && name === FIXER_AGENT) {
      const skillDir = opts.sharedSkills ? join(opts.sharedSkills, "app-fix") : undefined;
      const skill = skillDir ? await Bun.file(join(skillDir, "SKILL.md")).text().catch(() => "") : "";
      const prompt = [fixerSystemPrompt(opts.ws.home, skillDir ? join(skillDir, "scope.ts") : undefined), skill ? `--- The app-fix skill ---\n${skill.slice(0, MAX_CONTEXT)}` : ""].filter(Boolean).join("\n\n");
      return { id: `${SPACE_APP}/${FIXER_AGENT}`, runtime: baseRuntime(opts.runtimes, baseDefault()), cwd: opts.ws.home, systemPrompt: prompt, tools: [], app: SPACE_APP };
    }
    if (app === SPACE_APP && name === DIRECTOR_AGENT) {
      const model = opts.teamModel?.(`${SPACE_APP}/${DIRECTOR_AGENT}`) ?? undefined;
      return { id: `${SPACE_APP}/${DIRECTOR_AGENT}`, runtime: model?.includes("/") ? model.slice(0, model.indexOf("/")) : baseRuntime(opts.runtimes, baseDefault()), ...(model ? { model } : {}), cwd: opts.ws.home, systemPrompt: withCatalogue(directorSystemPrompt(opts.ws.home, opts.teamRoster?.() ?? []), SPACE_APP), tools: opts.runTokens ? [...DIRECTOR_TOOLS] : [], app: SPACE_APP };
    }
    if (app === SPACE_APP && name === ENGINEER_AGENT) {
      const model = opts.teamModel?.(`${SPACE_APP}/${ENGINEER_AGENT}`) ?? undefined;
      const skillDir = opts.sharedSkills ? join(opts.sharedSkills, "app-fix") : undefined;
      const skill = skillDir ? await Bun.file(join(skillDir, "SKILL.md")).text().catch(() => "") : "";
      const prompt = [engineerSystemPrompt(opts.ws.home, skillDir ? join(skillDir, "scope.ts") : undefined), skill ? `--- The app-fix skill (the procedure for changing an app; a brief from the Director replaces the Fix this request, and the RESULT line is optional) ---\n${skill.slice(0, MAX_CONTEXT)}` : ""].filter(Boolean).join("\n\n");
      return { id: `${SPACE_APP}/${ENGINEER_AGENT}`, runtime: model?.includes("/") ? model.slice(0, model.indexOf("/")) : baseRuntime(opts.runtimes, baseDefault()), ...(model ? { model } : {}), cwd: opts.ws.home, systemPrompt: withCatalogue(prompt, SPACE_APP), tools: [], app: SPACE_APP };
    }
    const entry = registry.get(app);
    const a = entry?.manifest.agents.find((x) => x.name === name);
    if (!entry || !a) throw new NotFound(`unknown agent: ${app}/${name}`);
    return {
      id: `${app}/${name}`,
      appDir: entry.manifest.dir,
      ...(a.runtime ? { runtime: a.runtime } : {}),
      ...(a.model ? { model: a.model } : {}),
      // The real path: the runtime files its transcripts under the directory it actually runs in,
      // and an app directory may be a symlink into the repository checkout.
      cwd: await realDir(resolve(entry.manifest.dir, a.cwd)),
      systemPrompt: [withCatalogue(await systemPromptFor(entry.manifest, a), app), agentSkillsPrompt(await resolveAgentSkills(a.skills, { app, appDir: entry.manifest.dir, ...(opts.sharedSkills ? { shared: opts.sharedSkills } : {}), appDirOf: (other) => registry.get(other)?.manifest.dir }))].filter(Boolean).join("\n\n"),
      tools: a.tools,
      app,
    };
  };

  const intentContext = async (agentId: string, skills: string[]) => {
    const [app, name] = agentId.split("/");
    const agent = await resolveAgent(app!, name!);
    if (!agent.appDir) throw new Error("Skill intents require an app agent");
    return skillContext(agent.appDir, skills);
  };

  const availableIntents = async (definitions = opts.shortcuts?.agentIntents() ?? []): Promise<AgentIntentView[]> => {
    return Promise.all(definitions.map(async (intent) => {
      try {
        await intentContext(intent.agent, intent.skills);
        return { ...intent, available: true };
      } catch (e) { return { ...intent, available: false, reason: (e as Error).message }; }
    }));
  };

  return {
    "/api/shortcuts/resolve": {
      POST: wrap(async (req) => {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.text !== "string" || body.text.length > 4000 || typeof body.timezone !== "string" || !isTimezone(body.timezone)) {
          return error(400, "Expected text (at most 4000 characters) and an IANA timezone");
        }
        const found = intents(body.text, opts.actionCatalogue?.() ?? [], body.timezone);
        const definitions = (opts.shortcuts?.agentIntents() ?? []).map((i) => ({ ...i, available: true }));
        // Precedence: arithmetic and conversions, then app action sentence patterns, then agent
        // intents, then keywords and names. A complete app pattern match leaves agents out.
        const direct = found.some((i) => i.kind === "calc" || i.kind === "convert" || (i.kind === "action" && i.pattern !== undefined));
        const matched = direct ? [] : matchAgentIntents(body.text, definitions);
        const agents = await availableIntents(matched);
        // Resolve precedence here, including unavailable agents: clients must never receive
        // an ordinary action as an implicit fallback for a matching skill intent.
        const selected = agents.length ? [] : found;
        return json({ ok: true, intents: selected, agentIntents: agents, ambiguous: agents.length ? agents.length > 1 : selected.some((i) => i.kind === "action" && i.ambiguous) });
      }),
    },
    "/api/shortcuts/interpret": {
      POST: wrap(async (req) => {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.text !== "string" || body.text.length > 4000 || typeof body.timezone !== "string" || !isTimezone(body.timezone)) {
          return error(400, "Expected text (at most 4000 characters) and an IANA timezone");
        }
        if (!opts.interpret) return error(503, "Model interpretation is unavailable");
        // Short text, arithmetic and conversions never reach the model.
        if (!wantsInterpretation(body.text)) return json({ ok: true, skipped: true, interpretation: null });
        const actions = opts.actionCatalogue?.() ?? [];
        const enabled = (opts.shortcuts?.agentIntents() ?? []).filter((i) => i.enabled).map((i) => ({ ...i, available: true }));
        const agents = (await availableIntents(enabled)).filter((i) => i.available);
        const now = Date.now();
        // The request's signal: a person who typed on cancels the call.
        const answer = await opts.interpret(interpretPrompt(body.text, actions, agents, body.timezone, now), INTERPRET_SYSTEM, req.signal);
        const found = answer === undefined ? null : parseInterpretation(answer, actions, agents, body.timezone, now);
        const interpretation = found?.kind === "agent" ? { kind: "agent", intent: agents.find((i) => i.id === found.id)! } : found;
        return json({ ok: true, skipped: false, interpretation, ...(answer === undefined ? { failed: true } : {}) });
      }),
    },
    "/api/shortcuts/agent-intents": {
      GET: wrap(async () => {
        return json({ ok: true, intents: await availableIntents() });
      }),
      POST: wrap(async (req) => {
        if (!opts.shortcuts) return error(503, "Agent intent storage is unavailable");
        const intent = parseAgentIntent(await req.json());
        // Disabling a removed agent's routing must remain possible.
        if (intent.enabled) await intentContext(intent.agent, intent.skills);
        opts.shortcuts.setAgentIntent(intent);
        return json({ ok: true, intent });
      }),
    },
    "/api/agents": {
      GET: async (req) => {
        const lay = layout.read();
        const hidden = new Set(lay.hidden);
        const agents: AgentView[] = builtinAgentViews(opts.runtimes, baseDefault());
        for (const { manifest } of registry.list()) {
          if (hidden.has(manifest.app) || manifest.status === "archived") continue;
          for (const a of manifest.agents) {
            const model = agentDefault(manifest.app, a);
            agents.push(agentView(manifest, a, { runtime: model.slice(0, model.indexOf("/")), modelOptions: chatOptions(opts.runtimes) }));
          }
        }
        agents.push(...(opts.peers?.agents(hidden) ?? []));
        const icons = opts.icons && new URL(req.url).searchParams.get("icons") !== "manifest" ? await opts.icons.overrides() : undefined;
        const listed = orderBy(agents, lay.order.agents, (a) => a.id, (a) => (a.peer ? 1 : 0));
        return json({ ok: true, agents: icons ? listed.map((a) => applyToAgent(icons, a)) : listed });
      },
    },

    "/api/agents/:app/:agent/chat": {
      POST: wrap(async (req) => {
        const agent = await resolveAgent(req.params.app ?? "", req.params.agent ?? "");
        const body = await chatBody(req);
        if (!body) return error(400, "body must be JSON");
        let message = typeof body.message === "string" ? body.message.trim() : "";
        const images = parseChatImages(body.images);
        if (!message && !images.length) return error(400, "message is required");
        if (!message) message = "Please inspect the attached images.";
        if (message.length > MAX_MESSAGE) return error(400, `message is longer than ${MAX_MESSAGE} characters`);
        const sessionId = typeof body.sessionId === "string" && SESSION_ID_RE.test(body.sessionId) ? body.sessionId : undefined;
        let skillIntent = sessionId ? sessions.intentContext(agent.id, sessionId) : null;
        if (body.intentId !== undefined) {
          if (typeof body.intentId !== "string") return error(400, "intentId must be a string");
          if (typeof body.timezone !== "string" || !isTimezone(body.timezone)) return error(400, "Agent intent requires an IANA timezone");
          skillIntent = { id: body.intentId, timezone: body.timezone };
        }
        if (skillIntent) {
          const intent = opts.shortcuts?.agentIntents().find((i) => i.id === skillIntent.id);
          if (!intent || !intent.enabled) return error(404, "Unknown or disabled agent intent");
          if (intent.agent !== agent.id) return error(400, "Intent belongs to a different agent");
          const context = await intentContext(intent.agent, intent.skills);
          agent.systemPrompt = [agent.systemPrompt, `User timezone: ${skillIntent.timezone}. Request time: ${new Date().toISOString()}. Interpret relative dates in the user's timezone.`, context].filter(Boolean).join("\n\n");
        }
        // A chat runs where its app lives (docs/model-machines.md): another machine's runtime is that machine's agent.
        const onMachine = typeof body.model === "string" ? splitMachine(body.model) : undefined;
        if (onMachine) return error(400, `a chat runs where its app lives; open ${onMachine.machine}/${agent.id} for ${onMachine.machine}'s runtimes`);
        if (body.model !== undefined && (typeof body.model !== "string" || !MODEL_RE.test(body.model))) return error(400, "invalid model");
        const reqModel = typeof body.model === "string" && MODEL_RE.test(body.model) ? body.model : undefined;
        const isBase = agent.id === `${SPACE_APP}/${SPACE_AGENT}`;
        const previous = sessionId ? sessions.get(agent.id, sessionId) : null;
        // A session recorded before runtimes were stored ran on Space Assistant's Claude or the agent's manifest runtime.
        const legacyRuntime = isBase ? "claude" : agent.runtime ?? "claude";
        const appDefault = isBase ? undefined : agentDefault(agent.app, agent);
        const defaultRuntime = appDefault ? appDefault.slice(0, appDefault.indexOf("/")) : agent.runtime!;
        const runtimeName = previous?.runtime ?? (previous ? legacyRuntime : defaultRuntime);
        // A legacy bare SPACE_CHAT_MODEL (normally sonnet) belongs to Claude, not a Codex-only installation.
        const configuredDefault = isBase ? baseDefault() : appDefault;
        const defaultModel = !isBase || configuredDefault?.includes("/") || opts.runtimes.get(runtimeName)?.kind === "claude-code" ? configuredDefault : undefined;
        const requested = reqModel ?? previous?.model ?? (runtimeName === defaultRuntime ? defaultModel : undefined);
        const selected = requested?.includes("/") ? requested : `${runtimeName}/${requested ?? "intermediate"}`;
        const selectedName = selected.slice(0, selected.indexOf("/"));
        if (sessionId && selectedName !== runtimeName) return error(400, "start a new conversation to switch runtimes");
        const configured = opts.runtimes.get(selectedName);
        if (!configured) return error(501, `runtime ${selectedName} is not configured on this space`);
        if (!configured.capabilities.chat) return error(501, `runtime ${selectedName} does not support chat`);
        const runtime = configured;
        // The client answers approvals and may steer the turn: a live process (docs/runtimes.md#live-chat).
        const interactive = body.interactive === true;
        if (images.length && !supportsChatImages(runtime.kind, interactive)) {
          return error(400, runtime.kind === "deepseek-harness" ? "DeepSeek Harness needs an interactive turn for chat images" : "This runtime does not support chat images");
        }
        // A tier the runtime has no model for (DeepSeek Harness) leaves the runtime's own default.
        const tier = (MODEL_TIERS as readonly string[]).includes(selected.slice(selectedName.length + 1));
        const model = tier && !opts.runtimes.tierOptions({ all: true }).some((o) => o.value === selected) ? undefined : opts.runtimes.resolve(selected).model;
        const permissionMode = typeof body.permissionMode === "string" ? body.permissionMode : undefined;
        if (body.effort !== undefined && !(CHAT_EFFORTS as readonly unknown[]).includes(body.effort)) return error(400, `effort must be one of ${CHAT_EFFORTS.join(", ")}`);
        const effort = body.effort as ChatEffort | undefined;
        const env: Record<string, string | undefined> = {
          ...process.env,
          ...(await loadAppEnv(agent.cwd)),
          ...(opts.envFor && agent.app !== SPACE_APP ? await opts.envFor(agent.app) : {}),
          // Which agent this turn is, for a command the agent runs that wants to return to this conversation later.
          SPACE_AGENT_ID: agent.id,
        };
        // A turn of an agent that may delegate gets its run token (docs/orders.md#who-may-call); no other turn does.
        delete env.SPACE_RUN_TOKEN;
        const minted = opts.runTokens?.mint(agent.id);
        if (minted) {
          env.SPACE_RUN_TOKEN = minted.token;
          if (opts.apiUrl) env.SPACE_API_URL = opts.apiUrl;
        }
        // Set in process only (a delegation's result, agents/delegations.ts); a request from outside cannot carry it.
        const trigger = (req as { spaceTrigger?: RunTrigger }).spaceTrigger;
        // What the person changed through the last turn's cards goes before the message (docs/chat-cards.md).
        const changes = cards.changesNote(agent.id, sessionId);
        let run;
        const release = await opts.holdApp?.(agent.app);
        try {
          run = runs.start({
            agent: agent.id,
            runtime,
            model,
            ...(trigger ? { trigger } : {}),
            ...(changes ? { message } : {}),
            // The manifest's tool list is Claude Code's syntax; other runtimes bound the agent by the permission mode's sandbox.
            turn: { message: changes ? `${changes}\n\n${message}` : message, images, sessionId, model, permissionMode, ...(effort ? { effort } : {}), interactive, systemPrompt: agent.systemPrompt, allowedTools: runtime.kind === "claude-code" ? agent.tools : [], cwd: agent.cwd, env },
            onSession: (sid) => sessions.record(agent.id, sid, sessionId, message.slice(0, 40), runtime.name, model, skillIntent ?? undefined),
          });
          if (release) runs.subscribe(run.id, run.lastSeq, { onEvent() {}, onEnd: release });
          minted?.bind(run.id);
        } catch (e) {
          release?.();
          minted?.drop();
          if (e instanceof RunBusyError) return error(409, e.message);
          if (e instanceof RunClosedError) return error(503, e.message);
          throw e;
        }
        return runResponse(runs, run.id, 0, { heartbeatMs: opts.heartbeatMs })!;
      }),
    },

    "/api/agents/cards/state": {
      POST: wrap(async (req) => {
        const body = (await req.json().catch(() => null)) as { agent?: unknown; card?: unknown } | null;
        const app = typeof body?.agent === "string" ? cardApp(body.agent) : null;
        if (!app) return error(400, "agent must be an app agent of this space");
        const card = parseCard(body?.card);
        if (!card) return error(400, "card is not a valid card");
        if (!card.state) return error(400, "this card has no state capability");
        const r = await callCard(app, card.state, { ids: card.items.map((i) => i.id) });
        if (!r.ok) return r.res;
        return json({ ok: true, items: parseItemStates(r.data.items, cardLink(app)) });
      }),
    },

    "/api/agents/cards/action": {
      POST: wrap(async (req) => {
        const body = (await req.json().catch(() => null)) as { token?: unknown; card?: unknown; action?: unknown; items?: unknown } | null;
        const grant = typeof body?.token === "string" ? cards.grant(body.token) : undefined;
        if (!grant) return json({ ok: false, error: "this card is read-only now: the conversation has moved on", readOnly: true }, 409);
        const card = typeof body?.card === "number" ? grant.cards[body.card] : undefined;
        if (!card) return error(400, "card must be the index of a card of this token");
        const capability = typeof body?.action === "string" ? card.actions?.[body.action as keyof NonNullable<typeof card.actions>] : undefined;
        if (!capability) return error(400, "this card has no such action");
        if (body?.items !== undefined && (!Array.isArray(body.items) || !body.items.every((x) => typeof x === "string"))) return error(400, "items must be a list of item ids");
        const chosen = body?.items === undefined ? card.items : card.items.filter((i) => (body.items as string[]).includes(i.id));
        if (!chosen.length) return error(400, "no item of this card was chosen");
        const r = await callCard(grant.app, capability, { items: chosen.map((i) => ({ id: i.id, ...(i.version !== undefined ? { version: i.version } : {}) })) });
        if (!r.ok) return r.res;
        const items = parseItemStates(r.data.items, cardLink(grant.app));
        cards.removed(body!.token as string, items.filter((i) => i.status === "removed" && chosen.some((c) => c.id === i.id)).map((i) => i.id));
        return json({ ok: true, items });
      }),
    },

    "/api/agents/runs": {
      GET: wrap((req) => {
        const agent = new URL(req.url).searchParams.get("agent");
        return json({ ok: true, runs: runs.list({ ...listQuery(req), ...(agent ? { agent } : {}) }) });
      }),
    },

    "/api/agents/:app/:agent/runs": {
      GET: wrap((req) => json({ ok: true, runs: runs.list({ ...listQuery(req), agent: `${req.params.app}/${req.params.agent}` }) })),
    },

    "/api/agents/:app/:agent/runs/:id": {
      GET: wrap((req) => json({ ok: true, run: runOf(req) })),
    },

    "/api/agents/watch": {
      GET: wrap(() => watchResponse(runs, null, { heartbeatMs: opts.heartbeatMs })),
    },

    "/api/agents/:app/:agent/watch": {
      GET: wrap((req) => watchResponse(runs, `${req.params.app}/${req.params.agent}`, { heartbeatMs: opts.heartbeatMs })),
    },

    "/api/agents/:app/:agent/runs/:id/events": {
      GET: wrap((req) => {
        const run = runOf(req);
        // `after` from the query, else the browser's own reconnect header.
        const after = Number(new URL(req.url).searchParams.get("after") ?? req.headers.get("last-event-id") ?? 0);
        return runResponse(runs, run.id, Number.isFinite(after) && after > 0 ? after : 0, { heartbeatMs: opts.heartbeatMs }) ?? error(404, "unknown run");
      }),
    },

    "/api/agents/:app/:agent/runs/:id/stop": {
      POST: wrap((req) => {
        const run = runOf(req);
        const stopped = runs.stop(run.id);
        return json({ ok: true, stopped, run: runs.get(run.id) });
      }),
    },

    "/api/agents/:app/:agent/runs/:id/steer": {
      POST: wrap(async (req) => {
        const run = runOf(req);
        const body = await chatBody(req);
        if (!body) return error(400, "body must be JSON");
        const message = typeof body.message === "string" ? body.message.trim() : "";
        const images = parseChatImages(body.images);
        if (!message && !images.length) return error(400, "message is required");
        if (message.length > MAX_MESSAGE) return error(400, `message is longer than ${MAX_MESSAGE} characters`);
        try {
          await runs.steer(run.id, { message: message || "Please inspect the attached images.", images });
        } catch (e) {
          if (e instanceof RunStateError) return error(409, e.message);
          throw e;
        }
        return json({ ok: true });
      }),
    },

    "/api/agents/:app/:agent/runs/:id/approvals/:rid": {
      POST: wrap(async (req) => {
        const run = runOf(req);
        const body = (await req.json().catch(() => null)) as { decision?: unknown; answers?: unknown } | null;
        const decision = body?.decision;
        if (!(APPROVAL_DECISIONS as readonly unknown[]).includes(decision)) return error(400, `decision must be one of ${APPROVAL_DECISIONS.join(", ")}`);
        const answers = parseAnswers(body?.answers);
        if (answers === false) return error(400, "answers must map question ids to lists of strings");
        const answered = runs.respond(run.id, req.params.rid ?? "", decision as ApprovalDecision, answers);
        return answered ? json({ ok: true }) : error(409, "this request is no longer waiting for an answer");
      }),
    },

    "/api/agents/:app/:agent/sessions": {
      GET: wrap(async (req) => {
        const agent = await resolveAgent(req.params.app ?? "", req.params.agent ?? "");
        return json({ ok: true, sessions: sessions.list(agent.id) });
      }),
    },

    "/api/agents/:app/:agent/sessions/:sid": {
      GET: wrap(async (req) => {
        const agent = await resolveAgent(req.params.app ?? "", req.params.agent ?? "");
        const sid = req.params.sid ?? "";
        if (!SESSION_ID_RE.test(sid)) return error(400, "invalid session id");
        // The runtime that ran the session keeps its record; `home` (tests) reads Claude Code's from elsewhere.
        const previous = sessions.get(agent.id, sid);
        const isBase = agent.id === `${SPACE_APP}/${SPACE_AGENT}`;
        const runtime = opts.runtimes.get(previous?.runtime ?? (isBase ? (previous ? "claude" : agent.runtime!) : agent.runtime ?? "claude"));
        const messages = opts.home && runtime?.kind === "claude-code" ? await readTranscript(agent.cwd, sid, opts.home) : runtime?.transcript ? await runtime.transcript(agent.cwd, sid) : null;
        if (!messages) return error(404, "transcript not found");
        const app = cardApp(agent.id);
        const shown = messages.map((m) => (m.role === "user" ? { ...m, text: withoutChangesNote(m.text) } : m));
        return json({ ok: true, messages: transcriptCards(shown, app ? cardLink(app) : null) });
      }),
    },
  };
}

/** The prompt file, then the app context (title, description, AGENTS.md) so the agent knows its app. */
async function systemPromptFor(m: Manifest, a: ManifestAgent): Promise<string | undefined> {
  const parts: string[] = [];
  if (a.prompt) {
    const file = Bun.file(join(m.dir, a.prompt));
    if (await file.exists()) parts.push((await file.text()).trim());
    else parts.push(`(prompt file ${a.prompt} is missing)`);
  }
  const ctx = [`You are the agent "${a.name}" of the app "${m.title ?? m.app}" in an ai-space workspace.`];
  if (m.description) ctx.push(m.description);
  ctx.push(`App directory: ${m.dir}`);
  parts.push(ctx.join(" "));
  const agentsMd = Bun.file(join(m.dir, "AGENTS.md"));
  if (await agentsMd.exists()) parts.push(`--- AGENTS.md ---\n${(await agentsMd.text()).slice(0, MAX_CONTEXT)}`);
  return parts.join("\n\n");
}

async function realDir(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

class NotFound extends Error {}

/** A question's answers from the client: absent → undefined, malformed → false. */
export function parseAnswers(raw: unknown): QuestionAnswers | undefined | false {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return false;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 8) return false;
  const answers: QuestionAnswers = {};
  for (const [id, list] of entries) {
    if (id.length > 200 || !Array.isArray(list) || list.length > 12 || !list.every((a) => typeof a === "string" && a.length <= MAX_MESSAGE)) return false;
    answers[id] = list as string[];
  }
  return answers;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
