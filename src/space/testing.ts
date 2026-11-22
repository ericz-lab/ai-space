import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What tests need from the host and Windows gives differently. Tests only: nothing a running
 * Space imports.
 */

export const WINDOWS = process.platform === "win32";

const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

/**
 * Removes a test's scratch directory. POSIX unlinks a file that is still open; Windows refuses
 * (`EBUSY`) until the last handle is gone, and a closed `bun:sqlite` database keeps its file open
 * until its statements are collected. So on Windows this collects, retries for a moment, and then
 * leaves the directory in the system's temporary folder rather than fail a test whose subject
 * passed. Elsewhere it is `rm -rf`, and every error is the caller's.
 */
export async function removeTemp(path: string): Promise<void> {
  if (!WINDOWS) return rm(path, { recursive: true, force: true });
  for (let attempt = 0; ; attempt++) {
    try {
      return await rm(path, { recursive: true, force: true });
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      if (attempt >= 20) return;
      Bun.gc(true);
      await Bun.sleep(25);
    }
  }
}

/** `removeTemp` for a synchronous teardown: one collection, one retry, then the same leniency on Windows. */
export function removeTempSync(path: string): void {
  if (!WINDOWS) return rmSync(path, { recursive: true, force: true });
  for (let attempt = 0; ; attempt++) {
    try {
      return rmSync(path, { recursive: true, force: true });
    } catch (e) {
      if (!BUSY.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      if (attempt >= 1) return;
      Bun.gc(true);
    }
  }
}

/**
 * Whether this process may create symbolic links. Always on POSIX; on Windows only with
 * Developer Mode or an elevated process, so a test about links is skipped where the system
 * refuses to make one (`test.skipIf(!CAN_SYMLINK)`).
 */
export const CAN_SYMLINK: boolean = (() => {
  if (!WINDOWS) return true;
  const dir = mkdtempSync(join(tmpdir(), "space-symlink-probe-"));
  try {
    symlinkSync(join(dir, "target"), join(dir, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
