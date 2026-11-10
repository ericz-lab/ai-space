import { describe, expect, test } from "bun:test";
import { UI_KIT_PATH, createUiKitRoutes, loadUiKit } from "./ui-kit.ts";

const kit = loadUiKit();
const get = (headers: Record<string, string> = {}) => createUiKitRoutes(kit)[UI_KIT_PATH]!.GET!(new Request(`http://app.test${UI_KIT_PATH}`, { headers }));

/** The custom properties a block declares. */
const declared = (block: string) => new Set([...block.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));

describe("ui kit", () => {
  test("serves the stylesheet with an etag and answers 304 for it", async () => {
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const etag = r.headers.get("etag")!;
    expect(await r.text()).toContain(".sp-tile");
    expect((await get({ "if-none-match": etag })).status).toBe(304);
  });

  test("both dark blocks redefine the same tokens, all first declared in the light :root", async () => {
    const { css } = await kit();
    const light = declared(/^:root \{([\s\S]*?)^\}/m.exec(css)![1]!);
    const media = declared(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n  \}/.exec(css)![1]!);
    const attr = declared(/^:root\[data-theme="dark"\] \{([\s\S]*?)^\}/m.exec(css)![1]!);
    expect([...media].sort()).toEqual([...attr].sort());
    expect([...attr].filter((t) => !light.has(t))).toEqual([]);
  });

  test("every token a rule reads is declared", async () => {
    const { css } = await kit();
    const all = declared(css);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    // Set per element by the page: a status colour, a meter's value, a bar's height.
    for (const local of ["--st", "--v", "--h"]) used.delete(local);
    expect([...used].filter((t) => !all.has(t))).toEqual([]);
  });

  test("the system font, no named web font", async () => {
    const { css } = await kit();
    expect(/--font-sans:([^;]+);/.exec(css)![1]).not.toMatch(/Inter|Roboto|Helvetica/);
  });
});
