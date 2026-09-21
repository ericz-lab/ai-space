import { describe, expect, test } from "bun:test";
import { HealthProbe } from "./health.ts";

// A fetch that answers when told to, so the test controls the order of the probe and the readers.
function gate() {
  const waiting: Array<() => void> = [];
  let calls = 0;
  const fetch: typeof globalThis.fetch = (async () => {
    calls++;
    await new Promise<void>((r) => waiting.push(r));
    return new Response("ok");
  }) as unknown as typeof globalThis.fetch;
  return { fetch, release: () => waiting.splice(0).forEach((r) => r()), calls: () => calls };
}

describe("HealthProbe.peek", () => {
  test("answers unknown before the first probe, then the cached result; one probe per url at a time", async () => {
    const g = gate();
    const probe = new HealthProbe({ fetch: g.fetch, ttlMs: 60_000 });
    expect(probe.peek(8712, "/healthz")).toBe("unknown");
    expect(probe.peek(8712, "/healthz")).toBe("unknown");
    expect(g.calls()).toBe(1);
    g.release();
    await probe.settle();
    expect(probe.peek(8712, "/healthz")).toBe("ok");
    expect(g.calls()).toBe(1);
  });

  test("an expired entry is still answered while the refresh runs", async () => {
    const g = gate();
    const probe = new HealthProbe({ fetch: g.fetch, ttlMs: 0 });
    probe.peek(8712, "/healthz");
    g.release();
    await probe.settle();
    expect(probe.peek(8712, "/healthz")).toBe("ok");
    expect(g.calls()).toBe(2);
  });

  test("check shares the probe peek started", async () => {
    const g = gate();
    const probe = new HealthProbe({ fetch: g.fetch });
    expect(probe.peek(8712, "/healthz")).toBe("unknown");
    const pending = probe.check(8712, "/healthz");
    g.release();
    expect(await pending).toBe("ok");
    expect(g.calls()).toBe(1);
  });
});
