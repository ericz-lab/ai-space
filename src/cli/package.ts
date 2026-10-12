import { resolve } from "node:path";
import { assertTarget, choice } from "../space/packages/contract.ts";
import { assertPackageCompatibility } from "../space/packages/manifest.ts";
import { inspectPackage, packApplication, readPackageFile } from "../space/packages/pack.ts";
import { need, noMore, parseArgs } from "./args.ts";
import type { Ctx } from "./types.ts";
import { confirm } from "./common.ts";

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
  if (extra !== undefined) throw new Error("target must be OS/ARCH");
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
  const result = await (await ctx.client()).json("POST", "/api/packages", bytes, { binary: true, timeoutMs: 300_000, headers: {
    "content-type": "application/octet-stream", "idempotency-key": id,
    ...(flags["allow-unsigned"] ? { "x-space-allow-unsigned": "true" } : {}), ...(upgrade ? { "x-space-upgrade": "true" } : {}),
  } });
  ctx.print.data(result); return 0;
};

export async function packagesVerb(ctx: Ctx, argv: string[]): Promise<number> {
  noMore(parseArgs(argv, {}).positional, 0);
  ctx.print.data(await (await ctx.client()).get("/api/packages")); return 0;
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
  const { flags, positional } = parseArgs(argv, { yes: { kind: "bool" }, "operation-id": { kind: "value" } });
  const app = need(positional, 0, "APP");
  const operationId = kind === "rollback" ? need(positional, 1, "RETAINED_OPERATION_ID") : undefined;
  noMore(positional, kind === "rollback" ? 2 : 1);
  if (!await confirm(ctx, !!flags.yes, `${kind} package ${app}? User data will be retained.`)) return 1;
  const id = String(flags["operation-id"] ?? crypto.randomUUID());
  ctx.io.err(`operation: ${id}`);
  ctx.print.data(await (await ctx.client()).json(kind === "rollback" ? "POST" : "DELETE", `/api/packages/apps/${encodeURIComponent(app)}${kind === "rollback" ? "/rollback" : ""}`, operationId ? { operationId } : undefined, { headers: { "idempotency-key": id }, timeoutMs: 120_000 }));
  return 0;
};
