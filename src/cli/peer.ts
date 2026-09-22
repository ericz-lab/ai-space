import { noMore, parseArgs } from "./args.ts";
import { ago } from "./output.ts";
import { type Ctx, type Noun } from "./types.ts";

/** `space peer`: the other machines this hub knows. */

type Peer = { name: string; url: string; health: string; asOf?: string; error?: string; stale: boolean; apps: number; agents: number; widgets: number; duplicates?: string[] };

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

export const peerNoun: Noun = { name: "peer", summary: "the peer machines of this hub", verbs: { ls: { usage: "", summary: "health, snapshot age, counts", run: ls } } };
