import { describe, expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { parsePetSpec } from "./pet-spec.ts";
import { PetFeed, sanitizeMood } from "./pets.ts";
import type { AppRegistry } from "./registry.ts";

const PET = `
pets:
  - name: dog
    title: Dog
    sheet: /pet/sheet.png
    grid: 4x4
    width: 64
    pixelated: true
    animations:
      walk: { row: 0, frames: 4, ms: 600 }
      lie: { row: 1, frames: 2, ms: 1600 }
      sit: { row: 2, frames: 2, ms: 1200 }
    rest: lie
    mood: /api/mood
    refresh: 20s
`;
const manifest = (extra = "") => parseManifest(`name: dog\nurl: https://dog.example/\nservice: { command: bun x, port: 9100 }\n${PET}${extra}`, "/apps/dog");

describe("pets manifest section", () => {
  test("parses grid, animations, rest and mood", () => {
    const p = manifest().pets![0]!;
    expect(p).toMatchObject({ name: "dog", title: "Dog", sheet: "/pet/sheet.png", columns: 4, rows: 4, width: 64, pixelated: true, rest: "lie", mood: "/api/mood", refreshMs: 20_000 });
    expect(p.animations.sit).toEqual({ row: 2, frames: 2, ms: 1200 });
  });

  test("defaults: width 70, rest is the first pose, no mood", () => {
    const p = parsePetSpec({ name: "cat", sheet: "https://x.example/s.png", grid: "2x2", animations: { walk: { row: 0, frames: 2, ms: 500 }, idle: { row: 1, frames: 2, ms: 500 } } });
    expect(p).toMatchObject({ width: 70, rest: "idle", pixelated: false, refreshMs: 30_000 });
    expect(p.mood).toBeUndefined();
  });

  test.each([
    [{ name: "cat", sheet: "/s.png", grid: "4x4", animations: { lie: { row: 0, frames: 1, ms: 500 } } }, "needs walk"],
    [{ name: "cat", sheet: "/s.png", grid: "4", animations: {} }, "grid"],
    [{ name: "cat", sheet: "http://x/s.png", grid: "4x4", animations: {} }, "https"],
    [{ name: "cat", sheet: "/s.png", grid: "4x4", animations: { walk: { row: 4, frames: 1, ms: 500 } } }, "row"],
    [{ name: "cat", sheet: "/s.png", grid: "4x4", animations: { walk: { row: 0, frames: 5, ms: 500 } } }, "frames"],
    [{ name: "cat", sheet: "/s.png", grid: "4x4", animations: { walk: { row: 0, frames: 1, ms: 500 } } }, "rest must name"],
    [{ name: "cat", sheet: "/s.png", grid: "4x4", animations: { walk: { row: 0, frames: 1, ms: 500 }, lie: { row: 1, frames: 1, ms: 500 } }, refresh: "5s" }, "15s"],
    [{ name: "cat", sheet: "/s.png", grid: "4x4", animations: {}, colour: "red" }, "unknown key"],
  ])("refuses %j", (raw, message) => {
    expect(() => parsePetSpec(raw)).toThrow(message);
  });

  test("pet titles translate by name, and only declared pets", () => {
    expect(manifest("i18n:\n  zh:\n    pets:\n      dog: { title: 小狗 }\n").i18n).toEqual({ zh: { pets: { dog: { title: "小狗" } } } });
    expect(() => manifest("i18n:\n  zh:\n    pets:\n      cat: { title: 猫 }\n")).toThrow('no pet named "cat"');
  });

  test("names are unique", () => {
    expect(() => parseManifest(`name: x\nservice: { command: x, port: 1 }\npets:\n  - { name: a, sheet: /a.png, grid: 1x2, animations: { walk: { row: 0, frames: 1, ms: 500 }, b: { row: 1, frames: 1, ms: 500 } } }\n  - { name: a, sheet: /a.png, grid: 1x2, animations: { walk: { row: 0, frames: 1, ms: 500 }, b: { row: 1, frames: 1, ms: 500 } } }\n`, "/x")).toThrow("duplicate pets name");
  });

  test("a path needs a service", () => {
    expect(() => parseManifest(`name: dog\n${PET}`, "/apps/dog")).toThrow("needs a service");
  });
});

describe("mood", () => {
  test("keeps the contract's fields only", () => {
    const m = manifest();
    expect(sanitizeMood(m, m.pets![0]!, { ok: true, animation: "sit", move: "stay", say: { en: " Hm ", zh: "嗯", bad_tag: "x" }, link: "/#incidents", asOf: "2026-10-21T08:00:00Z", extra: 1 })).toEqual({
      ok: true,
      animation: "sit",
      move: "stay",
      say: { en: "Hm", zh: "嗯" },
      link: "https://dog.example/#incidents",
      asOf: "2026-10-21T08:00:00Z",
    });
    expect(sanitizeMood(m, m.pets![0]!, { ok: true, animation: "lie", say: "hi", link: "javascript:alert(1)" })).toEqual({ ok: true, animation: "lie", move: "roam", say: { en: "hi" } });
  });

  test("refuses walk and undeclared animations", () => {
    expect(() => sanitizeMood(manifest(), manifest().pets![0]!, { ok: true, animation: "walk" })).toThrow("unknown animation");
    expect(() => sanitizeMood(manifest(), manifest().pets![0]!, { ok: true, animation: "dance" })).toThrow("unknown animation");
  });
});

describe("PetFeed", () => {
  const registry = (m = manifest()) => ({ list: () => [{ manifest: m }], get: (app: string) => (app === m.app ? { manifest: m } : undefined) }) as unknown as AppRegistry;

  test("lists the pet with a same-origin sheet and leaves hidden apps out", () => {
    const feed = new PetFeed(registry());
    expect(feed.list()[0]).toMatchObject({ id: "dog/dog", app: "dog", name: "dog", title: "Dog", sheet: "/api/pets/dog/dog/sheet", rest: "lie", hasMood: true });
    expect(feed.list(new Set(["dog"]))).toEqual([]);
  });

  test("reads the mood on loopback, caches it and reports a failure as is", async () => {
    const calls: string[] = [];
    let answer: unknown = { ok: true, animation: "sit", move: "stay" };
    const feed = new PetFeed(registry(), { fetch: (async (url: string) => (calls.push(url), Response.json(answer))) as unknown as typeof fetch });
    expect(await feed.mood("dog", "dog")).toMatchObject({ ok: true, animation: "sit" });
    await feed.mood("dog", "dog");
    expect(calls).toEqual(["http://127.0.0.1:9100/api/mood"]);
    answer = { ok: true, animation: "nope" };
    const fresh = new PetFeed(registry(), { fetch: (async () => Response.json(answer)) as unknown as typeof fetch });
    expect(await fresh.mood("dog", "dog")).toEqual({ ok: false, error: "unknown animation: nope" });
  });

  test("passes PNG sheets and refuses other types", async () => {
    const png = new PetFeed(registry(), { fetch: (async () => new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } })) as unknown as typeof fetch });
    expect((await png.sheet("dog", "dog")).type).toBe("image/png");
    const svg = new PetFeed(registry(), { fetch: (async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } })) as unknown as typeof fetch });
    await expect(svg.sheet("dog", "dog")).rejects.toThrow("not PNG");
  });

  test("an app without a pet is not found", async () => {
    await expect(new PetFeed(registry()).mood("dog", "cat")).rejects.toThrow("no pet");
  });
});
