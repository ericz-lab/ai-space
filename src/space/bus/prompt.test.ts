import { describe, expect, test } from "bun:test";
import { capabilitiesPrompt } from "./prompt.ts";

describe("capabilities prompt", () => {
  test("nothing to say when no app provides or publishes", () => {
    expect(capabilitiesPrompt([])).toBeUndefined();
    expect(capabilitiesPrompt([{ app: "a", provides: [], publishes: [], consumes: [{ event: "b/c", kind: "stream" }] }])).toBeUndefined();
  });

  test("lists capabilities and events per app, peers marked, the agent's own app last, with the right token", () => {
    const out = capabilitiesPrompt(
      [
        { app: "notes", provides: [{ name: "save", description: "Save a note.", method: "POST", path: "/api/save", timeoutMs: 1000 }], publishes: [], consumes: [] },
        { app: "dailie/insight", peer: "dailie", provides: [{ name: "research", description: "Research a symbol.", method: "POST", path: "/x", timeoutMs: 1000, callers: ["portfolio"] }], publishes: [{ name: "report.ready", description: "A report is done." }], consumes: [] },
        { app: "feed", provides: [], publishes: [{ name: "item.added" }], consumes: [] },
      ],
      { self: "feed" },
    )!;
    expect(out).toContain("--- Space capabilities ---");
    expect(out).toContain('-H "Authorization: Bearer $SPACE_APP_TOKEN"');
    const order = ["dailie/insight (on peer dailie)", "notes", "feed (this app)"].map((s) => out.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(out).toContain("  provides research — Research a symbol. (POST, callers: portfolio)");
    expect(out).toContain("  publishes insight/report.ready — A report is done.");
    expect(out).toContain("  publishes feed/item.added");
    expect(capabilitiesPrompt([{ app: "a", provides: [{ name: "x", method: "GET", path: "/", timeoutMs: 1 }], publishes: [], consumes: [] }], { operator: true })).toContain("$SPACE_API_TOKEN");
  });

  test("is capped in size", () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ app: `app${i}`, provides: [{ name: "cap", description: "x".repeat(40), method: "POST" as const, path: "/", timeoutMs: 1 }], publishes: [], consumes: [] }));
    const out = capabilitiesPrompt(many)!;
    expect(out.length).toBeLessThanOrEqual(6_000);
    expect(out).toContain("more in GET /api/capabilities");
  });
});
