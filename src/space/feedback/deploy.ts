import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { deployRepo } from "../workspace.ts";

/**
 * After the Fix Engineer fixed an app on another machine and pushed the commit to the app's
 * `origin`, the app's own machine takes it: in `<workspace>/app-src/<app>`, a fast-forward from
 * `origin`, then a push to the `deploy` remote, whose hook runs `space app deploy` with the
 * manifest's checks (docs/app-spec.md#deploy). A missing checkout is cloned from the manifest's
 * `repo:` first, with the host's `<workspace>/repos/<app>.git` as its deploy remote when that repository exists.
 *
 * An app without a deploy remote whose `<workspace>/apps/<app>` is itself a git clone needs no
 * bare repository: the commit is fetched into that clone from `app-src/<app>` and `space app
 * deploy --rev` runs here, the same command the hook would run. The clone must be at a commit the
 * new one contains, as a push to a bare repository would require.
 *
 * Anything unexpected — a clone that fails, local changes, another branch, a history that does not
 * fast-forward, neither a deploy remote nor a cloned app directory — stops it and says why; the
 * person deploys by hand then.
 */

export type Runner = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;

const spawnRunner = (cmd: string[], env: Record<string, string>): Runner => async (args, opts) => {
  const spawn = () => Bun.spawn([...cmd, ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  let p: ReturnType<typeof spawn>;
  try {
    p = spawn();
  } catch (e) {
    // Bun throws instead of exiting non-zero when the command cannot start, e.g. a missing cwd.
    return { code: -1, out: (e as Error).message };
  }
  const timer = setTimeout(() => p.kill(), opts.timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out: `${out}${err}`.trim() };
};

export const gitRunner: Runner = spawnRunner(["git"], { GIT_TERMINAL_PROMPT: "0" });

/** The `space` CLI of this code, on the workspace `home`, with the Bun running this process. */
export const spaceRunner = (home: string): Runner => spawnRunner([process.execPath, join(import.meta.dir, "..", "..", "index.ts")], { SPACE_HOME: home });

export type DeployOptions = {
  /** The manifest's `repo:`, cloned into app-src/<app> when the checkout is missing. */
  repo?: string;
  /** The bare repository whose hook deploys the app (docs/app-spec.md#deploy); default `<workspace>/repos/<app>.git`. */
  gitDir?: string;
  run?: Runner;
  /** Runs `space <args>`: the deploy itself when the app has no bare repository. */
  space?: Runner;
};

const isDir = (path: string) => stat(path).then((s) => s.isDirectory(), () => false);
const exists = (path: string) => stat(path).then(() => true, () => false);

export async function deployFromOrigin(home: string, app: string, opts: DeployOptions = {}): Promise<{ ok: boolean; log: string }> {
  const { repo, gitDir = deployRepo(home, app), run = gitRunner, space = spaceRunner(home) } = opts;
  const src = join(home, "app-src");
  const dir = join(src, app);
  const live = join(home, "apps", app);
  const log: string[] = [];
  const record = (line: string, r: { code: number; out: string }) => {
    log.push(`$ ${line}${r.out ? `\n${r.out.slice(-1500)}` : ""}`);
    return r;
  };
  const step = async (args: string[], timeoutMs = 120_000, cwd = dir) => record(`git ${args.join(" ")}`, await run(args, { cwd, timeoutMs }));
  const fail = (why: string) => ({ ok: false, log: [why, ...log].join("\n") });
  // Without the folder git cannot even start (Bun reports it as a missing `git` binary), so clone it first.
  if (!(await isDir(dir))) {
    if (!repo) return fail(`no source checkout at app-src/${app}, and the manifest names no repo to clone`);
    await mkdir(src, { recursive: true });
    if ((await step(["clone", repo, app], 10 * 60_000, src)).code !== 0) return fail(`no source checkout at app-src/${app}, and cloning ${repo} failed`);
    if (await isDir(gitDir)) await step(["remote", "add", "deploy", gitDir]);
  }
  if ((await step(["rev-parse", "--show-toplevel"])).code !== 0) return fail(`no source checkout at app-src/${app}`);
  const branch = (await step(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  if (branch !== "main") return fail(`app-src/${app} is on ${branch || "no branch"}, not main`);
  if ((await step(["status", "--porcelain"])).out.trim()) return fail(`app-src/${app} has local changes`);
  const hasRemote = (await step(["remote", "get-url", "deploy"])).code === 0;
  if (!hasRemote && !(await exists(join(live, ".git")))) return fail(`app-src/${app} has no deploy remote, and apps/${app} is not a git clone to deploy into`);
  if ((await step(["pull", "--ff-only", "origin", "main"])).code !== 0) return fail("origin/main does not fast-forward this checkout");
  if (hasRemote) {
    // The deploy remote's hook runs the manifest's install and checks before the service restarts.
    const push = await step(["push", "deploy", "HEAD:main"], 15 * 60_000);
    if (push.code !== 0) return fail("the deploy push failed; the running version is unchanged");
    return { ok: true, log: log.join("\n") };
  }
  // No bare repository: the app directory is a clone, and takes the commit from this checkout.
  const rev = (await step(["rev-parse", "HEAD"])).out.trim();
  if (!/^[0-9a-f]{40,64}$/.test(rev)) return fail(`app-src/${app} has no commit to deploy`);
  if ((await step(["fetch", dir, "main"], 120_000, live)).code !== 0) return fail(`apps/${app} could not fetch the commit from app-src/${app}`);
  if ((await step(["merge-base", "--is-ancestor", "HEAD", rev], 120_000, live)).code !== 0) return fail(`apps/${app} is at a commit that origin/main does not contain; the running version is unchanged`);
  // `space app deploy` runs the manifest's install and checks before the service restarts.
  const args = ["app", "deploy", app, "--rev", rev];
  const deployed = record(`space ${args.join(" ")}`, await space(args, { cwd: home, timeoutMs: 15 * 60_000 }));
  if (deployed.code !== 0) return fail("space app deploy failed; the running version is unchanged");
  return { ok: true, log: log.join("\n") };
}
