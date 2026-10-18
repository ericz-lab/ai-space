import { need, noMore, parseArgs } from "./args.ts";
import type { Ctx } from "./types.ts";

/**
 * `space app create` and `space app build`: apps made and changed inside ai-space
 * (docs/app-studio.md). The running Space makes the source under `<workspace>/app-src/<app>/`
 * from its package template, packs it and installs or upgrades it; no GitHub, no deploy channel.
 */

type Build = { app: string; version: string; action: "installed" | "upgraded" };

export const createVerb = async (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, { title: { kind: "value" }, description: { kind: "value" } });
  noMore(p.positional, 1);
  const name = need(p.positional, 0, "NAME");
  const c = await ctx.client();
  const res = await c.post<{ dir: string; build: Build }>("/api/studio/apps", { name, ...(p.flags.title ? { title: p.flags.title } : {}), ...(p.flags.description ? { description: p.flags.description } : {}) }, { timeoutMs: 120_000 });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`${res.build.app} ${res.build.version} ${res.build.action}; its source is ${res.dir}`);
  ctx.print.line(`change the files there, then: space app build ${res.build.app}`);
  return 0;
};

export const buildVerb = async (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, {});
  noMore(p.positional, 1);
  const name = need(p.positional, 0, "NAME");
  const c = await ctx.client();
  const res = await c.post<{ build: Build }>(`/api/studio/apps/${encodeURIComponent(name)}/build`, undefined, { timeoutMs: 120_000 });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`${res.build.app} ${res.build.version} ${res.build.action}`);
  return 0;
};
