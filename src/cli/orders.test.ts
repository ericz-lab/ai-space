import { describe, expect, test } from "bun:test";
import { runCli } from "./testing.ts";
import { EXIT } from "./types.ts";

/** `space orders import` (docs/cli.md#orders): the Space reads the source; the command prints the counts and what it skipped. */

const env = { SPACE_HOME: "/nonexistent/space-cli-test", SPACE_API_URL: "http://127.0.0.1:8711" };
const report = { kind: "hive", from: "/tmp/hive/hive.db", dryRun: true, added: { topics: 2, orders: 5, pictures: 1, transcripts: 2 }, matched: 1, unchanged: 0, skipped: [{ item: "hive decree (hive's machine)#8", reason: "hive kept no text of it" }] };

describe("space orders import", () => {
  test("sends the kind, an absolute --from and the flags; prints a count per kind and each skipped item", async () => {
    const r = await runCli(["orders", "import", "hive", "--from", "/tmp/hive/hive.db", "--hive-machine", "david", "--dry-run"], (t) => t.scripted.reply({ status: 200, body: { ok: true, report } }), { env });
    expect(r.code).toBe(EXIT.ok);
    expect(r.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8711/api/orders/import", body: { kind: "hive", from: "/tmp/hive/hive.db", hiveMachine: "david", dryRun: true } });
    expect(r.out[0]).toBe("Dry run: nothing written. hive from /tmp/hive/hive.db:");
    expect(r.out).toContain("  orders would add:      5");
    expect(r.out.at(-1)).toBe("    hive decree (hive's machine)#8: hive kept no text of it");
  });

  test("hive needs --from; only decree or hive", async () => {
    expect((await runCli(["orders", "import", "hive"], () => {}, { env })).code).toBe(EXIT.usage);
    expect((await runCli(["orders", "import", "tasks"], () => {}, { env })).code).toBe(EXIT.usage);
  });
});
