import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type Catalog, type CatalogEntry, type CatalogView, catalogOffers, useCatalog } from "./AppCatalog.tsx";
import { LangContext } from "./i18n.ts";
import Store, { Detail, ProgressLine, UpdateAll, tabApps } from "./Store.tsx";

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
const installed = (version: string, over: Partial<NonNullable<CatalogEntry["installed"]>> = {}) => ({ version, origin: "package" as const, ref: `v${version}`, dev: false, ...over });
const view = (apps: CatalogEntry[], git = true): CatalogView => ({ sources: [{ url: "https://example.com/catalog.json", ok: true, apps: apps.length }], apps, git });

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const serve = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
};

const render = (v: CatalogView, { selecting = false, lang = "en" as "en" | "zh", openUrl }: { selecting?: boolean; lang?: "en" | "zh"; openUrl?: (app: string) => string | undefined } = {}) =>
  renderToStaticMarkup(
    <LangContext.Provider value={lang}>
      <Store open initial={v} selecting={selecting} onClose={() => {}} openUrl={openUrl} />
    </LangContext.Provider>,
  );

function DetailOf({ v, name }: { v: CatalogView; name: string }) {
  const cat = useCatalog({ initial: v });
  return <Detail a={v.apps.find((a) => a.name === name)!} cat={cat} git={v.git} onBack={() => {}} />;
}
const detail = (v: CatalogView, name: string, lang: "en" | "zh" = "en") =>
  renderToStaticMarkup(
    <LangContext.Provider value={lang}>
      <DetailOf v={v} name={name} />
    </LangContext.Provider>,
  );
const card = (html: string, name: string) => html.split('<li class="store-card">').find((r) => r.includes(`<strong>${name.toUpperCase()}</strong>`))!;

test("the ticks show only in Batch Install, at the top right, on the installable apps and none ticked", () => {
  const v = view([entry("one"), entry("two"), entry("three", { installed: installed("1.0.0"), state: "installed" })]);
  const boxes = (html: string) => html.match(/class="cat-pick"/g)?.length ?? 0;
  const plain = render(v);
  expect(boxes(plain)).toBe(0);
  expect(plain).toContain(">Batch Install</button>");
  const on = render(v, { selecting: true });
  expect(boxes(on)).toBe(2);
  expect(on).not.toMatch(/class="cat-pick"[^>]*checked=""/);
  expect(on).toContain(">Cancel</button>");
  expect(on).not.toContain("chosen");
  // Nothing left to install: no Batch Install.
  expect(render(view([entry("three", { installed: installed("1.0.0"), state: "installed" })]))).not.toContain("Batch Install");
  expect(render(v, { lang: "zh" })).toContain(">批量安装</button>");
});

test("a card says who publishes the app, its release, what it needs and whether the publisher is trusted", () => {
  const html = render(view([entry("one", { needs: ["model", "operator", "something-new"], publisher: { ...publisher, trusted: false } })]));
  const c = card(html, "one");
  expect(c).toContain("needs an AI model");
  expect(c).toContain("changes Space settings");
  expect(c).toContain("something-new");
  expect(c).toContain("Acme · v1.0.0 · not trusted yet");
  expect(c).toContain('aria-label="Details of ONE"');
});

test("a card's button follows the state: install, update, open, source, none for an old deployment", () => {
  const html = render(
    view([
      entry("fresh"),
      entry("stale", { installed: installed("0.9.0"), state: "update" }),
      entry("here", { installed: installed("1.0.0"), state: "installed" }),
      entry("nolink", { installed: installed("1.0.0"), state: "installed" }),
      entry("draft", { latest: null, state: "unreleased" }),
      entry("old", { state: "legacy" }),
    ]),
    { openUrl: (app) => (app === "here" ? "https://here.example/" : undefined) },
  );
  expect(card(html, "fresh")).toContain(">Install<");
  expect(card(html, "stale")).toContain("Update to 1.0.0");
  expect(card(html, "stale")).toContain("Installed 0.9.0");
  expect(card(html, "here")).toContain('href="https://here.example/"');
  expect(card(html, "here")).toContain(">Open<");
  expect(card(html, "nolink")).not.toContain(">Open<");
  expect(card(html, "draft")).toContain("From source");
  expect(card(html, "draft")).not.toContain(">Install<");
  expect(card(html, "old")).toContain("deployed the old way");
  expect(card(html, "old")).not.toContain("<button class=\"btn2");
  expect(render(view([entry("draft", { latest: null, state: "unreleased" })], false))).not.toContain("From source");
});

test("the tabs: discover puts recommended apps first, installed and updates narrow the list, the search reads every language", () => {
  const apps = [
    entry("plain", { recommended: false }),
    entry("pick", { installed: installed("1.0.0"), state: "installed" }),
    entry("behind", { installed: installed("0.1.0"), state: "update", description: { en: "Notes", zh: "笔记本" } }),
  ];
  expect(tabApps(apps, "discover").map((a) => a.name)).toEqual(["pick", "behind", "plain"]);
  expect(tabApps(apps, "installed").map((a) => a.name)).toEqual(["pick", "behind"]);
  expect(tabApps(apps, "updates").map((a) => a.name)).toEqual(["behind"]);
  expect(tabApps(apps, "discover", "笔记").map((a) => a.name)).toEqual(["behind"]);
  expect(tabApps(apps, "discover", "acme plain").map((a) => a.name)).toEqual(["plain"]);
  // The Updates tab carries the count.
  expect(render(view(apps))).toContain('Updates<span class="store-count">1</span>');
});

test("the details show every fact and offer what the state allows", () => {
  const fresh = detail(view([entry("fresh", { latest: { version: "1.0.0", tag: "v1.0.0", sourcePackage: true }, online: [{ en: "Search needs the web" }] })]), "fresh");
  expect(fresh).toContain(">Install<");
  expect(fresh).toContain("with source you can change");
  expect(fresh).toContain("From source");
  expect(fresh).toContain("v1.0.0 (v1.0.0)");
  expect(fresh).toContain("not installed");
  expect(fresh).toContain("Search needs the web");
  expect(fresh).toContain("MIT");
  expect(fresh).toContain('href="https://example.com/fresh"');
  expect(fresh).toContain("aaaaaaaaaaaaaaaa…");
  expect(fresh).not.toContain("Uninstall");

  const changed = detail(view([entry("mine", { installed: installed("0.9.0", { source: "modified" }), state: "update" })]), "mine");
  expect(changed).toContain("Update to 1.0.0");
  expect(changed).toContain("Update over my changes");
  expect(changed).toContain("Rebuild");
  expect(changed).toContain("app-src/mine, changed by you");
  expect(changed).toContain("Installed 0.9.0 · from the signed package");
  expect(changed).toContain(">Uninstall<");
  expect(changed).not.toContain(">Install<");

  const dev = detail(view([entry("dev", { installed: installed("1.1.0", { origin: "source", ref: "main", dev: true, source: "own" }), state: "installed" })]), "dev");
  expect(dev).toContain("development version (main)");
  expect(dev).toContain("app-src/dev, your own checkout");
  expect(dev).not.toContain("From source");
  expect(dev).not.toContain("Update over my changes");
});

test("a Space without a catalog says so, and the store speaks the panel's language", () => {
  expect(render({ sources: [], apps: [], git: true })).toContain("No app catalog is set for this Space");
  const stale = render({ sources: [{ url: "https://example.com/c.json", ok: false, stale: true, error: "HTTP 503", apps: 1 }], apps: [entry("one")], git: true });
  expect(stale).toContain("showing the last copy");
  expect(stale).toContain("HTTP 503");
  const zh = render(view([entry("one")]), { lang: "zh" });
  expect(zh).toContain("应用商店");
  expect(zh).toContain("中文one");
  expect(zh).toContain("About one");
  expect(zh).toContain(">安装<");
  expect(detail(view([entry("one", { installed: installed("1.0.0"), state: "installed" })]), "one", "zh")).toContain(">卸载<");
});

test("the first-use card counts installable apps only on a Space without any catalog app", async () => {
  serve({ ok: true, ...view([entry("one"), entry("two"), entry("draft", { latest: null, state: "unreleased" })]) });
  expect(await catalogOffers()).toBe(2);
  serve({ ok: true, ...view([entry("one"), entry("two", { installed: installed("1.0.0", { ref: null }), state: "installed" })]) });
  expect(await catalogOffers()).toBe(0);
  serve({ ok: true, ...view([entry("one"), entry("two", { state: "legacy" })]) });
  expect(await catalogOffers()).toBe(0);
  serve({ ok: false, error: "unauthorized" }, 401);
  expect(await catalogOffers()).toBe(0);
  globalThis.fetch = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await catalogOffers()).toBe(0);
});

function UpdateAllOf({ v }: { v: CatalogView }) {
  const cat = useCatalog({ initial: v });
  return <UpdateAll cat={cat} apps={v.apps.filter((a) => a.state === "update")} />;
}

test("the Updates tab offers one button for every app with a newer release", () => {
  const v = view([entry("a", { installed: installed("0.1.0"), state: "update" }), entry("b", { installed: installed("0.2.0"), state: "update" })]);
  const html = renderToStaticMarkup(
    <LangContext.Provider value="en">
      <UpdateAllOf v={v} />
    </LangContext.Provider>,
  );
  expect(html).toContain("2 apps have a newer release.");
  expect(html).toContain(">Update all<");
});

test("an install in flight shows its step, and the download as a share of the package", () => {
  const a = entry("one");
  const line = (progress: Catalog["progress"], app = "one") =>
    renderToStaticMarkup(
      <LangContext.Provider value="en">
        <ProgressLine a={a} cat={{ working: { app, how: "install" }, progress } as unknown as Catalog} />
      </LangContext.Provider>,
    );
  const since = "2026-11-21T00:00:00.000Z";
  const download = line({ app: "one", kind: "install", stage: "download", received: 1_048_576, total: 4_194_304, since });
  expect(download).toContain("Downloading · 1.0 MB of 4.0 MB");
  expect(download).toContain("width:25%");
  const build = line({ app: "one", kind: "install", stage: "build", since });
  expect(build).toContain("Building");
  expect(build).toContain('class="busy"');
  // Another app's change, or none, shows nothing here.
  expect(line({ app: "two", kind: "install", stage: "build", since }, "two")).toBe("");
  expect(line(null)).toBe("");
});
