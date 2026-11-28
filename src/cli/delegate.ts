import { need, noMore, parseArgs } from "./args.ts";
import { Client } from "./client.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * `space delegate` (docs/orders.md#routes-and-commands): a delegating agent's turn hands work to a
 * team member, adds to it, stops it and looks at it. The turn's `SPACE_RUN_TOKEN` (and
 * `SPACE_API_URL`) come from its environment; `start` and `say` need it, `show`, `ls` and `stop`
 * also work with the operator's token.
 */

type Note = { seq: number; at: string; kind: string; text: string; taken?: boolean; readAt?: string | null; reason?: string };
type Delegation = { id: number; label: string; state: string; to: { agent: string; role: string; title: string; session: string | null }; permission: string; createdAt: string; endedAt: string | null; notes: Note[]; delivered: string | null; asking: string[] };

const MAX_BRIEF = 20_000;

/** The client with the turn's run token when there is one, else the operator's. */
async function client(ctx: Ctx, needToken: boolean): Promise<Client> {
  const base = await ctx.client();
  const token = ctx.io.env.SPACE_RUN_TOKEN?.trim();
  if (!token && needToken) throw new UsageError("SPACE_RUN_TOKEN is not set: only a turn of an agent that may delegate (the Director) can start a delegation or add to one");
  return token ? new Client({ ...base.target, token }, ctx.io.fetch) : base;
}

const idOf = (raw: string): number => {
  const id = Number(raw.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) throw new UsageError(`${raw} is not a delegation's number`);
  return id;
};

const start = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { "brief-file": { kind: "value" }, brief: { kind: "value" }, continue: { kind: "value" }, image: { kind: "list" } });
  const to = need(positional, 0, "ROLE");
  noMore(positional, 1);
  if (!!flags["brief-file"] === !!flags.brief) throw new UsageError("give the brief once: --brief-file <path> (- for stdin) or --brief \"<text>\"");
  const brief = flags.brief ?? (flags["brief-file"] === "-" ? await ctx.io.stdin() : await Bun.file(flags["brief-file"]!).text().catch(() => {
    throw new UsageError(`cannot read the brief file ${flags["brief-file"]}`);
  }));
  if (!brief.trim()) throw new UsageError("the brief is empty");
  if (brief.length > MAX_BRIEF) throw new UsageError(`the brief is ${brief.length} characters; the limit is ${MAX_BRIEF}`);
  const images = (flags.image ?? []).map((x) => {
    const n = Number(x.replace(/^#/, ""));
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--image takes an order's number, not ${x}`);
    return n;
  });
  const c = await client(ctx, true);
  const r = await c.post<{ delegation: Delegation }>("/api/delegations", { to, brief, ...(flags.continue ? { continue: idOf(flags.continue) } : {}), ...(images.length ? { images } : {}) });
  if (ctx.flags.json) return ctx.print.data(r), 0;
  const d = r.delegation;
  ctx.print.line(`${d.label} started: ${d.to.title || d.to.role} (${d.to.agent}), permission ${d.permission}. The result comes back to this conversation when it ends; end your turn now.`);
  return 0;
};

const say = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const id = idOf(need(positional, 0, "ID"));
  const message = positional.slice(1).join(" ").trim();
  if (!message) throw new UsageError("say what to add: space delegate say <id> \"<message>\"");
  const c = await client(ctx, true);
  const r = await c.post<{ ok: boolean; reason?: string; error?: string }>(`/api/delegations/${id}/steer`, { message });
  if (ctx.flags.json) return ctx.print.data(r), r.ok ? 0 : 1;
  if (r.ok) ctx.print.line(`Delegation #${id}: added to its running turn; it reads it after its current step.`);
  else ctx.io.err(`Delegation #${id}: not taken (${r.reason}): ${r.error ?? ""}`.trim());
  return r.ok ? 0 : 1;
};

const stop = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const id = idOf(need(positional, 0, "ID"));
  noMore(positional, 1);
  const c = await client(ctx, false);
  const r = await c.post<{ stopped: boolean; last: string }>(`/api/delegations/${id}/stop`);
  if (ctx.flags.json) return ctx.print.data(r), 0;
  ctx.print.line(r.stopped ? `Delegation #${id} stopped. Files it changed stay changed. What it had said:` : `Delegation #${id} had already ended. Its result:`);
  ctx.print.line(r.last || "(nothing)");
  return 0;
};

const show = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const id = idOf(need(positional, 0, "ID"));
  noMore(positional, 1);
  const c = await client(ctx, false);
  const r = await c.get<{ delegation: Delegation; tail: string[] }>(`/api/delegations/${id}`);
  if (ctx.flags.json) return ctx.print.data(r), 0;
  const d = r.delegation;
  const now = Date.now();
  ctx.print.line(`${d.label} → ${d.to.title || d.to.role} (${d.to.agent}): ${d.state}${d.asking.length ? ` — waiting for the person: ${d.asking.join("; ")}` : ""}${d.to.session ? ` · session ${d.to.session}` : ""} · started ${ago(d.createdAt, now)}`);
  for (const n of d.notes) {
    const mark = n.kind === "say" ? (n.taken ? (n.readAt ? " (read)" : " (taken, not read yet)") : ` (not taken: ${n.reason})`) : "";
    ctx.print.line(`  ${n.seq}. ${n.kind}${mark}: ${n.text.length > 300 ? `${n.text.slice(0, 299)}…` : n.text}`);
  }
  if (r.tail.length) {
    ctx.print.line("  last steps:");
    for (const l of r.tail) ctx.print.line(`    ${l}`);
  }
  return 0;
};

const ls = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { session: { kind: "value" } });
  noMore(positional, 0);
  const c = await client(ctx, false);
  const r = await c.get<{ delegations: Delegation[] }>(`/api/delegations${flags.session ? `?session=${encodeURIComponent(flags.session)}` : ""}`);
  if (ctx.flags.json) return ctx.print.data(r), 0;
  const now = Date.now();
  ctx.print.table(r.delegations, [
    { title: "id", get: (d) => d.id, align: "right" },
    { title: "to", get: (d) => d.to.role },
    { title: "state", get: (d) => d.state },
    { title: "started", get: (d) => ago(d.createdAt, now) },
    { title: "brief", get: (d) => (d.notes[0]?.text ?? "").split("\n")[0]!.slice(0, 60) },
  ], "no delegations");
  return 0;
};

export const delegateNoun: Noun = {
  name: "delegate",
  summary: "hand work to a team member from an agent's turn, add to it, stop it (docs/orders.md)",
  verbs: {
    start: { usage: "ROLE --brief-file PATH|- [--continue ID] [--image ORDER]...", summary: "start a delegation (also --brief \"<text>\"); answers at once", run: start },
    say: { usage: "ID MESSAGE", summary: "add a message to the delegate's running turn", run: say },
    stop: { usage: "ID", summary: "stop the delegate's turn; prints what it had said", run: stop },
    show: { usage: "ID", summary: "the delegation's record and the delegate's last steps", run: show },
    ls: { usage: "[--session SID]", summary: "this conversation's delegations (the operator: every recent one)", run: ls },
  },
};
