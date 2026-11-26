import { describe, expect, test } from "bun:test";
import type { TrendBlock, WidgetBlock } from "../../../../src/space/panel/blocks.ts";
import * as web from "../../../../src/web/widget-interact.ts";
import { MESSAGES } from "../../../../src/web/messages.ts";
import { decodeWidget } from "./catalogue.ts";
import {
  blockAction,
  blocksOf,
  cardActions,
  chosenView,
  clampPage,
  confirmOf,
  controlsOf,
  countUp,
  decodeWidgetAnswer,
  flashMarks,
  hasControl,
  inputValue,
  messageText,
  pagesOf,
  pointDate,
  readout,
  rowsPerPage,
  stepPage,
  viewsOf,
  widgetPostPath,
} from "./widget-interact.ts";

const raw = {
  id: "todo/today",
  app: "todo",
  name: "today",
  title: "Today",
  ok: true,
  size: "1x1",
  items: [],
  blocks: [
    { type: "status", label: "Buy milk", value: "today", action: { id: "done:42", kind: "check", label: { en: "Mark done", zh: "标记完成" } } },
    { type: "metric", label: "Open", value: 3, copy: "3 open" },
    { type: "sparkle", label: "Unknown type", value: 1 },
    { type: "metric", label: "Bad action", value: 1, action: { id: "x", kind: "launch", label: "Go" } },
  ],
  views: [
    { id: "today", label: { en: "Today", zh: "今日" }, blocks: [{ type: "metric", label: "Open", value: 3 }] },
    { id: "7d", label: "7 days", blocks: [{ type: "metric", label: "Open", value: 9 }] },
    { id: "BAD id", label: "x", blocks: [{ type: "metric", label: "x", value: 1 }] },
  ],
  actions: [
    { id: "add", kind: "input", label: "Add", placeholder: "Add a task…" },
    { id: "add2", kind: "input", label: "Second input" },
    { id: "rerun", kind: "button", label: "Run now", confirm: { en: "Run it now?", zh: "现在运行？" } },
    { id: "zap", kind: "teleport", label: "?" },
  ],
};

describe("decoding a card", () => {
  test("unknown block types, unknown action kinds and malformed fields are dropped, never fatal", () => {
    const w = decodeWidget(raw)!;
    expect(w.blocks!.map((b) => b.label)).toEqual(["Buy milk", "Open", "Bad action"]);
    expect(w.blocks![2]!.action).toBeUndefined();
    expect(w.views!.map((v) => v.id)).toEqual(["today", "7d"]);
    expect(w.actions!.map((a) => a.id)).toEqual(["add", "rerun"]);
    expect(decodeWidget({ ...raw, blocks: "nope", views: { a: 1 }, actions: [null] })!.blocks).toBeUndefined();
    expect(decodeWidget(null)).toBeUndefined();
  });

  test("an older Space's card has none of it and reads as before", () => {
    const w = decodeWidget({ id: "a/b", app: "a", name: "b", title: "B", ok: true, blocks: [{ type: "metric", label: "x", value: 1 }] })!;
    expect(w.views).toBeUndefined();
    expect(w.actions).toBeUndefined();
    expect(w.frame).toBeUndefined();
    expect(viewsOf(w)).toBeUndefined();
    expect(cardActions(w)).toEqual({ buttons: [] });
  });
});

describe("who may do what", () => {
  const w = decodeWidget(raw)!;
  test("on a screen everything responds; in Edit Layout and the library it is drawn and inert", () => {
    expect(controlsOf(w, "live")).toEqual({ live: true, acts: true, actLive: true });
    expect(controlsOf(w, "edit")).toEqual({ live: false, acts: true, actLive: false });
    expect(controlsOf(w, "preview")).toEqual({ live: false, acts: true, actLive: false });
  });

  test("a peer's card has no write-back controls, whatever its payload carries", () => {
    const peer = { ...w, peer: "seoul" };
    const c = controlsOf(peer, "live");
    expect(c).toEqual({ live: true, acts: false, actLive: false });
    expect(cardActions(peer)).toEqual({ buttons: [] });
    expect(blockAction(peer.blocks![0]!, c)).toBeUndefined();
    // Copy still works on a peer's card.
    expect(hasControl(peer.blocks![1]!, c)).toBe(true);
    expect(hasControl(peer.blocks![0]!, c)).toBe(false);
  });

  test("the card's input and buttons; a confirmation asked in the card", () => {
    const a = cardActions(w);
    expect(a.input?.id).toBe("add");
    expect(a.buttons.map((b) => b.id)).toEqual(["rerun"]);
    expect(confirmOf(a.buttons[0]!, "zh")).toEqual({ text: "现在运行？", label: "Run now" });
    expect(confirmOf(a.input!, "en")).toBeUndefined();
    expect(inputValue("  milk  ")).toBe("milk");
    expect(inputValue("   ")).toBeUndefined();
    expect(inputValue("x".repeat(2001))).toBeUndefined();
  });
});

describe("views", () => {
  const w = decodeWidget(raw)!;
  test("the first view by default, the reader's last choice while the card still has it", () => {
    const views = viewsOf(w)!;
    expect(chosenView(undefined, w.id, views)!.id).toBe("today");
    expect(chosenView({ [w.id]: "7d" }, w.id, views)!.id).toBe("7d");
    expect(chosenView({ [w.id]: "gone" }, w.id, views)!.id).toBe("today");
    expect(blocksOf(w, views[1])![0]).toMatchObject({ value: 9 });
    expect(blocksOf(w, undefined)).toBe(w.blocks);
    expect(blocksOf({ ...w, ok: false }, views[1])).toBeUndefined();
  });
});

describe("the writes", () => {
  test("the routes, the fresh card and its message; any failure keeps the Space's reason", () => {
    expect(widgetPostPath({ app: "to do", name: "x" }, "refresh")).toBe("/api/widgets/to%20do/x/refresh");
    const ok = decodeWidgetAnswer(200, JSON.stringify({ ok: true, message: { en: "Done", zh: "已完成" }, widget: raw }), "zh");
    expect(ok.ok && ok.widget.id).toBe("todo/today");
    expect(ok.ok && ok.message).toBe("已完成");
    expect(decodeWidgetAnswer(502, '{"ok":false,"error":"unknown action"}', "en")).toEqual({ ok: false, error: "unknown action" });
    // An older Space has no such route.
    expect(decodeWidgetAnswer(404, "Not Found", "en")).toEqual({ ok: false, error: "HTTP 404" });
    expect(decodeWidgetAnswer(200, '{"ok":true}', "en")).toEqual({ ok: false, error: "HTTP 200" });
    expect(messageText("x".repeat(300), "en").length).toBe(200);
    expect(messageText(42, "en")).toBe("");
  });

  test("the words are the panel's", () => {
    for (const k of ["widget.copy", "widget.copied", "widget.refresh", "widget.refreshing", "widget.views", "widget.pages", "widget.page", "widget.actionFailed", "widget.send", "layout.edit", "layout.align", "layout.center", "layout.split", "layout.reset", "layout.resetAsk", "layout.undo", "layout.saveFailed", "widget.resizeWidth", "widget.resizeHeight", "widget.resizeBoth", "screens.done"] as const) {
      expect(MESSAGES.en[k]).toBeTruthy();
      expect(MESSAGES.zh[k]).toBeTruthy();
    }
  });
});

describe("rows, readout and motion", () => {
  test("the shared rules are the panel's own", () => {
    expect(pagesOf).toBe(web.pagesOf);
    expect(flashMarks(undefined, "", [])).toBeUndefined();
  });

  test("rows per page: the size's table until measured, else what fits under the hero", () => {
    expect(rowsPerPage("1x2")).toBe(6);
    expect(rowsPerPage("2x2", { avail: 100, heights: [], gap: 10, pagerH: 26 })).toBe(10);
    expect(rowsPerPage("1x1", { avail: 200, heights: [40, 40, 40], gap: 10, pagerH: 26 })).toBe(3);
    expect(rowsPerPage("1x1", { avail: 100, heights: [40, 40, 40, 40], gap: 10, pagerH: 26 })).toBe(1);
    expect(clampPage(5, 2)).toBe(1);
    expect(stepPage(0, 3, -1)).toBe(0);
    expect(stepPage(1, 3, 1)).toBe(2);
  });

  test("the readout: the point's value and date in place of the latest", () => {
    const b: TrendBlock = { type: "trend", label: "Visits", style: "line", points: [{ t: "2026-11-01", v: 10 }, { t: "2026-11-02T14:30:00Z", v: null }, { t: "2026-11-03", v: 1234.5 }] };
    expect(readout(b, 2, "en")).toEqual({ value: "1,234.5", date: pointDate("2026-11-03", "en") });
    expect(readout(b, 1, "en")!.value).toBeUndefined();
    expect(readout(b, 9, "en")).toBeUndefined();
    expect(pointDate("2026-11-02T14:30:00Z", "en")).toContain("Nov");
  });

  test("a value flashes on a new payload of the same view, not on the first or after a view change", () => {
    const a: WidgetBlock[] = [{ type: "metric", label: "Open", value: 3 }];
    const b: WidgetBlock[] = [{ type: "metric", label: "Open", value: 4 }];
    expect(flashMarks({ view: "", blocks: a }, "", b)).toEqual(["up"]);
    expect(flashMarks({ view: "today", blocks: a }, "7d", b)).toBeUndefined();
    expect(flashMarks({ view: "", blocks: a }, "", a)).toBeUndefined();
  });

  test("a number counts up and ends on its value", () => {
    expect(countUp(10, 0)).toBe(0);
    expect(countUp(10, 0.5)).toBe(9);
    expect(countUp(2.5, 1)).toBe(2.5);
  });
});
