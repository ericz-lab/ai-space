import { stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * After the Fix Engineer fixed an app on another machine and pushed the commit to the app's
 * `origin`, the app's own machine takes it: in `<workspace>/app-src/<app>`, a fast-forward from
 * `origin`, then a push to the `deploy` remote, whose hook runs `space app deploy` with the
 * manifest's checks (docs/app-spec.md#deploy). Anything unexpected — no checkout, local changes,
 * another branch, a history that does not fast-forward, no deploy remote — stops it and says why;
 * the person deploys by hand then.
 */

export type Runner = (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; out: string }>;

export const gitRunner: Runner = async (args, opts) => {
  const spawn = () => Bun.spawn(["git", ...args], { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  let p: ReturnType<typeof spawn>;
  try {
    p = spawn();
  } catch (e) {
    // Bun throws instead of exiting non-zero when git cannot start, e.g. a missing cwd.
    return { code: -1, out: (e as Error).message };
  }
  const timer = setTimeout(() => p.kill(), opts.timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out: `${out}${err}`.trim() };
};

export async function deployFromOrigin(home: string, app: string, run: Runner = gitRunner): Promise<{ ok: boolean; log: string }> {
  const dir = join(home, "app-src", app);
  const log: string[] = [];
  const step = async (args: string[], timeoutMs = 120_000) => {
    const r = await run(args, { cwd: dir, timeoutMs });
    log.push(`$ git ${args.join(" ")}${r.out ? `\n${r.out.slice(-1500)}` : ""}`);
    return r;
  };
  const fail = (why: string) => ({ ok: false, log: [why, ...log].join("\n") });
  // Without the folder, git cannot even start and Bun reports it as a missing `git` binary.
  if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) return fail(`no source checkout at app-src/${app} on this machine; deploy by hand from where the source lives`);
  if ((await step(["rev-parse", "--show-toplevel"])).code !== 0) return fail(`no source checkout at app-src/${app}`);
  const branch = (await step(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim();
  if (branch !== "main") return fail(`app-src/${app} is on ${branch || "no branch"}, not main`);
  if ((await step(["status", "--porcelain"])).out.trim()) return fail(`app-src/${app} has local changes`);
  if ((await step(["remote", "get-url", "deploy"])).code !== 0) return fail(`app-src/${app} has no deploy remote`);
  if ((await step(["pull", "--ff-only", "origin", "main"])).code !== 0) return fail("origin/main does not fast-forward this checkout");
  // The deploy remote's hook runs the manifest's install and checks before the service restarts.
  const push = await step(["push", "deploy", "HEAD:main"], 15 * 60_000);
  if (push.code !== 0) return fail("the deploy push failed; the running version is unchanged");
  return { ok: true, log: log.join("\n") };
}
