import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DEFAULT_ARCHIVE_LIMIT, readArchive, writeArchive, type ArchiveEntry } from "./archive.ts";
import { mapping, MAX_FILES, MAX_METADATA_BYTES, packagePath, parsePackageIndex, type PackageIndex, type PackageTarget } from "./contract.ts";
import { parsePackageManifest, type PackageManifest } from "./manifest.ts";

export type InspectedPackage = {
  index: PackageIndex;
  manifest: PackageManifest;
  files: Map<string, ArchiveEntry>;
  signature: { status: "unsigned" } | { status: "verified" | "untrusted"; keyId: string };
};

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

/** Build from explicit app-relative files/directories. No build commands or install hooks run. */
export async function packApplication(opts: {
  dir: string;
  include: string[];
  output: string;
  target: PackageTarget;
  sourceIncluded: boolean;
  signingKey?: string;
  limit?: number;
}): Promise<{ path: string; app: string; version: string; files: number; bytes: number; sha256: string; excluded: string[] }> {
  const root = await realpath(opts.dir);
  const output = resolve(opts.output);
  if (output === root || output.startsWith(root + sep)) throw new Error("write packages outside the source directory");
  const limit = opts.limit ?? DEFAULT_ARCHIVE_LIMIT;
  const files = new Map<string, ArchiveEntry>();
  const excluded: string[] = [];
  let bytes = 0;
  const visit = async (path: string) => {
    packagePath(path);
    if (excludedPath(path)) { excluded.push(path); return; }
    // Check every ancestor: include may name a file below a symlink directly.
    const pieces = path.split("/");
    for (let i = 1; i < pieces.length; i++) {
      if (!(await lstat(join(root, ...pieces.slice(0, i)))).isDirectory()) throw new Error(`package ancestor must be a real directory: ${path}`);
    }
    const absolute = join(root, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`package cannot contain a symlink: ${path}; bundle dependencies first`);
    if (stat.isDirectory()) {
      for (const child of (await readdir(absolute)).sort()) await visit(`${path}/${child}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`package cannot contain special files: ${path}`);
    if (files.has(path)) return;
    if (files.size >= MAX_FILES) throw new Error("selected files exceed package file limit");
    bytes += stat.size;
    if (bytes > limit) throw new Error("selected files exceed package byte limit");
    const content = new Uint8Array(await Bun.file(absolute).arrayBuffer());
    if (content.length !== stat.size) throw new Error(`file changed while packing: ${path}`);
    files.set(path, { path, bytes: content, executable: !!(stat.mode & 0o111) });
  };
  for (const path of ["space.yaml", ...opts.include]) await visit(path);
  const entries = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const index = parsePackageIndex({ format: 1, target: opts.target, sourceIncluded: opts.sourceIncluded, files: entries.map((f) => ({ path: f.path, size: f.bytes.length, sha256: sha256(f.bytes), executable: f.executable })) });
  const manifest = validatePayload(index, files);
  const metadata = new TextEncoder().encode(JSON.stringify(index));
  if (metadata.length > MAX_METADATA_BYTES) throw new Error("package index exceeds metadata limit");
  const outer: ArchiveEntry[] = [{ path: "package.json", bytes: metadata, executable: false }];
  if (opts.signingKey) {
    const key = createPrivateKey(opts.signingKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("package signing requires an Ed25519 key");
    const envelope = { algorithm: "ed25519", keyId: publicKeyId(createPublicKey(key)), signature: sign(null, metadata, key).toString("base64") };
    outer.push({ path: "package.sig", bytes: new TextEncoder().encode(JSON.stringify(envelope)), executable: false });
  }
  outer.push(...entries.map((e) => ({ ...e, path: `app/${e.path}` })));
  const archive = writeArchive(outer, limit);
  if (archive.length > limit) throw new Error("compressed package exceeds byte limit");
  // Exclusive creation prevents silently replacing an existing release or following an output link.
  const handle = await open(output, "wx", 0o600);
  try { await handle.writeFile(archive); } finally { await handle.close(); }
  return { path: output, app: manifest.app, version: manifest.version, files: files.size, bytes: archive.length, sha256: sha256(archive), excluded };
}

export async function readPackageFile(path: string, limit = DEFAULT_ARCHIVE_LIMIT): Promise<Uint8Array> {
  const file = Bun.file(path);
  if (file.size > limit) throw new Error("compressed package exceeds byte limit");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > limit) throw new Error("compressed package exceeds byte limit");
  return bytes;
}

/** Inspection never executes code. Untrusted signatures are reported, not promoted to trusted. */
export async function inspectPackage(bytes: Uint8Array, trustedKeys: string[] = [], limit = DEFAULT_ARCHIVE_LIMIT): Promise<InspectedPackage> {
  const entries = await readArchive(bytes, limit);
  const outer = new Map(entries.map((e) => [e.path, e]));
  const metadata = outer.get("package.json");
  if (!metadata || metadata.executable || metadata.bytes.length > MAX_METADATA_BYTES) throw new Error("missing or invalid package.json");
  const index = parsePackageIndex(json(metadata.bytes));
  const files = new Map<string, ArchiveEntry>();
  for (const e of entries) {
    if (e.path === "package.json" || e.path === "package.sig") continue;
    if (!e.path.startsWith("app/")) throw new Error(`unexpected outer file: ${e.path}`);
    files.set(e.path.slice(4), { ...e, path: e.path.slice(4) });
  }
  const manifest = validatePayload(index, files);
  const envelope = outer.get("package.sig");
  if (!envelope) return { index, manifest, files, signature: { status: "unsigned" } };
  if (envelope.executable || envelope.bytes.length > 4096) throw new Error("invalid package.sig");
  const s = mapping(json(envelope.bytes), "signature", ["algorithm", "keyId", "signature"]);
  if (s.algorithm !== "ed25519" || typeof s.keyId !== "string" || !/^[a-f0-9]{64}$/.test(s.keyId) || typeof s.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(s.signature)) throw new Error("invalid signature envelope");
  const key = trustedKeys.map((pem) => createPublicKey(pem)).find((k) => k.asymmetricKeyType === "ed25519" && publicKeyId(k) === s.keyId);
  if (!key) return { index, manifest, files, signature: { status: "untrusted", keyId: s.keyId } };
  if (!verify(null, metadata.bytes, key, Buffer.from(s.signature, "base64"))) throw new Error("invalid package signature");
  return { index, manifest, files, signature: { status: "verified", keyId: s.keyId } };
}

function publicKeyId(key: KeyObject): string { return sha256(key.export({ type: "spki", format: "der" })); }
function json(bytes: Uint8Array): unknown { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }

function validatePayload(index: PackageIndex, files: Map<string, ArchiveEntry>): PackageManifest {
  if (files.size !== index.files.length) throw new Error("archive file count differs from package index");
  for (const f of index.files) {
    const found = files.get(f.path);
    if (!found || found.bytes.length !== f.size || sha256(found.bytes) !== f.sha256 || found.executable !== f.executable) throw new Error(`package file failed integrity check: ${f.path}`);
    if (excludedPath(f.path)) throw new Error(`package contains an excluded file: ${f.path}`);
    if (index.target.os === "any" && nativeMagic(found.bytes)) throw new Error(`native binary requires a concrete platform target: ${f.path}`);
  }
  const manifest = parsePackageManifest(new TextDecoder("utf-8", { fatal: true }).decode(files.get("space.yaml")!.bytes));
  const launch = manifest.launch;
  if (launch?.kind === "static" && !files.has(`${launch.root}/${launch.index}`)) throw new Error("static launch index is absent from package");
  if (launch?.kind === "process") {
    const entry = files.get(launch.entry);
    if (!entry) throw new Error("process launch entry is absent from package");
    if (launch.runtime === "native" && (index.target.os === "any" || !entry.executable)) throw new Error("native launch needs an executable entry and concrete platform target");
  }
  for (const agent of manifest.agents) {
    if (agent.prompt && !files.has(packagePath(agent.prompt.replace(/^\.\//, ""), "agent.prompt"))) throw new Error(`agent prompt is absent: ${agent.prompt}`);
  }
  for (const task of manifest.tasks) {
    if (task.target.kind === "agent" && !files.has(packagePath(task.target.prompt.replace(/^\.\//, ""), "task.prompt"))) throw new Error(`task prompt is absent: ${task.target.prompt}`);
  }
  return manifest;
}

function excludedPath(path: string): boolean {
  return path.split("/").some((part) => {
    const p = part.toLowerCase();
    return [".git", ".ssh", "data", "logs", "secrets", "space.env", ".ds_store", "id_rsa", "id_ed25519"].includes(p)
      || (p === ".env" || p.startsWith(".env.")) && p !== ".env.example"
      || /\.(db|sqlite|sqlite3)(-wal|-shm)?$/.test(p) || /\.(pem|key|log)$/.test(p);
  });
}

function nativeMagic(bytes: Uint8Array): boolean {
  const magic = Buffer.from(bytes.subarray(0, 4)).toString("hex");
  return ["7f454c46", "feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(magic) || bytes[0] === 77 && bytes[1] === 90;
}
