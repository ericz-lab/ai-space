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
import { MODEL_TIERS } from "../runtimes/types.ts";
import type { Manifest, ManifestAgent } from "../scheduler/manifest.ts";
import { loadAppEnv } from "../scheduler/targets.ts";
import type { Workspace } from "../workspace.ts";
import { MODEL_RE, SESSION_ID_RE, runResponse } from "./runtime.ts";
import { RunBusyError, RunClosedError, RunRegistry } from "./runs.ts";
import type { SessionStore } from "./sessions.ts";
import { readTranscript } from "./transcript.ts";

/**
 * HTTP surface for agents, shaped as a Bun.serve `routes` table.
 *
 *   GET  /api/agents                              every agent of every visible app, plus the space agent, then the peers' agents
 *   POST /api/agents/:app/:agent/chat             { message, sessionId?, model?, permissionMode? } → SSE of a new background run (x-run-id)
 *   GET  /api/agents/runs?recent=<s>&agent=        runs newest first: running ones and those that ended in the last `recent` seconds
 *   GET  /api/agents/:app/:agent/runs              the agent's runs (same query)
 *   GET  /api/agents/:app/:agent/runs/:id          one run
 *   GET  /api/agents/:app/:agent/runs/:id/events?after=<seq>   SSE: replay after `seq`, then live
 *   POST /api/agents/:app/:agent/runs/:id/stop     stop a running turn
 *   GET  /api/agents/:app/:agent/sessions         recent sessions
 *   GET  /api/agents/:app/:agent/sessions/:sid    restored transcript
 *
 * Like the panel routes these carry no bearer token; see docs/panel.md.
 */

export type AgentsApiOptions = {
  ws: Workspace;
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
  /** Home directory for transcripts; default: the process's. */
  home?: string;
  /** Other machines whose agents this panel lists; chat with them is forwarded by the peer routes. */
  peers?: PeerHub;
  /** The panel's icon packs: the active one's icons replace avatars and corner icons in the list. */
  icons?: IconPacks;
  /** The bus catalogue (local apps and peers'), appended to every agent's system prompt (docs/events.md). */
  capabilities?: () => (AppCapabilities & { peer?: string })[];
  /** Chat turns as background runs; default: a registry over an in-memory database. */
  runs?: RunRegistry;
  /** SSE keepalive interval (tests). */
  heartbeatMs?: number;
};

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

/** The runtime/tier values any agent's chat may pick. */
function chatOptions(runtimes: RuntimeRegistry): NonNullable<AgentView["modelOptions"]> {
  return runtimes.tierOptions().filter((o) => o.capabilities.chat).map(({ value, runtime, tier, model }) => ({ value, runtime, tier, model }));
}

function baseRuntime(runtimes: RuntimeRegistry, defaultModel?: string): string {
  if (defaultModel?.includes("/")) return defaultModel.split("/")[0]!;
  return runtimes.get("claude")?.capabilities.chat ? "claude" : runtimes.list().find((r) => r.capabilities.chat)?.name ?? runtimes.default.name;
}

function spaceAgentPrompt(ws: Workspace): string {
  return [
    `You are the assistant of an ai-space workspace at ${ws.home}.`,
    "Apps live under apps/<name>/, each with a space.yaml manifest (spec in core/docs/app-spec.md when ai-space is deployed here). Runtime data is under data/<name>/. Answer questions about the space, inspect manifests and files, and help operate apps.",
    "Be honest: say when you cannot find or verify something instead of guessing.",
  ].join("\n");
}

type ResolvedAgent = {
  id: string;
  /** The manifest's declaration, for an app agent. */
  runtime?: string;
  model?: string;
  cwd: string;
  systemPrompt?: string;
  tools: string[];
  app: string;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
type Routes = Record<string, Handler | Partial<Record<"GET" | "POST", Handler>>>;

const MAX_MESSAGE = 20_000;
const MAX_CONTEXT = 24_000;

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

  /** `runtime/model` for a value: a bare tier on `tierRuntime`, another bare model on `runtime` (else the space's default runtime). */
  const qualify = (value: string | undefined, tierRuntime: string, runtime?: string): string | undefined => {
    if (!value || value.includes("/")) return value;
    return `${(MODEL_TIERS as readonly string[]).includes(value) ? tierRuntime : runtime ?? opts.runtimes.default.name}/${value}`;
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
    const entry = registry.get(app);
    const a = entry?.manifest.agents.find((x) => x.name === name);
    if (!entry || !a) throw new NotFound(`unknown agent: ${app}/${name}`);
    return {
      id: `${app}/${name}`,
      ...(a.runtime ? { runtime: a.runtime } : {}),
      ...(a.model ? { model: a.model } : {}),
      // The real path: the runtime files its transcripts under the directory it actually runs in,
      // and an app directory may be a symlink into the repository checkout.
      cwd: await realDir(resolve(entry.manifest.dir, a.cwd)),
      systemPrompt: withCatalogue(await systemPromptFor(entry.manifest, a), app),
      tools: a.tools,
      app,
    };
  };

  return {
    "/api/agents": {
      GET: async (req) => {
        const lay = layout.read();
        const hidden = new Set(lay.hidden);
        const agents: AgentView[] = [spaceAgentView(opts.runtimes, baseDefault())];
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
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (!body) return error(400, "body must be JSON");
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return error(400, "message is required");
        if (message.length > MAX_MESSAGE) return error(400, `message is longer than ${MAX_MESSAGE} characters`);
        const sessionId = typeof body.sessionId === "string" && SESSION_ID_RE.test(body.sessionId) ? body.sessionId : undefined;
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
        // A tier the runtime has no model for (DeepSeek Harness) leaves the runtime's own default.
        const tier = (MODEL_TIERS as readonly string[]).includes(selected.slice(selectedName.length + 1));
        const model = tier && !opts.runtimes.tierOptions().some((o) => o.value === selected) ? undefined : opts.runtimes.resolve(selected).model;
        const permissionMode = typeof body.permissionMode === "string" ? body.permissionMode : undefined;
        const env: Record<string, string | undefined> = { ...process.env, ...(await loadAppEnv(agent.cwd)), ...(opts.envFor && agent.app !== SPACE_APP ? await opts.envFor(agent.app) : {}) };
        let run;
        try {
          run = runs.start({
            agent: agent.id,
            runtime,
            model,
            // The manifest's tool list is Claude Code's syntax; other runtimes bound the agent by the permission mode's sandbox.
            turn: { message, sessionId, model, permissionMode, systemPrompt: agent.systemPrompt, allowedTools: runtime.kind === "claude-code" ? agent.tools : [], cwd: agent.cwd, env },
            onSession: (sid) => sessions.record(agent.id, sid, sessionId, message.slice(0, 40), runtime.name, model),
          });
        } catch (e) {
          if (e instanceof RunBusyError) return error(409, e.message);
          if (e instanceof RunClosedError) return error(503, e.message);
          throw e;
        }
        return runResponse(runs, run.id, 0, { heartbeatMs: opts.heartbeatMs })!;
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
        return json({ ok: true, messages });
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
