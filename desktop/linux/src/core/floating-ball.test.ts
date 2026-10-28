import { describe, expect, test } from "bun:test";
import { decodeCatalogue } from "./catalogue.ts";
import {
  DIAL_DIAMETER, EMPTY_SLOT, MARGIN, type Rect, agentFor, agentForApp, decodeFromBall, dialCenter, isOwnDrop, isPictureType, offer,
  origin, refFor, resolveDial, sectionAt, setting, slot, withLead,
} from "./floating-ball.ts";

// The Mac's FloatingBallRulesTests, with y pointing down: a 1440 × 900 screen under a 25-point
// top bar, above a 70-point dock.
const visible: Rect = { x: 0, y: 25, width: 1440, height: 805 };
const size = { width: 52, height: 52 };
const place = (saved?: { x: number; y: number }, screen = visible) => origin(saved, size, screen);

describe("the ball's place", () => {
  test("its first place is the right edge, a third of the way down", () => {
    const o = place();
    expect(o.x).toBe(1440 - 52 - 12);
    expect(o.y).toBeLessThan(visible.y + visible.height / 2);
    expect(o.y).toBeGreaterThanOrEqual(visible.y + MARGIN);
  });

  test("a saved place is kept when it fits", () => {
    expect(place({ x: 300, y: 400 })).toEqual({ x: 300, y: 400 });
  });

  test("a saved place off the screen comes back inside", () => {
    expect(place({ x: -40, y: 0 })).toEqual({ x: 12, y: 37 });
    expect(place({ x: 5000, y: 5000 })).toEqual({ x: 1376, y: 766 });
  });

  test("a screen too small for the ball still gets it", () => {
    expect(place({ x: 10, y: 10 }, { x: 0, y: 0, width: 40, height: 40 })).toEqual({ x: 0, y: 0 });
  });
});

describe("what a drag offers", () => {
  const of = (types: string[], files: string[] = [], promised = false) => offer(types, files, isPictureType, promised);

  test("one file is taken when it is a picture", () => {
    expect(of(["text/uri-list"], ["image/png"])).toBe("file");
    expect(of(["text/uri-list"], ["application/pdf"])).toBe("nothing");
    expect(of(["text/uri-list"], ["image/png", "image/jpeg"])).toBe("nothing");
    expect(of(["text/uri-list"], [""])).toBe("nothing");
  });

  test("picture data is taken and a file beside it wins", () => {
    expect(of(["image/png", "text/x-moz-url"])).toBe("picture");
    expect(of(["image/png", "text/uri-list"], ["image/heic"])).toBe("file");
    expect(of(["image/png", "text/uri-list"], ["application/pdf"])).toBe("nothing");
  });

  test("a promise is taken only with nothing better", () => {
    expect(of(["XdndDirectSave0", "text/x-moz-url"], [], true)).toBe("promise");
    expect(of(["image/png", "XdndDirectSave0"], [], true)).toBe("picture");
  });

  test("links and text are refused", () => {
    expect(of(["text/x-moz-url", "text/plain;charset=utf-8"])).toBe("nothing");
    expect(of([])).toBe("nothing");
    expect(isPictureType("image/svg+xml")).toBe(true);
    expect(isPictureType("imagery/png")).toBe(false);
  });
});

describe("the dial", () => {
  test("sections go clockwise from the top", () => {
    const c = { x: 200, y: 200 }, r = 80;
    expect(sectionAt({ x: 200, y: 200 - r }, c)).toBe("keep");
    expect(sectionAt({ x: 200 + r, y: 200 }, c)).toBe("assistant");
    expect(sectionAt({ x: 200, y: 200 + r }, c)).toBe("todo");
    expect(sectionAt({ x: 200 - r, y: 200 }, c)).toBe("design");
  });

  test("the hub and past the rim are no section", () => {
    const c = { x: 200, y: 200 };
    expect(sectionAt({ x: 210, y: 205 }, c)).toBeUndefined();
    expect(sectionAt({ x: 200 + DIAL_DIAMETER, y: 200 }, c)).toBeUndefined();
  });

  test("the dial stays whole on the screen", () => {
    const ball = { x: 1440 - 38, y: 300 };
    const c = dialCenter(ball, visible);
    expect(c.x + DIAL_DIAMETER / 2).toBeLessThanOrEqual(visible.x + visible.width);
    expect(c.y).toBe(ball.y);
    const middle = { x: 700, y: 400 };
    expect(dialCenter(middle, visible)).toEqual(middle);
  });

  test("a section opens this machine's entry before a peer's", () => {
    const refs = ["thinkbook/ai-todo", "ai-todo", "keep-notes", "david/space/assistant", "space/assistant", "thinkbook/ai-design"];
    expect(refFor("todo", refs)).toBe("ai-todo");
    expect(refFor("assistant", refs)).toBe("space/assistant");
    expect(refFor("design", refs)).toBe("thinkbook/ai-design");
    expect(refFor("keep", refs)).toBeUndefined();
    expect(refFor("assistant", ["thinkbook/space/assistant"])).toBe("thinkbook/space/assistant");
  });

  test("a section hands its work to its app's agent", () => {
    const refs = ["space/assistant", "space/ui-fixer", "david/space/assistant", "thinkbook/ai-design/designer", "thinkbook/ai-todo/planner", "ai-todo/planner"];
    expect(agentFor("assistant", refs)).toBe("space/assistant");
    expect(agentFor("todo", refs)).toBe("ai-todo/planner");
    expect(agentFor("design", refs)).toBe("thinkbook/ai-design/designer");
    expect(agentFor("keep", refs)).toBeUndefined();
  });

  test("each Space sets its own sections", () => {
    expect(slot("keep", undefined)).toBeUndefined();
    const slots = setting("todo", "app:vault", undefined);
    expect(slots).toEqual(["", "", "app:vault", ""]);
    expect(slot("todo", slots)).toBe("app:vault");
    expect(slot("keep", slots)).toBeUndefined();
    const cleared = setting("todo", undefined, setting("design", EMPTY_SLOT, slots));
    expect(slot("todo", cleared)).toBeUndefined();
    expect(slot("design", cleared)).toBe(EMPTY_SLOT);
  });

  test("an app's agent is found on its own machine first", () => {
    const refs = ["space/assistant", "keep/keeper", "thinkbook/ai-todo/planner", "ai-todo/planner"];
    expect(agentForApp("keep", refs)).toBe("keep/keeper");
    expect(agentForApp("thinkbook/ai-todo", refs)).toBe("thinkbook/ai-todo/planner");
    expect(agentForApp("ai-todo", refs)).toBe("ai-todo/planner");
    expect(agentForApp("david/ai-todo", refs)).toBe("thinkbook/ai-todo/planner");
    expect(agentForApp("vault", refs)).toBeUndefined();
  });
});

describe("a Space's dial", () => {
  const app = (id: string, peer?: string) => ({ id, title: id, url: `/apps/${id}/`, ...(peer ? { peer } : {}) });
  const agent = (id: string, app: string, name: string, peer?: string) => ({ id, app, name, title: name, ...(peer ? { peer } : {}) });
  const catalogue = decodeCatalogue({
    apps: { apps: [app("keep"), app("ai-todo"), app("vault"), app("thinkbook/ai-design", "thinkbook")] },
    agents: { agents: [agent("space/assistant", "space", "assistant"), agent("ai-todo/planner", "ai-todo", "planner"), agent("thinkbook/ai-design/designer", "ai-design", "designer", "thinkbook")] },
    widgets: { widgets: [{ id: "keep/recent", app: "keep", name: "recent", title: "Recent" }] },
  });

  test("the default apps, each with its agent or Space Assistant", () => {
    const dial = resolveDial(catalogue, undefined);
    expect(dial.keep).toMatchObject({ agent: "space/assistant", borrowed: true, hidden: false });
    expect(dial.keep.entry?.ref).toBe("keep");
    expect(dial.assistant).toMatchObject({ agent: "space/assistant", borrowed: false });
    expect(dial.todo).toMatchObject({ agent: "ai-todo/planner", borrowed: false });
    expect(dial.design).toMatchObject({ agent: "thinkbook/ai-design/designer", borrowed: false });
  });

  test("Settings' choices: another app, an agent, none, never a widget", () => {
    const slots = ["app:vault", "agent:ai-todo/planner", EMPTY_SLOT, "widget:keep/recent"];
    const dial = resolveDial(catalogue, slots);
    expect(dial.keep).toMatchObject({ agent: "space/assistant", borrowed: true });
    expect(dial.keep.entry?.ref).toBe("vault");
    expect(dial.assistant).toMatchObject({ agent: "ai-todo/planner", borrowed: false });
    expect(dial.todo).toEqual({ borrowed: false, hidden: true });
    expect(dial.design).toEqual({ borrowed: false, hidden: false });
  });

  test("no catalogue, or no agent at all, leaves every section without work", () => {
    expect(resolveDial(undefined, undefined).todo).toEqual({ borrowed: false, hidden: false });
    const bare = decodeCatalogue({ apps: { apps: [app("keep")] }, agents: { agents: [] }, widgets: { widgets: [] } });
    expect(resolveDial(bare, undefined).keep).toEqual({ borrowed: false, hidden: false });
  });
});

describe("the two processes", () => {
  test("lines from the ball are checked", () => {
    expect(decodeFromBall('{"type":"open","section":"todo","startupId":"x"}')).toEqual({ type: "open", section: "todo", startupId: "x" });
    expect(decodeFromBall('{"type":"open","section":"elsewhere"}')).toBeUndefined();
    expect(decodeFromBall('{"type":"drop","file":"/run/user/1000/ai-space-drops/a.png","temporary":true}')).toEqual({ type: "drop", file: "/run/user/1000/ai-space-drops/a.png", temporary: true });
    expect(decodeFromBall('{"type":"drop","file":"relative.png"}')).toBeUndefined();
    expect(decodeFromBall('{"type":"moved","origin":{"x":10.4,"y":20.6}}')).toEqual({ type: "moved", origin: { x: 10, y: 21 } });
    expect(decodeFromBall('{"type":"menu","action":"rm -rf"}')).toBeUndefined();
    expect(decodeFromBall("not json")).toBeUndefined();
    expect(decodeFromBall("null")).toBeUndefined();
  });

  test("only the ball's own temporary files are removed", () => {
    const folder = "/run/user/1000/ai-space-drops";
    expect(isOwnDrop(`${folder}/a.png`, folder)).toBe(true);
    expect(isOwnDrop(`${folder}/../a.png`, folder)).toBe(false);
    expect(isOwnDrop(`${folder}/x/a.png`, folder)).toBe(false);
    expect(isOwnDrop("/home/me/a.png", folder)).toBe(false);
  });

  test("the lead goes before the message once", () => {
    expect(withLead("", "Save this to Keep:")).toBe("Save this to Keep:\n");
    expect(withLead("Save this to Keep:\nhello", "Save this to Keep:")).toBe("Save this to Keep:\nhello");
  });
});
