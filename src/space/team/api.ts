import { TEAM_PERMISSIONS, type TeamMember, type TeamPermission, type TeamStore } from "./store.ts";

/**
 * GET /api/team    { ok, members, options, permissions }: every member with its model and permission,
 *                  the model values a member may take (this Space's chat runtimes and tiers)
 * PUT /api/team    { members: [{ role, model?, permission? }] } changes those two fields of existing
 *                  members; anything else is refused (400) and nothing is changed
 *
 * The owner's only (docs/orders.md#team): an app's token or another credential is refused (403).
 */

export type TeamApiOptions = {
  team: TeamStore;
  /** The `runtime/tier` values a chat can run on here. */
  modelOptions: () => { value: string; runtime: string; tier: string; model: string; unavailable?: string }[];
  /** `null` for the owner; anything else is refused. Absent: everyone is the owner. */
  callerApp?: (req: Request) => Promise<string | null>;
};

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;

export function createTeamRoutes(opts: TeamApiOptions): Record<string, Partial<Record<"GET" | "PUT", Handler>>> {
  const owner = (h: Handler): Handler => async (req) => {
    if (opts.callerApp && (await opts.callerApp(req)) !== null) return error(403, "the team is the owner's");
    return h(req);
  };
  const view = () => ({ ok: true, members: opts.team.list().map(memberView), options: opts.modelOptions(), permissions: TEAM_PERMISSIONS });
  return {
    "/api/team": {
      GET: owner(() => json(view())),
      PUT: owner(async (req) => {
        const body = (await req.json().catch(() => null)) as unknown;
        let changes: { role: string; model?: string | null; permission?: TeamPermission }[];
        try {
          changes = parseTeamUpdate(body, opts.team, opts.modelOptions().map((o) => o.value));
        } catch (e) {
          return error(400, (e as Error).message);
        }
        for (const c of changes) opts.team.update(c.role, c);
        return json(view());
      }),
    },
  };
}

/** The checked changes of a `PUT /api/team` body; throws with the reason. */
export function parseTeamUpdate(body: unknown, team: TeamStore, models: string[]): { role: string; model?: string | null; permission?: TeamPermission }[] {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as { members?: unknown }).members)) throw new Error("body must be { members: [{ role, model?, permission? }] }");
  const list = (body as { members: unknown[] }).members;
  if (!list.length || list.length > 50) throw new Error("members must list 1 to 50 changes");
  return list.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`members[${i}] must be an object`);
    const m = raw as Record<string, unknown>;
    const extra = Object.keys(m).filter((k) => !["role", "model", "permission"].includes(k));
    if (extra.length) throw new Error(`members[${i}]: only model and permission can change here (not ${extra.join(", ")})`);
    if (typeof m.role !== "string" || !team.get(m.role)) throw new Error(`members[${i}]: unknown role ${JSON.stringify(m.role)}; the team has ${team.list().map((x) => x.role).join(", ")}`);
    const out: { role: string; model?: string | null; permission?: TeamPermission } = { role: m.role };
    if ("model" in m) {
      if (m.model !== null && (typeof m.model !== "string" || !models.includes(m.model))) throw new Error(`members[${i}]: model must be null (the default) or one of this Space's chat models (${models.join(", ") || "none"})`);
      out.model = m.model as string | null;
    }
    if ("permission" in m) {
      if (!(TEAM_PERMISSIONS as readonly unknown[]).includes(m.permission)) throw new Error(`members[${i}]: permission must be one of ${TEAM_PERMISSIONS.join(", ")}`);
      out.permission = m.permission as TeamPermission;
    }
    return out;
  });
}

function memberView(m: TeamMember) {
  return { role: m.role, title: m.title, i18n: m.i18n, agent: m.agent, summary: m.summary, model: m.model, permission: m.permission, enabled: m.enabled, builtin: m.builtin, updatedAt: new Date(m.updatedAt).toISOString() };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
