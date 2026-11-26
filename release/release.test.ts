import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStableNames, artifacts, notes, stableName, sums } from "./manifest.ts";
import { linuxArchiveName } from "./linux.ts";
import { windowsArchiveName } from "./windows.ts";
import { archiveName, included } from "./server.ts";

describe("the server archive", () => {
  test("takes the runtime tree and leaves tests and the native clients out", () => {
    expect(included("src/index.ts")).toBe(true);
    expect(included("src/space/terminal/pty_helper.py")).toBe(true);
    expect(included("skills/space-app/SKILL.md")).toBe(true);
    expect(included("bin/space")).toBe(true);
    expect(included("package.json")).toBe(true);
    expect(included("LICENSE")).toBe(true);
    expect(included("NOTICE.md")).toBe(true);
    expect(included("src/space/identity.test.ts")).toBe(false);
    expect(included("desktop/macos/AISpace/Info.plist")).toBe(false);
    expect(included("mobile/ios/project.yml")).toBe(false);
    expect(included(".github/workflows/release.yml")).toBe(false);
    expect(included("release/server.ts")).toBe(false);
  });

  test("is named after the version, system and CPU", () => {
    expect(archiveName({ version: "1.2.3", os: "linux", arch: "arm64" })).toBe("ai-space-1.2.3-linux-arm64");
    expect(linuxArchiveName("1.2.3", "x64")).toBe("ai-space-desktop-1.2.3-linux-x64");
    expect(windowsArchiveName("1.2.3", "x64")).toBe("ai-space-desktop-1.2.3-windows-x64");
    expect(windowsArchiveName("1.2.3-dev.abc1234", "arm64")).toBe("ai-space-desktop-1.2.3-dev.abc1234-windows-arm64");
  });

  test("leaves the Linux and Windows apps out too", () => {
    expect(included("desktop/linux/src/main.ts")).toBe(false);
    expect(included("release/linux.ts")).toBe(false);
    expect(included("desktop/windows/AISpace/App.xaml.cs")).toBe(false);
    expect(included("release/windows.ts")).toBe(false);
  });

  test("both installers are valid shell", async () => {
    for (const script of ["release/install.sh", "release/get.sh", "deploy/install.sh", "desktop/macos/scripts/package.sh", "desktop/linux/install.sh", "desktop/linux/ai-space.sh"]) {
      const p = Bun.spawn(["sh", "-n", script], { cwd: join(import.meta.dir, ".."), stderr: "pipe" });
      expect({ script, code: await p.exited }).toEqual({ script, code: 0 });
    }
  });
});

describe("the release manifest", () => {
  test("hashes every artifact, and says which Mac build is unsigned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-manifest-"));
    try {
      await Bun.write(join(dir, "ai-space-1.0.0-linux-x64.tar.gz"), "server");
      await Bun.write(join(dir, "ai-space-1.0.0-windows-x64.tar.gz"), "server for windows");
      await Bun.write(join(dir, "ai-space-desktop-1.0.0-macos-arm64-unsigned.dmg"), "client");
      await Bun.write(join(dir, "ai-space-desktop-1.0.0-linux-x64.tar.gz"), "linux");
      await Bun.write(join(dir, "ai-space-desktop-1.0.0-windows-x64.exe"), "windows");
      await Bun.write(join(dir, "install.sh"), "#!/usr/bin/env bash\n");
      await Bun.write(join(dir, "SHA256SUMS"), "stale");
      const list = await artifacts(dir);
      expect(list.map((a) => a.name)).toEqual(["ai-space-1.0.0-linux-x64.tar.gz", "ai-space-1.0.0-windows-x64.tar.gz", "ai-space-desktop-1.0.0-linux-x64.tar.gz", "ai-space-desktop-1.0.0-macos-arm64-unsigned.dmg", "ai-space-desktop-1.0.0-windows-x64.exe", "install.sh"]);
      expect(list[0]!.sha256).toBe(new Bun.CryptoHasher("sha256").update("server").digest("hex"));
      expect(sums(list)).toBe(list.map((a) => `${a.sha256}  ${a.name}\n`).join(""));
      const text = notes({ product: "ai-space", version: "1.0.0", commit: "0123456789abcdef", created: "", artifacts: list });
      expect(text).toContain("AI Space 1.0.0, built from 0123456789ab");
      expect(text).toContain("**not signed**");
      expect(text).toContain("| `ai-space-1.0.0-linux-x64.tar.gz` | AI Space (the service and its web panel) for Linux");
      expect(text).toContain("| `ai-space-1.0.0-windows-x64.tar.gz` | AI Space (the service and its web panel) for Windows");
      expect(text).toContain("<dir>\\install.ps1");
      expect(text).toContain("| `ai-space-desktop-1.0.0-linux-x64.tar.gz` | AI Space Desktop for Linux");
      expect(text).toContain("| `ai-space-desktop-1.0.0-windows-x64.exe` | AI Space Desktop for Windows");
      expect(text).toContain("| `ai-space-desktop-1.0.0-macos-arm64-unsigned.dmg` | AI Space Desktop for Mac, **not signed**");
      expect(text).not.toContain("| |");
      expect(text).toContain("bash <dir>/install.sh");
      expect(text).toContain("curl -fsSL https://ai-space.me/install.sh | bash");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("stable download names", () => {
  test("drop the version (and -unsigned) from AI Space Desktop files only", () => {
    expect(stableName("ai-space-desktop-0.3.0-macos-arm64-unsigned.dmg")).toBe("ai-space-desktop-macos-arm64.dmg");
    expect(stableName("ai-space-desktop-0.3.0-macos-arm64.dmg")).toBe("ai-space-desktop-macos-arm64.dmg");
    expect(stableName("ai-space-desktop-1.2.3-dev.abc1234-windows-arm64.exe")).toBe("ai-space-desktop-windows-arm64.exe");
    expect(stableName("ai-space-desktop-0.3.0-linux-x64.tar.gz")).toBe("ai-space-desktop-linux-x64.tar.gz");
    expect(stableName("ai-space-desktop-macos-arm64.dmg")).toBeUndefined();
    expect(stableName("ai-space-0.3.0-linux-x64.tar.gz")).toBeUndefined();
    expect(stableName("install.sh")).toBeUndefined();
  });

  test("are copies listed in SHA256SUMS that the installers' Server patterns never pick", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-stable-"));
    try {
      await Bun.write(join(dir, "ai-space-1.0.0-macos-arm64.tar.gz"), "server");
      await Bun.write(join(dir, "ai-space-desktop-1.0.0-macos-arm64-unsigned.dmg"), "mac");
      await Bun.write(join(dir, "ai-space-desktop-1.0.0-windows-x64.exe"), "win");
      expect(await addStableNames(dir)).toEqual(["ai-space-desktop-macos-arm64.dmg", "ai-space-desktop-windows-x64.exe"]);
      expect(await Bun.file(join(dir, "ai-space-desktop-macos-arm64.dmg")).text()).toBe("mac");
      const list = await artifacts(dir);
      const text = notes({ product: "ai-space", version: "1.0.0", commit: "0123456789abcdef", created: "", artifacts: list });
      expect(text).toContain("| `ai-space-desktop-macos-arm64.dmg` | The same file as `ai-space-desktop-1.0.0-macos-arm64-unsigned.dmg`");
      expect(text).not.toContain("| |");
      // release/get.sh and get.ps1 look for ai-space-(server-)?<digit>…-<os>-<arch>.tar.gz
      const server = sums(list).split("\n").filter((l) => /  ai-space-(server-)?[0-9][^ ]*-[a-z]+-[a-z0-9]+\.tar\.gz$/.test(l));
      expect(server.map((l) => l.split("  ")[1])).toEqual(["ai-space-1.0.0-macos-arm64.tar.gz"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
