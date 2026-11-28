import { join } from "node:path";
import type { Manifest } from "../scheduler/manifest.ts";

/**
 * The apps ai-space currently knows: every manifest that passed validation on
 * boot or on a later sync, keyed by app name. The panel reads its lists from
 * here; the scheduler, storage and notify services keep their own state and
 * are synced by the entry point when a manifest changes.
 */

export type RegisteredApp = {
  manifest: Manifest;
  /**
   * True when the directory holds nothing but the manifest and its assets:
   * no service and no git repository. Such apps are owned by the panel (it
   * created them from a link) and may be deleted from it.
   */
  manifestOnly: boolean;
  registeredAt: number;
  /**
   * The loopback form of a public `url` (defaults.ts `loopbackUrl`), for a viewer at this machine
   * (docs/router.md#a-viewer-on-this-machine). `manifest.url` stays the public one: whatever is stored,
   * sent to another machine or routed uses that.
   */
  localUrl?: string;
};

/** The manifest a viewer sees the app through: with `url` swapped for its loopback form when `local` and it has one. */
export function manifestFor(entry: RegisteredApp, local: boolean): Manifest {
  return local && entry.localUrl ? { ...entry.manifest, url: entry.localUrl } : entry.manifest;
}

export class AppRegistry {
  private readonly apps = new Map<string, RegisteredApp>();

  async set(manifest: Manifest, opts: { localUrl?: string } = {}): Promise<RegisteredApp> {
    const manifestOnly = manifest.spec !== 2 && !manifest.service && !(await isDir(join(manifest.dir, ".git")));
    const entry: RegisteredApp = { manifest, manifestOnly, registeredAt: Date.now(), ...(opts.localUrl ? { localUrl: opts.localUrl } : {}) };
    this.apps.set(manifest.app, entry);
    return entry;
  }

  remove(app: string): boolean {
    return this.apps.delete(app);
  }

  get(app: string): RegisteredApp | undefined {
    return this.apps.get(app);
  }

  /** Sorted by app name. */
  list(): RegisteredApp[] {
    return [...this.apps.values()].sort((a, b) => a.manifest.app.localeCompare(b.manifest.app));
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
