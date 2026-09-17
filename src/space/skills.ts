import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

/**
 * One skill directory for the whole workspace.
 *
 * ai-space's shared skills (`skills/` in the checkout) and every app's skills
 * (`apps/<app>/skills/` per the app spec, plus an app's own `.claude/skills/`)
 * are linked into `<workspace>/.claude/skills/`, so a Claude Code session
 * started by hand anywhere in the workspace sees all of them, the same way a
 * project's own skills would be. Refreshed on boot, on `init` and on every
 * workspace sync (`POST /api/apps/sync`), so a skill an app adds or drops
 * shows up without a restart.
 *
 * Names: a skill keeps its directory name; shared skills win a collision and
 * the app's copy is linked as `<app>-<skill>` instead. Links into `apps/`, the
 * shared skills or an extra app directory that are no longer wanted are removed,
 * as are dangling ones; anything else in the directory (a real directory, a
 * link the user made elsewhere) is left alone and keeps its name.
 */

export const SKILL_FILE = "SKILL.md";
/** Where an app keeps its skills, in order of preference. */
export const APP_SKILL_DIRS = ["skills", join(".claude", "skills")] as const;

export type SkillSource = {
  /** Link name in the workspace skill directory. */
  name: string;
  /** The skill directory the link points to. */
  dir: string;
  /** `space` for a shared skill, else the app's directory name. */
  owner: string;
};

export type SkillLinkResult = {
  /** Where the links live. */
  dir: string;
  /** Every link the directory now holds, in link order. */
  linked: SkillSource[];
  /** Links removed because their source is gone or no longer wanted. */
  removed: string[];
  /** Skills linked under a prefixed name because a shared skill or an earlier app took theirs. */
  renamed: { owner: string; skill: string; name: string }[];
};

export function skillLinkDir(home: string): string {
  return join(home, ".claude", "skills");
}

/** Subdirectories of `dir` that carry a SKILL.md, sorted by name. */
export async function listSkills(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    if (await Bun.file(join(dir, name, SKILL_FILE)).exists()) out.push(join(dir, name));
  }
  return out;
}

/** Every skill directory an app ships, looking in each of `APP_SKILL_DIRS`. */
export async function appSkills(appDir: string): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sub of APP_SKILL_DIRS) {
    for (const dir of await listSkills(join(appDir, sub))) {
      const name = basename(dir);
      if (seen.has(name)) continue; // `skills/` wins over `.claude/skills/` for the same name
      seen.add(name);
      out.push(dir);
    }
  }
  return out;
}

/** The skills to link, shared first, then each app in the order given; names made unique. */
export async function collectSkills(shared: string | undefined, appDirs: string[]): Promise<{ sources: SkillSource[]; renamed: SkillLinkResult["renamed"] }> {
  const sources: SkillSource[] = [];
  const renamed: SkillLinkResult["renamed"] = [];
  const taken = new Set<string>();
  const add = (owner: string, dir: string) => {
    const skill = basename(dir);
    let name = skill;
    if (taken.has(name)) {
      name = `${owner}-${skill}`;
      if (taken.has(name)) return; // the same app dir listed twice; keep the first
      renamed.push({ owner, skill, name });
    }
    taken.add(name);
    sources.push({ name, dir: resolve(dir), owner });
  };
  if (shared) for (const dir of await listSkills(shared)) add("space", dir);
  for (const appDir of appDirs) {
    const owner = basename(resolve(appDir));
    for (const dir of await appSkills(appDir)) add(owner, dir);
  }
  return { sources, renamed };
}

/**
 * Make `<home>/.claude/skills/` hold exactly one link per skill in `shared` and
 * the apps. Idempotent; an existing link to the right place is kept as is.
 */
export async function linkSkills(home: string, shared: string | undefined, appDirs: string[]): Promise<SkillLinkResult> {
  const dir = skillLinkDir(home);
  const { sources, renamed } = await collectSkills(shared, appDirs);
  await mkdir(dir, { recursive: true });

  const wanted = new Map(sources.map((s) => [s.name, s.dir]));
  // Links into these are ours: the shared skills, the workspace's apps/ and any extra app dir.
  const roots = [shared, join(home, "apps"), ...appDirs].filter((p): p is string => !!p).map((p) => resolve(p) + "/");
  const removed: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    let st;
    try {
      st = await lstat(path);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    const target = resolve(dir, await readlink(path));
    if (wanted.get(name) === target) {
      wanted.delete(name); // already right
      continue;
    }
    // Ours to manage when it points into a skill source, or nowhere at all.
    const dangling = !(await Bun.file(join(target, SKILL_FILE)).exists());
    if (dangling || roots.some((r) => target.startsWith(r))) {
      await unlink(path);
      removed.push(name);
    } else {
      wanted.delete(name); // a link the user made; do not fight over the name
    }
  }
  for (const [name, target] of wanted) {
    try {
      await symlink(target, join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // a real directory of that name: the user's, keep it
    }
  }
  return { dir, linked: sources, removed, renamed };
}

/** One line for the boot log. */
export function describeSkillLinks(r: SkillLinkResult): string {
  const shared = r.linked.filter((s) => s.owner === "space").length;
  const apps = new Set(r.linked.filter((s) => s.owner !== "space").map((s) => s.owner)).size;
  const parts = [`${r.linked.length} skill${r.linked.length === 1 ? "" : "s"} linked (${shared} shared, ${r.linked.length - shared} from ${apps} app${apps === 1 ? "" : "s"}) in ${r.dir}`];
  if (r.removed.length) parts.push(`removed ${r.removed.join(", ")}`);
  for (const x of r.renamed) parts.push(`${x.owner}/${x.skill} linked as ${x.name} (name taken)`);
  return parts.join("; ");
}
