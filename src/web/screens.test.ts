import { describe, expect, test } from "bun:test";
import { WIDGET_SIZES as SERVER_SIZES } from "../space/scheduler/manifest.ts";
import { HOME, WIDGET_SIZES, addScreen, matches, move, parseKey, pin, removeScreen, renameScreen, screensOf, seedScreens, unpin } from "./screens.ts";

describe("screens", () => {
  test("a first home screen takes the panel's own tiles and the head of each list", () => {
    const apps = Array.from({ length: 10 }, (_, i) => `a${i}`);
    const [home] = seedScreens(apps, ["x/one", "y/two"], ["w/1"]);
    expect(home?.id).toBe(HOME);
    expect(home?.items).toEqual([...apps.slice(0, 8).map((a) => `app:${a}`), "builtin:inbox", "builtin:terminal", "builtin:settings", "agent:x/one", "agent:y/two", "widget:w/1"]);
  });

  test("pin adds once, unpin removes only from that screen", () => {
    let s = addScreen(seedScreens([], [], []), "Work").screens;
    s = pin(s, HOME, "app:notes");
    s = pin(s, HOME, "app:notes");
    s = pin(s, "s1", "app:notes");
    expect(s[0]?.items.filter((k) => k === "app:notes")).toHaveLength(1);
    expect(screensOf(s, "app:notes")).toEqual([HOME, "s1"]);
    s = unpin(s, HOME, "app:notes");
    expect(screensOf(s, "app:notes")).toEqual(["s1"]);
  });

  test("move reorders a group in place and leaves the other entries where they were", () => {
    const s = [{ id: HOME, name: "", items: ["app:a", "widget:w1", "app:b", "app:c", "widget:w2"] }];
    expect(move(s, HOME, ["app:a", "app:b", "app:c"], 2, 0)[0]?.items).toEqual(["app:c", "widget:w1", "app:a", "app:b", "widget:w2"]);
    expect(move(s, HOME, ["widget:w1", "widget:w2"], 0, 1)[0]?.items).toEqual(["app:a", "widget:w2", "app:b", "app:c", "widget:w1"]);
    expect(move(s, HOME, ["app:a"], 0, 3)).toBe(s);
  });

  test("screens get unique ids, names are trimmed, home cannot be removed", () => {
    let { screens, id } = addScreen(seedScreens([], [], []), "  Study ");
    expect(id).toBe("s1");
    expect(screens[1]?.name).toBe("Study");
    const second = addScreen(removeScreen(addScreen(screens, "x").screens, "s1"), "y");
    expect(second.id).toBe("s3");
    screens = renameScreen(second.screens, "s3", " z ");
    expect(screens.map((s) => [s.id, s.name])).toEqual([[HOME, ""], ["s2", "x"], ["s3", "z"]]);
    expect(removeScreen(screens, HOME)).toBe(screens);
  });

  test("keys parse back into kind and id; ids may hold a peer prefix", () => {
    expect(parseKey("widget:mac/notes/recent")).toEqual({ kind: "widget", id: "mac/notes/recent" });
    expect(parseKey("nope:x")).toBeNull();
    expect(parseKey("app")).toBeNull();
  });

  test("search needs every word somewhere in the entry", () => {
    expect(matches("todo plan", "AI Todo", "a planner agent")).toBe(true);
    expect(matches("TODO", "ai todo")).toBe(true);
    expect(matches("todo stock", "AI Todo")).toBe(false);
    expect(matches("  ", "anything")).toBe(true);
  });
});
test("the page's widget sizes are the manifest's", () => {
  expect([...WIDGET_SIZES]).toEqual([...SERVER_SIZES]);
});
