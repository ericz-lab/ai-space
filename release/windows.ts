/**
 * `bun release/windows.ts [--out dist] [--arch x64|arm64]`: AI Space Desktop for Windows as a zip
 * file (docs/windows-desktop.md, docs/editions.md):
 *
 *   ai-space-desktop-<version>-windows-<arch>.zip   the client (desktop/windows/build.ts)
 *
 * It unpacks to one folder; AISpace.exe in it runs from there and offers to install itself for
 * the user. It carries no AI Space: that is the release's own archive and installer.
 */
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildWindows, hostArch, type WindowsArch } from "../desktop/windows/build.ts";
import { SPACE_ROOT } from "../src/space/config.ts";
import { readVersion } from "../src/space/version.ts";
import { run } from "./server.ts";

export const windowsArchiveName = (version: string, arch: WindowsArch) => `ai-space-desktop-${version}-windows-${arch}`;

/** Zips `dir` into `archive` with the folder itself at the top. */
async function zip(dir: string, archive: string): Promise<void> {
  await rm(archive, { force: true });
  const parent = resolve(dir, "..");
  if (process.platform === "win32") {
    // Windows' own tar writes zip by the name's extension; a tar earlier in PATH (Git's) may not.
    await run([join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), "-a", "-c", "-f", archive, "-C", parent, basename(dir)], parent);
  } else {
    await run(["zip", "-q", "-r", "-X", archive, basename(dir)], parent);
  }
}

export async function releaseWindows(opts: { out: string; arch?: WindowsArch; root?: string }): Promise<string> {
  const root = opts.root ?? SPACE_ROOT;
  const arch = opts.arch ?? hostArch();
  const out = resolve(opts.out);
  await mkdir(out, { recursive: true });
  const name = windowsArchiveName(await readVersion(root), arch);
  const dir = join(out, name);
  await buildWindows({ out: dir, arch, root });
  const archive = join(out, `${name}.zip`);
  await zip(dir, archive);
  await rm(dir, { recursive: true, force: true });
  return archive;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arch = value("--arch");
  if (arch !== undefined && arch !== "x64" && arch !== "arm64") throw new Error("--arch is x64 or arm64");
  console.log(await releaseWindows({ out: value("--out") ?? join(SPACE_ROOT, "dist"), ...(arch ? { arch } : {}) }));
}
