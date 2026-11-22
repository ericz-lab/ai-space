import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { windowsShell } from "../host-tools.ts";
import { parseShell } from "./config.ts";
import { quoteArg } from "./conpty_helper.ts";
import { detectPtyBackend, hasConPty, spawnPty } from "./pty.ts";

const windows = process.platform === "win32";

describe("the terminal's backend on Windows", () => {
  test("is the pseudoconsole, from the first Windows that has one", () => {
    expect(hasConPty("10.0.17763")).toBe(true);
    expect(hasConPty("10.0.26100")).toBe(true);
    expect(hasConPty("10.0.17134")).toBe(false);
    expect(hasConPty("6.3.9600")).toBe(false);
    const win11 = { platform: "win32", release: "10.0.26100" };
    expect(detectPtyBackend({}, win11)).toBe("conpty");
    expect(detectPtyBackend({ SPACE_TERMINAL_PTY: "conpty" }, win11)).toBe("conpty");
    // The forkpty backends do not exist there, forced or not.
    expect(detectPtyBackend({ SPACE_TERMINAL_PTY: "python" }, win11)).toBeUndefined();
    expect(detectPtyBackend({}, { platform: "win32", release: "10.0.14393" })).toBeUndefined();
    // And the pseudoconsole is nobody's backend elsewhere.
    expect(detectPtyBackend({ SPACE_TERMINAL_PTY: "conpty" }, { platform: "linux", release: "6.8.0" })).toBeUndefined();
  });

  test("the shell is PowerShell unless the operator names one", () => {
    const system = { SystemRoot: "C:\\Windows" };
    expect(windowsShell(system, (n) => (n === "pwsh" ? "C:\\Program Files\\PowerShell\\7\\pwsh.exe" : null), () => true)).toEqual(["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-NoLogo"]);
    expect(windowsShell(system, () => null, () => true)).toEqual(["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoLogo"]);
    expect(windowsShell({ ...system, ComSpec: "C:\\Windows\\System32\\cmd.exe" }, () => null, () => false)).toEqual(["C:\\Windows\\System32\\cmd.exe"]);
    expect(parseShell("cmd.exe /k", {}, "win32")).toEqual(["cmd.exe", "/k"]);
    // Git Bash's SHELL (/usr/bin/bash) names no Windows program: it is not followed there.
    expect(parseShell(undefined, { SHELL: "/usr/bin/bash", SystemRoot: "C:\\Windows" }, "win32")[0]).not.toBe("/usr/bin/bash");
    expect(parseShell(undefined, { SHELL: "/bin/zsh" }, "linux")).toEqual(["/bin/zsh", "-l"]);
  });

  test("arguments are quoted the way Windows reads a command line back", () => {
    expect(quoteArg("powershell.exe")).toBe("powershell.exe");
    expect(quoteArg("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"');
    expect(quoteArg("")).toBe('""');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
  });
});

describe.skipIf(!windows)("a pseudoconsole session", () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
  const cmd = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\cmd.exe`;

  function open() {
    let out = "";
    const dec = new TextDecoder();
    let exit: (v: { code: number | null; detail?: string }) => void = () => {};
    const exited = new Promise<{ code: number | null; detail?: string }>((r) => (exit = r));
    const pty = spawnPty("conpty", { cmd: [cmd], cwd: tmpdir(), env: process.env as Record<string, string>, cols: 90, rows: 25, onData: (c) => (out += dec.decode(c, { stream: true })), onExit: (code, detail) => exit({ code, detail }) });
    const until = async (what: (text: string) => boolean, ms = 15_000) => {
      const end = Date.now() + ms;
      while (!what(strip(out)) && Date.now() < end) await Bun.sleep(50);
      return what(strip(out));
    };
    return { pty, exited, until, type: (s: string) => pty.write(new TextEncoder().encode(s)) };
  }

  test("runs the command, takes keystrokes and a resize, and reports the command's exit status", async () => {
    const s = open();
    expect(await s.until((t) => t.includes(">"))).toBe(true);
    s.type("echo conpty-%OS%\r");
    expect(await s.until((t) => t.includes("conpty-Windows_NT"))).toBe(true);
    s.pty.resize(60, 20);
    s.type("mode con\r");
    expect(await s.until((t) => /Columns:\s+60/.test(t) || /:\s+60\s/.test(t.split("mode con").at(-1) ?? ""))).toBe(true);
    s.type("exit 7\r");
    expect(await s.exited).toEqual({ code: 7, detail: undefined });
  }, 40_000);

  test("a kill hangs the command up: the session ends with no status", async () => {
    const s = open();
    expect(await s.until((t) => t.includes(">"))).toBe(true);
    s.pty.kill();
    expect((await s.exited).code).toBeNull();
  }, 40_000);
});
