import { resolve } from "node:path";
import { assertTarget, choice } from "../space/packages/contract.ts";
import { assertPackageCompatibility } from "../space/packages/manifest.ts";
import { inspectPackage, packApplication, readPackageFile } from "../space/packages/pack.ts";
import { need, noMore, parseArgs } from "./args.ts";
import type { Ctx } from "./types.ts";

export async function packVerb(ctx: Ctx, argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv, {
    output: { kind: "value" }, include: { kind: "value" }, target: { kind: "value" },
    "source-included": { kind: "bool" }, "sign-key": { kind: "value" },
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
