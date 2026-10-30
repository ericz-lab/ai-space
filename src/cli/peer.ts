import { need, noMore, parseArgs } from "./args.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun } from "./types.ts";

/** `space peer`: the other machines this hub knows. */

type Peer = { name: string; id?: string; url: string; health: string; asOf?: string; error?: string; stale: boolean; apps: number; agents: number; widgets: number; duplicates?: string[] };

const ls = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const c = await ctx.client();
  const res = await c.get<{ peers: Peer[] }>("/api/peers");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const now = Date.now();
  ctx.print.table(res.peers, [
    { title: "peer", get: (p) => p.name },
    { title: "url", get: (p) => p.url },
    { title: "health", get: (p) => p.health + (p.stale ? " (stale)" : "") },
    { title: "snapshot", get: (p) => ago(p.asOf, now) },
    { title: "apps", get: (p) => p.apps, align: "right" },
    { title: "agents", get: (p) => p.agents, align: "right" },
    { title: "error", get: (p) => p.error ?? "" },
  ], "no peers (SPACE_PEER_<NAME> in the workspace .env)");
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

export const peerNoun: Noun = {
  name: "peer",
  summary: "the peer machines of this hub",
  verbs: {
    ls: { usage: "", summary: "health, snapshot age, counts", run: ls },
    rename: { usage: "OLD NEW", summary: "rename a peer and move what this hub keeps under its name", run: rename },
  },
};
