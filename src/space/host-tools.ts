import { existsSync, realpathSync } from "node:fs";
import { win32 } from "node:path";

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
export function isXcodeStub(path: string, platform = process.platform, realpath: (path: string) => string = realpathSync): boolean {
  if (platform !== "darwin") return false;
  let real = path;
  try {
    real = realpath(path);
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
export function userToolDirs(home: string, platform: string = process.platform): string[] {
  if (platform === "win32") {
    // Claude Code's installer, Bun, npm's global prefix (where `codex` lands), Volta and Cargo.
    return [win32.join(home, ".local", "bin"), win32.join(home, ".claude", "local"), win32.join(home, ".bun", "bin"), win32.join(home, "AppData", "Roaming", "npm"), win32.join(home, ".volta", "bin"), win32.join(home, ".cargo", "bin")];
  }
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
export function withUserToolDirs(path: string | undefined, home: string, exists: (dir: string) => boolean = existsSync, platform: string = process.platform): string {
  // Windows separates the entries with `;` (a `:` belongs to the drive) and has no /usr/bin.
  const windows = platform === "win32";
  const separator = windows ? ";" : ":";
  const parts = (path ?? "").split(separator).filter(Boolean);
  for (const dir of userToolDirs(home, platform)) if (!parts.includes(dir) && exists(dir)) parts.push(dir);
  if (!windows) for (const dir of ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(separator);
}

type Env = Record<string, string | undefined>;

/**
 * The search path of an environment. Windows names the variable `Path` and matches it without
 * regard to case, which `process.env` does too, but a copy of it (`{ ...process.env }`) is a plain
 * object that keeps only the spelling it was given.
 */
export function pathOf(env: Env, platform: string = process.platform): string | undefined {
  if (env.PATH !== undefined || platform !== "win32") return env.PATH;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  return key === undefined ? undefined : env[key];
}

/** A copy of `env` with `PATH` as its search path and, on Windows, no second spelling of it left to win. */
export function withPath(env: Env, PATH: string, platform: string = process.platform): Env {
  const copy: Env = { ...env };
  if (platform === "win32") for (const k of Object.keys(copy)) if (k.toUpperCase() === "PATH") delete copy[k];
  copy.PATH = PATH;
  return copy;
}
