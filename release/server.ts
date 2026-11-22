/**
 * `bun release/server.ts [--out dist]`: the Server edition's release archive for this machine's
 * system and CPU (docs/release.md).
 *
 *   ai-space-<version>-<os>-<arch>.tar.gz
 *     ai-space-<version>-<os>-<arch>/
 *       install.sh          release/install.sh: install or upgrade from this directory
 *                           (the windows archive: install.ps1, release/install.ps1)
 *       RELEASE.json        product, version, commit, os, arch, bun
 *       runtime/bun         the Bun that built it, so the machine needs none (windows: bun.exe)
 *       node_modules/       production dependencies, installed from bun.lock
 *       src/ skills/ bin/ deploy/ docs/ ...   the committed tree, without tests
 *
 * Only committed files go in (`git ls-files`), so a dirty checkout cannot leak into a release.
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { SPACE_ROOT } from "../src/space/config.ts";
import { readVersion } from "../src/space/version.ts";

/** Top-level paths of the tree that go into the archive. */
export const INCLUDE = ["src/", "skills/", "bin/", "deploy/", "docs/", "package.json", "bun.lock", "tsconfig.json", ".env.example", "AGENTS.md", "CLAUDE.md", "README.md", "README.zh-CN.md"];

/** Whether a committed path goes into the archive. */
export function included(path: string): boolean {
  if (/\.test\.tsx?$/.test(path)) return false;
  return INCLUDE.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p));
}

export type ReleaseInfo = { product: "ai-space"; edition: "server" | "local"; version: string; commit: string; os: string; arch: string; bun: string };

/** The system in an archive's name: `linux`, `macos` or `windows`. */
export const releaseOs = (platform: string = process.platform): string => (platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform);

/** The Bun inside a release tree, relative to it. */
export const runtimeBun = (platform: string = process.platform): string => join("runtime", platform === "win32" ? "bun.exe" : "bun");

export function archiveName(info: Pick<ReleaseInfo, "version" | "os" | "arch">): string {
  return `ai-space-${info.version}-${info.os}-${info.arch}`;
}

export async function run(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return out;
}

/**
 * The release tree both editions run from, at `stage`: the committed files, production
 * dependencies, `runtime/bun` and `RELEASE.json`. The Server puts `install.sh` beside it and tars
 * it; the Local edition puts it inside the Mac app (release/local.ts).
 */
export async function stageRelease(opts: { root?: string; stage: string; edition: ReleaseInfo["edition"] }): Promise<ReleaseInfo> {
  const root = opts.root ?? SPACE_ROOT;
  const os = releaseOs();
  const info: ReleaseInfo = {
    product: "ai-space",
    edition: opts.edition,
    version: await readVersion(root),
    commit: (process.env.GITHUB_SHA || (await run(["git", "rev-parse", "HEAD"], root))).trim(),
    os,
    arch: process.arch,
    bun: Bun.version,
  };
  const stage = resolve(opts.stage);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const files = (await run(["git", "ls-files", "-z"], root)).split("\0").filter((f) => f && included(f));
  for (const f of files) {
    await mkdir(dirname(join(stage, f)), { recursive: true });
    await cp(join(root, f), join(stage, f), { preserveTimestamps: true });
  }
  console.error(`[release] ${files.length} files`);

  await run([process.execPath, "install", "--frozen-lockfile", "--production"], stage);
  await mkdir(join(stage, "runtime"), { recursive: true });
  await cp(process.execPath, join(stage, runtimeBun()));
  await chmod(join(stage, runtimeBun()), 0o755);
  await Bun.write(join(stage, "RELEASE.json"), `${JSON.stringify(info, null, 2)}\n`);
  return info;
}

export async function buildServer(opts: { root?: string; out: string }): Promise<string> {
  const root = opts.root ?? SPACE_ROOT;
  const out = resolve(opts.out);
  const os = releaseOs();
  const name = archiveName({ version: await readVersion(root), os, arch: process.arch });
  const stage = join(out, name);
  await stageRelease({ root, stage, edition: "server" });
  // Each system's archive carries the installer that system can run.
  const installer = process.platform === "win32" ? "install.ps1" : "install.sh";
  await cp(join(root, "release", installer), join(stage, installer));
  await chmod(join(stage, installer), 0o755);

  const archive = join(out, `${name}.tar.gz`);
  await rm(archive, { force: true });
  // Windows' own tar: a `tar` found on the search path there may be Git's, which reads `C:` as a remote host.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  await run([tar, "-czf", archive, "-C", out, name], root);
  await rm(stage, { recursive: true, force: true });
  return archive;
}

if (import.meta.main) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 ? process.argv[i + 1]! : join(SPACE_ROOT, "dist");
  console.log(await buildServer({ out }));
}
