import { need, noMore, parseArgs, parseCount } from "./args.ts";
import { appOf } from "./common.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/** `space event`: the scheduler's events, and publishing one. */

type Event = { id: number; name: string; app: string; at: string; data?: unknown };

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { name: { kind: "value" }, app: { kind: "value" }, limit: { kind: "value", alias: "n" } });
  noMore(positional, 0);
  const q = new URLSearchParams({ limit: String(parseCount(flags.limit, 30, "--limit")) });
  if (flags.name) q.set("name", flags.name);
  if (flags.app) q.set("app", flags.app);
  const c = await ctx.client();
  const res = await c.get<{ events: Event[] }>(`/api/events?${q}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.events, [
    { title: "id", get: (e) => e.id, align: "right" },
    { title: "when", get: (e) => ago(e.at, now) },
    { title: "app", get: (e) => e.app },
    { title: "event", get: (e) => e.name },
    { title: "data", get: (e) => (e.data === undefined ? "" : JSON.stringify(e.data).slice(0, 80)) },
  ], "no events");
  return 0;
};

const emit = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "value" }, data: { kind: "value" } });
  const name = need(positional, 0, "NAME");
  noMore(positional, 1);
  let data: unknown;
  if (flags.data !== undefined) {
    try {
      data = JSON.parse(flags.data);
    } catch {
      throw new UsageError("--data must be JSON");
    }
  }
  const c = await ctx.client();
  const asApp = Boolean(c.target.appToken) && !flags.app;
  const app = asApp ? undefined : appOf(ctx, flags.app);
  const res = await c.post<{ event: Event; matched: string[] }>("/api/events", { name, ...(app ? { app } : {}), ...(data !== undefined ? { data } : {}) }, { asApp });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`${res.event.name} #${res.event.id}: ${res.matched.length ? `matched ${res.matched.join(", ")}` : "no task listens"}`);
  return 0;
};

export const eventNoun: Noun = {
  name: "event",
  summary: "events: recent ones, publish one",
  verbs: {
    ls: { usage: "[--name N] [--app APP] [-n 30]", summary: "recent events, newest first", run: ls },
    emit: { usage: "NAME [--data JSON] [--app APP]", summary: "publish an event (the app comes from SPACE_APP inside a task)", run: emit },
  },
};
