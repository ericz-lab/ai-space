import { need, noMore, parseArgs } from "./args.ts";
import type { Ctx, Noun } from "./types.ts";

const ls = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  ctx.print.data(await (await ctx.client()).get("/api/connections")); return 0;
};
const create = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { endpoint: { kind: "value" }, "token-env": { kind: "value" }, apps: { kind: "value" } });
  const direction = need(positional, 0, "incoming|outgoing"), remoteSpaceId = need(positional, 1, "REMOTE_SPACE_ID"); noMore(positional, 2);
  if (!["incoming", "outgoing"].includes(direction)) throw new Error("direction must be incoming or outgoing");
  ctx.print.data(await (await ctx.client()).post("/api/connections", { direction, remoteSpaceId, apps: names(flags.apps), ...(flags.endpoint ? { url: flags.endpoint } : {}), ...(flags["token-env"] ? { tokenEnv: flags["token-env"] } : {}) }));
  return 0;
};
const grant = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { apps: { kind: "value" } });
  const id = need(positional, 0, "CONNECTION_ID"); noMore(positional, 1);
  if (flags.apps === undefined) throw new Error("--apps is required (empty string revokes all local apps)");
  ctx.print.data(await (await ctx.client()).patch(`/api/connections/${encodeURIComponent(id)}`, { apps: names(flags.apps) })); return 0;
};
const enabled = (value: boolean) => async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {}); const id = need(positional, 0, "CONNECTION_ID"); noMore(positional, 1);
  ctx.print.data(await (await ctx.client()).patch(`/api/connections/${encodeURIComponent(id)}`, { enabled: value })); return 0;
};
function names(raw: unknown): string[] { return String(raw ?? "").split(",").map((v) => v.trim()).filter(Boolean); }
export const connectionNoun: Noun = { name: "connection", summary: "package Hub connections and directional local-app grants", verbs: {
  ls: { usage: "", summary: "identity, grants and connection state", run: ls },
  create: { usage: "incoming|outgoing REMOTE_SPACE_ID [--endpoint URL --token-env NAME] [--apps APP,...]", summary: "create a connection; incoming credentials are returned once", run: create },
  grant: { usage: "CONNECTION_ID --apps APP,...", summary: "replace this machine's shared-app list (empty revokes all)", run: grant },
  enable: { usage: "CONNECTION_ID", summary: "enable reconnection with existing grants", run: enabled(true) },
  disable: { usage: "CONNECTION_ID", summary: "disconnect and abort current remote work", run: enabled(false) },
} };
