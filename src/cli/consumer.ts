import { need, noMore, parseArgs } from "./args.ts";
import { confirm, readBody } from "./common.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/** `space consumer`: external consumers of the bus (docs/events.md#external-consumers). */

type Filter = Record<string, string | string[]>;
type Consumer = {
  name: string;
  description?: string;
  subscriptions: { event: string; filter?: Filter }[];
  calls: { capability: string; filter?: Filter }[];
  tokenHint: string;
  createdAt: string;
  rotatedAt?: string;
  lastSeenAt?: string;
};

const filterText = (f?: Filter) => (f ? Object.entries(f).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`).join(" ") : "");

/** `--filter groupId=g1,g2` (repeatable) → `{ groupId: ["g1", "g2"] }`. */
export function parseFilterFlags(flags: string[] | undefined): Filter | undefined {
  if (!flags?.length) return undefined;
  const out: Filter = {};
  for (const f of flags) {
    const eq = f.indexOf("=");
    const key = eq > 0 ? f.slice(0, eq).trim() : "";
    const values = eq > 0 ? f.slice(eq + 1).split(",").map((v) => v.trim()).filter(Boolean) : [];
    if (!key || !values.length) throw new UsageError("--filter must look like field=value or field=v1,v2");
    out[key] = values.length === 1 ? values[0]! : values;
  }
  return out;
}

const printToken = (ctx: Ctx, name: string, token: string) => {
  ctx.print.line(`token for ${name} (shown once; store it now):`);
  ctx.print.line(token);
};

const ls = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const res = await c.get<{ consumers: Consumer[] }>("/api/consumers");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.consumers, [
    { title: "consumer", get: (x) => x.name },
    { title: "events", get: (x) => x.subscriptions.map((s) => s.event + (s.filter ? ` [${filterText(s.filter)}]` : "")).join(", ") },
    { title: "calls", get: (x) => x.calls.map((k) => k.capability).join(", ") },
    { title: "token", get: (x) => x.tokenHint },
    { title: "last seen", get: (x) => ago(x.lastSeenAt, now) },
  ], "no external consumers (space consumer add)");
  return 0;
};

const show = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const name = need(positional, 0, "NAME");
  noMore(positional, 1);
  const c = await ctx.client();
  const res = await c.get<{ consumer: Consumer; deliveries: Record<string, number>; streams: number }>(`/api/consumers/${encodeURIComponent(name)}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const x = res.consumer;
  const now = Date.now();
  ctx.print.line(`${x.name}${x.description ? ` - ${x.description}` : ""}`);
  for (const s of x.subscriptions) ctx.print.line(`  event  ${s.event}${s.filter ? `  ${filterText(s.filter)}` : ""}`);
  for (const k of x.calls) ctx.print.line(`  call   ${k.capability}${k.filter ? `  ${filterText(k.filter)}` : ""}`);
  ctx.print.line(`  token ${x.tokenHint}, created ${ago(x.createdAt, now)}${x.rotatedAt ? `, rotated ${ago(x.rotatedAt, now)}` : ""}, last seen ${ago(x.lastSeenAt, now)}`);
  ctx.print.line(`  streams open ${res.streams}; deliveries ${Object.entries(res.deliveries).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return 0;
};

const add = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, {
    event: { kind: "list" },
    filter: { kind: "list" },
    call: { kind: "list" },
    description: { kind: "value" },
    "json-file": { kind: "value" },
  });
  let body: unknown;
  if (flags["json-file"] || positional[0] === "-" || positional[0]?.trim().startsWith("{")) {
    noMore(positional, 1);
    body = await readBody(ctx, positional[0], flags["json-file"]);
  } else {
    const name = need(positional, 0, "NAME");
    noMore(positional, 1);
    if (!flags.event?.length) throw new UsageError("--event is required (repeat it for several)");
    // One --filter applies to every event and every call: the groups it may hear about are the groups it may read.
    const filter = parseFilterFlags(flags.filter);
    body = {
      name,
      ...(flags.description ? { description: flags.description } : {}),
      subscriptions: flags.event.map((event) => ({ event, ...(filter ? { filter } : {}) })),
      calls: (flags.call ?? []).map((capability) => ({ capability, ...(filter ? { filter } : {}) })),
    };
  }
  const c = await ctx.client();
  const res = await c.post<{ consumer: Consumer; token: string }>("/api/consumers", body);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`added ${res.consumer.name}: ${res.consumer.subscriptions.map((s) => s.event).join(", ")}${res.consumer.calls.length ? `; calls ${res.consumer.calls.map((k) => k.capability).join(", ")}` : ""}`);
  printToken(ctx, res.consumer.name, res.token);
  return 0;
};

const rotate = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool", alias: "y" } });
  const name = need(positional, 0, "NAME");
  noMore(positional, 1);
  if (!(await confirm(ctx, flags.yes, `Rotate ${name}'s token? The current one stops working at once.`))) return 1;
  const c = await ctx.client();
  const res = await c.post<{ consumer: Consumer; token: string }>(`/api/consumers/${encodeURIComponent(name)}/rotate`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  printToken(ctx, res.consumer.name, res.token);
  return 0;
};

const rm = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool", alias: "y" } });
  const name = need(positional, 0, "NAME");
  noMore(positional, 1);
  if (!(await confirm(ctx, flags.yes, `Remove ${name}? Its token, streams and waiting deliveries end at once.`))) return 1;
  const c = await ctx.client();
  const res = await c.delete(`/api/consumers/${encodeURIComponent(name)}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`removed ${name}`);
  return 0;
};

export const consumerNoun: Noun = {
  name: "consumer",
  summary: "external consumers: programs elsewhere that stream bus events",
  verbs: {
    ls: { usage: "", summary: "consumers, their events, calls and last contact", run: ls },
    show: { usage: "NAME", summary: "one consumer with its delivery counts", run: show },
    add: { usage: "NAME --event E [--filter k=v1,v2] [--call APP/CAP] [--description D] | JSON|- | --json-file F", summary: "create one; prints its token once", run: add },
    rotate: { usage: "NAME [--yes]", summary: "a new token; the old one and its streams end at once", run: rotate },
    rm: { usage: "NAME [--yes]", summary: "revoke: token, streams and waiting deliveries end at once", run: rm },
  },
};
