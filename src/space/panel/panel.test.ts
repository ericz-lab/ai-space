import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { LayoutStore, orderBy } from "./layout.ts";
import { linkManifest, parseLinkApp } from "./links.ts";
import { agentView, appView, iconUrl, resolveLink, serviceView } from "./view.ts";

describe("layout", () => {
  test("orderBy puts unknown names after ordered ones, alphabetically", () => {
    const items = ["c", "a", "b", "d"].map((name) => ({ name }));
    expect(orderBy(items, ["d", "b"], (i) => i.name).map((i) => i.name)).toEqual(["d", "b", "a", "c"]);
  });

  test("store round-trips, validates and dedupes", () => {
    const store = new LayoutStore(new Database(":memory:"));
    expect(store.read()).toEqual({ order: { apps: [], agents: [], widgets: [] }, hidden: [], sizes: {}, hiddenWidgets: [], screens: null, frames: {}, widgetAlign: "start" });
    store.update({ order: { apps: ["b", "a", "b", 3 as unknown as string] } });
    store.update({ hidden: ["x"] });
    expect(store.read()).toEqual({ order: { apps: ["b", "a"], agents: [], widgets: [] }, hidden: ["x"], sizes: {}, hiddenWidgets: [], screens: null, frames: {}, widgetAlign: "start" });
    expect(store.hide("y", true).hidden).toEqual(["x", "y"]);
    expect(store.hide("x", false).hidden).toEqual(["y"]);
    expect(() => store.update({ hidden: "x" as unknown as string[] })).toThrow(/hidden must be/);
    expect(store.update({ hiddenWidgets: { "a/w": true, "b/w": true } }).hiddenWidgets).toEqual(["a/w", "b/w"]);
    expect(store.update({ hiddenWidgets: { "a/w": false } }).hiddenWidgets).toEqual(["b/w"]);
    expect(() => store.update({ hiddenWidgets: ["a/w"] as unknown as Record<string, boolean> })).toThrow(/hiddenWidgets must be/);
    expect(() => store.update({ hiddenWidgets: { "a/w": "yes" as unknown as boolean } })).toThrow(/true or false/);
  });

  test("frames merge by widget id, are validated, and null removes one", () => {
    const store = new LayoutStore(new Database(":memory:"));
    expect(store.update({ frames: { "a/w": { w: 0.5, h: 320 }, "b/w": { w: 1, h: 140 } } }).frames).toEqual({ "a/w": { w: 0.5, h: 320 }, "b/w": { w: 1, h: 140 } });
    expect(store.update({ frames: { "a/w": { w: 0.25, h: 900 } } }).frames).toEqual({ "a/w": { w: 0.25, h: 900 }, "b/w": { w: 1, h: 140 } });
    expect(store.update({ frames: { "b/w": null } }).frames).toEqual({ "a/w": { w: 0.25, h: 900 } });
    // Extra keys are not kept.
    expect(store.update({ frames: { "c/w": { w: 0.1, h: 200, x: 1 } as unknown as { w: number; h: number } } }).frames["c/w"]).toEqual({ w: 0.1, h: 200 });
    for (const bad of [{ w: 0.09, h: 300 }, { w: 1.01, h: 300 }, { w: 0.5, h: 139 }, { w: 0.5, h: 901 }, { w: Number.NaN, h: 300 }, { w: Number.POSITIVE_INFINITY, h: 300 }, { w: "0.5", h: 300 }, [0.5, 300], 1])
      expect(() => store.update({ frames: { "a/w": bad as unknown as { w: number; h: number } } })).toThrow(/frames\.a\/w/);
    expect(() => store.update({ frames: [] as unknown as Record<string, null> })).toThrow(/frames must be/);
    // A refused patch changes nothing.
    expect(store.read().frames["a/w"]).toEqual({ w: 0.25, h: 900 });
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`x/${i}`, { w: 0.5, h: 300 }]));
    expect(() => store.update({ frames: many })).toThrow(/too many frames/);
  });

  test("a size written alone drops the frame; written together, both stay", () => {
    const store = new LayoutStore(new Database(":memory:"));
    store.update({ frames: { "a/w": { w: 0.6, h: 500 } }, sizes: { "a/w": "2x2" } });
    expect(store.read()).toMatchObject({ frames: { "a/w": { w: 0.6, h: 500 } }, sizes: { "a/w": "2x2" } });
    // A native client that only knows sizes chose a classic size: the panel shows that one.
    expect(store.update({ sizes: { "a/w": "1x1" } })).toMatchObject({ frames: {}, sizes: { "a/w": "1x1" } });
  });

  test("widgetAlign is start or center, start by default", () => {
    const store = new LayoutStore(new Database(":memory:"));
    expect(store.read().widgetAlign).toBe("start");
    expect(store.update({ widgetAlign: "center" }).widgetAlign).toBe("center");
    expect(store.update({ hidden: [] }).widgetAlign).toBe("center");
    expect(() => store.update({ widgetAlign: "right" })).toThrow(/widgetAlign/);
    expect(store.update({ widgetAlign: "start" }).widgetAlign).toBe("start");
  });

  test("a stored layout with malformed frames reads back without them", () => {
    const db = new Database(":memory:");
    const store = new LayoutStore(db);
    db.query("INSERT INTO panel_kv (key, value) VALUES ('layout', ?)").run(JSON.stringify({ frames: { "a/w": { w: 0.5, h: 300 }, "b/w": { w: 5, h: 300 }, "c/w": "x" }, widgetAlign: "middle" }));
    expect(store.read()).toMatchObject({ frames: { "a/w": { w: 0.5, h: 300 } }, widgetAlign: "start" });
  });
});

describe("links", () => {
  test("parseLinkApp normalises and rejects bad input", () => {
    expect(parseLinkApp({ name: " My-App ", title: "  My   App ", url: "https://a.example.com", icon: "🔧", description: "x" })).toEqual({ name: "my-app", title: "My App", description: "x", icon: "🔧", url: "https://a.example.com" });
    expect(() => parseLinkApp({ name: "bad name" })).toThrow(/kebab-case/);
    expect(() => parseLinkApp({ name: "a", url: "ftp://x" })).toThrow(/url must/);
    expect(() => parseLinkApp({ name: "a", icon: "icons/x.svg" })).toThrow(/icon must/);
    expect(() => parseLinkApp({ name: "a", title: 3 })).toThrow(/title must be/);
  });

  test("linkManifest parses back through parseManifest", () => {
    const yaml = linkManifest({ name: "tool", title: 'A "quoted" tool', url: "https://t.example.com/#x", icon: "🔧", repo: "https://github.com/x/tool.git" });
    const m = parseManifest(yaml, "/apps/tool");
    expect(m).toMatchObject({ app: "tool", title: 'A "quoted" tool', url: "https://t.example.com/#x", icon: "🔧", repo: "https://github.com/x/tool.git", status: "active" });
    expect(m.service).toBeUndefined();
  });
});

describe("view", () => {
  const m = parseManifest("name: n\nicon: icon.svg\nurl: https://n.example.com/app/\n", "/apps/n");
  test("iconUrl distinguishes emoji, urls and files", () => {
    expect(iconUrl(m)).toBe("/api/apps/n/icon");
    expect(iconUrl({ ...m, icon: "📦" })).toBe("📦");
    expect(iconUrl({ ...m, icon: "https://x/i.png" })).toBe("https://x/i.png");
    expect(iconUrl({ ...m, icon: undefined })).toBe("📦");
  });
  test("views carry the manifest's translations next to the plain text, only when there are any", () => {
    const m = parseManifest(
      "name: notes\ntitle: Notes\nservice: { command: x, port: 8710 }\nagents:\n  - name: a\n  - name: b\nwidgets:\n  - name: w\n    source: /w\ni18n:\n  zh:\n    title: 笔记\n    agents: { a: { title: 甲 } }\n    widgets: { w: { title: 组件 } }\n",
      "/apps/notes",
    );
    const entry = { manifest: m, manifestOnly: false } as Parameters<typeof appView>[0];
    const app = appView(entry, { hidden: false });
    expect(app.title).toBe("Notes");
    expect(app.i18n).toEqual({ zh: { title: "笔记" } });
    expect(app.agents[0]?.i18n).toEqual({ zh: { title: "甲" } });
    expect("i18n" in (app.agents[1] ?? {})).toBe(false);
    expect(app.widgets[0]?.i18n).toEqual({ zh: { title: "组件" } });
    expect(serviceView(entry, { hidden: false })?.i18n).toEqual({ zh: { title: "笔记" } });
    const plain = parseManifest("name: bare\nagents:\n  - name: a\n", "/apps/bare");
    expect("i18n" in appView({ manifest: plain, manifestOnly: false } as Parameters<typeof appView>[0], { hidden: false })).toBe(false);
    expect("i18n" in agentView(plain, plain.agents[0]!)).toBe(false);
  });

  test("resolveLink resolves against the app url", () => {
    expect(resolveLink(m, "/#recent")).toBe("https://n.example.com/#recent");
    expect(resolveLink(m, "list")).toBe("https://n.example.com/app/list");
    expect(resolveLink(m, undefined)).toBe("https://n.example.com/app/");
    expect(resolveLink({ ...m, url: undefined }, "/x")).toBe("");
  });
});
