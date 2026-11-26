import { homedir } from "node:os";
import { join } from "node:path";
import { SHARED_SKILLS } from "../space/config.ts";
import { cloneDefaultApps, describeInstalls, installDefaultApps, newPackagePort, newWorkspaceEnv, parseDefaultApps } from "../space/defaults.ts";
import { RUNTIMES_FILE } from "../space/runtimes/config.ts";
import { RUNTIME_ENV, type Runtimes, findRuntimes, renderRuntimesYaml } from "../space/runtimes/discover.ts";
import { loadRouterConfig, renderCaddyfile } from "../space/router/index.ts";
import { codexUpgrade } from "../space/runtimes/codex-upgrade.ts";
import { EXTENSIONS, EXTENSION_TITLES, type Extension, SetupAborted, realDeps, runSetup, terminalIO } from "../space/setup.ts";
import { describeSkillLinks, linkSkills } from "../space/skills.ts";
import { discoverApps, ensureWorkspace, readWorkspaceEnv, resolveHome } from "../space/workspace.ts";
import { noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";
import { WorkspaceBusy, acquireWorkspaceLock } from "../space/instance.ts";
import { readVersion } from "../space/version.ts";
import { EDITION } from "../space/identity.ts";

/**
 * The commands that work with no ai-space running, or that start it:
 * `init`, `install-defaults`, `setup`, `start`. What `src/index.ts` did
 * before the CLI, unchanged.
 */

/** How `init` looks for the agent CLIs of a new workspace; tests replace it. */
export const initDeps = { findRuntimes: (env: Record<string, string | undefined>) => findRuntimes(env, env.HOME?.trim() || homedir()) };

/** Whether nothing listens on the loopback port. */
export function portFree(port: number): boolean {
  try {
    Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }).stop(true);
    return true;
  } catch {
    return false;
  }
}

/** A loopback port nothing listens on now. */
export function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/**
 * A new workspace (`init` creates its `.env`) starts usable without editing anything
 * (docs/install.md#a-new-workspace): the `.env` gets `newWorkspaceEnv`'s defaults, and
 * `runtimes.yaml` the agent CLIs found on this machine, when the workspace has no such file and
 * the environment names no runtime.
 */
async function newWorkspace(home: string, env: Record<string, string | undefined>): Promise<{ envText: string; looked: boolean; runtimes?: { text: string; found: string[] } }> {
  let runtimes: { text: string; found: string[] } | undefined;
  const wanted = !RUNTIME_ENV.some((k) => env[k]?.trim()) && !(await Bun.file(join(home, RUNTIMES_FILE)).exists());
  if (wanted) {
    const r: Runtimes = await initDeps.findRuntimes(env);
    const text = renderRuntimesYaml(r, ["# Written by init for this new workspace: the agent CLIs found on this machine (docs/runtimes.md).", "# Edit freely; init writes this file only when it creates the workspace's .env."]);
    if (text) runtimes = { text, found: (Object.keys(r) as (keyof Runtimes)[]).filter((k) => r[k]) };
  }
  // SPACE_MODEL_DEFAULT's built-in `sonnet` names a Claude model; without Claude Code the default runtime's tier stands in for it.
  const modelDefault = runtimes && !runtimes.found.includes("claude") ? "junior" : undefined;
  return { envText: newWorkspaceEnv(env, { packagePort: newPackagePort(env, portFree, freePort), modelDefault }), looked: wanted, runtimes };
}

const init = (installDefaults: boolean) => async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const err = ctx.io.err;
  const home = resolveHome(ctx.io.env);
  let fresh: Awaited<ReturnType<typeof newWorkspace>> | undefined;
  const newEnv = installDefaults ? undefined : async () => (fresh = await newWorkspace(home, ctx.io.env)).envText;
  const { ws, created, updated } = await ensureWorkspace(home, ctx.io.env, { newEnv });
  for (const p of created) err(`[space] created ${p}`);
  for (const p of updated) err(`[space] regenerated ${p}`);
  if (fresh?.runtimes) {
    await Bun.write(join(ws.home, RUNTIMES_FILE), fresh.runtimes.text);
    err(`[space] runtimes: wrote ${join(ws.home, RUNTIMES_FILE)} with ${fresh.runtimes.found.join(", ")}`);
  } else if (fresh?.looked) err("[space] runtimes: no agent CLI found (claude, codex, dsh); add one later in Settings, Models");
  // Default apps (src/space/defaults.ts): SPACE_DEFAULT_APPS from the environment or the workspace .env.
  // `init` clones them; `install-defaults` runs their installers after boot, when their space.env exists.
  const env = { ...(await readWorkspaceEnv(ws)), ...ctx.io.env };
  try {
    const apps = parseDefaultApps(env);
    const log = (l: string) => err(`[space] default apps: ${l}`);
    const reports = installDefaults ? await installDefaultApps(ws, apps, { log, supervisor: env.SPACE_SUPERVISOR?.trim() === "space" ? "space" : "operator" }) : await cloneDefaultApps(ws, apps, { log });
    err(`[space] default apps: ${describeInstalls(reports)}`);
  } catch (e) {
    err(`[space] default apps: ${(e as Error).message}`);
  }
  if (installDefaults) return 0;
  err(`[space] skills: ${describeSkillLinks(await linkSkills(ws.home, SHARED_SKILLS, await discoverApps(ws)))}`);
  // With the router on, the caddy unit needs a file to start from before any app exists.
  const router = loadRouterConfig(env).config;
  const caddyfile = join(ws.run, "Caddyfile");
  if (router.backend === "caddy" && !(await Bun.file(caddyfile).exists())) {
    await Bun.write(caddyfile, renderCaddyfile([], { port: router.port, socket: join(ws.run, "caddy.sock"), logDir: join(ws.logs, "router"), spacePort: Number(env.SPACE_PORT ?? 8700), fallback: router.fallback }));
    err(`[space] router: wrote ${caddyfile} with no routes yet; the caddy unit can start`);
  }
  err(`[space] workspace ready at ${ws.home}`);
  return 0;
};

const setup = (only?: Extension) => async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const { ws } = await ctx.workspace();
  try {
    await runSetup(realDeps(terminalIO(), ws), only ? { only } : {});
  } catch (e) {
    if (!(e instanceof SetupAborted)) throw e;
    ctx.io.err("\n[space] setup: input closed before the end; nothing written");
    return 1;
  }
  return 0;
};

const start = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  if (!ctx.boot) throw new UsageError("start is only available through the entry point (bun src/index.ts)");
  const { ws, config } = await ctx.workspace();
  // One service per workspace: a second one would run a second scheduler on the same data (src/space/instance.ts).
  try {
    await acquireWorkspaceLock(ws.run, ws.home, { port: config.port, edition: EDITION, version: await readVersion() });
  } catch (e) {
    if (e instanceof WorkspaceBusy) return ctx.io.err(`[space] ${e.message}`), 1;
    throw e;
  }
  await ctx.boot(ws, config);
  // boot serves until a signal ends the process; the exit code is the process's.
  return await new Promise<number>(() => {});
};

const upgradeCodex = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { "dry-run": { kind: "bool" }, "no-update": { kind: "bool" }, "no-restart": { kind: "bool" } });
  noMore(positional, 0);
  const { ws } = await ctx.workspace();
  const r = await codexUpgrade({ home: ws.home, dryRun: flags["dry-run"], skipUpdate: flags["no-update"], restart: !flags["no-restart"], log: (l) => ctx.io.err(`[space] codex: ${l}`) });
  for (const f of r.failures) ctx.io.err(`[space] codex: ${f}`);
  return r.failures.length ? 1 : 0;
};

export const lifecycleNouns: Noun[] = [
  { name: "init", summary: "create the workspace, clone the default apps, link the skills, and exit", defaultVerb: "run", verbs: { run: { usage: "", summary: "create ~/.ai-space (SPACE_HOME) and what a first boot needs", run: init(false) } } },
  { name: "install-defaults", summary: "run the default apps' own installers, once ai-space is up", defaultVerb: "run", verbs: { run: { usage: "", summary: "each default app's deploy/install.sh", run: init(true) } } },
  {
    name: "setup",
    summary: "interactive walk-through that fills the workspace .env: the basic install, then optional extensions",
    defaultVerb: "run",
    verbs: {
      run: { usage: "", summary: "the basic install (tools, core, services), then offers the extensions; restarts the unit", run: setup() },
      ...Object.fromEntries(EXTENSIONS.map((ext) => [ext, { usage: "", summary: EXTENSION_TITLES[ext], run: setup(ext) }])),
    },
  },
  { name: "codex-upgrade", summary: "update the Codex CLI; its catalogue gives each codex tier the newest model", defaultVerb: "run", verbs: { run: { usage: "[--dry-run] [--no-update] [--no-restart]", summary: "codex update on every machine a codex runtime uses, a probe of each tier's model, then restart", run: upgradeCodex } } },
  { name: "start", summary: "boot: ensure the workspace, sync the apps, serve the Space API", defaultVerb: "run", verbs: { run: { usage: "", summary: "what the unit runs", run: start } } },
];
