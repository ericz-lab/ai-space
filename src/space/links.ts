import { symlink } from "node:fs/promises";

/**
 * Links in the workspace, on a host that may not allow them. Linux and macOS make symbolic links
 * for anyone. Windows makes one only for an administrator or in Developer Mode, and answers EPERM
 * otherwise; it does let any user make a junction, which links a directory by its absolute path and
 * which `lstat`, `readlink` and `unlink` treat as a symbolic link. So a directory link is a
 * junction there, and a file link that is refused is left to the caller, who keeps a copy instead.
 * This is the one place that knows the difference.
 */

export type Linking = {
  /** Links `path` to the file `target`. False when the host refuses and the caller is to keep a copy. */
  file(target: string, path: string): Promise<boolean>;
  /** Whether file links may be copies on this host, so a copy made earlier is still kept current. */
  copies: boolean;
};

const WINDOWS = process.platform === "win32";

export const hostLinking: Linking = {
  async file(target, path) {
    try {
      await symlink(target, path);
      return true;
    } catch (e) {
      if (WINDOWS && (e as NodeJS.ErrnoException).code === "EPERM") return false;
      throw e;
    }
  },
  copies: WINDOWS,
};

/** Links `path` to the directory `target`, an absolute path. */
export async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, WINDOWS ? "junction" : undefined);
}
