import { afterEach, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AppModels, { type AppGroup, AppModelDetail, AppModelList, loadPeerModels, type Option, saveAppModel, summarize } from "./AppModels.tsx";
import { translate } from "./messages.ts";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const options: Option[] = [
  { value: "codex/basic", runtime: "codex", tier: "basic", model: "gpt-mini" },
  { value: "david:codex/intermediate", runtime: "codex", tier: "intermediate", model: "gpt" },
];
const news: AppGroup = {
  key: "news",
  app: "news",
  title: "News",
  icon: "📰",
  rows: [
    { tag: null, manifest: "junior", override: "david:codex/intermediate", model: "david:codex/intermediate", source: "override-app" },
    { tag: "curate", manifest: "codex/basic", model: "codex/basic", source: "manifest-tag" },
    { tag: "translate", override: "codex/basic", model: "codex/basic", source: "override-tag" },
    { tag: "digest", model: "david:codex/intermediate", source: "override-app" },
  ],
};
const notes: AppGroup = { key: "notes", app: "notes", title: "Notes", icon: "📝", rows: [{ tag: null, model: "codex/intermediate", source: "default" }] };

/** Every element in a rendered tree, walking function components that hold no hooks. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("summarize counts the purposes that run on another model than the app", () => {
  expect(summarize(news.rows)).toEqual({ app: news.rows[0], differ: 2 });
  expect(summarize(notes.rows).differ).toBe(0);
});

test("the list shows one row per app with its model, source and differing purposes, and no select", () => {
  const html = renderToStaticMarkup(<AppModelList groups={[news, notes]} onOpen={() => {}} t={t} />);
  expect(html.match(/class="task-main app-model-row"/g)?.length).toBe(2);
  expect(html).toContain("News");
  expect(html).toContain("david:codex/intermediate");
  expect(html).toContain("override for the app");
  expect(html).toContain("2 purposes differ");
  expect(html).toContain("codex/intermediate");
  expect(html).toContain("space default");
  expect(html).not.toContain("<select");
  expect(html).not.toContain("curate");
});

test("a click on a row opens that app", () => {
  const opened: string[] = [];
  const tree = AppModelList({ groups: [news, notes], onOpen: (app) => opened.push(app), t });
  const rows = elements(tree).filter((el) => el.type === "button");
  expect(rows.map((el) => el.props["data-app"])).toEqual(["news", "notes"]);
  (rows[1]!.props.onClick as () => void)();
  expect(opened).toEqual(["notes"]);
});

test("the app page has the app-wide select and one per purpose, with declared, resolved value and source", () => {
  const html = renderToStaticMarkup(<AppModelDetail group={news} options={options} onSaved={() => {}} t={t} />);
  expect(html.match(/<select/g)?.length).toBe(4);
  expect(html).toContain('id="app-model-news-"');
  expect(html).toContain("All purposes");
  expect(html).toContain('id="app-model-news-curate"');
  expect(html).toContain("space.yaml: codex/basic");
  expect(html).toContain("space.yaml, this purpose");
  expect(html).toContain("override for this purpose");
  expect(html).toContain("not in space.yaml");
  expect(html).toContain("Per purpose");
});

test("an app without purposes says so on its page", () => {
  const html = renderToStaticMarkup(<AppModelDetail group={notes} options={options} onSaved={() => {}} t={t} />);
  expect(html.match(/<select/g)?.length).toBe(1);
  expect(html).toContain("No purposes declared");
});

test("an override change patches the app's model for that purpose, and an empty value clears it", async () => {
  const calls: { url: string; method?: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, app: "news", rows: news.rows }));
  }) as unknown as typeof fetch;
  const saved = await saveAppModel("news", "curate", "david:codex/intermediate");
  await saveAppModel("news", null, "");
  expect(saved.rows).toEqual(news.rows);
  expect(calls).toEqual([
    { url: "/api/panel/apps/news/model", method: "PATCH", body: { tag: "curate", model: "david:codex/intermediate" } },
    { url: "/api/panel/apps/news/model", method: "PATCH", body: { model: null } },
  ]);
});

test("standalone, an open app's page has a back button to the list", () => {
  const html = renderToStaticMarkup(<AppModels open onClose={() => {}} selected="news" onSelect={() => {}} />);
  expect(html).toContain('title="Back"');
  expect(html).toContain('aria-label="news"');
});

test("a peer's app is keyed by its machine and its page's selects carry the machine", () => {
  const remote: AppGroup = { ...notes, key: "david/notes", peer: "david" };
  const opened: string[] = [];
  const tree = AppModelList({ groups: [remote], onOpen: (key) => opened.push(key), t, heading: t("appModels.onPeer", { peer: "david" }) });
  (elements(tree).find((el) => el.type === "button")!.props.onClick as () => void)();
  expect(opened).toEqual(["david/notes"]);
  expect(renderToStaticMarkup(tree)).toContain("On david");
  expect(renderToStaticMarkup(<AppModelDetail group={remote} options={options} onSaved={() => {}} t={t} />)).toContain('id="app-model-david-notes-"');
  expect(renderToStaticMarkup(<AppModelList groups={[]} onOpen={() => {}} t={t} heading="On box" note="box is not answering: down" />)).toContain("box is not answering");
});

test("a change to a peer's app goes to the hub's peer route", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, app: "notes", rows: [] }));
  }) as unknown as typeof fetch;
  await saveAppModel("notes", null, "codex/basic", "david");
  expect(calls).toEqual([{ url: "/api/peers/david/apps/notes/model", body: { model: "codex/basic" } }]);
});

test("a peer's rows load with its own choices; an older peer and an unreachable one are told apart", async () => {
  const answers: Record<string, Response> = {
    "/api/peers/new/model/apps": Response.json({ ok: true, apps: [{ app: "notes", rows: [] }], options }),
    "/api/peers/old/model/apps": new Response("", { status: 404 }),
    "/api/peers/down/model/apps": Response.json({ ok: false, error: "peer down unreachable: timeout" }, { status: 502 }),
  };
  globalThis.fetch = (async (url: string) => answers[url]!) as unknown as typeof fetch;
  expect(await loadPeerModels("new")).toEqual({ peer: "new", apps: [{ app: "notes", rows: [] }], options });
  expect(await loadPeerModels("old")).toEqual({ peer: "old", old: true });
  expect(await loadPeerModels("down")).toEqual({ peer: "down", error: "peer down unreachable: timeout" });
});
