/**
 * `bun release/local.ts [--out dist] [--app <file.spaceapp>]...`: the Local edition's Mac app, the native client with the
 * Space service inside it (docs/editions.md#ai-space-local, docs/release.md#local-edition).
 *
 *   <out>/local/AI Space.app/Contents/
 *     MacOS/AISpace                 the Mac client (desktop/macos/scripts/build.sh)
 *     Resources/space/              the release tree of release/server.ts, edition "local":
 *       RELEASE.json                  product, edition, version, commit, os, arch, bun
 *       runtime/bun                   the Bun that built it
 *       runtime/space-pty             the terminal's forkpty helper (src/space/terminal/pty_helper.c)
 *       bundled-apps/*.spaceapp       the apps installed on first launch, from `--app` or LOCAL_APPS
 *                                     (space-separated paths); `space local install` installs them
 *       node_modules/ src/ skills/ bin/ ...
 *
 * Every Mach-O file inside Resources/space is signed with the hardened runtime and the runtime's
 * entitlements (JIT), then the app itself, so the bundle verifies as one. SIGN_IDENTITY picks the
 * identity, ad-hoc ("-") by default; notarizing and the .dmg are the pipeline's (release step 7).
 *
 * release/local-smoke.ts runs the service from inside the bundle; the app installs it with
 * `space local install` (src/space/local.ts, docs/local.md).
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { SPACE_ROOT } from "../src/space/config.ts";
import { run, stageRelease } from "./server.ts";

const MACOS = join(SPACE_ROOT, "desktop", "macos");

/** Whether a file starts with a Mach-O or universal binary magic number. */
export async function isMachO(path: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(path).slice(0, 4).arrayBuffer());
  if (head.length < 4) return false;
  const magic = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
}

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

export async function machOFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of files(dir)) if ((await stat(f)).size >= 4 && (await isMachO(f))) out.push(f);
  return out.sort();
}

function codesign(identity: string, path: string, entitlements?: string): string[] {
  return ["codesign", "--force", "--options", "runtime", identity === "-" ? "--timestamp=none" : "--timestamp", ...(entitlements ? ["--entitlements", entitlements] : []), "--sign", identity, path];
}

export async function buildLocal(opts: { root?: string; out: string; identity?: string; apps?: string[] }): Promise<string> {
  if (process.platform !== "darwin") throw new Error("the Local edition builds on macOS only");
  const root = opts.root ?? SPACE_ROOT;
  const identity = opts.identity ?? process.env.SIGN_IDENTITY ?? "-";
  const out = resolve(opts.out, "local");
  const app = join(out, "AI Space.app");
  const payload = join(app, "Contents", "Resources", "space");

  await run(["sh", join(MACOS, "scripts", "build.sh")], MACOS).catch((e) => {
    throw new Error(`Mac client build failed: ${e instanceof Error ? e.message : e}`);
  });
  await rm(app, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(join(MACOS, "build", "AISpace.app"), app, { recursive: true, verbatimSymlinks: true });

  const info = await stageRelease({ root, stage: payload, edition: "local" });
  await run(["cc", "-O2", "-Wall", "-o", join(payload, "runtime", "space-pty"), join(root, "src", "space", "terminal", "pty_helper.c")], root);
  const apps = opts.apps ?? (process.env.LOCAL_APPS ?? "").split(/\s+/).filter(Boolean);
  if (apps.length) await mkdir(join(payload, "bundled-apps"), { recursive: true });
  for (const app of apps) {
    if (!app.endsWith(".spaceapp")) throw new Error(`${app}: a bundled app is a .spaceapp package (space app pack)`);
    await cp(resolve(app), join(payload, "bundled-apps", basename(app)));
  }

  const entitlements = join(MACOS, "AISpace", "SpaceRuntime.entitlements");
  const bins = await machOFiles(payload);
  for (const bin of bins) await run(codesign(identity, bin, bin.endsWith("/runtime/bun") ? entitlements : undefined), root);
  await run(codesign(identity, app, join(MACOS, "AISpace", "AISpace.entitlements")), root);
  await run(["codesign", "--verify", "--strict", "--deep", app], root);
  console.error(`[local] ${info.version} (${info.commit.slice(0, 12)}), ${bins.length} signed binaries, ${apps.length} bundled app(s), identity ${identity === "-" ? "ad-hoc" : identity}`);
  return app;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
  const out = value("--out")[0] ?? join(SPACE_ROOT, "dist");
  const apps = value("--app");
  console.log(await buildLocal({ out, ...(apps.length ? { apps } : {}) }));
}
