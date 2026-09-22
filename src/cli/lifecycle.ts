import { join } from "node:path";
import { SHARED_SKILLS } from "../space/config.ts";
import { cloneDefaultApps, describeInstalls, installDefaultApps, parseDefaultApps } from "../space/defaults.ts";
import { loadRouterConfig, renderCaddyfile } from "../space/router/index.ts";
import { SetupAborted, realDeps, runSetup, terminalIO } from "../space/setup.ts";
import { describeSkillLinks, linkSkills } from "../space/skills.ts";
import { discoverApps, ensureWorkspace, readWorkspaceEnv, resolveHome } from "../space/workspace.ts";
import { noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * The commands that work with no ai-space running, or that start it:
 * `init`, `install-defaults`, `setup`, `start`. What `src/index.ts` did
 * before the CLI, unchanged.
 */

const init = (installDefaults: boolean) => async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const err = ctx.io.err;
  const { ws, created, updated } = await ensureWorkspace(resolveHome(ctx.io.env), ctx.io.env);
  for (const p of created) err(`[space] created ${p}`);
  for (const p of updated) err(`[space] regenerated ${p}`);
  // Default apps (src/space/defaults.ts): SPACE_DEFAULT_APPS from the environment or the workspace .env.
  // `init` clones them; `install-defaults` runs their installers after boot, when their space.env exists.
  const env = { ...(await readWorkspaceEnv(ws)), ...ctx.io.env };
  try {
    const apps = parseDefaultApps(env);
    const log = (l: string) => err(`[space] default apps: ${l}`);
    const reports = installDefaults ? await installDefaultApps(ws, apps, { log }) : await cloneDefaultApps(ws, apps, { log });
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
    await Bun.write(caddyfile, renderCaddyfile([], { port: router.port, socket: join(ws.run, "caddy.sock"), logDir: join(ws.logs, "router") }));
    err(`[space] router: wrote ${caddyfile} with no routes yet; the caddy unit can start`);
  }
  err(`[space] workspace ready at ${ws.home}`);
  return 0;
};

const setup = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const { ws } = await ctx.workspace();
  try {
    await runSetup(realDeps(terminalIO(), ws));
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
  await ctx.boot(ws, config);
  // boot serves until a signal ends the process; the exit code is the process's.
  return await new Promise<number>(() => {});
};

export const lifecycleNouns: Noun[] = [
  { name: "init", summary: "create the workspace, clone the default apps, link the skills, and exit", defaultVerb: "run", verbs: { run: { usage: "", summary: "create ~/.ai-space (SPACE_HOME) and what a first boot needs", run: init(false) } } },
  { name: "install-defaults", summary: "run the default apps' own installers, once ai-space is up", defaultVerb: "run", verbs: { run: { usage: "", summary: "each default app's deploy/install.sh", run: init(true) } } },
  { name: "setup", summary: "interactive first-install walk-through that fills the workspace .env", defaultVerb: "run", verbs: { run: { usage: "", summary: "asks for every value, sends a test message, probes the bucket, restarts the unit", run: setup } } },
  { name: "start", summary: "boot: ensure the workspace, sync the apps, serve the Space API", defaultVerb: "run", verbs: { run: { usage: "", summary: "what the unit runs", run: start } } },
];
