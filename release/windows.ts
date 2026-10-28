/**
 * `bun release/windows.ts [--out dist] [--arch x64|arm64] [--edition client|local|both] [--bundle <dir>]`:
 * the Windows app as zip files, one per edition (docs/windows-desktop.md, docs/editions.md):
 *
 *   ai-space-windows-client-<version>-<arch>.zip   the client (desktop/windows/build.ts)
 *   ai-space-windows-local-<version>-<arch>.zip    the client with local/, the Linux release it
 *                                                  sets up in WSL 2
 *
 * Each unpacks to one folder; AISpace.exe in it runs from there and offers to install itself for
 * the user. The Local edition takes its bundle from --bundle (made on Linux by
 * `bun desktop/windows/build.ts --bundle-only`), or builds it when this machine is Linux.
 */
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildWindows, hostArch, type WindowsArch } from "../desktop/windows/build.ts";
import { SPACE_ROOT } from "../src/space/config.ts";
import { readVersion } from "../src/space/version.ts";
import { run } from "./server.ts";

export const windowsArchiveName = (edition: "client" | "local", version: string, arch: WindowsArch) => `ai-space-windows-${edition}-${version}-${arch}`;

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

export async function releaseWindows(opts: { out: string; editions: ("client" | "local")[]; arch?: WindowsArch; bundle?: string; root?: string }): Promise<string[]> {
  const root = opts.root ?? SPACE_ROOT;
  const arch = opts.arch ?? hostArch();
  const out = resolve(opts.out);
  await mkdir(out, { recursive: true });
  const version = await readVersion(root);
  const archives: string[] = [];
  for (const edition of opts.editions) {
    const name = windowsArchiveName(edition, version, arch);
    const dir = join(out, name);
    await buildWindows({ out: dir, arch, local: edition === "local", ...(opts.bundle ? { bundle: opts.bundle } : {}), root });
    const archive = join(out, `${name}.zip`);
    await zip(dir, archive);
    await rm(dir, { recursive: true, force: true });
    archives.push(archive);
  }
  return archives;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const edition = value("--edition") ?? "both";
  const editions = edition === "both" ? (["client", "local"] as const) : [edition as "client" | "local"];
  if (!editions.every((e) => e === "client" || e === "local")) throw new Error("--edition is client, local or both");
  const arch = value("--arch");
  if (arch !== undefined && arch !== "x64" && arch !== "arm64") throw new Error("--arch is x64 or arm64");
  const bundle = value("--bundle");
  for (const a of await releaseWindows({ out: value("--out") ?? join(SPACE_ROOT, "dist"), editions: [...editions], ...(arch ? { arch } : {}), ...(bundle ? { bundle } : {}) })) console.log(a);
}
