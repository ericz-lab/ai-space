import type { Database } from "bun:sqlite";

/**
 * The team (docs/orders.md#team): who does the work behind an order and with what rights, one row
 * per member in `team_members` (space.db). In this phase the team is the Director alone, the row
 * its turns take their model and permission from; the table already holds the fields the later
 * phases need (role, title, agent, summary, enabled).
 */

/** What a member may do without asking, and the runtime permission mode each setting sends. */
export const TEAM_PERMISSIONS = ["ask", "edit", "full"] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

export const PERMISSION_MODE: Record<TeamPermission, string | undefined> = { ask: undefined, edit: "acceptEdits", full: "bypassPermissions" };

export type TeamMember = {
  role: string;
  title: string;
  i18n: Record<string, { title: string }>;
  /** `<app>/<agent>`. */
  agent: string;
  summary: string;
  /** A `runtime/tier` (or `runtime/model`) value; null = the agent's default. */
  model: string | null;
  permission: TeamPermission;
  enabled: boolean;
  /** Built in: cannot be removed or disabled. */
  builtin: boolean;
  updatedAt: number;
};

export const DIRECTOR_ROLE = "director";

const SEED: Omit<TeamMember, "updatedAt">[] = [
  {
    role: DIRECTOR_ROLE,
    title: "Director",
    i18n: { zh: { title: "总管" } },
    agent: "space/director",
    summary: "Takes every order: answers, looks things up, records to-dos and asks the person when an order needs more.",
    model: null,
    permission: "ask",
    enabled: true,
    builtin: true,
  },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS team_members (
  role       TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  i18n       TEXT NOT NULL DEFAULT '{}',
  agent      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  model      TEXT,
  permission TEXT NOT NULL DEFAULT 'ask',
  enabled    INTEGER NOT NULL DEFAULT 1,
  builtin    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

type Row = { role: string; title: string; i18n: string; agent: string; summary: string; model: string | null; permission: string; enabled: number; builtin: number; updated_at: number };

export class TeamStore {
  private readonly now: () => number;

  constructor(
    private readonly db: Database,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    db.exec(SCHEMA);
    // The built-in rows exist on every Space; a seed never overwrites what the person set.
    const seed = db.query("INSERT OR IGNORE INTO team_members (role, title, i18n, agent, summary, model, permission, enabled, builtin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const m of SEED) seed.run(m.role, m.title, JSON.stringify(m.i18n), m.agent, m.summary, m.model, m.permission, m.enabled ? 1 : 0, m.builtin ? 1 : 0, this.now());
  }

  list(): TeamMember[] {
    return this.db.query<Row, []>("SELECT * FROM team_members ORDER BY builtin DESC, role").all().map(memberOf);
  }

  get(role: string): TeamMember | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM team_members WHERE role = ?").get(role);
    return row ? memberOf(row) : undefined;
  }

  /** The Director's row; always there (seeded). */
  director(): TeamMember {
    return this.get(DIRECTOR_ROLE)!;
  }

  update(role: string, patch: { model?: string | null; permission?: TeamPermission }): TeamMember | undefined {
    const cur = this.get(role);
    if (!cur) return undefined;
    const model = patch.model === undefined ? cur.model : patch.model;
    const permission = patch.permission ?? cur.permission;
    this.db.query("UPDATE team_members SET model = ?, permission = ?, updated_at = ? WHERE role = ?").run(model, permission, this.now(), role);
    return this.get(role);
  }
}

function memberOf(r: Row): TeamMember {
  let i18n: TeamMember["i18n"] = {};
  try {
    i18n = JSON.parse(r.i18n) as TeamMember["i18n"];
  } catch { /* none */ }
  return {
    role: r.role,
    title: r.title,
    i18n,
    agent: r.agent,
    summary: r.summary,
    model: r.model,
    permission: (TEAM_PERMISSIONS as readonly string[]).includes(r.permission) ? (r.permission as TeamPermission) : "ask",
    enabled: r.enabled === 1,
    builtin: r.builtin === 1,
    updatedAt: r.updated_at,
  };
}
