import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { need, noMore, parseArgs } from "./args.ts";
import { installPackageVerb } from "./package.ts";
import { progress } from "./common.ts";
import { ApiError, type Ctx, UsageError } from "./types.ts";

/**
 * `space app catalog`, and `space app install|upgrade NAME`: apps from the app catalog
 * (docs/app-catalog.md), installed by the running Space from their signed package or built from
 * their source. `install FILE` / `upgrade FILE` keep installing a package file.
 */

type Localized = { en: string; zh?: string };
type EntryView = {
  name: string;
  title: Localized;
  needs: string[];
  publisher: { id: string; name: string; keyId: string; trusted: boolean };
  latest: { version: string; tag: string; sourcePackage: boolean } | null;
  installed: { version: string; origin: string; ref: string | null; dev: boolean } | null;
  state: string;
};
type CatalogView = { sources: { url: string; ok: boolean; stale?: boolean; error?: string; apps: number }[]; apps: EntryView[]; git: boolean };
type Result = { app: string; version: string; action: string; from: string; dir?: string; ref?: string | null; source?: { dir: string; action: string; saved?: string } };

export const catalogVerb = async (ctx: Ctx, argv: string[]): Promise<number> => {
  const p = parseArgs(argv, { refresh: { kind: "bool" } });
  noMore(p.positional, 0);
  const c = await ctx.client();
  const res = await c.get<CatalogView>(`/api/app-catalog${p.flags.refresh ? "?refresh=1" : ""}`);
  if (ctx.flags.json) return ctx.print.data(res), 0;
  for (const s of res.sources) if (!s.ok) ctx.io.err(`${s.url}: ${s.stale ? "showing the last copy; " : ""}${s.error ?? "unavailable"}`);
  if (!res.sources.length) ctx.io.err("no app catalog configured (SPACE_APP_CATALOG=none)");
  ctx.print.table(res.apps, [
    { title: "name", get: (a) => a.name },
    { title: "title", get: (a) => a.title.en },
    { title: "release", get: (a) => a.latest?.version ?? "" },
    { title: "installed", get: (a) => (a.installed ? `${a.installed.version} (${a.installed.origin}${a.installed.dev ? `, ${a.installed.ref}` : ""})` : "") },
    { title: "state", get: (a) => a.state },
    { title: "needs", get: (a) => a.needs.join(", ") },
    { title: "publisher", get: (a) => `${a.publisher.name}${a.publisher.trusted ? "" : " (not trusted yet)"}` },
  ]);
  return 0;
};

/** The first argument that is not a flag or a flag's value. */
function target(argv: string[]): string | undefined {
  const takesValue = new Set(["--operation-id", "--ref"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (takesValue.has(a)) { i++; continue; }
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/** A package file, by its look or because it exists; anything else is a catalog app name. */
export function namesPackageFile(arg: string, cwd: string): boolean {
  return arg.endsWith(".spaceapp") || arg.includes("/") || existsSync(resolve(cwd, arg));
}

const catalogChange = (upgrade: boolean) => async (ctx: Ctx, argv: string[]): Promise<number> => {
  const p = parseArgs(argv, { source: { kind: "bool" }, package: { kind: "bool" }, ref: { kind: "value" }, "with-source": { kind: "bool" }, "no-source": { kind: "bool" }, "replace-source": { kind: "bool" }, trust: { kind: "bool" } });
  const name = need(p.positional, 0, "NAME");
  noMore(p.positional, 1);
  if (p.flags.source && p.flags.package) throw new UsageError("--source and --package exclude each other");
  const from = p.flags.source ? "source" : p.flags.package ? "package" : undefined;
  const body = { ...(from ? { from } : {}), ...(p.flags["with-source"] ? { withSource: true } : {}), ...(p.flags["no-source"] ? { withSource: false } : {}), ...(p.flags["replace-source"] ? { replaceSource: true } : {}), ...(p.flags.ref ? { ref: String(p.flags.ref), from: "source" } : {}), ...(p.flags.trust ? { trust: true } : {}) };
  const c = await ctx.client();
  const path = `/api/app-catalog/${encodeURIComponent(name)}/${upgrade ? "upgrade" : "install"}`;
  const fromSource = from === "source" || Boolean(p.flags.ref);
  progress(ctx, `${upgrade ? "upgrading" : "installing"} ${name}${fromSource ? " from source; building can take a few minutes" : ""}...`);
  let res: { result: Result };
  try {
    res = await c.post<{ result: Result }>(path, body, { timeoutMs: 15 * 60_000 });
  } catch (e) {
    const b = (e as ApiError).body as { code?: string; error?: string; publisher?: { name: string; keyId: string; url?: string } } | undefined;
    if (e instanceof ApiError && b?.code === "source-modified") {
      ctx.io.err(b.error ?? e.message);
      if (from !== "source" && !p.flags.ref) ctx.io.err(`keep yours: space app build ${name}    take the release: space app upgrade ${name} --replace-source`);
      return 1;
    }
    if (!(e instanceof ApiError) || b?.code !== "trust-required" || !b.publisher) throw e;
    const who = b.publisher;
    ctx.io.err(`${name} is published by ${who.name}${who.url ? ` (${who.url})` : ""}, key ${who.keyId}; this Space does not trust them yet.`);
    if (!ctx.io.isTTY) {
      ctx.io.err("run again with --trust to trust this publisher");
      return 1;
    }
    const answer = (await ctx.io.prompt(`Trust ${who.name} and ${upgrade ? "upgrade" : "install"} ${name}? [y/N] `)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") return 1;
    res = await c.post<{ result: Result }>(path, { ...body, trust: true }, { timeoutMs: 15 * 60_000 });
  }
  if (ctx.flags.json) return ctx.print.data(res), 0;
  const r = res.result;
  ctx.print.line(`${r.app} ${r.version} ${r.action} from ${r.from}${r.ref ? ` (${r.ref})` : ""}`);
  if (r.source?.action === "kept") ctx.print.line(`${r.source.dir} is yours and was left as it is; the release's source was not copied`);
  else if (r.source?.action === "replaced") ctx.print.line(`your changed source was moved to ${r.source.saved}`);
  if (r.dir && r.source?.action !== "kept") ctx.print.line(`its source is ${r.dir}; change it there, then: space app build ${r.app}`);
  return 0;
};

/** `install` and `upgrade`: a package file as before, or an app of the catalog by name. */
export const installOrCatalog = (upgrade = false) => (ctx: Ctx, argv: string[]): Promise<number> => {
  const arg = target(argv);
  return arg !== undefined && namesPackageFile(arg, ctx.io.cwd) ? installPackageVerb(upgrade)(ctx, argv) : catalogChange(upgrade)(ctx, argv);
};
