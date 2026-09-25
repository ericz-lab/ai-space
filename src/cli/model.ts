import { ModelStore, importCalls } from "../space/model/index.ts";
import { need, noMore, parseArgs, parseCount } from "./args.ts";
import { appOf } from "./common.ts";
import { ago, duration, tokens, usd, when } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/** `space model`: the model service's usage ledger, status, one call, and the offline import. */

type Totals = { calls: number; errors: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; tokens: number; costUsd: number; durationMs: number };
type Usage = {
  window: string;
  since: string;
  backend: string;
  totals: Totals;
  byApp: (Totals & { app: string })[];
  byTag: (Totals & { app: string; tag: string; model: string })[];
  byModel: (Totals & { model: string })[];
  byRuntime: (Totals & { runtime: string; model: string })[];
  history: { firstAt?: string; totals: Totals };
};

const totalsColumns = <R extends Totals>() => [
  { title: "calls", get: (r: R) => r.calls, align: "right" as const },
  { title: "errors", get: (r: R) => r.errors || "", align: "right" as const },
  { title: "input", get: (r: R) => tokens(r.inputTokens), align: "right" as const },
  { title: "cache r/w", get: (r: R) => `${tokens(r.cacheReadTokens)}/${tokens(r.cacheWriteTokens)}`, align: "right" as const },
  { title: "output", get: (r: R) => tokens(r.outputTokens), align: "right" as const },
  { title: "cost", get: (r: R) => usd(r.costUsd), align: "right" as const },
  { title: "time", get: (r: R) => duration(Math.round(r.durationMs / Math.max(1, r.calls))) + "/call", align: "right" as const },
];

const usage = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { window: { kind: "value", alias: "w" }, app: { kind: "value" }, by: { kind: "value" } });
  noMore(positional, 0);
  const q = new URLSearchParams();
  if (flags.window) q.set("window", flags.window);
  if (flags.app) q.set("app", flags.app);
  const c = await ctx.client();
  const u = await c.get<Usage>(`/api/model/usage${q.size ? `?${q}` : ""}`);
  if (ctx.flags.json) return ctx.print.data(u), 0;
  const t = u.totals;
  ctx.print.line(`last ${u.window}${flags.app ? ` · ${flags.app}` : ""}: ${t.calls} calls, ${t.errors} errors, ${tokens(t.tokens)} tokens, ${usd(t.costUsd)}` + (u.history.firstAt ? ` · all time since ${when(u.history.firstAt).slice(0, 10)}: ${u.history.totals.calls} calls, ${usd(u.history.totals.costUsd)}` : ""));
  ctx.print.line("");
  const by = flags.by ?? "app";
  if (by === "app") ctx.print.table(u.byApp, [{ title: "app", get: (r) => r.app }, ...totalsColumns()], "no calls in the window");
  else if (by === "tag") ctx.print.table(u.byTag, [{ title: "app", get: (r) => r.app }, { title: "tag", get: (r) => r.tag }, { title: "model", get: (r) => r.model }, ...totalsColumns()], "no calls in the window");
  else if (by === "model") ctx.print.table(u.byModel, [{ title: "model", get: (r) => r.model }, ...totalsColumns()], "no calls in the window");
  else if (by === "runtime") ctx.print.table(u.byRuntime, [{ title: "runtime", get: (r) => r.runtime }, { title: "model", get: (r) => r.model }, ...totalsColumns()], "no calls in the window");
  else throw new UsageError("--by must be app, tag, model or runtime");
  return 0;
};

type Call = { id: number; app: string; tag: string; model: string; runtime: string; status: string; error?: string; startedAt: string; durationMs: number; usage?: { inputTokens?: number; outputTokens?: number }; costUsd?: number };

const calls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "value" }, tag: { kind: "value" }, limit: { kind: "value", alias: "n" } });
  noMore(positional, 0);
  const q = new URLSearchParams({ limit: String(parseCount(flags.limit, 30, "--limit")) });
  if (flags.app) q.set("app", flags.app);
  if (flags.tag) q.set("tag", flags.tag);
  const c = await ctx.client();
  const res = await c.get<{ calls: Call[] }>(`/api/model/calls?${q}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.calls, [
    { title: "when", get: (r) => ago(r.startedAt, now) },
    { title: "app", get: (r) => r.app },
    { title: "tag", get: (r) => r.tag },
    { title: "model", get: (r) => r.model },
    { title: "runtime", get: (r) => r.runtime },
    { title: "status", get: (r) => r.status },
    { title: "in/out", get: (r) => `${tokens(r.usage?.inputTokens ?? 0)}/${tokens(r.usage?.outputTokens ?? 0)}`, align: "right" },
    { title: "cost", get: (r) => usd(r.costUsd), align: "right" },
    { title: "time", get: (r) => duration(r.durationMs), align: "right" },
    { title: "error", get: (r) => (r.error ?? "").slice(0, 60) },
  ]);
  return 0;
};

const status = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const s = await c.get<{ backend: string; runtimes: { name: string; kind: string; backend: string; capabilities: Record<string, boolean>; default: boolean }[]; maxConcurrency: number; running: number; waiting: number }>("/api/model/status");
  if (ctx.flags.json) return ctx.print.data(s), 0;
  ctx.print.line(`${s.running} running, ${s.waiting} waiting, cap ${s.maxConcurrency}`);
  ctx.print.line("");
  ctx.print.table(s.runtimes, [
    { title: "runtime", get: (r) => r.name + (r.default ? " *" : "") },
    { title: "kind", get: (r) => r.kind },
    { title: "backend", get: (r) => r.backend },
    { title: "can", get: (r) => Object.entries(r.capabilities).filter(([, v]) => v).map(([k]) => k).join(", ") },
  ]);
  return 0;
};

const run = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { app: { kind: "value" }, model: { kind: "value", alias: "m" }, tag: { kind: "value" }, system: { kind: "value" }, mode: { kind: "value" }, timeout: { kind: "value" } });
  let prompt = positional.join(" ").trim();
  if (prompt === "-") prompt = (await ctx.io.stdin()).trim();
  if (!prompt) throw new UsageError("PROMPT is required (- reads it from stdin)");
  const c = await ctx.client();
  const asApp = Boolean(c.target.appToken) && !flags.app;
  const app = asApp ? undefined : appOf(ctx, flags.app);
  if (flags.mode && flags.mode !== "slim" && flags.mode !== "full") throw new UsageError("--mode must be slim or full");
  const body = { prompt, ...(flags.mode ? { mode: flags.mode } : {}), ...(app ? { app } : {}), ...(flags.model ? { model: flags.model } : {}), ...(flags.tag ? { tag: flags.tag } : {}), ...(flags.system ? { system: flags.system } : {}), ...(flags.timeout ? { timeoutMs: Number(flags.timeout) } : {}) };
  if (ctx.flags.json) {
    const res = await c.json("POST", "/api/model/run", body, { asApp, timeoutMs: 15 * 60_000, accept: [502] });
    ctx.print.data(res);
    return (res as { ok?: boolean }).ok ? 0 : 1;
  }
  let failed: string | undefined;
  for await (const ev of c.events("POST", "/api/model/run", { ...body, stream: true }, { asApp })) {
    if (ev.event === "delta") ctx.io.write((JSON.parse(ev.data) as { text: string }).text);
    else if (ev.event === "error") failed = (JSON.parse(ev.data) as { error: string }).error;
    else if (ev.event === "done") ctx.io.write("\n");
  }
  if (failed) {
    ctx.io.err(`space: model run: ${failed}`);
    return 1;
  }
  return 0;
};

const importCmd = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const app = need(positional, 0, "APP");
  const file = need(positional, 1, "FILE");
  noMore(positional, 2);
  const { config } = await ctx.workspace();
  const store = new ModelStore(config.dbPath, { retentionDays: config.model.retentionDays });
  try {
    const r = importCalls(store, app, await Bun.file(file).text());
    if (ctx.flags.json) ctx.print.data({ ok: true, app, ...r });
    else ctx.print.line(`${app}: read ${r.read}, imported ${r.imported}, skipped ${r.skipped} already present`);
    return 0;
  } finally {
    store.close();
  }
};

export const modelNoun: Noun = {
  name: "model",
  summary: "model calls: usage by app and model, recent calls, runtimes, one call, import",
  verbs: {
    usage: { usage: "[--window 5h|24h|7d|30d] [--app APP] [--by app|tag|model|runtime]", summary: "the ledger's sums, the panel's Model usage numbers", run: usage },
    calls: { usage: "[--app APP] [--tag TAG] [-n 30]", summary: "recent calls, newest first", run: calls },
    status: { usage: "", summary: "runtimes, concurrency, calls in flight", run: status },
    run: { usage: "[--app APP] [--model M] [--tag T] [--mode slim|full] [--system S] PROMPT…|-", summary: "one call, the answer streamed to stdout (PROMPT - reads stdin)", run: run },
    import: { usage: "APP FILE.jsonl", summary: "add an app's own call history to the ledger (offline, on this machine)", run: importCmd },
  },
};
