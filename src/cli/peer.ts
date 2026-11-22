import { need, noMore, parseArgs } from "./args.ts";
import { ago } from "./output.ts";
import { ApiError, UsageError, type Ctx, type Noun } from "./types.ts";

/** `space peer`: the other machines this hub knows. */

type Peer = { name: string; id?: string; url: string; via?: "http" | "connection"; health: string; asOf?: string; error?: string; stale: boolean; apps: number; agents: number; widgets: number; duplicates?: string[] };

const ls = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const res = await c.get<{ peers: Peer[] }>("/api/peers");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.peers, [
    { title: "peer", get: (p) => p.name },
    // `legacy`: SPACE_PEER_* over HTTPS, what `space peer migrate` moves onto a connection.
    { title: "via", get: (p) => (p.via === "connection" ? "connection" : "legacy") },
    { title: "url", get: (p) => p.url },
    { title: "health", get: (p) => p.health + (p.stale ? " (stale)" : "") },
    { title: "snapshot", get: (p) => ago(p.asOf, now) },
    { title: "apps", get: (p) => p.apps, align: "right" },
    { title: "agents", get: (p) => p.agents, align: "right" },
    { title: "error", get: (p) => p.error ?? "" },
  ], "no peers (a connection whose other Space grants the panel scope, see `space connection ls`, or SPACE_PEER_<NAME> in the workspace .env)");
  const legacy = res.peers.filter((p) => p.via !== "connection").length;
  if (legacy && !ctx.flags.quiet) ctx.io.err(`${legacy} on the legacy peer channel: \`space peer migrate --all\` moves them onto connections (docs/peers.md#moving-a-legacy-peer)`);
  return 0;
};

/** `space peer rename OLD NEW`: the `.env` line and everything the hub keeps under the old name (docs/peers.md#renaming-a-peer). */
const rename = async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {});
  const from = need(positional, 0, "OLD");
  const to = need(positional, 1, "NEW");
  noMore(positional, 2);
  const c = await ctx.client();
  const res = await c.post<{ from: string; to: string; id: string | null; moved: Record<string, number> }>(`/api/peers/${encodeURIComponent(from)}/rename`, { to });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const moved = Object.entries(res.moved).map(([area, n]) => `${area} ${n}`).join(", ");
  ctx.print.line(`${res.from} → ${res.to}${res.id ? ` (id ${res.id})` : ""}; moved: ${moved || "nothing stored yet"}`);
  return 0;
};

type Step = { step: string; status: string; detail: string };
type Migrated = { ok: boolean; peer: string; state: string; steps?: Step[]; error?: string; connection?: string; manual?: string[]; removed?: { key: string; value: string }[]; warnings?: string[]; rollback?: string[] };

/**
 * `space peer migrate NAME | --all`: a legacy peer moved onto a package connection under the same name
 * (docs/peers.md#moving-a-legacy-peer), one `POST /api/peers/<name>/migrate` per peer. Exit 0 when every peer
 * is migrated, verified (`--keep-legacy`), planned (`--dry-run`), waiting for its owner (`--manual`) or moved
 * already; 1 when one is not.
 */
const migrate = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, {
    all: { kind: "bool" }, manual: { kind: "bool" }, finish: { kind: "bool" }, "dry-run": { kind: "bool" }, "keep-legacy": { kind: "bool" },
    "hub-url": { kind: "value" }, "hub-headers": { kind: "value" }, "peer-id": { kind: "value" }, wait: { kind: "value" },
  });
  if (flags.manual && flags.finish) throw new UsageError("--manual and --finish are two runs: --manual first, --finish once the peer is connected");
  if (flags.all ? positional.length : !positional.length) throw new UsageError("name one peer, or --all");
  noMore(positional, 1);
  if (flags.all && flags["peer-id"]) throw new UsageError("--peer-id names one peer's Space; it does not go with --all");
  let waitMs: number | undefined;
  if (flags.wait !== undefined) {
    const s = Number(flags.wait);
    if (!Number.isFinite(s) || s < 1 || s > 300) throw new UsageError("--wait takes seconds, 1 to 300");
    waitMs = s * 1000;
  }
  const c = await ctx.client();
  const names = flags.all ? (await c.get<{ peers: Peer[] }>("/api/peers")).peers.filter((p) => p.via !== "connection").map((p) => p.name) : [positional[0]!];
  const body = {
    mode: flags.manual ? "manual" : flags.finish ? "finish" : "auto",
    ...(flags["dry-run"] ? { dryRun: true } : {}), ...(flags["keep-legacy"] ? { keepLegacy: true } : {}),
    ...(flags["hub-url"] ? { hubUrl: flags["hub-url"] } : {}), ...(flags["hub-headers"] ? { hubHeaders: flags["hub-headers"] } : {}),
    ...(flags["peer-id"] ? { peerId: flags["peer-id"] } : {}), ...(waitMs ? { waitMs } : {}),
  };
  const results: Migrated[] = [];
  for (const name of names) {
    let r: Migrated;
    try {
      // The route waits for the connection (30 s by default), the adopt call and a snapshot.
      r = await c.json<Migrated>("POST", `/api/peers/${encodeURIComponent(name)}/migrate`, body, { accept: [409], timeoutMs: (waitMs ?? 30_000) + 60_000 });
    } catch (e) {
      // One peer's refusal does not stop the others under --all; alone, it is the command's error.
      if (!(e instanceof ApiError) || !flags.all) throw e;
      r = { ok: false, peer: name, state: "error", error: e.message };
    }
    results.push(r);
    if (!ctx.flags.json) report(ctx, r);
  }
  if (ctx.flags.json) ctx.print.data(flags.all ? { ok: results.every((r) => r.ok), results } : results[0]);
  else if (flags.all && !names.length) ctx.print.line("no peer on the legacy channel: nothing to migrate");
  return results.every((r) => r.ok) ? 0 : 1;
};

const STATE_TEXT: Record<string, string> = {
  "dry-run": "dry run, nothing changed",
  manual: "waiting for the commands below on the peer",
  kept: "verified; the legacy peer is kept (--keep-legacy)",
  migrated: "migrated",
  already: "already on a connection",
  "needs-manual": "not migrated",
  unverified: "not migrated",
  refused: "not migrated",
  error: "not migrated",
};
const MARK: Record<string, string> = { done: "✓", skipped: "·", would: "→", failed: "✗" };

function report(ctx: Ctx, r: Migrated): void {
  const p = ctx.print;
  p.line(`${r.peer}: ${STATE_TEXT[r.state] ?? r.state}${r.connection ? ` (connection ${r.connection})` : ""}`);
  for (const s of r.steps ?? []) p.line(`  ${MARK[s.status] ?? "-"} ${s.step.padEnd(10)} ${s.detail}`);
  if (r.error) ctx.io.err(`  ${r.error}`);
  for (const w of r.warnings ?? []) ctx.io.err(`  note: ${w}`);
  if (r.manual?.length) {
    p.line("");
    for (const l of r.manual) p.line(`  ${l}`);
  }
  if (r.removed?.length) {
    p.line(r.state === "dry-run" ? "  would comment out in .env:" : `  commented out in .env (to restore them, remove the "# "):`);
    for (const x of r.removed) p.line(`    ${x.key}=${x.value}`);
  }
  if (r.rollback?.length && (r.state === "migrated" || r.state === "kept")) {
    p.line("  to go back:");
    for (const l of r.rollback) p.line(`    ${l}`);
  }
}

export const peerNoun: Noun = {
  name: "peer",
  summary: "the peer machines of this hub",
  verbs: {
    ls: { usage: "", summary: "how each is reached (connection or legacy), health, snapshot age, counts", run: ls },
    rename: { usage: "OLD NEW", summary: "rename a peer and move what this hub keeps under its name", run: rename },
    migrate: {
      usage: "NAME | --all [--manual | --finish] [--dry-run] [--keep-legacy] [--hub-url URL] [--hub-headers 'Name: v; Name: v'] [--peer-id ID] [--wait SECONDS]",
      summary: "move a SPACE_PEER_* peer onto a package connection under the same name, keeping what this hub stores for it",
      run: migrate,
    },
  },
};
