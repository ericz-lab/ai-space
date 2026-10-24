/**
 * `bun release/linux.ts [--out dist] [--edition client|local|both]`: the Linux desktop app as
 * tarballs, one per edition (docs/linux-desktop.md, docs/editions.md):
 *
 *   ai-space-linux-client-<version>-<arch>.tar.gz   the client (desktop/linux/build.ts)
 *   ai-space-linux-local-<version>-<arch>.tar.gz    the client with the Space's release tree in
 *                                                   space/ (runtime/bun, runtime/space-pty)
 *
 * Each unpacks to one directory; `./install.sh` in it installs the app for the user.
 */
import { mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { buildLinux } from "../desktop/linux/build.ts";
import { SPACE_ROOT } from "../src/space/config.ts";
import { readVersion } from "../src/space/version.ts";
import { run } from "./server.ts";

export const linuxArchiveName = (edition: "client" | "local", version: string, arch: string = process.arch) => `ai-space-linux-${edition}-${version}-${arch}`;

export async function releaseLinux(opts: { out: string; editions: ("client" | "local")[]; root?: string }): Promise<string[]> {
  if (process.platform !== "linux") throw new Error("the Linux app builds on Linux (its Local edition carries this machine's Bun)");
  const root = opts.root ?? SPACE_ROOT;
  const out = resolve(opts.out);
  await mkdir(out, { recursive: true });
  const version = await readVersion(root);
  const archives: string[] = [];
  for (const edition of opts.editions) {
    const name = linuxArchiveName(edition, version);
    const dir = join(out, name);
    await buildLinux({ out: dir, local: edition === "local", root });
    const archive = join(out, `${name}.tar.gz`);
    await rm(archive, { force: true });
    await run(["tar", "-czf", archive, "-C", out, basename(dir)], root);
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
  for (const a of await releaseLinux({ out: value("--out") ?? join(SPACE_ROOT, "dist"), editions: [...editions] })) console.log(a);
}
