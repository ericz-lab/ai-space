import { createHash, generateKeyPairSync } from "node:crypto";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertTarget, choice } from "../space/packages/contract.ts";
import { assertPackageCompatibility } from "../space/packages/manifest.ts";
import { inspectPackage, packApplication, readPackageFile } from "../space/packages/pack.ts";
import { buildRelease, ReleaseError } from "../space/packages/release.ts";
import { need, noMore, parseArgs } from "./args.ts";
import { type Ctx, UsageError } from "./types.ts";
import { confirm } from "./common.ts";
import { ago } from "./output.ts";

export async function packVerb(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, {
    output: { kind: "value" }, include: { kind: "value" }, target: { kind: "value" },
    "source-included": { kind: "bool" }, "sign-key": { kind: "value" },
    manifest: { kind: "value" },
  });
  const dir = resolve(ctx.io.cwd, need(positional, 0, "DIR"));
  noMore(positional, 1);
  const output = resolve(ctx.io.cwd, need(flags.output ? [flags.output] : [], 0, "--output FILE"));
  const [os, arch, extra] = String(flags.target ?? "any/any").split("/");
  if (extra !== undefined) throw new UsageError("--target must be OS/ARCH");
  const result = await packApplication({
    dir, output, include: flags.include ? String(flags.include).split(",") : [],
    target: { os: choice(os, "target.os", ["any", "linux", "darwin"]), arch: choice(arch, "target.arch", ["any", "x64", "arm64"]) },
    sourceIncluded: !!flags["source-included"],
    ...(flags.manifest ? { manifest: await Bun.file(resolve(ctx.io.cwd, String(flags.manifest))).text() } : {}),
    ...(flags["sign-key"] ? { signingKey: await Bun.file(resolve(ctx.io.cwd, String(flags["sign-key"]))).text() } : {}),
  });
  if (ctx.flags.json) ctx.print.data(result);
  else {
    ctx.print.line(`${result.app}@${result.version}: ${result.files} files → ${result.path}`);
    for (const path of result.excluded) ctx.io.err(`excluded: ${path}`);
  }
  return 0;
}

export async function inspectPackageVerb(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, { "trusted-key": { kind: "value" }, "check-host": { kind: "bool" } });
  const file = resolve(ctx.io.cwd, need(positional, 0, "FILE"));
  noMore(positional, 1);
  const inspected = await inspectPackage(await readPackageFile(file), flags["trusted-key"] ? [await Bun.file(resolve(ctx.io.cwd, String(flags["trusted-key"]))).text()] : []);
  if (flags["check-host"]) {
    assertTarget(inspected.index.target, { os: process.platform, arch: process.arch });
    assertPackageCompatibility(inspected.manifest, Bun.version);
  }
  const result = { app: inspected.manifest.app, version: inspected.manifest.version, target: inspected.index.target, sourceIncluded: inspected.index.sourceIncluded,
    files: inspected.index.files.length, signature: inspected.signature, offline: inspected.manifest.offline, launch: inspected.manifest.launch };
  if (ctx.flags.json) ctx.print.data(result);
  else ctx.print.kv([["app", result.app], ["version", result.version], ["target", `${result.target.os}/${result.target.arch}`], ["files", result.files], ["signature", result.signature.status]]);
  return 0;
}

export const installPackageVerb = (upgrade = false) => async (ctx: Ctx, argv: string[]): Promise<number> => {
  const { flags, positional } = parseArgs(argv, { "allow-unsigned": { kind: "bool" }, "operation-id": { kind: "value" } });
  const file = resolve(ctx.io.cwd, need(positional, 0, "FILE")); noMore(positional, 1);
  const bytes = await readPackageFile(file);
  const id = String(flags["operation-id"] ?? crypto.randomUUID());
  ctx.io.err(`operation: ${id} (reuse --operation-id if the response is interrupted)`);
  const result = await (await ctx.client()).json<{ operation?: Operation; change?: { app: string } }>("POST", "/api/packages", bytes, { binary: true, timeoutMs: 300_000, headers: {
    "content-type": "application/octet-stream", "idempotency-key": id,
    ...(flags["allow-unsigned"] ? { "x-space-allow-unsigned": "true" } : {}), ...(upgrade ? { "x-space-upgrade": "true" } : {}),
  } });
  if (ctx.flags.json) return ctx.print.data(result), 0;
  if (result.operation) ctx.print.line(`${result.operation.app} ${result.operation.version} ${result.operation.state}`);
  else if (result.change) ctx.print.line(`${result.change.app} upgraded`);
  return 0;
};

type Operation = { id: string; app: string; version: string; state: string; error: string | null; updatedAt: string };

export async function packagesVerb(ctx: Ctx, argv: string[]): Promise<number> {
  noMore(parseArgs(argv, {}).positional, 0);
  const res = await (await ctx.client()).get<{ spaceId: string; operations: Operation[] }>("/api/packages");
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(`this Space: ${res.spaceId}`);
  const now = Date.now();
  ctx.print.table(res.operations ?? [], [
    { title: "app", get: (o) => o.app },
    { title: "version", get: (o) => o.version },
    { title: "state", get: (o) => o.state },
    { title: "operation", get: (o) => o.id },
    { title: "updated", get: (o) => ago(o.updatedAt, now) },
    { title: "error", get: (o) => (o.error ?? "").slice(0, 60) },
  ], "no packages");
  return 0;
}

export async function openPackageVerb(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, { "space-id": { kind: "value" }, connection: { kind: "value" } });
  const app = need(positional, 0, "APP"); noMore(positional, 1);
  const c = await ctx.client();
  const spaceId = flags["space-id"] ?? (await c.get<{ spaceId: string }>("/api/packages")).spaceId;
  const result = await c.post<{ url: string }>("/api/packages/open", { app, spaceId, ...(flags.connection ? { connectionId: flags.connection } : {}) });
  if (ctx.flags.json) ctx.print.data(result); else ctx.print.line(result.url);
  return 0;
}

export const packageChangeVerb = (kind: "rollback" | "remove") => async (ctx: Ctx, argv: string[]): Promise<number> => {
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool", alias: "y" }, "operation-id": { kind: "value" } });
  const app = need(positional, 0, "APP");
  const operationId = kind === "rollback" ? need(positional, 1, "RETAINED_OPERATION_ID") : undefined;
  noMore(positional, kind === "rollback" ? 2 : 1);
  const question = kind === "rollback"
    ? `Roll package ${app} back to operation ${operationId}? Its current code is replaced; user data is kept.`
    : `Remove package ${app}? It stops and is unregistered; its code and user data are kept.`;
  if (!await confirm(ctx, !!flags.yes, question)) return 1;
  const id = String(flags["operation-id"] ?? crypto.randomUUID());
  ctx.io.err(`operation: ${id}`);
  const res = await (await ctx.client()).json(kind === "rollback" ? "POST" : "DELETE", `/api/packages/apps/${encodeURIComponent(app)}${kind === "rollback" ? "/rollback" : ""}`, operationId ? { operationId } : undefined, { headers: { "idempotency-key": id }, timeoutMs: 120_000 });
  if (ctx.flags.json) return ctx.print.data(res), 0;
  ctx.print.line(kind === "rollback" ? `${app} rolled back to operation ${operationId}` : `${app} removed; its data is kept`);
  return 0;
};

/** `space app release DIR`: build a checkout into packages for publishing (docs/app-catalog.md#publishing-an-app). Runs here, without the Space. */
export async function releaseVerb(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, { "output-dir": { kind: "value" }, "sign-key": { kind: "value" }, variant: { kind: "value" } });
  const dir = resolve(ctx.io.cwd, positional[0] ?? ".");
  noMore(positional, 1);
  const variant = choice(String(flags.variant ?? "both"), "--variant", ["bundle", "source", "both"]);
  const result = await buildRelease({
    dir, outDir: resolve(ctx.io.cwd, String(flags["output-dir"] ?? join(tmpdir(), "space-packages"))),
    variants: variant === "both" ? ["bundle", "source"] : [variant],
    ...(flags["sign-key"] ? { signingKey: await Bun.file(resolve(ctx.io.cwd, String(flags["sign-key"]))).text() } : {}),
    log: (line) => ctx.io.err(line),
  }).catch((e) => {
    if (e instanceof ReleaseError && e.log) ctx.io.err(e.log.trimEnd());
    throw e;
  });
  if (ctx.flags.json) ctx.print.data({ app: result.app, version: result.version, packages: result.packages });
  else for (const p of result.packages) ctx.print.line(`${p.path}  sha256 ${p.sha256}  ${p.bytes} bytes${p.sourceIncluded ? "  (source included)" : ""}`);
  return 0;
}

/**
 * `space app keygen --out FILE`: a publisher's Ed25519 signing key. The private key goes to FILE
 * (mode 600, never overwritten), its public key to FILE.pub; the key ID printed is what catalogs and
 * `inspect-package` show. Keep the private key out of every repository.
 */
export async function keygenVerb(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, { out: { kind: "value" } });
  noMore(positional, 0);
  const out = resolve(ctx.io.cwd, need(flags.out ? [String(flags.out)] : [], 0, "--out FILE"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex");
  const handle = await open(out, "wx", 0o600);
  try { await handle.writeFile(privateKey.export({ type: "pkcs8", format: "pem" }).toString()); } finally { await handle.close(); }
  await Bun.write(`${out}.pub`, pub);
  if (ctx.flags.json) ctx.print.data({ privateKey: out, publicKey: `${out}.pub`, keyId });
  else ctx.print.kv([["private key", out], ["public key", `${out}.pub`], ["key id", keyId]]);
  return 0;
}
