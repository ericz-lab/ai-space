import type { Database } from "bun:sqlite";
import { installationKey } from "./contract.ts";

export type InstallOperation = {
  id: string;
  app: string;
  version: string;
  digest: string;
  state: "installing" | "installed" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
};
type Row = Omit<InstallOperation, "createdAt" | "updatedAt"> & { created_at: number; updated_at: number };

export class PackageStore {
  readonly spaceId: string;
  constructor(readonly db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS space_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS package_operations (
        id TEXT PRIMARY KEY, app TEXT NOT NULL, version TEXT NOT NULL, digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('installing','installed','failed')), error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS package_active_install ON package_operations(app) WHERE state IN ('installing','installed');
    `);
    db.query("INSERT OR IGNORE INTO space_identity(singleton,id) VALUES(1,?)").run(crypto.randomUUID());
    this.spaceId = (db.query("SELECT id FROM space_identity WHERE singleton=1").get() as { id: string }).id;
    installationKey(this.spaceId, "validation");
  }

  get(id: string): InstallOperation | undefined {
    const row = this.db.query("SELECT * FROM package_operations WHERE id=?").get(id) as Row | null;
    return row ? view(row) : undefined;
  }

  list(): InstallOperation[] {
    return (this.db.query("SELECT * FROM package_operations ORDER BY created_at,id").all() as Row[]).map(view);
  }

  /** Synchronous transaction also serializes other processes using this workspace database. */
  reserve(id: string, app: string, version: string, digest: string): { operation: InstallOperation; fresh: boolean } {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id)) throw new Error("operation ID must be a UUID v4");
    return this.db.transaction(() => {
      const same = this.get(id);
      if (same) {
        if (same.app !== app || same.digest !== digest) throw new Error("operation ID already belongs to a different package");
        return { operation: same, fresh: false };
      }
      const active = this.db.query("SELECT * FROM package_operations WHERE app=? AND state IN ('installing','installed')").get(app) as Row | null;
      if (active) {
        if (active.digest === digest) return { operation: view(active), fresh: false };
        throw new Error(`${app} already has an installation; use the upgrade workflow`);
      }
      const now = Date.now();
      this.db.query("INSERT INTO package_operations(id,app,version,digest,state,created_at,updated_at) VALUES(?,?,?,?,'installing',?,?)").run(id, app, version, digest, now, now);
      return { operation: this.get(id)!, fresh: true };
    }).immediate();
  }

  finish(id: string, state: "installed" | "failed", error: string | null = null): InstallOperation {
    this.db.query("UPDATE package_operations SET state=?,error=?,updated_at=? WHERE id=? AND state='installing'").run(state, error, Date.now(), id);
    return this.get(id)!;
  }
}

function view({ created_at, updated_at, ...row }: Row): InstallOperation {
  return { ...row, createdAt: new Date(created_at).toISOString(), updatedAt: new Date(updated_at).toISOString() };
}
