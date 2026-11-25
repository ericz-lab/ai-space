import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PriceBook } from "./book.ts";
import { bundledCatalogue, CATALOGUE_CACHE, CatalogueFeed, type Catalogue, parseCatalogue } from "./catalogue.ts";
import { guardChanges } from "./guard.ts";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });
const home = async () => { const d = await mkdtemp(join(tmpdir(), "space-catalogue-")); dirs.push(d); return d; };
const URL_ = "https://prices.example/v1.json";
const quiet = () => {};

/** The bundled catalogue with one price moved and a later date: what a merge to main publishes. */
const newer = (input = 2.5, asOf = "2099-01-01"): Catalogue => {
  const c = structuredClone(bundledCatalogue());
  c.asOf = asOf;
  c.vendors.openai!.models["gpt-6-sol"] = { ...c.vendors.openai!.models["gpt-6-sol"]!, input };
  return c;
};

test("the release's own catalogue is valid, dated by its newest data", () => {
  const c = bundledCatalogue();
  expect(parseCatalogue(JSON.parse(JSON.stringify(c)))).toEqual(JSON.parse(JSON.stringify(c)));
  expect(Object.keys(c.vendors).sort()).toEqual(["anthropic", "deepseek", "minimax", "openai"]);
  expect(c.asOf >= "2026-11-24").toBe(true);
});

test("a fetched catalogue is checked whole: absurd or malformed ones are refused", () => {
  const ok = bundledCatalogue();
  const bad = (patch: (c: Record<string, any>) => void) => {
    const c = structuredClone(ok) as unknown as Record<string, any>;
    patch(c);
    return () => parseCatalogue(c);
  };
  expect(bad((c) => { c.schema = 2; })).toThrow("schema");
  expect(bad((c) => { c.vendors.openai.models["gpt-6-sol"].input = -1; })).toThrow("not a price");
  expect(bad((c) => { c.vendors.openai.models["gpt-6-sol"].output = 1e9; })).toThrow("not a price");
  expect(bad((c) => { c.vendors.openai.models["gpt-6-sol"].fastMultiplier = 100; })).toThrow("fastMultiplier");
  expect(bad((c) => { c.vendors.openai.models["gpt-6-sol"].script = "x"; })).toThrow("unknown key");
  expect(bad((c) => { c.vendors.openai.hosts = ["evil.example/path"]; })).toThrow("fields");
  expect(bad((c) => { c.vendors = {}; })).toThrow("no prices");
  expect(bad((c) => {
    for (const v of Object.values(c.vendors) as any[]) for (const p of Object.values(v.models) as any[]) if (p.input !== undefined) { p.input = 0; p.output = 0; delete p.tiers; }
  })).toThrow("every token price is zero");
  expect(bad((c) => { c.modelWatch.prices[0].input = "1"; })).toThrow("modelWatch");
  // Anything but prices is dropped.
  const extra = parseCatalogue({ ...structuredClone(ok), runtimes: { evil: true } } as unknown);
  expect("runtimes" in extra).toBe(false);
});

test("the feed: a newer catalogue is taken and cached, a broken one refused with the last good kept, a 304 costs nothing", async () => {
  const h = await home();
  let answer: () => Response = () => Response.json(newer(), { headers: { etag: '"one"' } });
  const seen: Record<string, string>[] = [];
  const fetcher = (async (_u: string, init: RequestInit) => { seen.push(init.headers as Record<string, string>); return answer(); }) as unknown as typeof fetch;
  const feed = new CatalogueFeed({ home: h, url: URL_, fetch: fetcher, log: quiet });
  expect(feed.origin()).toBe("bundled");
  expect(await feed.refresh()).toBe(true);
  expect(feed.origin()).toBe("fetched");
  expect(feed.current().vendors.openai!.models["gpt-6-sol"]!.input).toBe(2.5);
  // Nothing about the install travels: no token, no machine, a generic user agent.
  expect(seen[0]).toEqual({ accept: "application/json", "user-agent": "ai-space" });

  answer = () => new Response(null, { status: 304 });
  expect(await feed.refresh()).toBe(false);
  expect(seen[1]!["if-none-match"]).toBe('"one"');

  answer = () => new Response('{"schema":1,"asOf":"2099-02-01","vendors":{"openai":{"name":"x","asOf":"2099-02-01","source":"x","hosts":[],"models":{"gpt-6-sol":{"input":-5,"output":1}}}}}');
  expect(await feed.refresh()).toBe(false);
  expect(feed.status().error).toContain("not a price");
  expect(feed.current().vendors.openai!.models["gpt-6-sol"]!.input).toBe(2.5);

  answer = () => new Response("x".repeat(5_000_000));
  expect(await feed.refresh()).toBe(false);
  expect(feed.status().error).toContain("bytes");

  // Restarted, offline: the cached copy, not the release's.
  const again = new CatalogueFeed({ home: h, url: URL_, fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch, log: quiet });
  await again.load();
  await again.refresh();
  expect(again.origin()).toBe("fetched");
  expect(again.current().vendors.openai!.models["gpt-6-sol"]!.input).toBe(2.5);
  expect((await readdir(join(h, "run"))).includes(CATALOGUE_CACHE.split("/").at(-1)!)).toBe(true);
});

test("the release's own copy wins when it is newer than the fetched one; an empty URL fetches nothing", async () => {
  const h = await home();
  const old = newer(9, "2000-01-01");
  const feed = new CatalogueFeed({ home: h, url: URL_, fetch: (async () => Response.json(old)) as unknown as typeof fetch, log: quiet });
  await feed.refresh();
  expect(feed.origin()).toBe("bundled");
  expect(feed.current().vendors.openai!.models["gpt-6-sol"]!.input).toBe(2);
  let calls = 0;
  const off = new CatalogueFeed({ home: h, url: "", fetch: (async () => { calls++; return Response.json(newer()); }) as unknown as typeof fetch, log: quiet });
  expect(await off.refresh()).toBe(false);
  expect(calls).toBe(0);
});

test("a fetched catalogue reprices: the book tells its listeners, the owner's file still wins", async () => {
  const h = await home();
  await Bun.write(join(h, "gateway-prices.yaml"), "openai/gpt-6-luna: [7, 7]\n");
  const fetcher = (async (u: string) => (String(u).includes("models.dev") ? new Response("{}") : Response.json(newer()))) as unknown as typeof fetch;
  const book = new PriceBook({ home: h, env: { SPACE_PRICES_URL: URL_ }, fetch: fetcher, log: quiet, offline: true });
  await book.load();
  let told = 0;
  book.onChange(() => told++);
  expect(book.forVendor("openai", "gpt-6-sol")?.price.input).toBe(2);
  await book.refreshCatalogue();
  expect(told).toBe(1);
  expect(book.forVendor("openai", "gpt-6-sol")).toMatchObject({ source: "ai-space openai 2026-11-24", price: { input: 2.5 } });
  expect(book.forVendor("openai", "gpt-6-luna")).toEqual({ source: "price file", price: { input: 7, output: 7 } });
});

test("the publish guard: moves within the bound pass, a big move, a removal or a new zero waits for a person", () => {
  const before = bundledCatalogue();
  expect(guardChanges(before, newer(2.5)).violations).toEqual([]);
  expect(guardChanges(before, newer(2.5)).changed).toEqual([{ key: "openai/gpt-6-sol input", before: 2, after: 2.5 }]);
  expect(guardChanges(before, newer(20)).violations).toEqual(["openai/gpt-6-sol input: 2 → 20, more than 50%"]);
  const gone = newer();
  delete gone.vendors.deepseek!.models["deepseek-v4-pro"];
  expect(guardChanges(before, gone).violations.filter((v) => v.includes("removed")).length).toBe(4);
  const zero = newer();
  zero.vendors.openai!.models["gpt-9"] = { input: 0, output: 0 };
  expect(guardChanges(before, zero).violations).toEqual(["openai/gpt-9 input: new and zero", "openai/gpt-9 output: new and zero"]);
  expect(guardChanges(newer(), before).violations.some((v) => v.includes("older than the published"))).toBe(true);
});
