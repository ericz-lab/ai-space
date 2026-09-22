import { need, noMore, parseArgs, parseCount } from "./args.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * `space notify`: send a message through the running ai-space, read the
 * history, check the channels. `send` keeps the flags of the older
 * `bun src/index.ts notify …`, which is its alias.
 */

/** The request body from the `send` flags and text; the app defaults to `SPACE_APP` (a task's command). */
export function parseNotifyArgs(argv: string[], env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const { flags, positional } = parseArgs(argv, {
    app: { kind: "value" },
    level: { kind: "value" },
    title: { kind: "value" },
    url: { kind: "value" },
    channel: { kind: "value" },
    key: { kind: "value" },
    window: { kind: "value" },
    wait: { kind: "bool" },
  });
  const body: Record<string, unknown> = {};
  if (flags.app) body.app = flags.app;
  if (flags.level) body.level = flags.level;
  if (flags.title) body.title = flags.title;
  if (flags.url) body.url = flags.url;
  if (flags.channel) body.channels = [flags.channel];
  if (flags.key) body.key = flags.key;
  if (flags.window) body.window = flags.window;
  if (flags.wait) body.wait = true;
  body.app ??= env.SPACE_APP;
  if (!body.app) throw new UsageError("--app is required (or set SPACE_APP)");
  if (positional.length === 0) throw new UsageError("text is required");
  body.text = positional.join(" ");
  return body;
}

type Delivery = { channel: string; status: string; error?: string };
type Notification = { id: string; app: string; level: string; title?: string; text: string; createdAt: string; deliveries: Delivery[] };

const send = async (ctx: Ctx, argv: string[]) => {
  const body = parseNotifyArgs(argv, ctx.io.env);
  const c = await ctx.client();
  let res: { ok?: boolean; error?: string; notification?: Notification };
  try {
    res = await c.json("POST", "/api/notify", body, { asApp: true, timeoutMs: body.wait ? 90_000 : 10_000 });
  } catch (e) {
    // The older command printed the undelivered text so a script's log keeps it; keep that.
    ctx.io.err(`space: notify: undelivered message from ${String(body.app)}: ${[body.title, body.text].filter(Boolean).map(String).join(" ")}`);
    throw e;
  }
  const d = res.notification?.deliveries ?? [];
  if (ctx.flags.json) ctx.print.data(res);
  else ctx.io.err(`notify: ${res.notification?.id} ${d.map((x) => `${x.channel}=${x.status}${x.error ? ` (${x.error})` : ""}`).join(" ")}`.trim());
  return body.wait && d.some((x) => x.status === "error") ? 1 : 0;
};

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "value" }, limit: { kind: "value", alias: "n" } });
  noMore(positional, 0);
  const q = new URLSearchParams({ limit: String(parseCount(flags.limit, 20, "--limit")) });
  if (flags.app) q.set("app", flags.app);
  const c = await ctx.client();
  const res = await c.get<{ notifications: Notification[] }>(`/api/notifications?${q}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.notifications, [
    { title: "when", get: (n) => ago(n.createdAt, now) },
    { title: "app", get: (n) => n.app },
    { title: "level", get: (n) => n.level },
    { title: "title", get: (n) => n.title ?? "" },
    { title: "text", get: (n) => n.text.slice(0, 60) },
    { title: "deliveries", get: (n) => n.deliveries.map((d) => `${d.channel}=${d.status}`).join(" ") },
  ]);
  return 0;
};

type Channel = { name: string; kind?: string; enabled: boolean; lastSentAt?: string; lastError?: string; error?: string };

const channels = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const res = await c.get<{ channels: Channel[] }>("/api/notify/channels");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.channels, [
    { title: "channel", get: (x) => x.name },
    { title: "kind", get: (x) => x.kind ?? "" },
    { title: "enabled", get: (x) => x.enabled },
    { title: "last sent", get: (x) => ago(x.lastSentAt, now) },
    { title: "error", get: (x) => x.error ?? x.lastError ?? "" },
  ], "no channels (SPACE_NOTIFY_<NAME> in the workspace .env)");
  return 0;
};

const test = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "CHANNEL");
  noMore(positional, 1);
  const c = await ctx.client();
  const res = await c.json<{ ok: boolean; notification: Notification }>("POST", `/api/notify/channels/${name}/test`, {}, { timeoutMs: 60_000, accept: [502] });
  if (ctx.flags.json) return ctx.print.data(res), res.ok ? 0 : 1;
  for (const d of res.notification.deliveries) ctx.print.line(`${d.channel}: ${d.status}${d.error ? ` (${d.error})` : ""}`);
  return res.ok ? 0 : 1;
};

export const notifyNoun: Noun = {
  name: "notify",
  summary: "notifications: send one, the history, the channels",
  // `space notify --app x text` (the older spelling) is `send`.
  defaultVerb: "send",
  verbs: {
    send: { usage: "[--app A] [--level L] [--title T] [--url U] [--channel C] [--key K] [--wait] TEXT…", summary: "send a message (the app comes from SPACE_APP inside a task)", run: send },
    ls: { usage: "[--app APP] [-n 20]", summary: "history with deliveries, newest first", run: ls },
    channels: { usage: "", summary: "every channel: kind, enabled, last sent, last error", run: channels },
    test: { usage: "CHANNEL", summary: "send a test message to one channel", run: test },
  },
};
