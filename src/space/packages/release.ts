import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { parsePackageManifest, type PackageManifest } from "./manifest.ts";
import { packApplication } from "./pack.ts";

/**
 * A source checkout made into packages (docs/app-catalog.md#building-from-source). The spec-2
 * declaration is `space.release.yaml` when the checkout has one (its `space.yaml` then stays spec 1
 * for a git deployment), else `space.yaml`. Without a `build:` section the checkout is packed as it
 * is, source and all (the App Studio template). With one, the checkout is copied to a scratch
 * directory, the build's commands run there, and the package carries `build.include`; a `source`
 * variant adds the source files. The checkout itself is never written to.
 */

export const RELEASE_MANIFEST = "space.release.yaml";
/** Never copied or packed: version control and its CI, installed dependencies, local secrets and data, earlier builds. */
export const SOURCE_EXCLUDE = new Set([".git", ".github", "node_modules", ".env", ".DS_Store", "data", "dist-packages"]);
const COMMAND_TIMEOUT_MS = 10 * 60_000;
const LOG_LIMIT = 64 * 1024;

export type SourceManifest = { file: string; yaml: string; manifest: PackageManifest };

/** The checkout's spec-2 declaration, or why it has none. */
export async function readSourceManifest(dir: string): Promise<SourceManifest> {
  const release = join(dir, RELEASE_MANIFEST);
  const file = (await Bun.file(release).exists()) ? release : join(dir, "space.yaml");
  if (!(await Bun.file(file).exists())) throw new Error(`no space.yaml in ${dir}`);
  const yaml = await Bun.file(file).text();
  return { file, yaml, manifest: parsePackageManifest(yaml) };
}

export type ReleaseVariant = "bundle" | "source";
export type ReleasePackage = { variant: ReleaseVariant; path: string; sha256: string; bytes: number; files: number; sourceIncluded: boolean };
export type ReleaseResult = { app: string; version: string; packages: ReleasePackage[]; log: string };

export class ReleaseError extends Error {
  constructor(message: string, readonly log = "") {
    super(message);
  }
}

/** Top-level entries of a checkout that may go into a package: everything but `SOURCE_EXCLUDE`, `.env*` files and earlier builds. */
export async function sourceEntries(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((n) => !SOURCE_EXCLUDE.has(n) && !(n.startsWith(".env.") && n !== ".env.example") && !n.endsWith(".spaceapp")).sort();
}

/**
 * The environment of a build command: enough for Bun and Git to work, nothing of the Space's own
 * (no operator token, storage credentials or app tokens reach a build script from a cloned repository).
 */
export function buildEnv(env: Record<string, string | undefined> = process.env, bun = process.execPath): Record<string, string> {
  const keep = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TERM", "BUN_INSTALL", "BUN_INSTALL_CACHE_DIR", "XDG_CACHE_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
  const out: Record<string, string> = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k]!;
  const dir = dirname(bun);
  const path = (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter).filter(Boolean);
  out.PATH = [dir, ...path.filter((p) => p !== dir)].join(delimiter);
  out.CI = "1";
  return out;
}

export type ReleaseOptions = {
  dir: string;
  outDir: string;
  /** Which packages to make. Without a `build:` section there is one, with its source. */
  variants: ReleaseVariant[];
  /** Ed25519 private key (PEM) to sign with. */
  signingKey?: string;
  /** File name of a variant's package; default `<app>-<version>.spaceapp`, the source variant of a build `<app>-<version>-source.spaceapp`. */
  fileName?: (variant: ReleaseVariant, app: string, version: string) => string;
  /** Where scratch copies go (default: the system temporary directory). */
  workRoot?: string;
  log?: (line: string) => void;
  /** Replaces running a command, for tests. */
  shell?: (command: string, cwd: string, log: (chunk: string) => void) => Promise<number>;
};

export async function buildRelease(opts: ReleaseOptions): Promise<ReleaseResult> {
  const { manifest, yaml } = await readSourceManifest(opts.dir).catch((e) => { throw new ReleaseError((e as Error).message); });
  const app = manifest.app, version = manifest.version;
  let log = "";
  const write = (chunk: string) => {
    log = (log + chunk).slice(-LOG_LIMIT);
  };
  const say = (line: string) => {
    write(line + "\n");
    opts.log?.(line);
  };
  const name = opts.fileName ?? ((variant: ReleaseVariant) => `${app}-${version}${variant === "source" && manifest.build ? "-source" : ""}.spaceapp`);
  await mkdir(opts.outDir, { recursive: true });
  const target = { os: "any", arch: "any" } as const;
  const packages: ReleasePackage[] = [];
  const pack = async (dir: string, include: string[], variant: ReleaseVariant, sourceIncluded: boolean) => {
    const output = join(opts.outDir, name(variant, app, version));
    await rm(output, { force: true });
    try {
      const r = await packApplication({ dir, include, output, target, sourceIncluded, manifest: yaml, ...(opts.signingKey ? { signingKey: opts.signingKey } : {}) });
      say(`packed ${variant}: ${r.files} files, ${r.bytes} bytes → ${output}`);
      for (const p of r.excluded) say(`  excluded ${p}`);
      packages.push({ variant, path: output, sha256: r.sha256, bytes: r.bytes, files: r.files, sourceIncluded });
    } catch (e) {
      throw new ReleaseError(`pack ${variant}: ${(e as Error).message}`, log);
    }
  };

  const entries = await sourceEntries(opts.dir);
  if (!manifest.build) {
    // The checkout is the package (App Studio's template): there is only the variant with source.
    if (!entries.includes("space.yaml")) throw new ReleaseError(`${RELEASE_MANIFEST} without a build section needs the checkout's space.yaml too`);
    await pack(opts.dir, entries.filter((n) => n !== "space.yaml"), "source", true);
    return { app, version, packages, log };
  }

  const build = manifest.build;
  const work = await mkdtemp(join(opts.workRoot ?? (process.env.TMPDIR || "/tmp"), `space-build-${app}-`));
  try {
    // Nested dependency and data directories stay behind too; only the path below the checkout counts.
    const skip = (from: string) => relative(opts.dir, from).split(sep).some((p) => SOURCE_EXCLUDE.has(p));
    for (const entry of entries) await cp(join(opts.dir, entry), join(work, entry), { recursive: true, filter: (from) => !skip(from) });
    if (!(await Bun.file(join(work, "space.yaml")).exists())) await Bun.write(join(work, "space.yaml"), yaml);
    const shell = opts.shell ?? runShell;
    for (const command of [...build.install, ...build.run]) {
      say(`$ ${command}`);
      const code = await shell(command, work, write);
      if (code !== 0) throw new ReleaseError(`build command failed (exit ${code}): ${command}`, log);
    }
    for (const path of build.include) {
      if (!(await stat(join(work, path)).catch(() => undefined))) throw new ReleaseError(`build.include names ${path}, which the build did not produce`, log);
    }
    if (opts.variants.includes("bundle")) await pack(work, build.include, "bundle", false);
    if (opts.variants.includes("source")) {
      const source = build.source ?? entries;
      await pack(work, [...new Set([...build.include, ...source])].filter((n) => n !== "space.yaml"), "source", true);
    }
    return { app, version, packages, log };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** `/bin/sh -c` in the scratch copy with `buildEnv`, output into the log, killed after ten minutes. */
async function runShell(command: string, cwd: string, log: (chunk: string) => void): Promise<number> {
  const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: buildEnv() });
  const timer = setTimeout(() => proc.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      log(decoder.decode(value, { stream: true }));
    }
  };
  try {
    await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    return await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}
