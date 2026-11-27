import type { Database } from "bun:sqlite";

/**
 * The team (docs/orders.md#team): who does the work behind an order and with what rights, one row
 * per member in `team_members` (space.db). Two rows are built in and seeded on every Space: the
 * Director (`space/director`), who takes every order and delegates, and the Engineer
 * (`space/engineer`), who changes an app's source. The person adds members from this Space's app
 * agents (a Designer, say). A built-in row can be edited and (the Engineer) disabled, never removed;
 * the Director cannot be disabled. Only the Director delegates, so the team is flat.
 */

/** What a member may do without asking, and the runtime permission mode each setting sends. */
export const TEAM_PERMISSIONS = ["ask", "edit", "full"] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

export const PERMISSION_MODE: Record<TeamPermission, string | undefined> = { ask: undefined, edit: "acceptEdits", full: "bypassPermissions" };

export type TeamMember = {
  role: string;
  title: string;
  i18n: Record<string, { title: string }>;
  /** `<app>/<agent>` of this Space, or `<peer>/<app>/<agent>` of a peer it runs agents on (docs/orders.md#on-another-machine). */
  agent: string;
  summary: string;
  /** A `runtime/tier` (or `runtime/model`) value; null = the agent's default. */
  model: string | null;
  permission: TeamPermission;
  enabled: boolean;
  /** Built in: cannot be removed; the Director cannot be disabled either. */
  builtin: boolean;
  updatedAt: number;
};

export const DIRECTOR_ROLE = "director";
export const ENGINEER_ROLE = "engineer";

/** A role: a short lowercase name the Director writes (`designer`), unique. */
export const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const MAX_MEMBERS = 30;
export const MAX_SUMMARY = 400;
export const MAX_MEMBER_TITLE = 60;

export const SEED: Omit<TeamMember, "updatedAt">[] = [
  {
    role: DIRECTOR_ROLE,
    title: "Director",
    i18n: { zh: { title: "总管" } },
    agent: "space/director",
    summary: "Takes every order: answers, looks things up, records to-dos, delegates to the team and asks the person when an order needs more.",
    model: null,
    permission: "ask",
    enabled: true,
    builtin: true,
  },
  {
    role: ENGINEER_ROLE,
    title: "Engineer",
    i18n: { zh: { title: "工程师" } },
    agent: "space/engineer",
    summary: "Changes an app's source in app-src/<app>/, runs its checks and deploys it through the app's own channel. Give it one app per brief.",
    model: null,
    permission: "edit",
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

/** The fields of a member the person sets. */
export type MemberPatch = Partial<Pick<TeamMember, "title" | "i18n" | "agent" | "summary" | "model" | "permission" | "enabled">>;

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
    // Phase 1 seeded the Director with a summary that said it does not delegate; an untouched one follows the seed.
    db.query("UPDATE team_members SET summary = ? WHERE role = ? AND summary = ?").run(SEED[0]!.summary, DIRECTOR_ROLE, "Takes every order: answers, looks things up, records to-dos and asks the person when an order needs more.");
  }

  list(): TeamMember[] {
    return this.db.query<Row, []>("SELECT * FROM team_members ORDER BY builtin DESC, role").all().map(memberOf);
  }

  get(role: string): TeamMember | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM team_members WHERE role = ?").get(role);
    return row ? memberOf(row) : undefined;
  }

  /** The first member whose agent is `agent`. */
  byAgent(agent: string): TeamMember | undefined {
    const row = this.db.query<Row, [string]>("SELECT * FROM team_members WHERE agent = ? ORDER BY builtin DESC, role LIMIT 1").get(agent);
    return row ? memberOf(row) : undefined;
  }

  /** The Director's row; always there (seeded). */
  director(): TeamMember {
    return this.get(DIRECTOR_ROLE)!;
  }

  /** Change an existing member; undefined when there is none. */
  update(role: string, patch: MemberPatch): TeamMember | undefined {
    const cur = this.get(role);
    if (!cur) return undefined;
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as TeamMember;
    this.db
      .query("UPDATE team_members SET title = ?, i18n = ?, agent = ?, summary = ?, model = ?, permission = ?, enabled = ?, updated_at = ? WHERE role = ?")
      .run(next.title, JSON.stringify(next.i18n), next.agent, next.summary, next.model, next.permission, next.enabled ? 1 : 0, this.now(), role);
    return this.get(role);
  }

  /** Add a member the person chose. */
  add(m: Omit<TeamMember, "updatedAt" | "builtin">): TeamMember {
    this.db
      .query("INSERT INTO team_members (role, title, i18n, agent, summary, model, permission, enabled, builtin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
      .run(m.role, m.title, JSON.stringify(m.i18n), m.agent, m.summary, m.model, m.permission, m.enabled ? 1 : 0, this.now());
    return this.get(m.role)!;
  }

  /** Remove a member the person added; a built-in row stays (false). */
  remove(role: string): boolean {
    return this.db.query("DELETE FROM team_members WHERE role = ? AND builtin = 0").run(role).changes > 0;
  }

  /** Several changes at once: all of them, or none when one throws. */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
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
