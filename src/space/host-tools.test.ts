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
  expect(whichUsable("sh")).toBeTruthy();
  expect(whichUsable("no-such-program-ai-space")).toBeUndefined();
});

test("the user tool directories are appended once, after the PATH a service was given", async () => {
  const { withUserToolDirs } = await import("./host-tools.ts");
  const have = new Set(["/h/.local/bin", "/opt/homebrew/bin"]);
  const p = withUserToolDirs("/usr/bin:/bin:/opt/homebrew/bin", "/h", (d) => have.has(d));
  expect(p).toBe("/usr/bin:/bin:/opt/homebrew/bin:/h/.local/bin:/usr/sbin:/sbin");
});
