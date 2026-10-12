import { Database } from "bun:sqlite";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { join } from "node:path";
import { workspacePaths } from "../workspace.ts";
import { installationKey } from "./contract.ts";
import { PackageInstaller, type InstallOptions } from "./install.ts";
import { inspectPackage, sha256 } from "./pack.ts";
import { PackageStore, type InstallOperation } from "./store.ts";

type Change = { id: string; app: string; kind: "upgrade" | "rollback" | "uninstall"; oldId: string; newId: string | null; state: "pending" | "done" | "failed"; error: string | null; createdAt: string; updatedAt: string };
type Row = { id: string; app: string; kind: Change["kind"]; old_id: string; new_id: string | null; state: Change["state"]; error: string | null; created_at: number; updated_at: number };
type Hooks = {
  suspend: (app: string) => Promise<() => void>; activate: (app: string) => Promise<void>; remove: (app: string) => Promise<void>;
  /** Proves the newly activated version starts; a throw restores the previous code. */
  verify?: (app: string) => Promise<void>;
};

/** Journaled code replacement. Data is deliberately never moved, deleted or rolled back here. */
export class PackageLifecycle {
  private readonly pending = new Set<Promise<Change>>();
  private closing = false;
  constructor(readonly installer: PackageInstaller, private readonly hooks: Hooks) {}
  get store() { return this.installer.store; }
  list(): Change[] { return (this.store.db.query("SELECT * FROM package_changes ORDER BY created_at,id").all() as Row[]).map(view); }
  get(id: string): Change | undefined { const row = this.store.db.query("SELECT * FROM package_changes WHERE id=?").get(id) as Row | null; return row ? view(row) : undefined; }

  upgrade(bytes: Uint8Array, options: InstallOptions = {}): Promise<Change> {
    return this.track(async () => {
      // Validate before reserving a mutation; the isolated installer enforces publisher trust again.
      const inspected = await inspectPackage(bytes, options.trustedKeys);
      if (inspected.signature.status !== "verified" && !(inspected.signature.status === "unsigned" && options.allowUnsigned)) throw new Error("upgrade requires a trusted signature or explicit unsigned decision");
      const app = inspected.manifest.app;
      const id = options.id ?? crypto.randomUUID();
      const previous = this.get(id);
      if (previous) {
        const target = previous.newId ? this.store.get(previous.newId) : undefined;
        if (previous.app !== app || previous.kind !== "upgrade" || target?.digest !== sha256(bytes)) throw new Error("operation ID belongs to a different change");
        return previous;
      }
      const change = this.reserve(id, app, "upgrade");
      const root = this.root(change.id);
      try {
        await this.makeRoot(root);
        const ws = workspacePaths(join(root, "staging"));
        await mkdir(ws.home, { mode: 0o700 });
        const db = new Database(":memory:");
        let next: InstallOperation;
        try {
          const staged = new PackageInstaller(ws, new PackageStore(db), this.installer.host);
          next = await staged.install(bytes, { ...options, id: crypto.randomUUID() });
          if (next.state !== "installed") throw new Error(next.error ?? "staging failed");
          await staged.drain();
        } finally { db.close(); }
        this.store.db.transaction(() => {
          this.store.retain(next);
          this.store.db.query("UPDATE package_changes SET new_id=?,updated_at=? WHERE id=?").run(next.id, Date.now(), id);
        }).immediate();
        return await this.switch(this.get(id)!, join(ws.apps, app));
      } catch (e) { return this.fail(change.id, e); }
    });
  }

  rollback(app: string, operationId: string, id: string = crypto.randomUUID()): Promise<Change> {
    return this.track(async () => {
      const existing = this.get(id);
      if (existing) {
        if (existing.app !== app || existing.kind !== "rollback" || existing.newId !== operationId) throw new Error("operation ID belongs to a different change");
        return existing;
      }
      const target = this.store.get(operationId);
      if (!target || target.app !== app || target.state !== "retired") throw new Error("rollback target is not a retained version of this app");
      const source = this.list().findLast((c) => c.app === app && c.oldId === operationId && c.state === "done");
      if (!source) throw new Error("retained version has no completed change receipt");
      const path = join(this.root(source.id), "previous");
      await this.installer.readInstalled(target, path);
      const change = this.reserve(id, app, "rollback", operationId);
      try { await this.makeRoot(this.root(id)); return await this.switch(change, path); }
      catch (e) { return this.fail(id, e); }
    });
  }

  uninstall(app: string, id: string = crypto.randomUUID()): Promise<Change> {
    return this.track(async () => {
      const existing = this.get(id);
      if (existing) {
        if (existing.app !== app || existing.kind !== "uninstall") throw new Error("operation ID belongs to a different change");
        return existing;
      }
      const change = this.reserve(id, app, "uninstall");
      try { await this.makeRoot(this.root(id)); return await this.switch(change); }
      catch (e) { return this.fail(id, e); }
    });
  }

  async drain(): Promise<void> { this.closing = true; await Promise.allSettled(this.pending); }

  /**
   * Before runtime activation, restore the last committed code for any interrupted change.
   * A tree that cannot be verified stays pending (its app is not activated and takes no new
   * change) and is returned for the operator; the other apps and the Space still start.
   */
  async recover(): Promise<{ change: Change; error: string }[]> {
    const blocked: { change: Change; error: string }[] = [];
    for (const change of this.list().filter((c) => c.state === "pending")) {
      try {
        await this.restore(change);
        this.finish(change.id, "failed", "interrupted change; previous version restored");
      } catch (e) { blocked.push({ change, error: (e as Error).message }); }
    }
    return blocked;
  }

  private async switch(change: Change, source?: string): Promise<Change> {
    const release = await this.hooks.suspend(change.app);
    try {
      const old = this.store.get(change.oldId)!;
      await this.installer.readInstalled(old);
      if (change.newId && source) await this.installer.readInstalled(this.store.get(change.newId)!, source);
      const destination = join(this.installer.ws.apps, change.app);
      await rename(destination, join(this.root(change.id), "previous"));
      await syncDirectory(this.installer.ws.apps); await syncDirectory(this.root(change.id));
      if (source) { await rename(source, destination); await syncDirectory(this.installer.ws.apps); }
      await this.hooks.remove(change.app);
      this.store.switchInstalled(change.app, change.newId ?? undefined);
      if (change.newId) { await this.hooks.activate(change.app); await this.hooks.verify?.(change.app); }
      return this.finish(change.id, "done");
    } catch (e) {
      // A failed activation can already have written app data. Only program files are restored.
      await this.hooks.remove(change.app);
      await this.restore(change);
      await this.hooks.activate(change.app);
      return this.finish(change.id, "failed", (e as Error).message);
    } finally { release(); }
  }

  private async restore(change: Change): Promise<void> {
    const old = this.store.get(change.oldId)!;
    const destination = join(this.installer.ws.apps, change.app);
    const previous = join(this.root(change.id), "previous");
    if (await exists(previous)) {
      await this.installer.readInstalled(old, previous);
      if (await exists(destination)) {
        if (!change.newId) throw new Error("unexpected app directory during uninstall recovery; manual inspection required");
        await this.installer.readInstalled(this.store.get(change.newId)!, destination);
        await rename(destination, join(this.root(change.id), "rejected"));
      }
      await rename(previous, destination);
      await syncDirectory(this.installer.ws.apps); await syncDirectory(this.root(change.id));
    } else await this.installer.readInstalled(old, destination);
    this.store.switchInstalled(change.app, old.id);
  }

  private reserve(id: string, app: string, kind: Change["kind"], next?: string): Change {
    installationKey(id, app);
    return this.store.db.transaction(() => {
      const old = this.store.list().find((o) => o.app === app && o.state === "installed");
      if (!old) throw new Error(`no installed package: ${app}`);
      const now = Date.now();
      this.store.db.query("INSERT INTO package_changes(id,app,kind,old_id,new_id,state,created_at,updated_at) VALUES(?,?,?,?,?,'pending',?,?)").run(id, app, kind, old.id, next ?? null, now, now);
      return this.get(id)!;
    }).immediate();
  }
  private finish(id: string, state: Change["state"], error: string | null = null): Change {
    this.store.db.query("UPDATE package_changes SET state=?,error=?,updated_at=? WHERE id=?").run(state, error, Date.now(), id);
    return this.get(id)!;
  }
  private async fail(id: string, error: unknown): Promise<Change> {
    const change = this.get(id)!;
    if (change.state !== "pending") return change;
    // Do not clear a journal lock until recovery succeeds. Unknown trees need operator inspection.
    await this.restore(change);
    return this.finish(id, "failed", (error as Error).message);
  }
  private root(id: string) { return join(this.installer.ws.run, "package-changes", id); }
  private async makeRoot(root: string) {
    const parent = join(this.installer.ws.run, "package-changes");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    if (!(await lstat(parent)).isDirectory()) throw new Error("package change root must be a real directory");
    await mkdir(root, { mode: 0o700 });
  }
  private track(work: () => Promise<Change>): Promise<Change> {
    if (this.closing || this.pending.size >= 2) return Promise.reject(new Error("package lifecycle is busy or shutting down"));
    const promise = work(); this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
}

function view(r: Row): Change { return { id: r.id, app: r.app, kind: r.kind, oldId: r.old_id, newId: r.new_id, state: r.state, error: r.error, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString() }; }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (e) { if ((e as { code?: string }).code === "ENOENT") return false; throw e; } }
async function syncDirectory(path: string): Promise<void> { const f = await open(path, "r"); try { await f.sync(); } finally { await f.close(); } }
