import { noMore, parseArgs } from "./args.ts";
import { ago, duration } from "./output.ts";
import { type Ctx, type Noun } from "./types.ts";

/** `space usage`: how often apps, agents and the panel's windows were opened, and for how long (docs/usage.md). */

type Row = { kind: string; key: string; opens: number; activeMs: number | null; sessions: number; lastAt: string | null };

const show = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { window: { kind: "value", alias: "w" }, kind: { kind: "value" } });
  noMore(positional, 0);
  const q = new URLSearchParams();
  if (flags.window) q.set("window", flags.window);
  if (flags.kind) q.set("kind", flags.kind);
  const c = await ctx.client();
  const u = await c.get<{ window: string; usage: Row[] }>(`/api/usage${q.size ? `?${q}` : ""}`);
  if (ctx.flags.json) return ctx.print.data(u), 0;
  // By time in use when anything measured it, else by opens.
  const timed = u.usage.some((r) => r.activeMs);
  const rows = [...u.usage].sort((a, b) => (timed ? (b.activeMs ?? 0) - (a.activeMs ?? 0) : 0) || b.opens - a.opens);
  const total = rows.reduce((n, r) => n + (r.activeMs ?? 0), 0);
  ctx.print.line(`last ${u.window}${flags.kind ? ` · ${flags.kind}` : ""}: ${rows.reduce((n, r) => n + r.opens, 0)} opens${total ? `, ${duration(total)} in use` : ""}`);
  ctx.print.line("");
  ctx.print.table(
    rows,
    [
      { title: "kind", get: (r) => r.kind },
      { title: "name", get: (r) => r.key },
      { title: "opens", get: (r) => r.opens, align: "right" },
      { title: "time", get: (r) => (r.activeMs === null ? "–" : duration(r.activeMs)), align: "right" },
      { title: "sessions", get: (r) => r.sessions || "", align: "right" },
      { title: "last", get: (r) => (r.lastAt ? ago(r.lastAt) : "") },
    ],
    "nothing used in the window",
  );
  return 0;
};

export const usageNoun: Noun = {
  name: "usage",
  summary: "how often apps, agents and the panel's windows were opened, and for how long",
  defaultVerb: "show",
  verbs: { show: { usage: "", summary: "the table by time in use, else opens [--window 7d|30d|90d|all] [--kind app|agent|builtin]", run: show } },
};
