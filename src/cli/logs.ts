import { need, noMore, parseArgs, parseCount } from "./args.ts";
import { type Ctx, type Noun } from "./types.ts";

/**
 * `space logs APP`: the app's log through `GET /api/apps/:app/logs`
 * (src/space/logs/); `space logs space` is ai-space's own.
 */

const show = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { lines: { kind: "value", alias: "n" }, follow: { kind: "bool", alias: "f" } });
  const app = need(positional, 0, "APP");
  noMore(positional, 1);
  const lines = parseCount(flags.lines, 100, "--lines");
  const c = await ctx.client();
  if (!flags.follow) {
    const text = await c.text(`/api/apps/${app}/logs?lines=${lines}`);
    if (ctx.flags.json) return ctx.print.data({ ok: true, app, lines: text.replace(/\n$/, "").split("\n").filter((l, i, a) => l || i < a.length - 1) }), 0;
    ctx.io.write(text);
    return 0;
  }
  for await (const ev of c.events("GET", `/api/apps/${app}/logs?lines=${lines}&follow=1`)) {
    if (ev.event === "line") ctx.io.write(`${JSON.parse(ev.data)}\n`);
    else if (ev.event === "end") {
      const { code } = JSON.parse(ev.data) as { code: number };
      if (code !== 0) ctx.io.err(`space: log command exited with ${code}`);
      return code === 0 ? 0 : 1;
    }
  }
  return 0;
};

export const logsNoun: Noun = {
  name: "logs",
  summary: "an app's log (space logs space: ai-space's own)",
  defaultVerb: "show",
  verbs: { show: { usage: "APP [-n 100] [-f]", summary: "the last lines, or keep following", run: show } },
};
