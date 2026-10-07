import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { loadManifest, type Manifest } from "../scheduler/manifest.ts";
import { installCommands } from "./spec.ts";

/**
 * The host side of a deploy (docs/app-spec.md#deploy): put a revision into the app directory, then
 * run the manifest's install, check and build commands there. Restarting is the caller's step and
 * happens only after this succeeds, so a failing type check or build never restarts the service.
 *
 * Where the revision comes from:
 *
 *   gitDir    the directory is the work tree of a bare repository (no `.git` inside it), the
 *             `git --work-tree` checkout most post-receive hooks do; the bare repository's index
 *             is the deployed tree, so the previous tree is `git write-tree` and HEAD never moves
 *   .git      the directory is a clone (its origin usually the bare repository); `reset --hard`
 *   neither   no revision: the commands run on what is there (an rsync deploy); nothing to restore
 *
 * On a failure after the checkout, the previous tree goes back and its install runs again, so the
 * files on disk match the process still running.
 */

export type DeployStep = "checkout" | "manifest" | "install" | "check" | "build";

export type Exec = (cmd: string[], cwd: string) => Promise<{ code: number; out: string; err: string }>;
/** Runs one manifest command with `/bin/sh -c` in `cwd`; its output goes to the log as it comes. */
export type Shell = (command: string, cwd: string) => Promise<number>;

export type PrepareOptions = {
  app: string;
  dir: string;
  /** The revision to deploy (a commit, branch or `origin/main`); absent: deploy what is in `dir`. */
  rev?: string;
  /** The bare repository whose work tree `dir` is. */
  gitDir?: string;
  exec?: Exec;
  shell?: Shell;
  log?: (line: string) => void;
};

export type PrepareResult =
  | { ok: true; manifest: Manifest; rev?: string; previous?: string }
  | { ok: false; step: DeployStep; error: string; rev?: string; previous?: string; restored?: boolean };

/** Hook variables that would point git and the commands at the repository the hook runs for. */
const GIT_LOCAL_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_QUARANTINE_PATH", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE"];

export function cleanEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !GIT_LOCAL_ENV.includes(k)) out[k] = v;
  return out;
}

/**
 * The environment of a manifest command: the hook's, without its repository variables, and with
 * the directory of the Bun running this deploy first on PATH, so `bun install` resolves in a hook
 * whose non-login shell never read the profile that adds ~/.bun/bin.
 */
export function commandEnv(env: Record<string, string | undefined> = process.env, bun = process.execPath): Record<string, string> {
  const out = cleanEnv(env);
  const dir = dirname(bun);
  const path = (out.PATH ?? "").split(delimiter).filter(Boolean);
  out.PATH = [dir, ...path.filter((p) => p !== dir)].join(delimiter);
  return out;
}

export async function prepareDeploy(opts: PrepareOptions): Promise<PrepareResult> {
  const exec = opts.exec ?? spawnCollect;
  const shell = opts.shell ?? shellStreaming(opts.log ?? (() => {}));
  const log = opts.log ?? (() => {});
  const { dir } = opts;
  if (!existsSync(dir)) return { ok: false, step: "checkout", error: `${dir} does not exist` };

  let source: Source | undefined;
  let rev: string | undefined;
  let previous: string | undefined;
  if (opts.rev) {
    const found = gitSource(opts, exec);
    if (typeof found === "string") return { ok: false, step: "checkout", error: found };
    source = found;
    const resolved = await source.resolve(opts.rev);
    if (!resolved) return { ok: false, step: "checkout", error: `${opts.rev} is not a commit in ${source.where}` };
    rev = resolved;
    previous = await source.current();
    const applied = await source.apply(rev);
    if (applied) return { ok: false, step: "checkout", error: applied, rev, ...(previous ? { previous } : {}) };
    log(`checked out ${rev.slice(0, 12)}${previous ? ` (was ${previous.slice(0, 12)})` : ""}`);
  }

  const fail = async (step: DeployStep, error: string): Promise<PrepareResult> => {
    const base = { ok: false as const, step, error, ...(rev ? { rev } : {}), ...(previous ? { previous } : {}) };
    if (!source || !previous) return base;
    log(`${step} failed: putting ${previous.slice(0, 12)} back`);
    const undo = await source.apply(previous);
    if (undo) {
      log(`could not restore ${previous.slice(0, 12)}: ${undo}`);
      return { ...base, restored: false };
    }
    const old = await loadManifest(dir).catch(() => undefined);
    for (const cmd of installCommands(old?.deploy, hasBunLock(dir))) {
      if ((await shell(cmd, dir)) !== 0) {
        log(`install of the restored tree failed: ${cmd}`);
        return { ...base, restored: false };
      }
    }
    return { ...base, restored: true };
  };

  let manifest: Manifest;
  try {
    manifest = await loadManifest(dir);
  } catch (e) {
    return fail("manifest", `space.yaml: ${(e as Error).message}`);
  }
  if (manifest.app !== opts.app) return fail("manifest", `space.yaml names the app "${manifest.app}", not "${opts.app}"`);

  const steps: [DeployStep, string[]][] = [
    ["install", installCommands(manifest.deploy, hasBunLock(dir))],
    ["check", manifest.deploy?.check ?? []],
    ["build", manifest.deploy?.build ?? []],
  ];
  for (const [step, commands] of steps) {
    for (const cmd of commands) {
      log(`${step}: ${cmd}`);
      const code = await shell(cmd, dir);
      if (code !== 0) return fail(step, `${cmd} exited with ${code}`);
    }
  }
  return { ok: true, manifest, ...(rev ? { rev } : {}), ...(previous ? { previous } : {}) };
}

type Source = {
  where: string;
  resolve: (rev: string) => Promise<string | undefined>;
  /** The deployed commit or tree, when one can be named. */
  current: () => Promise<string | undefined>;
  /** Undefined when done, else why not. */
  apply: (rev: string) => Promise<string | undefined>;
};

function gitSource(opts: PrepareOptions, exec: Exec): Source | string {
  const { dir, gitDir } = opts;
  const git = async (args: string[]) => {
    const r = await exec(["git", ...args], dir);
    return { ok: r.code === 0, out: r.out.trim(), err: (r.err.trim() || r.out.trim()) };
  };
  const commit = async (prefix: string[], rev: string) => {
    const r = await git([...prefix, "rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
    return r.ok && r.out ? r.out : undefined;
  };
  if (gitDir) {
    const g = [`--git-dir=${gitDir}`, `--work-tree=${dir}`];
    return {
      where: gitDir,
      resolve: (rev) => commit(g, rev),
      current: async () => {
        const r = await git([...g, "write-tree"]);
        return r.ok && r.out ? r.out : undefined;
      },
      // read-tree, not checkout: the bare repository's HEAD stays on its branch.
      apply: async (rev) => {
        const r = await git([...g, "read-tree", "-u", "--reset", rev]);
        return r.ok ? undefined : `git read-tree ${rev.slice(0, 12)}: ${r.err}`;
      },
    };
  }
  if (!existsSync(join(dir, ".git"))) return `${dir} is not a git checkout: pass --git-dir for the bare repository it is the work tree of, or deploy without --rev`;
  const c = ["-C", dir];
  return {
    where: dir,
    resolve: (rev) => commit(c, rev),
    current: () => commit(c, "HEAD"),
    apply: async (rev) => {
      const r = await git([...c, "reset", "-q", "--hard", rev]);
      return r.ok ? undefined : `git reset --hard ${rev.slice(0, 12)}: ${r.err}`;
    },
  };
}

function hasBunLock(dir: string): boolean {
  return existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"));
}

async function spawnCollect(cmd: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: cleanEnv() });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } catch (e) {
    return { code: 127, out: "", err: (e as Error).message };
  }
}

/** The default shell: the command's stdout and stderr, line by line, into the log. */
export function shellStreaming(log: (line: string) => void): Shell {
  return async (command, cwd) => {
    const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: commandEnv() });
    await Promise.all([lines(proc.stdout, log), lines(proc.stderr, log)]);
    return proc.exited;
  };
}

async function lines(stream: ReadableStream<Uint8Array>, log: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let partial = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    partial += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = partial.indexOf("\n")) >= 0) {
      log(`  ${partial.slice(0, i).replace(/\r$/, "")}`);
      partial = partial.slice(i + 1);
    }
  }
  partial += decoder.decode();
  if (partial) log(`  ${partial}`);
}
