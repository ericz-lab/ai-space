import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPACE_ROOT } from "../space/config.ts";
import { readOwnership, readRelease } from "../space/local.ts";
import { ServiceError, type ServiceStatus, planUninstall, realServiceDeps, releasePrefix, runUninstall, serviceInstall, serviceRemove, serviceRestart, serviceStart, serviceStatus, serviceStop, serviceWorkspace } from "../space/service.ts";
import { noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * ai-space's own installation on this machine (docs/release.md): `space service` drives its
 * background service under systemd or launchd, `space upgrade` installs the newest release over
 * this one, `space uninstall` removes it, `space open` opens the panel. They touch the disk and
 * the service manager directly, so they work with ai-space down.
 */

const REPO = "ericz-lab/ai-space";

const deps = (ctx: Ctx, over: { root?: string; bun?: string } = {}) => ({ ...realServiceDeps(ctx.flags.json ? () => {} : (l) => ctx.io.err(`[service] ${l}`), over), env: ctx.io.env });

function show(ctx: Ctx, s: ServiceStatus): void {
  ctx.print.kv([
    ["service", `${s.name} (${s.manager}${s.kind === "local" ? ", the AI Space app's" : ""})`],
    ["state", !s.installed ? "not installed" : s.running ? `running, pid ${s.pid}` : `${s.enabled ? "stopped" : "stopped, off at login"} (${s.detail})`],
    ["file", s.file],
    ["workspace", s.workspace],
    ["logs", s.logs],
  ]);
}

async function guarded(ctx: Ctx, work: () => Promise<ServiceStatus>): Promise<number> {
  try {
    const s = await work();
    if (ctx.flags.json) ctx.print.data({ ok: true, ...s });
    else show(ctx, s);
    return 0;
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    if (ctx.flags.json) ctx.print.data({ ok: false, code: e.code, error: e.message });
    else ctx.io.err(`error: ${e.message}`);
    return 1;
  }
}

const plain = (fn: typeof serviceStatus) => (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  return guarded(ctx, () => fn(deps(ctx)));
};

const install = (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, { root: { kind: "value" }, bun: { kind: "value" } });
  noMore(p.positional, 0);
  return guarded(ctx, () => serviceInstall(deps(ctx, { ...(typeof p.flags.root === "string" ? { root: p.flags.root } : {}), ...(typeof p.flags.bun === "string" ? { bun: p.flags.bun } : {}) })));
};

const workspace = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const path = await serviceWorkspace(deps(ctx));
  if (ctx.flags.json) ctx.print.data({ ok: true, workspace: path });
  else ctx.print.line(path);
  return 0;
};

export const serviceNoun: Noun = {
  name: "service",
  summary: "ai-space's own background service on this machine (systemd on Linux, launchd on a Mac)",
  defaultVerb: "status",
  verbs: {
    status: { usage: "", summary: "the unit, whether it runs, its workspace, where its log is", run: plain(serviceStatus) },
    install: { usage: "[--root <dir>] [--bun <path>]", summary: "write the unit for this code and workspace and (re)start it; what deploy/install.sh runs", run: install },
    start: { usage: "", summary: "start it and keep it on at login", run: plain(serviceStart) },
    stop: { usage: "", summary: "stop it (its work drains) and keep it off until started again", run: plain(serviceStop) },
    restart: { usage: "", summary: "restart it, for example after editing .env", run: plain(serviceRestart) },
    remove: { usage: "", summary: "stop and unregister it; the program and the workspace stay", run: plain(serviceRemove) },
    workspace: { usage: "", summary: "print the workspace it runs on: SPACE_HOME, else the installed unit's, else ~/.ai-space", run: workspace },
  },
};

// ------------------------------------------------------------------ upgrade

type ReleaseManifest = { version: string; commit: string };

function downloadBase(env: Record<string, string | undefined>, version: string | undefined): string {
  const mirror = env.AI_SPACE_DOWNLOAD?.trim();
  if (mirror) return mirror.replace(/\/+$/, "");
  return version ? `https://github.com/${REPO}/releases/download/v${version}` : `https://github.com/${REPO}/releases/latest/download`;
}

async function download(ctx: Ctx, url: string): Promise<Response> {
  // `file://` is what a mirror on disk and the tests use; fetch reads it like any other address.
  const r = await ctx.io.fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`could not download ${url} (HTTP ${r.status})`);
  return r;
}

/** Numeric comparison of `major.minor.patch`; anything after the numbers is ignored. */
export function newer(a: string, b: string): boolean {
  const n = (v: string) => v.replace(/^v/, "").split(/[.+-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

/**
 * `space upgrade`: the one-command installer of the release asked for, run over this
 * installation: same program directory, same workspace. It checks the archive against the
 * release's SHA256SUMS, switches `current`, restarts the service, waits for its health check and
 * puts the previous release back when the new one does not answer (release/install.sh).
 */
const upgrade = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { version: { kind: "value" }, check: { kind: "bool" }, force: { kind: "bool" } });
  noMore(positional, 0);
  const d = deps(ctx);
  const here = await readRelease(await realpath(SPACE_ROOT).catch(() => SPACE_ROOT));
  const prefix = await releasePrefix(SPACE_ROOT);
  if (here?.edition === "local" || (await readOwnership(await serviceWorkspace(d)))) throw new UsageError("this ai-space was installed by the AI Space app (the Local edition): update it from the app");
  if (!here || !prefix) throw new UsageError(`${SPACE_ROOT} is a checkout, not a release: update it with git pull, then bash deploy/install.sh`);
  const want = typeof flags.version === "string" ? flags.version.replace(/^v/, "") : undefined;
  const base = downloadBase(ctx.io.env, want);
  const latest = (await (await download(ctx, `${base}/manifest.json`)).json()) as ReleaseManifest;
  const target = latest.version;
  const upToDate = target === here.version && latest.commit === here.commit;
  if (flags.check || (upToDate && !flags.force)) {
    if (ctx.flags.json) ctx.print.data({ ok: true, installed: here.version, available: target, newer: newer(target, here.version), upToDate });
    else ctx.print.line(upToDate ? `ai-space ${here.version} is the ${want ? "release asked for" : "newest release"}` : `ai-space ${here.version} is installed; ${target} is available${flags.check ? ": space upgrade" : ""}`);
    return 0;
  }
  const tmp = await mkdtemp(join(tmpdir(), "ai-space-upgrade-"));
  try {
    const script = join(tmp, "install.sh");
    await Bun.write(script, await (await download(ctx, `${base}/install.sh`)).text());
    ctx.io.err(`[upgrade] ai-space ${here.version} → ${target}`);
    const proc = Bun.spawn(["bash", script], {
      env: { ...ctx.io.env, AI_SPACE_VERSION: target, AI_SPACE_PREFIX: prefix, SPACE_HOME: await serviceWorkspace(d), AI_SPACE_NO_OPEN: "1" },
      stdin: "ignore",
      stdout: ctx.flags.json ? "ignore" : "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (ctx.flags.json) ctx.print.data({ ok: code === 0, from: here.version, to: target });
    return code === 0 ? 0 : 1;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

export const upgradeNoun: Noun = {
  name: "upgrade",
  bare: true,
  summary: "install the newest release over this one (a release installation; the workspace is kept)",
  defaultVerb: "run",
  verbs: { run: { usage: "[--version <x.y.z>] [--check] [--force]", summary: "download, check and install it, restart the service, roll back if it does not answer; --check only says what is available", run: upgrade } },
};

// ---------------------------------------------------------------- uninstall

const uninstall = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { workspace: { kind: "bool" }, yes: { kind: "bool", alias: "y" }, "dry-run": { kind: "bool" } });
  noMore(positional, 0);
  const d = deps(ctx);
  let plan;
  try {
    plan = await planUninstall(d, { workspace: Boolean(flags.workspace) });
  } catch (e) {
    if (!(e instanceof ServiceError)) throw e;
    if (ctx.flags.json) ctx.print.data({ ok: false, code: e.code, error: e.message });
    else ctx.io.err(`error: ${e.message}`);
    return 1;
  }
  if (flags["dry-run"]) {
    if (ctx.flags.json) ctx.print.data({ ok: true, dryRun: true, ...plan });
    else {
      ctx.print.lines(plan.steps.length ? ["would:", ...plan.steps.map((s) => `  ${s.detail}`)] : ["nothing to remove"]);
      if (plan.kept.length) ctx.print.lines(["keeps:", ...plan.kept.map((k) => `  ${k}`)]);
    }
    return 0;
  }
  if (!plan.steps.length) {
    if (ctx.flags.json) ctx.print.data({ ok: true, ...plan });
    else ctx.print.line("nothing to remove");
    return 0;
  }
  if (!flags.yes) {
    if (!ctx.io.isTTY) throw new UsageError("uninstall asks before it removes anything; pass --yes to go ahead without a terminal (--dry-run shows what it would do)");
    for (const s of plan.steps) ctx.io.err(`  ${s.detail}`);
    for (const k of plan.kept) ctx.io.err(`  keeps ${k}`);
    const answer = (await ctx.io.prompt(flags.workspace ? "Delete ai-space AND all its data? Type yes: " : "Remove ai-space from this machine? [y/N] ")).trim().toLowerCase();
    if (flags.workspace ? answer !== "yes" : !["y", "yes"].includes(answer)) return ctx.io.err("nothing removed"), 1;
  }
  await runUninstall(d, plan);
  if (ctx.flags.json) ctx.print.data({ ok: true, ...plan });
  else {
    ctx.print.line("ai-space removed");
    for (const k of plan.kept) ctx.print.line(`kept ${k}`);
  }
  return 0;
};

export const uninstallNoun: Noun = {
  name: "uninstall",
  bare: true,
  summary: "remove ai-space from this machine: its service, the apps' services, the program; the workspace only with --workspace",
  defaultVerb: "run",
  verbs: { run: { usage: "[--workspace] [--yes] [--dry-run]", summary: "stop and unregister the services and delete the program; --workspace also deletes every app, database and setting", run: uninstall } },
};

// --------------------------------------------------------------------- open

/** The program that opens an address in the user's browser, when this session has a screen. */
export function opener(env: Record<string, string | undefined>, platform = process.platform, which: (name: string) => string | null = Bun.which): string[] | undefined {
  if (env.SSH_CONNECTION?.trim()) return undefined;
  if (platform === "darwin") return ["open"];
  if ((env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) && which("xdg-open")) return ["xdg-open"];
  return undefined;
}

const open = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { print: { kind: "bool" } });
  noMore(positional, 0);
  const c = await ctx.client();
  const url = `${c.url}/`;
  const cmd = flags.print ? undefined : opener(ctx.io.env);
  const opened = cmd ? (await Bun.spawn([...cmd, url], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited) === 0 : false;
  if (ctx.flags.json) ctx.print.data({ ok: true, url, opened });
  else ctx.print.line(url);
  if (!opened && !flags.print && !ctx.flags.json && ctx.io.env.SSH_CONNECTION?.trim()) {
    const port = new URL(url).port || "80";
    ctx.io.err(`over SSH the panel is on this machine's loopback; from your own computer: ssh -L ${port}:127.0.0.1:${port} <this machine>, then open ${url}`);
  }
  return 0;
};

export const openNoun: Noun = {
  name: "open",
  bare: true,
  summary: "open the panel in the browser, or print its address",
  defaultVerb: "run",
  verbs: { run: { usage: "[--print]", summary: "the panel of the ai-space this command talks to; --print only prints the address", run: open } },
};
