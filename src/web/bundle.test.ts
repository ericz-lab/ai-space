import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemp } from "../space/testing.ts";

/**
 * The server bundles the panel at runtime through the HTML import in routes.ts, with this Bun's
 * own CSS parser. A rule that parser rejects (channel math in an @supports condition once did)
 * fails the whole page with "500 Build Failed", and no other test bundles it; this one does.
 */
test("the panel page bundles: index.html with main.tsx and styles.css", async () => {
  const outdir = mkdtempSync(join(tmpdir(), "space-panel-bundle-"));
  try {
    const result = await Bun.build({ entrypoints: [join(import.meta.dir, "index.html")], outdir, target: "browser" });
    const logs = result.logs.map((l) => `${l.level}: ${l.message}${l.position ? ` (${l.position.file}:${l.position.line}:${l.position.column})` : ""}`).join("\n");
    if (!result.success) console.error(logs);
    expect(result.success, logs).toBe(true);
    expect(result.outputs.some((o) => o.path.endsWith(".css"))).toBe(true);
  } finally {
    await removeTemp(outdir);
  }
}, 60_000);
