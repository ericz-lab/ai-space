import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifacts, notes, sums } from "./manifest.ts";
import { linuxArchiveName } from "./linux.ts";
import { archiveName, included } from "./server.ts";

describe("the server archive", () => {
  test("takes the runtime tree and leaves tests and the native clients out", () => {
    expect(included("src/index.ts")).toBe(true);
    expect(included("src/space/terminal/pty_helper.py")).toBe(true);
    expect(included("skills/space-app/SKILL.md")).toBe(true);
    expect(included("bin/space")).toBe(true);
    expect(included("package.json")).toBe(true);
    expect(included("src/space/identity.test.ts")).toBe(false);
    expect(included("desktop/macos/AISpace/Info.plist")).toBe(false);
    expect(included("mobile/ios/project.yml")).toBe(false);
    expect(included(".github/workflows/release.yml")).toBe(false);
    expect(included("release/server.ts")).toBe(false);
  });

  test("is named after the version, system and CPU", () => {
    expect(archiveName({ version: "1.2.3", os: "linux", arch: "arm64" })).toBe("ai-space-server-1.2.3-linux-arm64");
    expect(linuxArchiveName("client", "1.2.3", "x64")).toBe("ai-space-linux-client-1.2.3-x64");
    expect(linuxArchiveName("local", "1.2.3", "arm64")).toBe("ai-space-linux-local-1.2.3-arm64");
  });

  test("leaves the Linux app out too", () => {
    expect(included("desktop/linux/src/main.ts")).toBe(false);
    expect(included("release/linux.ts")).toBe(false);
  });

  test("both installers are valid shell", async () => {
    for (const script of ["release/install.sh", "deploy/install.sh", "desktop/macos/scripts/package.sh", "desktop/linux/install.sh", "desktop/linux/ai-space.sh"]) {
      const p = Bun.spawn(["sh", "-n", script], { cwd: join(import.meta.dir, ".."), stderr: "pipe" });
      expect({ script, code: await p.exited }).toEqual({ script, code: 0 });
    }
  });
});

describe("the release manifest", () => {
  test("hashes every artifact, and says which Mac build is unsigned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-manifest-"));
    try {
      await Bun.write(join(dir, "ai-space-server-1.0.0-linux-x64.tar.gz"), "server");
      await Bun.write(join(dir, "ai-space-client-1.0.0-macos-arm64-unsigned.dmg"), "client");
      await Bun.write(join(dir, "ai-space-linux-local-1.0.0-x64.tar.gz"), "linux");
      await Bun.write(join(dir, "SHA256SUMS"), "stale");
      const list = await artifacts(dir);
      expect(list.map((a) => a.name)).toEqual(["ai-space-client-1.0.0-macos-arm64-unsigned.dmg", "ai-space-linux-local-1.0.0-x64.tar.gz", "ai-space-server-1.0.0-linux-x64.tar.gz"]);
      expect(list[2]!.sha256).toBe(new Bun.CryptoHasher("sha256").update("server").digest("hex"));
      expect(sums(list)).toBe(list.map((a) => `${a.sha256}  ${a.name}\n`).join(""));
      const text = notes({ product: "ai-space", version: "1.0.0", commit: "0123456789abcdef", created: "", artifacts: list });
      expect(text).toContain("AI Space 1.0.0, built from 0123456789ab");
      expect(text).toContain("**not signed**");
      expect(text).toContain("Local edition for Linux");
      expect(text).toContain("bash <dir>/install.sh");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
