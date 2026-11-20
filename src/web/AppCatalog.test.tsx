import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type CatalogEntry, CatalogPane, type CatalogView, catalogOffers } from "./AppCatalog.tsx";
import { LangContext } from "./i18n.ts";

const publisher = { id: "acme", name: "Acme", keyId: "a".repeat(64), trusted: true };
const entry = (name: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  name,
  title: { en: name.toUpperCase(), zh: `中文${name}` },
  description: { en: `About ${name}` },
  repo: `https://example.com/${name}`,
  license: "MIT",
  recommended: true,
  needs: [],
  online: [],
  publisher,
  latest: { version: "1.0.0", tag: "v1.0.0", sourcePackage: false },
  installed: null,
  state: "available",
  ...over,
});
const view = (apps: CatalogEntry[], git = true): CatalogView => ({ sources: [{ url: "https://example.com/catalog.json", ok: true, apps: apps.length }], apps, git });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const serve = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};

const render = (v: CatalogView, preselect = false, lang: "en" | "zh" = "en") =>
  renderToStaticMarkup(
    <LangContext.Provider value={lang}>
      <CatalogPane initial={v} preselect={preselect} busy={false} setBusy={() => {}} onInstalled={() => {}} onClose={() => {}} />
    </LangContext.Provider>,
  );

test("opened from the first-use card, every installable app starts ticked; otherwise none", () => {
  const v = view([entry("one"), entry("two"), entry("three", { installed: { version: "1.0.0", origin: "package", ref: "v1.0.0", dev: false }, state: "installed" })]);
  const ticked = (html: string) => html.match(/type="checkbox" class="cat-pick"[^>]*checked=""/g)?.length ?? 0;
  expect(ticked(render(v, true))).toBe(2);
  expect(ticked(render(v, false))).toBe(0);
  expect(render(v, true)).toContain("Install 2 chosen");
  expect(render(v, false)).not.toContain("chosen");
});

test("a row says what the app needs, what only works online, who publishes it and whether they are trusted", () => {
  const html = render(view([entry("one", { needs: ["model", "operator", "something-new"], online: [{ en: "Search needs the web" }], publisher: { ...publisher, trusted: false } })]));
  expect(html).toContain("needs an AI model");
  expect(html).toContain("changes Space settings");
  expect(html).toContain("something-new");
  expect(html).toContain("Search needs the web");
  expect(html).toContain("Acme · not trusted yet");
  expect(html).toContain("v1.0.0");
});

test("the buttons follow the state: install, update, source, with source, and none for an old deployment", () => {
  const html = render(
    view([
      entry("fresh", { latest: { version: "1.0.0", tag: "v1.0.0", sourcePackage: true } }),
      entry("stale", { installed: { version: "0.9.0", origin: "package", ref: "v0.9.0", dev: false }, state: "update" }),
      entry("dev", { installed: { version: "1.1.0", origin: "source", ref: "main", dev: true }, state: "installed" }),
      entry("old", { state: "legacy" }),
      entry("draft", { latest: null, state: "unreleased" }),
    ]),
  );
  const row = (name: string) => html.split('<li class="cat-row">').find((r) => r.includes(name.toUpperCase()))!;
  expect(row("fresh")).toContain(">Install<");
  expect(row("fresh")).toContain("with source");
  expect(row("fresh")).toContain("From source");
  expect(row("stale")).toContain("Update to 1.0.0");
  expect(row("dev")).toContain("development version (main)");
  expect(row("dev")).not.toContain("From source");
  expect(row("old")).toContain("Deployed the old way");
  expect(row("old")).not.toContain("<button");
  expect(row("draft")).toContain("no release yet");
  expect(row("draft")).toContain("From source");
  expect(row("draft")).not.toContain(">Install<");
});

test("without git on the machine, no source install is offered", () => {
  expect(render(view([entry("one")], false))).not.toContain("From source");
});

test("the panel's language picks the catalog's translation, falling back to English", () => {
  const html = render(view([entry("one")]), false, "zh");
  expect(html).toContain("中文one");
  expect(html).toContain("About one");
  expect(html).toContain("安装");
});

test("the first-use card counts installable apps only on a Space without any catalog app", async () => {
  serve({ ok: true, ...view([entry("one"), entry("two"), entry("draft", { latest: null, state: "unreleased" })]) });
  expect(await catalogOffers()).toBe(2);
  serve({ ok: true, ...view([entry("one"), entry("two", { installed: { version: "1.0.0", origin: "package", ref: null, dev: false }, state: "installed" })]) });
  expect(await catalogOffers()).toBe(0);
  serve({ ok: true, ...view([entry("one"), entry("two", { state: "legacy" })]) });
  expect(await catalogOffers()).toBe(0);
  serve({ ok: false, error: "unauthorized" }, 401);
  expect(await catalogOffers()).toBe(0);
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await catalogOffers()).toBe(0);
});
