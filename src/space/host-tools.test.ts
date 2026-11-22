import { afterEach, expect, test } from "bun:test";
import { XCODE_STUBS, isXcodeStub, setDevToolsInstalled, whichUsable } from "./host-tools.ts";

afterEach(() => setDevToolsInstalled(undefined));

// Simulated macOS paths must not resolve against the test host's filesystem.
const unchangedPath = (path: string) => path;

test("a /usr/bin stub counts as missing on a Mac without the Command Line Tools", () => {
  setDevToolsInstalled(false);
  expect(isXcodeStub("/usr/bin/git", "darwin", unchangedPath)).toBe(true);
  expect(isXcodeStub("/usr/bin/python3", "darwin", unchangedPath)).toBe(true);
  expect(isXcodeStub("/opt/homebrew/bin/git", "darwin", unchangedPath)).toBe(false);
  expect(isXcodeStub("/usr/bin/ssh", "darwin", unchangedPath)).toBe(false);
  expect(isXcodeStub("/usr/bin/git", "linux", unchangedPath)).toBe(false);
  expect(XCODE_STUBS.has("git")).toBe(true);
});

test("with the tools installed the same paths are real programs", () => {
  setDevToolsInstalled(true);
  expect(isXcodeStub("/usr/bin/git", "darwin", unchangedPath)).toBe(false);
});

test("symlinks are classified by their target, including versioned Python executables", () => {
  setDevToolsInstalled(false);
  expect(isXcodeStub("/usr/local/bin/python3", "darwin", () => "/usr/bin/python3")).toBe(true);
  expect(isXcodeStub("/usr/bin/python3", "darwin", () => "/usr/bin/python3.12")).toBe(false);
  expect(isXcodeStub("/opt/homebrew/bin/git", "darwin", () => "/opt/homebrew/Cellar/git/bin/git")).toBe(false);
});

test("an unresolved path is still checked for a stub", () => {
  setDevToolsInstalled(false);
  const missingPath = () => { throw new Error("missing path"); };
  expect(isXcodeStub("/usr/bin/python3", "darwin", missingPath)).toBe(true);
  expect(isXcodeStub("/usr/local/bin/python3", "darwin", missingPath)).toBe(false);
});

test("whichUsable finds ordinary programs and nothing for a missing one", () => {
  expect(whichUsable(process.platform === "win32" ? "cmd" : "sh")).toBeTruthy();
  expect(whichUsable("no-such-program-ai-space")).toBeUndefined();
});

test("the user tool directories are appended once, after the PATH a service was given", async () => {
  const { withUserToolDirs } = await import("./host-tools.ts");
  const have = new Set(["/h/.local/bin", "/opt/homebrew/bin"]);
  const p = withUserToolDirs("/usr/bin:/bin:/opt/homebrew/bin", "/h", (d) => have.has(d), "linux");
  expect(p).toBe("/usr/bin:/bin:/opt/homebrew/bin:/h/.local/bin:/usr/sbin:/sbin");
});

test("on Windows the search path is split on semicolons and gets no POSIX directories", async () => {
  const { withUserToolDirs } = await import("./host-tools.ts");
  const home = "C:\\Users\\me";
  const have = new Set([`${home}\\.local\\bin`, `${home}\\AppData\\Roaming\\npm`]);
  const p = withUserToolDirs(`C:\\Windows\\system32;${home}\\.local\\bin`, home, (d) => have.has(d), "win32");
  expect(p).toBe(`C:\\Windows\\system32;${home}\\.local\\bin;${home}\\AppData\\Roaming\\npm`);
});

test("a copied Windows environment keeps its search path under one name", async () => {
  const { pathOf, withPath } = await import("./host-tools.ts");
  const copied = { Path: "C:\\bin", HOME: "C:\\Users\\me" };
  expect(pathOf(copied, "win32")).toBe("C:\\bin");
  expect(pathOf(copied, "linux")).toBeUndefined();
  expect(pathOf({ PATH: "/bin", Path: "other" }, "win32")).toBe("/bin");
  expect(withPath(copied, "C:\\tools", "win32")).toEqual({ PATH: "C:\\tools", HOME: "C:\\Users\\me" });
  expect(withPath({ PATH: "/bin", Path: "kept" }, "/usr/bin", "linux")).toEqual({ PATH: "/usr/bin", Path: "kept" });
});

test("the command shell is the caller's own name off Windows, and Git for Windows' shell on it", async () => {
  const { hostShell } = await import("./host-tools.ts");
  const none = { which: () => null, exists: () => false };
  expect(hostShell("/bin/sh", {}, "linux", none)).toBe("/bin/sh");
  expect(hostShell("bash", {}, "darwin", none)).toBe("bash");

  const git = String.raw`C:\Program Files\Git`;
  const installed = { which: (name: string) => (name === "git" ? String.raw`${git}\cmd\git.exe` : null), exists: (p: string) => p.startsWith(String.raw`${git}\bin`) };
  expect(hostShell("sh", {}, "win32", installed)).toBe(String.raw`${git}\bin\sh.exe`);
  expect(hostShell("/bin/sh", {}, "win32", installed)).toBe(String.raw`${git}\bin\sh.exe`);
  expect(hostShell("bash", {}, "win32", installed)).toBe(String.raw`${git}\bin\bash.exe`);

  // Git off the search path, in its usual place; and the operator's own choice first.
  const usual = { which: () => null, exists: (p: string) => p === String.raw`D:\Apps\Git\bin\sh.exe` };
  expect(hostShell("sh", { ProgramFiles: String.raw`D:\Apps` }, "win32", usual)).toBe(String.raw`D:\Apps\Git\bin\sh.exe`);
  expect(hostShell("sh", { SPACE_SHELL: String.raw`D:\msys\sh.exe` }, "win32", none)).toBe(String.raw`D:\msys\sh.exe`);

  // System32's bash.exe starts WSL: it is never looked for, and no shell is an error that says what to do.
  expect(() => hostShell("bash", {}, "win32", none)).toThrow("install Git for Windows");
});
