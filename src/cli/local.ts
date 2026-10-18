import { LocalError, type LocalStatus, type Runtimes, localInstall, localRemoveService, localRestart, localStart, localStatus, localStop, realLocalDeps } from "../space/local.ts";
import { noMore, parseArgs } from "./args.ts";
import type { Ctx, Noun } from "./types.ts";

/**
 * `space local`: the Local edition's managed installation on this Mac (docs/local.md). The Mac app
 * runs these with `--json` through the Bun in its bundle; they also work by hand. They touch the
 * disk and launchd directly, so they work with ai-space down.
 */

function show(ctx: Ctx, s: LocalStatus): void {
  ctx.print.kv([
    ["state", s.state + (s.reason ? ` (${s.reason})` : "")],
    ["in this app", s.bundle ? `${s.bundle.version} ${s.bundle.commit.slice(0, 12)}` : ""],
    ["installed", s.installed ? `${s.installed.version} at ${s.installed.path}` : ""],
    ["workspace", `${s.workspace.path}${s.workspace.exists ? "" : " (none yet)"}`],
    ["service", `${s.service.label}: ${s.service.running ? `running, pid ${s.service.pid}` : !s.service.plist ? "not installed" : s.service.disabled ? "stopped" : s.service.detail}`],
    ["answers", s.running ? `${s.url} ${s.running.version} ${s.running.edition} ${s.running.installation ?? ""}` : "nothing"],
    ["claude", s.runtimes.claude ?? "not found"],
    ["codex", s.runtimes.codex ?? "not found"],
    ...(s.models ? [["default models", s.models.map((m) => `${m.value} (${m.model})`).join(", ") || "none: no agent CLI"] as [string, string]] : []),
  ]);
}

async function guarded(ctx: Ctx, work: () => Promise<unknown>, done: (v: never) => void): Promise<number> {
  try {
    const v = await work();
    if (ctx.flags.json) ctx.print.data({ ok: true, ...(v as object) });
    else done(v as never);
    return 0;
  } catch (e) {
    if (!(e instanceof LocalError)) throw e;
    if (ctx.flags.json) ctx.print.data({ ok: false, code: e.code, error: e.message, ...(e.status ? { status: e.status } : {}), ...(e.activity ? { activity: e.activity } : {}) });
    else ctx.io.err(`error: ${e.message}`);
    return 1;
  }
}

/** `--claude <path>` and `--codex <path>`: agent CLIs the user chose, over the search. */
const RUNTIME_FLAGS = { claude: { kind: "value" }, codex: { kind: "value" } } as const;

const deps = (ctx: Ctx, flags: Record<string, unknown> = {}) => {
  const d = realLocalDeps(ctx.flags.json ? () => {} : (l) => ctx.io.err(`[local] ${l}`));
  const runtimes: Partial<Runtimes> = {};
  for (const name of ["claude", "codex"] as const) if (typeof flags[name] === "string") runtimes[name] = flags[name] as string;
  return { ...d, runtimes };
};

const status = (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, RUNTIME_FLAGS);
  noMore(p.positional, 0);
  return guarded(ctx, () => localStatus(deps(ctx, p.flags)), (s: LocalStatus) => show(ctx, s));
};

const install = (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, { migrate: { kind: "bool" }, device: { kind: "value" }, wait: { kind: "bool" }, now: { kind: "bool" }, "default-model": { kind: "value" }, ...RUNTIME_FLAGS });
  noMore(p.positional, 0);
  const whenBusy = p.flags.now ? "now" : p.flags.wait ? "wait" : "refuse";
  return guarded(
    ctx,
    () => localInstall(deps(ctx, p.flags), { migrate: Boolean(p.flags.migrate), whenBusy, ...(typeof p.flags.device === "string" ? { device: p.flags.device } : {}), ...(typeof p.flags["default-model"] === "string" ? { defaultModel: p.flags["default-model"] } : {}) }),
    (r: Awaited<ReturnType<typeof localInstall>>) => {
      ctx.print.line(`ai-space ${r.version} ${r.upgraded ? "upgraded" : "installed"}${r.migrated ? " (workspace migrated)" : ""}: ${r.url}`);
      if (r.device) ctx.print.line(`device ${r.device.id} "${r.device.name}": ${r.device.token} (shown only now)`);
    },
  );
};

const lifecycle = (fn: typeof localStart) => (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, RUNTIME_FLAGS);
  noMore(p.positional, 0);
  return guarded(ctx, () => fn(deps(ctx, p.flags)), (s: LocalStatus) => show(ctx, s));
};

export const localNoun: Noun = {
  name: "local",
  summary: "the Local edition's installation on this Mac (what the app runs)",
  verbs: {
    status: { usage: "[--claude <path>] [--codex <path>]", summary: "what this Mac has: the app's release, the installed one, the workspace, the background service", run: status },
    install: { usage: "[--migrate] [--device <name>] [--default-model <runtime/tier>] [--wait | --now] [--claude <path>] [--codex <path>]", summary: "install or upgrade from the app and start the background service; a workspace without runtimes.yaml gets one from the agent CLIs found (refused when there is none); a first install needs --default-model; an upgrade while the Space is busy is refused unless --wait (until it is idle) or --now (drain it)", run: install },
    start: { usage: "", summary: "start the background service and keep it on at login", run: lifecycle(localStart) },
    stop: { usage: "", summary: "stop it and keep it off until started again", run: lifecycle(localStop) },
    restart: { usage: "", summary: "stop and start it", run: lifecycle(localRestart) },
    "remove-service": { usage: "", summary: "stop and unregister the background service, delete the program; the workspace stays", run: lifecycle(localRemoveService) },
  },
  defaultVerb: "status",
};
