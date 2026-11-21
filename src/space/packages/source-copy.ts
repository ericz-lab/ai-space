import { chmod, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PackageIndex } from "./contract.ts";
import { SOURCE_EXCLUDE } from "./release.ts";

/**
 * The editable copy of an app installed from a package with its source
 * (docs/app-catalog.md#the-source-of-an-installed-app). The installed tree under `apps/<app>/` is
 * what runs and is checked against its receipt, so it is never the place to edit; the same files
 * are put in `<workspace>/app-src/<app>/`, where `space app build` builds from.
 *
 * `.space-source.json` there records what was copied (path → SHA-256), so the Space can tell an
 * untouched copy, which a new release may replace, from one the owner changed, which is never
 * overwritten, without needing git. A directory without the record (a git checkout, an app made
 * in the Space) is the owner's and is left alone.
 */

export const SOURCE_RECORD = ".space-source.json";
const MANIFESTS = new Set(["space.yaml", "space.release.yaml"]);

export type SourceRecord = { app: string; version: string; files: Record<string, string> };
export type SourceCondition =
  | { state: "absent" }
  /** No record: not a copy the Space made. */
  | { state: "unmanaged" }
  | { state: "pristine"; version: string }
  /** `changed` lists up to 20 paths that differ, were added or are gone. */
  | { state: "modified"; version: string; changed: string[] };

/**
 * `space app build` raises `version:` in the declaration by itself; that line is not the owner's
 * change, so the declaration is compared without it.
 */
function digest(path: string, bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(MANIFESTS.has(path) ? new TextDecoder().decode(bytes).replace(/^version:.*$/m, "version:") : bytes);
  return hasher.digest("hex");
}

async function walk(root: string, at = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, at), { withFileTypes: true })) {
    if (SOURCE_EXCLUDE.has(entry.name) || (at === "" && (entry.name === SOURCE_RECORD || entry.name.endsWith(".spaceapp")))) continue;
    const path = at ? `${at}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(root, path));
    else out.push(path);
  }
  return out;
}

export async function readSourceRecord(dir: string): Promise<SourceRecord | undefined> {
  try {
    const r = JSON.parse(await Bun.file(join(dir, SOURCE_RECORD)).text()) as SourceRecord;
    return r && typeof r.app === "string" && typeof r.version === "string" && r.files && typeof r.files === "object" ? r : undefined;
  } catch { return undefined; }
}

export async function sourceCondition(dir: string): Promise<SourceCondition> {
  if (!(await lstat(dir).then(() => true, () => false))) return { state: "absent" };
  const record = await readSourceRecord(dir);
  if (!record) return { state: "unmanaged" };
  const changed: string[] = [];
  const present = new Set(await walk(dir));
  for (const [path, sha] of Object.entries(record.files)) {
    if (!present.delete(path) || digest(path, new Uint8Array(await Bun.file(join(dir, path)).arrayBuffer())) !== sha) changed.push(path);
  }
  changed.push(...present);
  return changed.length ? { state: "modified", version: record.version, changed: changed.sort().slice(0, 20) } : { state: "pristine", version: record.version };
}

/** Copy an installed app's files (its declaration and everything its package index lists) to `dir`, with the record. */
async function copyInstalled(installed: { dir: string; index: PackageIndex }, dir: string, app: string, version: string): Promise<void> {
  const files: Record<string, string> = {};
  for (const path of ["space.yaml", ...installed.index.files.map((f) => f.path)]) {
    const to = join(dir, path);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(installed.dir, path), to);
    // The installed tree may be read-only; the copy is for editing.
    const mode = (await lstat(to)).mode;
    await chmod(to, (mode | 0o600) & 0o777);
    files[path] = digest(path, new Uint8Array(await Bun.file(to).arrayBuffer()));
  }
  await Bun.write(join(dir, SOURCE_RECORD), JSON.stringify({ app, version, files } satisfies SourceRecord, null, 1) + "\n");
}

export type SourceOutcome =
  /** `copied`: first copy. `updated`: an untouched copy replaced by this version's. `kept`: the owner's, left as it is. `replaced`: the owner's moved to `saved`, this version's put in. */
  { dir: string; action: "copied" | "updated" | "kept" | "replaced"; saved?: string; changed?: string[] };

/**
 * Put the installed version's source at `dir`, unless what is there is the owner's. With `replace`
 * a changed copy is moved aside (never deleted) and the new one takes its place.
 */
export async function placeSource(installed: { dir: string; index: PackageIndex }, dir: string, app: string, version: string, opts: { replace?: boolean; now?: () => Date } = {}): Promise<SourceOutcome> {
  const condition = await sourceCondition(dir);
  if (condition.state === "unmanaged" || (condition.state === "modified" && !opts.replace)) {
    return { dir, action: "kept", ...(condition.state === "modified" ? { changed: condition.changed } : {}) };
  }
  await mkdir(dirname(dir), { recursive: true });
  const temp = `${dir}.new-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await copyInstalled(installed, temp, app, version);
    if (condition.state === "absent") { await rename(temp, dir); return { dir, action: "copied" }; }
    if (condition.state === "pristine") {
      // Dependencies and data the owner's tools put there (node_modules, .env, .git) move over to the new copy.
      for (const name of await readdir(dir)) if (SOURCE_EXCLUDE.has(name) && name !== SOURCE_RECORD) await rename(join(dir, name), join(temp, name)).catch(() => {});
      const old = `${dir}.old-${crypto.randomUUID().slice(0, 8)}`;
      await rename(dir, old); await rename(temp, dir); await rm(old, { recursive: true, force: true });
      return { dir, action: "updated" };
    }
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    const saved = `${dir}.saved-${stamp}`;
    await rename(dir, saved); await rename(temp, dir);
    return { dir, action: "replaced", saved };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
