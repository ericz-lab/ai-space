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

/**
 * The error `promise` rejects with (undefined when it resolves), awaited the plain way. Use it instead of
 * `expect(promise).rejects` (or `.resolves`) when the promise settles only on more socket traffic and the test
 * may be running inside a socket's callback (its code resumed by a frame that arrived): `rejects` waits by
 * running the event loop nested in the current call, and a nested loop does not deliver the next message of
 * the socket whose callback is still on the stack, so the test hangs until it times out. Seen with Bun 1.3.0
 * on Windows: the frame sent before the wait reaches the other end and its answer comes back, but the client's
 * `onmessage` is not run for it until the outer callback returns, which it never does. A plain `await` (or a
 * `Bun.sleep` first, which leaves the callback) gets the answer at once. Nothing outside a test nests the event
 * loop, so the channel itself is not affected; both ends of a connection in one process make every test a
 * socket callback after its first awaited frame.
 */
export async function rejection(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (e) {
    return e as Error;
  }
}
