import { need, noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * `space api METHOD PATH [BODY]`: one raw call with the token added, for the
 * routes no verb covers yet. JSON answers are pretty-printed, server-sent
 * events come out one line per event, anything else as is.
 */

const call = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "bool" } });
  const method = need(positional, 0, "METHOD").toUpperCase();
  const path = need(positional, 1, "PATH");
  noMore(positional, 3);
  if (!/^[A-Z]+$/.test(method)) throw new UsageError(`METHOD must be GET, POST, PATCH, PUT or DELETE, not ${method}`);
  // stdin is read only when asked (`-`): a script's stdin may be a pipe nobody closes.
  let body: string | undefined = positional[2];
  if (body === "-") body = (await ctx.io.stdin()).trim() || undefined;
  const c = await ctx.client();
  const res = await c.raw(method, path, body, { asApp: flags.app, timeoutMs: 24 * 3600_000 });
  const type = res.headers.get("content-type") ?? "";
  if (type.startsWith("text/event-stream") && res.body) {
    const { parseSse } = await import("./client.ts");
    for await (const ev of parseSse(res.body)) ctx.io.out(`${ev.event}: ${ev.data}`);
    return res.ok ? 0 : 1;
  }
  const text = await res.text();
  if (type.includes("json")) {
    try {
      ctx.io.out(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      ctx.io.out(text);
    }
  } else ctx.io.write(text.endsWith("\n") || !text ? text : `${text}\n`);
  if (!res.ok) ctx.io.err(`space: api: ${res.status}`);
  return res.ok ? 0 : 1;
};

export const apiNoun: Noun = {
  name: "api",
  summary: "one raw call to the Space API with the token added",
  defaultVerb: "call",
  verbs: { call: { usage: "METHOD PATH [BODY|-] [--app]", summary: "body from the argument, or stdin with -; --app presents the app's own token", run: call } },
};
