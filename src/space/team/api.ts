import { DIRECTOR_ROLE, MAX_MEMBER_TITLE, MAX_MEMBERS, MAX_SUMMARY, type MemberPatch, ROLE_RE, TEAM_PERMISSIONS, type TeamMember, type TeamPermission, type TeamStore } from "./store.ts";

/**
 * GET /api/team    { ok, members, options, permissions, agents }: every member, the model values a
 *                  member may take (this Space's chat runtimes and tiers), and the agents of this
 *                  Space that can be added (docs/orders.md#members-the-person-adds)
 * PUT /api/team    { members?: [{ role, title?, i18n?, agent?, summary?, model?, permission?, enabled? }], remove?: [role] }
 *                  a role the team has is changed, a new one is added (it needs `agent`), a listed
 *                  role is removed; all of it is checked first and applied together, or nothing is (400)
 *
 * The rules: the agent must be an agent of this Space (a peer's is refused: delegation stays on one
 * machine in this phase); a role is unique; a built-in row keeps its agent and cannot be removed;
 * the Director cannot be disabled and is the only member with its agent. The owner's only: an
 * app's token or another credential is refused (403).
 */

/** An agent a member may be: where it lives (`peer` for another machine's) and how it describes itself. */
export type TeamAgentInfo = { id: string; title: string; description: string; peer?: string; builtin?: boolean };

export type TeamApiOptions = {
  team: TeamStore;
  /** The `runtime/tier` values a chat can run on here. */
  modelOptions: () => { value: string; runtime: string; tier: string; model: string; unavailable?: string }[];
  /** The agents the panel lists (this Space's, then the peers'), for the checks and the page's choices. */
  agents: () => Promise<TeamAgentInfo[]> | TeamAgentInfo[];
  /** `null` for the owner; anything else is refused. Absent: everyone is the owner. */
  callerApp?: (req: Request) => Promise<string | null>;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

export type TeamChange = { kind: "update"; role: string; patch: MemberPatch } | { kind: "add"; member: Omit<TeamMember, "updatedAt" | "builtin"> } | { kind: "remove"; role: string };

export function createTeamRoutes(opts: TeamApiOptions): Record<string, Partial<Record<"GET" | "PUT", Handler>>> {
  const owner = (h: Handler): Handler => async (req) => {
    if (opts.callerApp && (await opts.callerApp(req)) !== null) return error(403, "the team is the owner's");
    return h(req);
  };
  const view = async () => {
    const agents = await opts.agents();
    return { ok: true, members: opts.team.list().map(memberView), options: opts.modelOptions(), permissions: TEAM_PERMISSIONS, agents: agents.filter((a) => !a.peer) };
  };
  return {
    "/api/team": {
      GET: owner(async () => json(await view())),
      PUT: owner(async (req) => {
        const body = (await req.json().catch(() => null)) as unknown;
        let changes: TeamChange[];
        try {
          changes = parseTeamUpdate(body, opts.team, opts.modelOptions().map((o) => o.value), await opts.agents());
        } catch (e) {
          return error(400, (e as Error).message);
        }
        opts.team.transaction(() => {
          for (const c of changes) {
            if (c.kind === "update") opts.team.update(c.role, c.patch);
            else if (c.kind === "add") opts.team.add(c.member);
            else opts.team.remove(c.role);
          }
        });
        return json(await view());
      }),
    },
  };
}

const FIELDS = ["role", "title", "i18n", "agent", "summary", "model", "permission", "enabled"];

/** The checked changes of a `PUT /api/team` body; throws with the reason. */
export function parseTeamUpdate(body: unknown, team: TeamStore, models: string[], agents: TeamAgentInfo[]): TeamChange[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be { members?: [...], remove?: [role] }");
  const b = body as { members?: unknown; remove?: unknown };
  const extra = Object.keys(b).filter((k) => k !== "members" && k !== "remove");
  if (extra.length) throw new Error(`unknown field ${extra.join(", ")}; the body is { members?, remove? }`);
  if (b.members !== undefined && !Array.isArray(b.members)) throw new Error("members must be a list");
  if (b.remove !== undefined && (!Array.isArray(b.remove) || !b.remove.every((r) => typeof r === "string"))) throw new Error("remove must be a list of roles");
  const list = (b.members ?? []) as unknown[];
  const removed = (b.remove ?? []) as string[];
  if (!list.length && !removed.length) throw new Error("nothing to change: give members or remove");
  if (list.length > 50 || removed.length > 50) throw new Error("at most 50 changes at once");
  const out: TeamChange[] = [];
  // The team as it will be, to check uniqueness and the count after every change.
  const roles = new Set(team.list().map((m) => m.role));
  for (const role of removed) {
    const cur = team.get(role);
    if (!cur) throw new Error(`remove: unknown role ${JSON.stringify(role)}`);
    if (cur.builtin) throw new Error(`remove: ${role} is built in; it can be edited${role === DIRECTOR_ROLE ? "" : " or disabled"}, not removed`);
    roles.delete(role);
    out.push({ kind: "remove", role });
  }
  const seen = new Set<string>();
  list.forEach((raw, i) => {
    const at = `members[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at} must be an object`);
    const m = raw as Record<string, unknown>;
    const unknown = Object.keys(m).filter((k) => !FIELDS.includes(k));
    if (unknown.length) throw new Error(`${at}: unknown field ${unknown.join(", ")}`);
    if (typeof m.role !== "string" || !ROLE_RE.test(m.role)) throw new Error(`${at}: role must be a short lowercase name (letters, digits, -), like designer`);
    if (seen.has(m.role)) throw new Error(`${at}: ${m.role} is listed twice`);
    seen.add(m.role);
    if (removed.includes(m.role)) throw new Error(`${at}: ${m.role} is both changed and removed`);
    const cur = team.get(m.role);
    const patch: MemberPatch = {};
    if ("title" in m) {
      if (typeof m.title !== "string" || !m.title.trim() || m.title.trim().length > MAX_MEMBER_TITLE) throw new Error(`${at}: title must be 1 to ${MAX_MEMBER_TITLE} characters`);
      patch.title = m.title.trim();
    }
    if ("i18n" in m) patch.i18n = parseI18n(m.i18n, at);
    if ("summary" in m) {
      if (typeof m.summary !== "string" || m.summary.length > MAX_SUMMARY) throw new Error(`${at}: summary must be text of at most ${MAX_SUMMARY} characters`);
      patch.summary = m.summary.trim();
    }
    if ("model" in m) {
      if (m.model !== null && (typeof m.model !== "string" || !models.includes(m.model))) throw new Error(`${at}: model must be null (the default) or one of this Space's chat models (${models.join(", ") || "none"})`);
      patch.model = m.model as string | null;
    }
    if ("permission" in m) {
      if (!(TEAM_PERMISSIONS as readonly unknown[]).includes(m.permission)) throw new Error(`${at}: permission must be one of ${TEAM_PERMISSIONS.join(", ")}`);
      patch.permission = m.permission as TeamPermission;
    }
    if ("enabled" in m) {
      if (typeof m.enabled !== "boolean") throw new Error(`${at}: enabled must be true or false`);
      if (m.role === DIRECTOR_ROLE && !m.enabled) throw new Error(`${at}: the Director takes every order and cannot be disabled`);
      patch.enabled = m.enabled;
    }
    let agent: TeamAgentInfo | undefined;
    if ("agent" in m) {
      if (typeof m.agent !== "string") throw new Error(`${at}: agent must be <app>/<agent>`);
      if (cur?.builtin && m.agent !== cur.agent) throw new Error(`${at}: ${m.role} is built in; its agent stays ${cur.agent}`);
      agent = checkAgent(m.agent, agents, at);
      if (m.agent === "space/director" && m.role !== DIRECTOR_ROLE) throw new Error(`${at}: the Director is a member once, as director`);
      patch.agent = m.agent;
    }
    if (cur) {
      out.push({ kind: "update", role: m.role, patch });
      return;
    }
    if (!agent) throw new Error(`${at}: ${m.role} is a new member; name its agent (<app>/<agent> of this Space)`);
    roles.add(m.role);
    if (roles.size > MAX_MEMBERS) throw new Error(`a team has at most ${MAX_MEMBERS} members`);
    out.push({
      kind: "add",
      member: {
        role: m.role,
        title: patch.title ?? (agent.title || m.role),
        i18n: patch.i18n ?? {},
        agent: agent.id,
        summary: patch.summary || clip(agent.description, MAX_SUMMARY),
        model: patch.model ?? null,
        permission: patch.permission ?? "ask",
        enabled: patch.enabled ?? true,
      },
    });
  });
  return out;
}

/** The agent of a member: one of this Space's; a peer's or an unknown one is refused with the reason. */
function checkAgent(id: string, agents: TeamAgentInfo[], at: string): TeamAgentInfo {
  const found = agents.find((a) => a.id === id);
  if (found?.peer) throw new Error(`${at}: ${id} is an agent of ${found.peer}; a member must be an agent of this Space (delegation to another machine is not built yet)`);
  if (!found) {
    const peer = agents.find((a) => a.peer && a.id === `${a.peer}/${id}`);
    throw new Error(`${at}: ${id} is not an agent of this Space${peer ? ` (${peer.peer} has one; delegation stays on this machine for now)` : ""}`);
  }
  return found;
}

function parseI18n(raw: unknown, at: string): Record<string, { title: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at}: i18n must be { <lang>: { title } }`);
  const out: Record<string, { title: string }> = {};
  for (const [lang, v] of Object.entries(raw as Record<string, unknown>)) {
    const title = (v as { title?: unknown } | null)?.title;
    if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(lang) || typeof title !== "string" || title.trim().length > MAX_MEMBER_TITLE) throw new Error(`${at}: i18n.${lang} must be { title } of at most ${MAX_MEMBER_TITLE} characters`);
    if (title.trim()) out[lang] = { title: title.trim() };
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function memberView(m: TeamMember) {
  return { role: m.role, title: m.title, i18n: m.i18n, agent: m.agent, summary: m.summary, model: m.model, permission: m.permission, enabled: m.enabled, builtin: m.builtin, updatedAt: new Date(m.updatedAt).toISOString() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
