/** Pure validation for package format 1. See docs/app-packages.md. No files are executed here. */
export const PACKAGE_FORMAT = 1;
export const PACKAGE_API = 1;
export const MAX_FILES = 100_000;
export const MAX_UNPACKED_BYTES = 4 * 1024 ** 3;
export const MAX_METADATA_BYTES = 32 * 1024 ** 2;

export type PackageTarget = { os: "any" | "linux" | "darwin"; arch: "any" | "x64" | "arm64" };
export type PackageFile = { path: string; size: number; sha256: string; executable: boolean };
export type PackageIndex = {
  format: 1;
  target: PackageTarget;
  sourceIncluded: boolean;
  files: PackageFile[];
};

export function mapping(raw: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${where} must be a mapping`);
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) if (!keys.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
  return doc;
}

export function text(raw: unknown, where: string, max = 300): string {
  if (typeof raw !== "string" || !raw.length || raw !== raw.trim() || raw.length > max || /[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error(`${where} must be a non-empty string without surrounding whitespace or control characters (max ${max})`);
  }
  return raw;
}

export function integer(raw: unknown, where: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) throw new Error(`${where} must be an integer from ${min} to ${max}`);
  return raw;
}

export function choice<T extends string>(raw: unknown, where: string, values: readonly T[]): T {
  if (typeof raw !== "string" || !values.includes(raw as T)) throw new Error(`${where} must be one of ${values.join(", ")}`);
  return raw as T;
}

/** Paths are app-relative POSIX paths, not URLs. Reject aliases before accessing any filesystem. */
export function packagePath(raw: unknown, where = "path"): string {
  const value = text(raw, where, 1024);
  if (!/^[A-Za-z0-9_@.+/-]+$/.test(value) || value.startsWith("/") || value.split("/").some((p) => !p || p === "." || p === ".." || p.endsWith("."))) {
    throw new Error(`${where} must be a canonical relative package path`);
  }
  return value;
}

/** Release versions deliberately use a small, deterministic grammar; no ranges or implicit latest. */
export function releaseVersion(raw: unknown, where = "version"): string {
  const value = text(raw, where, 80);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) || value.split(".").some((v) => !Number.isSafeInteger(Number(v)))) {
    throw new Error(`${where} must be a numeric major.minor.patch release`);
  }
  return value;
}

export function parsePackageIndex(raw: unknown): PackageIndex {
  const doc = mapping(raw, "package", ["format", "target", "sourceIncluded", "files"]);
  if (doc.format !== PACKAGE_FORMAT) throw new Error(`unsupported package format ${String(doc.format)}`);
  const target = mapping(doc.target, "target", ["os", "arch"]);
  const os = choice(target.os, "target.os", ["any", "linux", "darwin"]);
  const arch = choice(target.arch, "target.arch", ["any", "x64", "arm64"]);
  if ((os === "any") !== (arch === "any")) throw new Error("portable packages must use any for both os and arch");
  if (typeof doc.sourceIncluded !== "boolean") throw new Error("sourceIncluded must be a boolean");
  if (!Array.isArray(doc.files) || !doc.files.length || doc.files.length > MAX_FILES) throw new Error(`files must contain 1 to ${MAX_FILES} entries`);
  const paths = new Set<string>();
  let total = 0;
  const files = doc.files.map((raw, i): PackageFile => {
    const at = `files[${i}]`;
    const f = mapping(raw, at, ["path", "size", "sha256", "executable"]);
    const path = packagePath(f.path, `${at}.path`);
    // Case-insensitive hosts must see the same archive as case-sensitive hosts.
    const key = path.toLowerCase();
    if (paths.has(key)) throw new Error(`duplicate package path: ${path}`);
    paths.add(key);
    const size = integer(f.size, `${at}.size`, 0, MAX_UNPACKED_BYTES);
    total += size;
    if (total > MAX_UNPACKED_BYTES) throw new Error("package exceeds total unpacked byte limit");
    if (typeof f.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error(`${at}.sha256 must be a lowercase SHA-256 digest`);
    if (typeof f.executable !== "boolean") throw new Error(`${at}.executable must be a boolean`);
    return { path, size, sha256: f.sha256, executable: f.executable };
  });
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join("/"))) throw new Error(`file/directory collision: ${path}`);
    }
  }
  if (!files.some((f) => f.path === "space.yaml" && !f.executable)) throw new Error("package needs a non-executable space.yaml");
  return { format: PACKAGE_FORMAT, target: { os, arch }, sourceIncluded: doc.sourceIncluded, files };
}

export function assertTarget(target: PackageTarget, host: { os: string; arch: string }): void {
  if (target.os !== "any" && (target.os !== host.os || target.arch !== host.arch)) throw new Error(`package targets ${target.os}/${target.arch}, host is ${host.os}/${host.arch}`);
}

/** Installation identity is independent of peer aliases, hostnames, public URLs and ports. */
export function installationKey(spaceId: string, appId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(spaceId)) throw new Error("spaceId must be a lowercase UUID v4");
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(appId) || appId === "." || appId === "..") throw new Error("invalid appId");
  return `${spaceId}/${appId}`;
}
