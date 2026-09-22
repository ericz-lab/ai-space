import { ChatStore, importThreads } from "../space/chat/index.ts";
import { need, noMore, parseArgs, parseCount } from "./args.ts";
import { appOf } from "./common.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/** `space chat`: an app's threads, and the offline import of its own conversations. */

type Thread = { id: number; scope: string; title: string; createdAt: string; updatedAt: string };

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "value" }, scope: { kind: "value" }, limit: { kind: "value", alias: "n" } });
  noMore(positional, 0);
  const c = await ctx.client();
  const asApp = Boolean(c.target.appToken) && !flags.app;
  if (!flags.scope) throw new UsageError("--scope is required (threads live per app and scope, e.g. note:12 or calendar)");
  const q = new URLSearchParams({ limit: String(parseCount(flags.limit, 30, "--limit")), scope: flags.scope });
  if (!asApp) q.set("app", appOf(ctx, flags.app)!);
  const res = await c.get<{ threads: Thread[] }>(`/api/chat/threads?${q}`, { asApp });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.threads, [
    { title: "id", get: (t) => t.id, align: "right" },
    { title: "scope", get: (t) => t.scope },
    { title: "title", get: (t) => t.title },
    { title: "updated", get: (t) => ago(t.updatedAt, now) },
  ], "no threads");
  return 0;
};

const importCmd = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const app = need(positional, 0, "APP");
  const file = need(positional, 1, "FILE");
  noMore(positional, 2);
  const { config } = await ctx.workspace();
  const store = new ChatStore(config.dbPath);
  try {
    const r = importThreads(store, app, await Bun.file(file).text());
    if (ctx.flags.json) ctx.print.data({ ok: true, app, ...r });
    else ctx.print.line(`${app}: read ${r.read}, imported ${r.imported} threads (${r.messages} messages), skipped ${r.skipped} already present`);
    return 0;
  } finally {
    store.close();
  }
};

export const chatNoun: Noun = {
  name: "chat",
  summary: "chat threads of an app, and the import of its own conversations",
  verbs: {
    ls: { usage: "--app APP --scope S [-n 30]", summary: "threads of one scope, newest first", run: ls },
    import: { usage: "APP FILE.jsonl", summary: "add an app's own conversations (offline, on this machine)", run: importCmd },
  },
};
