import { join } from "node:path";
import { type Exec, prepareDeploy, type Shell } from "../space/deploy/deploy.ts";
import { need, noMore, parseArgs } from "./args.ts";
import { ApiError, type Ctx } from "./types.ts";

/**
 * `space app deploy APP [--rev REV] [--git-dir DIR] [--no-restart]`, run on the host, usually as
 * the whole body of a post-receive hook (docs/app-spec.md#deploy): check out the revision, run the
 * manifest's install, check and build commands, and only when all of them pass, sync the app and
 * restart its service. On a failure the previous revision goes back and the service keeps running.
 */

type Service = { supervisor: "space" | "operator"; unit: string; last?: { action: string; error?: string } };

export type DeployDeps = { exec?: Exec; shell?: Shell; healthWaitMs?: number };

export function deployVerb(deps: DeployDeps = {}) {
  return async (ctx: Ctx, argv: string[]): Promise<number> => {
    const { flags, positional } = parseArgs(argv, { rev: { kind: "value" }, "git-dir": { kind: "value" }, "no-restart": { kind: "bool" } });
    const app = need(positional, 0, "APP");
    noMore(positional, 1);
    const { ws } = await ctx.workspace();
    const log = (line: string) => ctx.io.err(line);
    const rev = flags.rev as string | undefined;
    const gitDir = flags["git-dir"] as string | undefined;
    const prepared = await prepareDeploy({ app, dir: join(ws.apps, app), ...(rev ? { rev } : {}), ...(gitDir ? { gitDir } : {}), log, ...(deps.exec ? { exec: deps.exec } : {}), ...(deps.shell ? { shell: deps.shell } : {}) });
    if (!prepared.ok) {
      const kept = prepared.restored === true ? `; ${prepared.previous!.slice(0, 12)} is back` : prepared.restored === false ? "; restoring the previous tree failed too: check the directory by hand" : "";
      ctx.io.err(`${app}: deploy stopped at ${prepared.step}: ${prepared.error}${kept}; the service was not restarted`);
      return 1;
    }
    const at = prepared.rev ? ` at ${prepared.rev.slice(0, 12)}` : "";
    if (flags["no-restart"]) {
      ctx.print.line(`${app}: prepared${at}, not restarted (--no-restart)`);
      return 0;
    }

    // The sync re-reads space.yaml and rewrites the unit; a changed unit restarts there already.
    const c = await ctx.client();
    let svc: Service | undefined;
    try {
      await c.post(`/api/apps/${app}/sync`);
      if (prepared.manifest.service) svc = (await c.get<{ service: Service }>(`/api/apps/${app}/service`)).service;
    } catch (e) {
      ctx.io.err(`${app}: prepared${at}, but ai-space did not take it: ${(e as Error).message}; the service was not restarted`);
      return 1;
    }
    const service = prepared.manifest.service;
    if (!service || !svc) {
      ctx.print.line(`${app}: deployed${at} (no service)`);
      return 0;
    }
    if (svc.supervisor !== "space") {
      ctx.print.line(`${app}: deployed${at}; services here are the operator's: restart ${svc.unit} yourself`);
      return 0;
    }
    const action = svc.last?.action ?? "unchanged";
    if (action === "conflict" || action === "failed") {
      ctx.io.err(`${app}: deployed${at}, but the service did not start: ${svc.last?.error ?? action}`);
      return 1;
    }
    if (!["restarted", "installed", "started"].includes(action)) {
      try {
        await c.post(`/api/apps/${app}/service`, { action: "restart" }, { timeoutMs: 120_000 });
      } catch (e) {
        ctx.io.err(`${app}: deployed${at}, but the restart failed: ${e instanceof ApiError ? e.message : (e as Error).message}`);
        return 1;
      }
    }
    if (!service.health) {
      ctx.print.line(`${app}: deployed${at}, ${svc.unit} restarted`);
      return 0;
    }
    const healthy = await waitHealthy(ctx, service.port, service.health, deps.healthWaitMs ?? 30_000);
    if (!healthy) {
      ctx.io.err(`${app}: deployed${at} and restarted, but GET 127.0.0.1:${service.port}${service.health} did not answer 200 within ${Math.round((deps.healthWaitMs ?? 30_000) / 1000)} s: space logs ${app}`);
      return 1;
    }
    ctx.print.line(`${app}: deployed${at}, ${svc.unit} restarted, healthy`);
    return 0;
  };
}

async function waitHealthy(ctx: Ctx, port: number, path: string, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const ok = await ctx.io
      .fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) })
      .then((r) => r.status === 200)
      .catch(() => false);
    if (ok) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(500);
  }
}
