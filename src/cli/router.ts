import { noMore, parseArgs } from "./args.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun } from "./types.ts";

/** `space router`: the hostnames routed on this machine (docs/router.md). */

type Status = { router: string; domain: string; port: number; file: string; routes: { app: string; host: string; target: string; status: string }[]; lastSync?: { at: string; ok: boolean; changed: boolean; error?: string } };

const show = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const s = await c.get<Status>("/api/router");
  if (ctx.flags.json) return ctx.print.data(s), 0;
  ctx.print.kv([
    ["router", s.router],
    ["domain", s.domain],
    ["port", s.port],
    ["file", s.file],
    ["last sync", s.lastSync ? `${ago(s.lastSync.at)} ${s.lastSync.ok ? (s.lastSync.changed ? "written" : "unchanged") : `FAILED ${s.lastSync.error ?? ""}`}` : ""],
  ]);
  if (s.routes.length) {
    ctx.print.line("");
    ctx.print.table(s.routes, [
      { title: "app", get: (r) => r.app },
      { title: "host", get: (r) => r.host },
      { title: "target", get: (r) => r.target },
      { title: "status", get: (r) => r.status },
    ]);
  }
  return 0;
};

const sync = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const res = await c.post<{ sync: { at: string; ok: boolean; changed: boolean; error?: string } }>("/api/router/sync");
  if (ctx.flags.json) return ctx.print.data(res), res.sync.ok ? 0 : 1;
  ctx.print.line(res.sync.ok ? (res.sync.changed ? "written and reloaded" : "unchanged") : `failed: ${res.sync.error ?? ""}`);
  return res.sync.ok ? 0 : 1;
};

export const routerNoun: Noun = {
  name: "router",
  summary: "the hostnames routed on this machine",
  verbs: {
    show: { usage: "", summary: "backend, domain, every route with its status, the last sync", run: show },
    sync: { usage: "", summary: "write the configuration and reload now", run: sync },
  },
};
