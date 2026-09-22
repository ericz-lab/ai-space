import { cp, mkdir, readdir, rename, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SPACE_ROOT } from "../space/config.ts";
import { readWorkspaceEnv, resolveHome, workspacePaths } from "../space/workspace.ts";
import { need, noMore, parseArgs, parseCount } from "./args.ts";
import { type Ctx, UsageError } from "./types.ts";

/**
 * `space app new NAME`: the `new-app` command of docs/app-spec.md. Copies
 * the `space-app` skill's template, fills in the name, title and port,
 * `git init` and a first commit, then a private GitHub repository under
 * `SPACE_GITHUB_OWNER` (workspace `.env`) unless `--no-github` or nothing is
 * configured. Registers nothing: putting the directory under `apps/` (or a
 * clone of the repository there) is the registration.
 */

export const TEMPLATE_DIR = join(SPACE_ROOT, "skills", "space-app", "templates");
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Files the template keeps under a name git or bun would otherwise act on. */
const RENAMES: Record<string, string> = { "env.example": ".env.example", gitignore: ".gitignore" };
const PLACEHOLDER_NAME = "my-app";
const PLACEHOLDER_TITLE = "My App";
const PLACEHOLDER_PORT = "8710";

export type NewAppOptions = {
  name: string;
  dir: string;
  title: string;
  port: number;
  github: false | { owner: string; visibility: string };
  templateDir?: string;
  /** `git` and `gh`, run in the app directory; a test replaces it. */
  exec?: (cmd: string[], cwd: string, env?: Record<string, string>) => Promise<{ code: number; out: string; err: string }>;
  log?: (line: string) => void;
};

export type NewAppResult = { dir: string; files: string[]; committed: boolean; repo?: string; note?: string };

export async function createApp(opts: NewAppOptions): Promise<NewAppResult> {
  if (!NAME_RE.test(opts.name)) throw new UsageError("NAME must be lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit");
  const dir = resolve(opts.dir);
  if (await exists(dir)) throw new UsageError(`${dir} already exists`);
  const templateDir = opts.templateDir ?? TEMPLATE_DIR;
  if (!(await exists(templateDir))) throw new Error(`template not found at ${templateDir}`);
  const exec = opts.exec ?? spawn;
  const log = opts.log ?? (() => {});

  await mkdir(dir, { recursive: true });
  await cp(templateDir, dir, { recursive: true });
  for (const [from, to] of Object.entries(RENAMES)) if (await exists(join(dir, from))) await rename(join(dir, from), join(dir, to));
  const files = await walk(dir);
  for (const file of files) {
    const path = join(dir, file);
    const text = await Bun.file(path).text();
    const filled = text.replaceAll(PLACEHOLDER_NAME, opts.name).replaceAll(PLACEHOLDER_TITLE, opts.title).replaceAll(PLACEHOLDER_PORT, String(opts.port));
    if (filled !== text) await Bun.write(path, filled);
  }
  log(`${files.length} files from the template in ${dir}`);

  let committed = false;
  const git = async (...args: string[]) => exec(["git", ...args], dir);
  const initr = await git("init", "-q", "-b", "main");
  if (initr.code !== 0) return { dir, files, committed, note: `git init failed: ${initr.err.trim() || initr.out.trim()}` };
  await git("add", "-A");
  const commit = await git("commit", "-q", "-m", `feat: ${opts.name} from the ai-space app template`);
  committed = commit.code === 0;
  if (!committed) return { dir, files, committed, note: `first commit failed: ${commit.err.trim() || commit.out.trim()} (is git configured with a user name and email?)` };
  log("git repository initialised, first commit made");

  if (!opts.github) return { dir, files, committed };
  const full = `${opts.github.owner}/${opts.name}`;
  const gh = await exec(["gh", "repo", "create", full, `--${opts.github.visibility}`, "--source", ".", "--remote", "origin", "--push"], dir);
  if (gh.code !== 0) return { dir, files, committed, note: `gh repo create ${full} failed: ${(gh.err || gh.out).trim().slice(0, 300)}; add the origin by hand and set repo: in space.yaml` };
  const remote = await git("remote", "get-url", "origin");
  const repo = remote.code === 0 ? remote.out.trim() : `https://github.com/${full}.git`;
  const manifest = join(dir, "space.yaml");
  const yaml = await Bun.file(manifest).text();
  const withRepo = yaml.includes("# repo: ") ? yaml.replace(/^# repo: .*$/m, `repo: ${repo}`) : `${yaml.replace(/\n$/, "")}\nrepo: ${repo}\n`;
  await Bun.write(manifest, withRepo);
  await git("add", "space.yaml");
  await git("commit", "-q", "-m", "chore: record the repository url in the manifest");
  await git("push", "-q");
  log(`repository ${repo} created and pushed`);
  return { dir, files, committed, repo };
}

export async function newApp(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, { dir: { kind: "value" }, title: { kind: "value" }, port: { kind: "value" }, "no-github": { kind: "bool" } });
  const name = need(positional, 0, "NAME");
  noMore(positional, 1);
  const env = { ...(await readWorkspaceEnv(workspacePaths(resolveHome(ctx.io.env))).catch(() => ({}))), ...ctx.io.env };
  const owner = env.SPACE_GITHUB_OWNER?.trim();
  const github = flags["no-github"] || !owner ? (false as const) : { owner, visibility: env.SPACE_GITHUB_VISIBILITY?.trim() || "private" };
  const r = await createApp({
    name,
    dir: flags.dir ? resolve(ctx.io.cwd, flags.dir) : resolve(ctx.io.cwd, name),
    title: flags.title ?? titleOf(name),
    port: parseCount(flags.port, Number(PLACEHOLDER_PORT), "--port"),
    github,
    log: (l) => ctx.io.err(`[space] app new: ${l}`),
  });
  if (ctx.flags.json) {
    ctx.print.data({ ok: !r.note, ...r });
    return r.note ? 1 : 0;
  }
  ctx.print.line(`${name}: created in ${r.dir}${r.repo ? `, repository ${r.repo}` : github ? "" : " (no repository: --no-github, or SPACE_GITHUB_OWNER is not set)"}`);
  if (r.note) ctx.io.err(`space: app new: ${r.note}`);
  ctx.print.line(`next: edit space.yaml (delete the sections the app does not need), then put the directory under apps/ and run space app sync`);
  return r.note ? 1 : 0;
}

export function titleOf(name: string): string {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(" ");
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = rel ? join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(root, path)));
    else out.push(path);
  }
  return out.sort();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function spawn(cmd: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, ...env } });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code, out, err };
}
