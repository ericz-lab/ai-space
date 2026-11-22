/**
 * `bun release/windows.ts [--out dist] [--arch x64|arm64]`: AI Space Desktop for Windows as one
 * program file (docs/windows-desktop.md, docs/editions.md):
 *
 *   ai-space-desktop-<version>-windows-<arch>.exe   the client (desktop/windows/build.ts)
 *
 * It runs where it is downloaded and offers to install itself for the user (as AISpace.exe). It
 * carries no AI Space: that is the release's own archive and installer.
 */
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildWindows, hostArch, type WindowsArch } from "../desktop/windows/build.ts";
import { SPACE_ROOT } from "../src/space/config.ts";
import { readVersion } from "../src/space/version.ts";

export const windowsArchiveName = (version: string, arch: WindowsArch) => `ai-space-desktop-${version}-windows-${arch}`;

export async function releaseWindows(opts: { out: string; arch?: WindowsArch; root?: string }): Promise<string> {
  const root = opts.root ?? SPACE_ROOT;
  const arch = opts.arch ?? hostArch();
  const out = resolve(opts.out);
  await mkdir(out, { recursive: true });
  const name = windowsArchiveName(await readVersion(root), arch);
  const dir = join(out, name);
  const { exe } = await buildWindows({ out: dir, arch, root });
  const program = join(out, `${name}.exe`);
  await copyFile(exe, program);
  await rm(dir, { recursive: true, force: true });
  return program;
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
