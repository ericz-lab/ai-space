import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPACE_ROOT } from "./config.ts";
import { VERSION_COPIES, readVersion, setVersion, versionsIn } from "./version.ts";

describe("the version", () => {
  test("package.json holds one", async () => {
    expect(await readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("every native copy matches package.json", async () => {
    const version = await readVersion();
    for (const copy of VERSION_COPIES) {
      const found = versionsIn(await Bun.file(join(SPACE_ROOT, copy.path)).text(), copy.pattern);
      expect({ path: copy.path, found: found.length > 0 }).toEqual({ path: copy.path, found: true });
      for (const v of found) expect({ path: copy.path, version: v }).toEqual({ path: copy.path, version });
    }
  });
});

describe("setVersion", () => {
  let dir = "";
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = ""; });

  function copyTree(): string {
    dir = mkdtempSync(join(tmpdir(), "space-version-"));
    for (const path of ["package.json", ...VERSION_COPIES.map((c) => c.path)]) cpSync(join(SPACE_ROOT, path), join(dir, path));
    return dir;
  }

  test("rewrites package.json and every copy", async () => {
    const root = copyTree();
    const changed = await setVersion("2.3.4-beta.1", root);
    expect(changed.sort()).toEqual(["package.json", ...VERSION_COPIES.map((c) => c.path)].sort());
    expect(await readVersion(root)).toBe("2.3.4-beta.1");
    for (const copy of VERSION_COPIES) {
      const found = versionsIn(await Bun.file(join(root, copy.path)).text(), copy.pattern);
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found)).toEqual(new Set(["2.3.4-beta.1"]));
    }
    // The build script still substitutes the placeholder; only the value after it changes.
    expect(await Bun.file(join(root, "mobile/ios/scripts/build.sh")).text()).toContain("s/$(MARKETING_VERSION)/2.3.4-beta.1/");
    expect(await setVersion("2.3.4-beta.1", root)).toEqual([]);
  });

  test("refuses something that is not a version", async () => {
    await expect(setVersion("v1", copyTree())).rejects.toThrow(/not a version/);
  });
});
