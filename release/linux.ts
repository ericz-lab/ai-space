/**
 * `bun release/linux.ts [--out dist]`: the Linux desktop app, the Client edition, as one tarball
 * (docs/linux-desktop.md, docs/editions.md):
 *
 *   ai-space-desktop-<version>-linux-<arch>.tar.gz   the client (desktop/linux/build.ts)
 *
 * It unpacks to one directory; `./install.sh` in it installs the app for the user.
 */
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildLinux } from "../desktop/linux/build.ts";
import { SPACE_ROOT } from "../src/space/config.ts";
import { readVersion } from "../src/space/version.ts";
import { run } from "./server.ts";

export const linuxArchiveName = (version: string, arch: string = process.arch) => `ai-space-desktop-${version}-linux-${arch}`;

export async function releaseLinux(opts: { out: string; root?: string }): Promise<string> {
  if (process.platform !== "linux") throw new Error("the Linux app builds on Linux");
  const root = opts.root ?? SPACE_ROOT;
  const out = resolve(opts.out);
  await mkdir(out, { recursive: true });
  const name = linuxArchiveName(await readVersion(root));
  const dir = join(out, name);
  await buildLinux({ out: dir, root });
  const archive = join(out, `${name}.tar.gz`);
  await rm(archive, { force: true });
  await run(["tar", "-czf", archive, "-C", out, basename(dir)], root);
  await rm(dir, { recursive: true, force: true });
  return archive;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  console.log(await releaseLinux({ out: value("--out") ?? join(SPACE_ROOT, "dist") }));
}
