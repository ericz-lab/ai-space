import { realpathSync } from "node:fs";
import { mkdir, open, rename, rmdir } from "node:fs/promises";

/**
 * File operations whose guarantees differ by host, next to `links.ts`. Callers state what they
 * need; this file knows how each system gives it.
 */

const WINDOWS = process.platform === "win32";

/**
 * Moves the directory `from` to `to`, which must not exist, and never replaces a tree that
 * appears there meanwhile. POSIX `rename` replaces an empty directory atomically and refuses a
 * populated one, so an empty `to` is made first as the reservation: `mkdir` fails when something
 * is already there. Windows refuses to rename onto any existing directory, so the rename alone is
 * the guarantee and a reservation would only make it fail.
 */
export async function renameToAbsent(from: string, to: string, mode = 0o700): Promise<void> {
  if (WINDOWS) return rename(from, to);
  await mkdir(to, { mode });
  try {
    await rename(from, to);
  } catch (e) {
    await rmdir(to).catch(() => {}); // only ever the empty reservation
    throw e;
  }
}

/**
 * Makes the entries of a directory durable after a rename in it. POSIX wants an `fsync` of the
 * directory itself. Windows cannot open a directory that way and has no such call; NTFS journals
 * the rename, which is the durability there is.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (WINDOWS) return;
  const f = await open(path, "r");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
}

/**
 * Whether a file's mode agrees with the executable flag recorded for it. Windows keeps no such
 * bit (what runs is decided by the file's name), so there every mode agrees and the file's size
 * and digest are what an installed tree is checked by.
 */
export function executableAgrees(mode: number, executable: boolean): boolean {
  return WINDOWS || !!(mode & 0o111) === executable;
}

/**
 * Makes the working directory the real one when the process was started in a link to it. A
 * release on Windows runs from `<prefix>\current`, a junction to `releases\<version>`: Bun's HTML
 * bundle resolves the page's own files to the real directory but addresses them relative to the
 * working directory, and with the two apart every script and stylesheet of the panel gets an
 * address that answers 404. POSIX keeps the directory it was given, as before.
 */
export function settleWorkingDirectory(platform: string = process.platform, cwd: { get(): string; set(dir: string): void } = { get: () => process.cwd(), set: (dir) => process.chdir(dir) }, real: (path: string) => string = realpathSync): void {
  if (platform !== "win32") return;
  try {
    const here = cwd.get();
    const there = real(here);
    if (there !== here) cwd.set(there);
  } catch {
    /* a directory that cannot be resolved is left as it is */
  }
}
