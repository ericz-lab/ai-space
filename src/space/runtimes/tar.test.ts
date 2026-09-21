import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ustar } from "./tar.ts";

describe("ustar", () => {
  test("the system tar unpacks the archive to the same bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-tar-"));
    try {
      const big = new Uint8Array(70_000).map((_, i) => i % 251);
      const archive = ustar([{ name: "prompt", bytes: new TextEncoder().encode("看图 hello\n") }, { name: "a1.png", bytes: big }, { name: "empty.gif", bytes: new Uint8Array(0) }]);
      expect(archive.byteLength % 512).toBe(0);
      const proc = Bun.spawn(["tar", "-xf", "-", "-C", dir], { stdin: "pipe", stderr: "pipe" });
      proc.stdin.write(archive);
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      expect(await Bun.file(join(dir, "prompt")).text()).toBe("看图 hello\n");
      expect(new Uint8Array(await Bun.file(join(dir, "a1.png")).arrayBuffer())).toEqual(big);
      expect(Bun.file(join(dir, "empty.gif")).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses names over 100 bytes", () => {
    expect(() => ustar([{ name: "x".repeat(101), bytes: new Uint8Array(1) }])).toThrow(/longer than 100/);
  });
});
