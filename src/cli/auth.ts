import { Database } from "bun:sqlite";
import { AuthService } from "../space/auth/service.ts";
import { AuthStore, OwnerExists } from "../space/auth/store.ts";
import { operatorTokenPath } from "../space/auth/operator-token.ts";
import { noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * `space auth`: the owner's password and sessions (docs/auth.md). These verbs work on
 * `space.db` directly, with or without ai-space running: being on the machine is
 * what allows them, so the first password can never be set from the network.
 */

const PIPE = { "password-stdin": { kind: "bool" as const } };

async function open(ctx: Ctx): Promise<{ service: AuthService; mode: string; home: string; close: () => void }> {
  const { ws, config } = await ctx.workspace();
  const db = new Database(config.dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return { service: new AuthService(new AuthStore(db)), mode: config.auth, home: ws.home, close: () => db.close() };
}

/** The new password: one line on stdin with --password-stdin, else asked twice on the terminal without echo. */
async function newPassword(ctx: Ctx, fromStdin: boolean): Promise<string> {
  if (fromStdin) return (await ctx.io.stdin()).replace(/\r?\n$/, "");
  if (!ctx.io.isTTY || !ctx.io.secret) throw new UsageError("no terminal to ask on: pipe the password with --password-stdin");
  const first = await ctx.io.secret("New password: ");
  const again = await ctx.io.secret("Repeat it: ");
  if (first !== again) throw new UsageError("the two passwords differ");
  return first;
}

const note = (ctx: Ctx, mode: string) => {
  if (mode !== "builtin") ctx.print.line("note: SPACE_AUTH is not builtin on this machine, so ai-space does not ask for this password yet (docs/auth.md#turning-it-on)");
};

const status = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const { service, mode, home, close } = await open(ctx);
  try {
    const owner = service.store.owner();
    const sessions = service.sessions();
    const tokenFile = await Bun.file(operatorTokenPath(home)).exists();
    const data = { mode, initialized: Boolean(owner), ...(owner ? { createdAt: new Date(owner.createdAt).toISOString(), passwordChangedAt: new Date(owner.passwordChangedAt).toISOString() } : {}), sessions: sessions.length, operatorTokenFile: tokenFile };
    if (ctx.flags.json) return ctx.print.data(data), 0;
    ctx.print.kv([
      ["mode", mode],
      ["owner", owner ? `set ${data.createdAt}` : "not set: run `space auth init`"],
      ["password changed", data.passwordChangedAt ?? ""],
      ["live sessions", sessions.length],
      ["operator token file", tokenFile ? operatorTokenPath(home) : ""],
    ]);
    return 0;
  } finally {
    close();
  }
};

const init = async (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, PIPE);
  noMore(p.positional, 0);
  const { service, mode, close } = await open(ctx);
  try {
    if (service.initialized()) throw new OwnerExists();
    await service.init(await newPassword(ctx, Boolean(p.flags["password-stdin"])));
    ctx.print.line("owner password set; sign in on the panel");
    note(ctx, mode);
    return 0;
  } catch (e) {
    if (e instanceof OwnerExists) return ctx.io.err(`error: ${e.message}`), 1;
    throw e;
  } finally {
    close();
  }
};

const resetPassword = async (ctx: Ctx, argv: string[]) => {
  const p = parseArgs(argv, PIPE);
  noMore(p.positional, 0);
  const { service, mode, close } = await open(ctx);
  try {
    if (!service.initialized()) return ctx.io.err("error: the owner is not initialized; run `space auth init` first"), 1;
    const { revoked } = await service.resetPassword(await newPassword(ctx, Boolean(p.flags["password-stdin"])));
    ctx.print.line(`password changed; ${revoked} session(s) signed out`);
    note(ctx, mode);
    return 0;
  } finally {
    close();
  }
};

const revokeSessions = async (ctx: Ctx, argv: string[]) => {
  noMore(parseArgs(argv, {}).positional, 0);
  const { service, close } = await open(ctx);
  try {
    const revoked = service.revokeAll();
    if (ctx.flags.json) return ctx.print.data({ revoked }), 0;
    ctx.print.line(`${revoked} session(s) signed out`);
    return 0;
  } finally {
    close();
  }
};

export const authNoun: Noun = {
  name: "auth",
  summary: "the owner's password and sign-in sessions (on this machine)",
  verbs: {
    status: { usage: "", summary: "mode, whether the owner is set, live sessions", run: status },
    init: { usage: "[--password-stdin]", summary: "set the owner's password the first time", run: init },
    "reset-password": { usage: "[--password-stdin]", summary: "set a new password and sign every session out", run: resetPassword },
    "revoke-sessions": { usage: "", summary: "sign every session out", run: revokeSessions },
  },
  defaultVerb: "status",
};
