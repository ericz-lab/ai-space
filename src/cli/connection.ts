import { need, noMore, parseArgs } from "./args.ts";
import { confirm } from "./common.ts";
import { UsageError, type Ctx, type Noun } from "./types.ts";

/** One row of `GET /api/connections`, what `ls` shows of it. */
type Row = {
  id: string; remoteSpaceId: string; direction: string; enabled: boolean; connected: boolean; error?: string;
  apps: string[]; scopes: string[]; fullTrust: boolean; alias: string | null; remoteName: string | null;
  peer?: { name: string; state: string; reason?: string; granted: { scopes: string[]; fullTrust: boolean } };
};

const ls = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const res = await (await ctx.client()).get<{ spaceId: string; connections: Row[] }>("/api/connections");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`this Space: ${res.spaceId}`);
  // "here": what this Space grants the other one; "there": what the other one grants this one (from its catalogue).
  ctx.print.table(res.connections, [
    { title: "id", get: (c) => c.id },
    { title: "direction", get: (c) => c.direction },
    { title: "remote", get: (c) => c.remoteSpaceId },
    { title: "name", get: (c) => c.alias ?? c.remoteName ?? c.remoteSpaceId.slice(0, 8) },
    { title: "state", get: (c) => (!c.enabled ? "disabled" : c.connected ? "up" : `down${c.error ? `: ${c.error}` : ""}`) },
    { title: "apps here", get: (c) => c.apps.join(",") || "-" },
    { title: "scopes here", get: (c) => scopeText(c) },
    { title: "peer", get: (c) => (c.peer ? (c.peer.state === "peer" ? `yes (${scopeText(c.peer.granted)})` : `no: ${c.peer.reason ?? c.peer.state}`) : "-") },
  ], "no connections");
  return 0;
};
const create = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { endpoint: { kind: "value" }, "token-env": { kind: "value" }, "headers-env": { kind: "value" }, apps: { kind: "value" }, scopes: { kind: "value" }, "full-trust": { kind: "bool" }, alias: { kind: "value" }, yes: { kind: "bool" } });
  const direction = need(positional, 0, "incoming|outgoing"), remoteSpaceId = need(positional, 1, "REMOTE_SPACE_ID"); noMore(positional, 2);
  if (!["incoming", "outgoing"].includes(direction)) throw new Error("direction must be incoming or outgoing");
  if (flags["full-trust"] && !await confirm(ctx, !!flags.yes, FULL_TRUST_QUESTION)) return 1;
  ctx.print.data(await (await ctx.client()).post("/api/connections", {
    direction, remoteSpaceId, apps: names(flags.apps),
    ...(flags.endpoint ? { url: flags.endpoint } : {}), ...(flags["token-env"] ? { tokenEnv: flags["token-env"] } : {}), ...(flags["headers-env"] ? { headersEnv: flags["headers-env"] } : {}),
    ...(flags.scopes !== undefined ? { scopes: names(flags.scopes) } : {}), ...(flags["full-trust"] ? { fullTrust: true } : {}), ...(flags.alias ? { alias: flags.alias } : {}),
  }));
  return 0;
};
const grant = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { apps: { kind: "value" } });
  const id = need(positional, 0, "CONNECTION_ID"); noMore(positional, 1);
  if (flags.apps === undefined) throw new Error("--apps is required (empty string revokes all local apps)");
  ctx.print.data(await (await ctx.client()).patch(`/api/connections/${encodeURIComponent(id)}`, { apps: names(flags.apps) })); return 0;
};
/** `scopes ID [--scopes S,...] [--full-trust on|off]`: what the other Space may do through this one's peer API (docs/app-packages.md#peer-scopes). */
const scopes = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { scopes: { kind: "value" }, "full-trust": { kind: "value" }, yes: { kind: "bool" } });
  const id = need(positional, 0, "CONNECTION_ID"); noMore(positional, 1);
  if (flags.scopes === undefined && flags["full-trust"] === undefined) throw new UsageError("--scopes S,... or --full-trust on|off is required (an empty --scopes grants none)");
  const trust = flags["full-trust"];
  if (trust !== undefined && trust !== "on" && trust !== "off") throw new UsageError("--full-trust takes on or off");
  if (trust === "on" && !await confirm(ctx, !!flags.yes, FULL_TRUST_QUESTION)) return 1;
  ctx.print.data(await (await ctx.client()).patch(`/api/connections/${encodeURIComponent(id)}`, {
    ...(flags.scopes !== undefined ? { scopes: names(flags.scopes) } : {}), ...(trust !== undefined ? { fullTrust: trust === "on" } : {}),
  }));
  return 0;
};
/** `alias ID NAME | --clear`: the name the other Space goes by here as a peer (its `<name>/` prefix and what is kept under it). */
const alias = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { clear: { kind: "bool" } });
  const id = need(positional, 0, "CONNECTION_ID");
  const name = flags.clear ? null : need(positional, 1, "NAME");
  noMore(positional, flags.clear ? 1 : 2);
  ctx.print.data(await (await ctx.client()).patch(`/api/connections/${encodeURIComponent(id)}`, { alias: name })); return 0;
};
const enabled = (value: boolean) => async (ctx: Ctx, argv: string[]) => {
  const { positional } = parseArgs(argv, {}); const id = need(positional, 0, "CONNECTION_ID"); noMore(positional, 1);
  ctx.print.data(await (await ctx.client()).patch(`/api/connections/${encodeURIComponent(id)}`, { enabled: value })); return 0;
};
const rm = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool" } }); const id = need(positional, 0, "CONNECTION_ID"); noMore(positional, 1);
  if (!await confirm(ctx, !!flags.yes, `remove connection ${id}? Its grants and incoming credential are deleted.`)) return 1;
  ctx.print.data(await (await ctx.client()).json("DELETE", `/api/connections/${encodeURIComponent(id)}`)); return 0;
};
const FULL_TRUST_QUESTION = "full trust lets the other Space use this machine's agents, models and terminal, change its apps, and do whatever a later version adds. Grant it?";
function names(raw: unknown): string[] { return String(raw ?? "").split(",").map((v) => v.trim()).filter(Boolean); }
function scopeText(g: { scopes: string[]; fullTrust: boolean }): string { return g.fullTrust ? "full trust" : g.scopes.join(",") || "-"; }
export const connectionNoun: Noun = { name: "connection", summary: "package Hub connections, directional local-app grants and peer scopes", verbs: {
  ls: { usage: "", summary: "identity, grants, scopes and connection state; whether each is a peer here", run: ls },
  create: { usage: "incoming|outgoing REMOTE_SPACE_ID [--endpoint URL --token-env NAME [--headers-env NAME]] [--apps APP,...] [--scopes SCOPE,...] [--full-trust [--yes]] [--alias NAME]", summary: "create a connection; incoming credentials are returned once", run: create },
  grant: { usage: "CONNECTION_ID --apps APP,...", summary: "replace this machine's shared-app list: packages, or spec-1 apps with a service (API only); empty revokes all", run: grant },
  scopes: { usage: "CONNECTION_ID [--scopes panel,agents,events,model,tasks,terminal,apps,manage] [--full-trust on|off [--yes]]",summary: "replace what the other Space may do through this one's peer API; empty grants none", run: scopes },
  alias: { usage: "CONNECTION_ID NAME | CONNECTION_ID --clear", summary: "the peer name the other Space goes by here (default: its SPACE_NAME)", run: alias },
  enable: { usage: "CONNECTION_ID", summary: "enable reconnection with existing grants", run: enabled(true) },
  disable: { usage: "CONNECTION_ID", summary: "disconnect and abort current remote work", run: enabled(false) },
  rm: { usage: "CONNECTION_ID [--yes]", summary: "disconnect and delete the connection, its grants and credential", run: rm },
} };
