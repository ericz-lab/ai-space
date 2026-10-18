import { existsSync, realpathSync } from "node:fs";

/**
 * Programs ai-space may start on the host, found deliberately. On a Mac without the Command Line
 * Tools, `/usr/bin/git`, `/usr/bin/python3` and a few others exist but are stubs: running one opens
 * a dialog offering to install the tools and then fails. The Local edition runs on such a Mac, so a
 * stub counts as missing and is never started (docs/editions.md#ai-space-local).
 */

/** The `/usr/bin` programs that are Command Line Tools stubs on macOS. */
export const XCODE_STUBS = new Set(["git", "python3", "pip3", "cc", "clang", "gcc", "make", "swift", "swiftc", "xcrun", "ld", "lldb"]);

let devTools: boolean | undefined;

/** Whether the Command Line Tools (or Xcode) are installed, so the `/usr/bin` stubs work. Asked once. */
export function devToolsInstalled(): boolean {
  if (devTools !== undefined) return devTools;
  if (process.platform !== "darwin") return (devTools = true);
  try {
    const r = Bun.spawnSync(["/usr/bin/xcode-select", "-p"], { stdout: "pipe", stderr: "ignore" });
    const dir = r.stdout.toString().trim();
    devTools = r.exitCode === 0 && dir !== "" && existsSync(dir);
  } catch {
    devTools = false;
  }
  return devTools;
}

/** For tests: forget the cached answer, or fix it. */
export function setDevToolsInstalled(v: boolean | undefined): void {
  devTools = v;
}

/** Whether a resolved path is a Command Line Tools stub that would only open the install dialog. */
export function isXcodeStub(path: string, platform = process.platform): boolean {
  if (platform !== "darwin") return false;
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    /* keep the path */
  }
  const m = /^\/usr\/bin\/([^/]+)$/.exec(real);
  if (!m || !XCODE_STUBS.has(m[1]!)) return false;
  return !devToolsInstalled();
}

/** `Bun.which`, except that a Command Line Tools stub counts as not found. */
export function whichUsable(name: string, opts: { PATH?: string } = {}): string | undefined {
  const found = Bun.which(name, opts.PATH === undefined ? {} : { PATH: opts.PATH });
  if (!found || isXcodeStub(found)) return undefined;
  return found;
}

/**
 * Where agent CLIs and their package managers put programs for one user. A process started by
 * launchd (the Local edition's background service) gets only `/usr/bin:/bin:/usr/sbin:/sbin`, not a
 * terminal's shell profile, so `claude`, `codex` and the tools they call would not be found.
 */
export function userToolDirs(home: string): string[] {
  return [
    `${home}/.local/bin`,
    `${home}/.claude/local`,
    `${home}/.bun/bin`,
    `${home}/.npm-global/bin`,
    `${home}/.volta/bin`,
    `${home}/.cargo/bin`,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
}

/** `path` with the user tool directories that exist appended, each once, after what it already had. */
export function withUserToolDirs(path: string | undefined, home: string, exists: (dir: string) => boolean = existsSync): string {
  const parts = (path ?? "").split(":").filter(Boolean);
  for (const dir of userToolDirs(home)) if (!parts.includes(dir) && exists(dir)) parts.push(dir);
  for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(":");
}
