/**
 * The Windows client as a folder that runs where it lies (docs/windows-desktop.md):
 *
 *   bun desktop/windows/build.ts [--out <dir>] [--arch x64|arm64] [--local [--bundle <dir>]]
 *   bun desktop/windows/build.ts --bundle-only --out <dir>
 *
 * The app folder (default desktop/windows/build/ai-space):
 *
 *   AISpace.exe …           `dotnet publish` of AISpace/, self-contained for win-<arch>, so the
 *                           computer needs no .NET (it needs the WebView2 Runtime, which Windows
 *                           10 and 11 carry)
 *   VERSION.json            version, commit, edition
 *   local/                  --local only: what the app unpacks into WSL (LocalBundle in
 *     bundle.tar.gz         Local/LocalManager.cs): the Linux release tree (release/server.ts
 *     RELEASE.json          stageRelease) with runtime/bun and runtime/space-pty
 *
 * The bundle runs inside WSL, so it is built on Linux of the same CPU as the Windows it is for: it
 * carries the Bun that builds it. Built elsewhere, --local takes a bundle made by --bundle-only.
 * dotnet builds the app anywhere, but only on Windows does the program file get its icon and
 * version (the SDK says NETSDK1074 elsewhere), so releases build it on Windows.
 */
import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SPACE_ROOT } from "../../src/space/config.ts";
import { readVersion } from "../../src/space/version.ts";
import { run, stageRelease } from "../../release/server.ts";

const HERE = join(SPACE_ROOT, "desktop", "windows");
export type WindowsArch = "x64" | "arm64";
export const BUNDLE_FILES = ["bundle.tar.gz", "RELEASE.json"] as const;

/** The CPU this machine's .NET and Bun are for, as the release names it. */
export function hostArch(): WindowsArch {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`no Windows build for ${process.arch}`);
}

/** `local/bundle.tar.gz` and `local/RELEASE.json`: the Linux release the Local edition unpacks into WSL. */
export async function buildLocalBundle(opts: { out: string; root?: string }): Promise<string> {
  if (process.platform !== "linux") throw new Error("the Local edition's bundle builds on Linux: it carries this machine's Bun, which runs in WSL");
  const root = opts.root ?? SPACE_ROOT;
  const out = resolve(opts.out);
  const stage = join(out, ".stage");
  await mkdir(out, { recursive: true });
  try {
    await stageRelease({ root, stage, edition: "local" });
    await run(["cc", "-O2", "-Wall", "-o", join(stage, "runtime", "space-pty"), join(root, "src", "space", "terminal", "pty_helper.c")], root);
    await rm(join(out, "bundle.tar.gz"), { force: true });
    // The tree's own files at the top: the app unpacks it into a directory of its choosing.
    await run(["tar", "-czf", join(out, "bundle.tar.gz"), "-C", stage, "."], root);
    await cp(join(stage, "RELEASE.json"), join(out, "RELEASE.json"));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  console.error(`[windows] local bundle → ${out}`);
  return out;
}

export async function buildWindows(opts: { out?: string; arch?: WindowsArch; local?: boolean; bundle?: string; root?: string } = {}): Promise<{ dir: string; version: string; commit: string; edition: "client" | "local" }> {
  const root = opts.root ?? SPACE_ROOT;
  const arch = opts.arch ?? hostArch();
  const dir = resolve(opts.out ?? join(HERE, "build", "ai-space"));
  const edition = opts.local ? "local" : "client";
  await rm(dir, { recursive: true, force: true });

  // The version comes from Directory.Build.props, a copy of package.json's (bun run set-version).
  await run([process.env.DOTNET || "dotnet", "publish", join(HERE, "AISpace", "AISpace.csproj"), "-c", "Release", "-r", `win-${arch}`, "--self-contained", "-p:DebugType=embedded", "--nologo", "-o", dir], root);

  const version = await readVersion(root);
  const commit = (process.env.GITHUB_SHA || (await run(["git", "rev-parse", "HEAD"], root).catch(() => ""))).trim();
  await Bun.write(join(dir, "VERSION.json"), `${JSON.stringify({ version, commit, edition, arch }, null, 2)}\n`);

  if (opts.local) {
    const local = join(dir, "local");
    if (opts.bundle) {
      await mkdir(local, { recursive: true });
      for (const f of BUNDLE_FILES) await cp(join(resolve(opts.bundle), f), join(local, f));
    } else {
      await buildLocalBundle({ out: local, root });
    }
    const release = (await Bun.file(join(local, "RELEASE.json")).json()) as { version: string; arch: string };
    if (release.version !== version) throw new Error(`the bundle is ${release.version}, the app ${version}`);
    if (release.arch !== arch) throw new Error(`the bundle is for ${release.arch}, the app for ${arch}`);
  }
  console.error(`[windows] ${edition} ${version} ${arch} → ${dir}`);
  return { dir, version, commit, edition };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arch = value("--arch");
  if (arch !== undefined && arch !== "x64" && arch !== "arm64") throw new Error("--arch is x64 or arm64");
  if (argv.includes("--bundle-only")) {
    console.log(await buildLocalBundle({ out: value("--out") ?? join(HERE, "build", "local") }));
  } else {
    const out = value("--out");
    const bundle = value("--bundle");
    console.log((await buildWindows({ ...(out ? { out } : {}), ...(arch ? { arch } : {}), ...(bundle ? { bundle } : {}), local: argv.includes("--local") })).dir);
  }
}
