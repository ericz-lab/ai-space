import { lstat, mkdir, open, rename, rm, rmdir, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Workspace } from "../workspace.ts";
import { assertTarget, installationKey } from "./contract.ts";
import { assertPackageCompatibility } from "./manifest.ts";
import { inspectPackage, sha256 } from "./pack.ts";
import { PackageStore, type InstallOperation } from "./store.ts";

const RECEIPT = ".space-install.json";
export type InstallOptions = {
  id?: string;
  trustedKeys?: string[];
  /** Explicit trust decision for a local unsigned artifact, not implied by upload permission. */
  allowUnsigned?: boolean;
};

/** File installation only. No scripts, services or tasks start until a runtime activates the app. */
export class PackageInstaller {
  private closing = false;
  private readonly pending = new Set<Promise<InstallOperation>>();
  constructor(readonly ws: Workspace, readonly store: PackageStore, readonly host = { os: process.platform as string, arch: process.arch as string, bun: Bun.version }) {}

  install(bytes: Uint8Array, options: InstallOptions = {}): Promise<InstallOperation> {
    if (this.closing) return Promise.reject(new Error("package installer is shutting down"));
    if (this.pending.size >= 2) return Promise.reject(new Error("package installer is busy; query existing operations before retrying"));
    const promise = this.performInstall(bytes, options);
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }

  async drain(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.pending);
  }

  private async performInstall(bytes: Uint8Array, options: InstallOptions): Promise<InstallOperation> {
    const inspected = await inspectPackage(bytes, options.trustedKeys);
    if (inspected.signature.status !== "verified" && !(inspected.signature.status === "unsigned" && options.allowUnsigned)) throw new Error("installation requires a trusted signature or an explicit unsigned local-package decision");
    assertTarget(inspected.index.target, this.host);
    assertPackageCompatibility(inspected.manifest, this.host.bun);
    const app = inspected.manifest.app;
    if (app === "space") throw new Error("the app name space is reserved");
    installationKey(this.store.spaceId, app);
    if (inspected.files.has(RECEIPT)) throw new Error(`${RECEIPT} is reserved for the installer`);
    await realDirectory(this.ws.apps);
    await realDirectory(this.ws.run);
    const root = join(this.ws.run, "packages");
    await realDirectory(root);
    const disk = await statfs(this.ws.apps);
    const needed = [...inspected.files.values()].reduce((n, f) => n + f.bytes.length, 0) + 1024 * 1024;
    if (disk.bavail * disk.bsize < needed) throw new Error("insufficient free space for package installation");
    const { operation, fresh } = this.store.reserve(options.id ?? crypto.randomUUID(), app, inspected.manifest.version, sha256(bytes));
    if (!fresh) return operation;
    const stage = join(root, operation.id);
    const destination = join(this.ws.apps, app);
    let published = false;
    let ownsStage = false;
    let reservedDestination = false;
    try {
      if (await exists(destination)) throw new Error(`${app} already has an app directory; explicit migration is required`);
      await mkdir(stage, { mode: 0o700 });
      ownsStage = true;
      for (const f of inspected.files.values()) {
        const path = join(stage, f.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, "wx", f.executable ? 0o755 : 0o644);
        try { await handle.writeFile(f.bytes); await handle.sync(); } finally { await handle.close(); }
      }
      // The receipt commits the exact operation and archive hash; it is not an app-owned file.
      const receipt = await open(join(stage, RECEIPT), "wx", 0o600);
      try { await receipt.writeFile(JSON.stringify({ id: operation.id, digest: operation.digest, index: inspected.index })); await receipt.sync(); } finally { await receipt.close(); }
      // Reserve an absent destination atomically, so rename never replaces another existing tree.
      await mkdir(destination, { mode: 0o700 });
      reservedDestination = true;
      await rename(stage, destination);
      published = true;
      return this.store.finish(operation.id, "installed");
    } catch (e) {
      // A published tree can be recovered from its receipt after restart; do not erase it on a DB error.
      if (published) throw e;
      if (ownsStage) await rm(stage, { recursive: true, force: true });
      if (reservedDestination) await rmdir(destination).catch(() => {}); // Only remove an empty reservation.
      return this.store.finish(operation.id, "failed", (e as Error).message);
    }
  }

  /** Run once at service startup, before accepting new install calls. Never runs package code. */
  async recover(): Promise<InstallOperation[]> {
    const recovered: InstallOperation[] = [];
    for (const operation of this.store.list().filter((o) => o.state === "installing")) {
      const destination = join(this.ws.apps, operation.app);
      try {
        const stat = await lstat(destination).catch(() => undefined);
        if (!stat?.isDirectory()) throw new Error("installation interrupted before publication");
        const receiptPath = join(destination, RECEIPT);
        if (!(await lstat(receiptPath)).isFile()) throw new Error("installation receipt is not a regular file");
        const receipt = await Bun.file(receiptPath).json() as { id?: string; digest?: string; index?: unknown };
        if (receipt.id !== operation.id || receipt.digest !== operation.digest) throw new Error("installation receipt does not match the journal");
        const { parsePackageIndex } = await import("./contract.ts");
        const index = parsePackageIndex(receipt.index);
        for (const f of index.files) {
          const pieces = f.path.split("/");
          for (let i = 1; i < pieces.length; i++) if (!(await lstat(join(destination, ...pieces.slice(0, i)))).isDirectory()) throw new Error("installed path has an unsafe ancestor");
          const file = join(destination, f.path);
          const s = await lstat(file);
          if (!s.isFile() || s.size !== f.size || !!(s.mode & 0o111) !== f.executable || sha256(new Uint8Array(await Bun.file(file).arrayBuffer())) !== f.sha256) throw new Error(`installed file failed recovery validation: ${f.path}`);
        }
        recovered.push(this.store.finish(operation.id, "installed"));
      } catch (e) {
        recovered.push(this.store.finish(operation.id, "failed", (e as Error).message));
      }
      // Only the private staging directory owned by this journal operation is removed.
      const stage = join(this.ws.run, "packages", operation.id);
      const parent = await lstat(dirname(stage)).catch(() => undefined);
      if (parent?.isDirectory()) await rm(stage, { recursive: true, force: true });
    }
    return recovered;
  }
}

async function realDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error(`expected a real directory: ${path}`);
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (e) { if ((e as { code?: string }).code === "ENOENT") return false; throw e; }
}
