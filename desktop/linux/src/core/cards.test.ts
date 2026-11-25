import { describe, expect, test } from "bun:test";
import { undoLabel as webUndoLabel } from "../../../../src/web/ChatCards.tsx";
import { MESSAGES } from "../../../../src/web/messages.ts";
import {
  type Card,
  type ShownCard,
  actionBody,
  actionOutcome,
  agendaDays,
  canUndo,
  cardStyle,
  cardsBase,
  cardsEvent,
  compactValue,
  decodeCard,
  decodeCards,
  decodeItemStates,
  galleryLine,
  leadOf,
  mergeStates,
  openIds,
  parseCardDate,
  pillOf,
  rowUndoStyle,
  shownCard,
  shownItem,
  stateBody,
  stateItems,
  undoLabel,
  undoable,
} from "./cards.ts";
import { TurnReply } from "./chat.ts";
import { cardApp, decodeCatalogue } from "./catalogue.ts";

const receipt = { v: 1, kind: "receipt", title: "已添加 3 条", items: [{ id: "72", title: "开会", detail: "后天 周四 08:00", url: "https://todo.example/?todo=72", version: 1 }, { id: 73, title: "交报销", detail: "周五 11-27 · 高" }, { id: "74", title: "约体检" }], state: "card-state", actions: { undo: "card-undo" } };

const shown = (raw: unknown, token?: string): ShownCard => shownCard({ card: decodeCard(raw)!, raw, index: 0, ...(token ? { token } : {}) });

describe("decoding cards", () => {
  test("a v1 card decodes; a numeric id is its string; an unknown field is ignored", () => {
    const card = decodeCard({ ...receipt, future: { x: 1 }, items: [{ ...receipt.items[0], extra: true }, receipt.items[1]] })!;
    expect(card).toEqual({ v: 1, kind: "receipt", title: "已添加 3 条", items: [{ id: "72", title: "开会", detail: "后天 周四 08:00", url: "https://todo.example/?todo=72", version: 1 }, { id: "73", title: "交报销", detail: "周五 11-27 · 高" }], state: "card-state", actions: { undo: "card-undo" } });
  });

  test("what cannot be drawn is not a card", () => {
    expect(decodeCard({ ...receipt, v: 2 })).toBeUndefined();
    expect(decodeCard({ ...receipt, kind: "draft" })).toBeUndefined();
    expect(decodeCard({ ...receipt, items: [] })).toBeUndefined();
    expect(decodeCard({ v: 1, kind: "value" })).toBeUndefined();
    expect(decodeCard({ v: 1, kind: "value", text: "12 条" })).toEqual({ v: 1, kind: "value", items: [], text: "12 条" });
    // Only a receipt acts; an action other than undo is left out.
    expect(decodeCard({ ...receipt, kind: "list" })!.actions).toBeUndefined();
    expect(decodeCard({ ...receipt, actions: { edit: "card-edit" } })!.actions).toBeUndefined();
  });

  test("a live event's cards keep their index in the event and its token; a restored list has none", () => {
    const got = cardsEvent({ type: "cards", cards: [{ v: 9 }, receipt], token: "tok" });
    expect(got.map((c) => [c.index, c.token, c.card.title])).toEqual([[1, "tok", "已添加 3 条"]]);
    expect(got[0]!.raw).toBe(receipt);
    expect(cardsEvent({ type: "cards", cards: [receipt] })[0]!.token).toBeUndefined();
    expect(cardsEvent({ type: "text", cards: [receipt] })).toEqual([]);
    expect(decodeCards([receipt, receipt]).map((c) => c.index)).toEqual([0, 1]);
    expect(decodeCards("nope")).toEqual([]);
  });

  test("a turn's reply collects every cards event", () => {
    const r = new TurnReply();
    r.apply(JSON.stringify({ type: "cards", cards: [receipt], token: "a" }));
    r.apply(JSON.stringify({ type: "cards", cards: [receipt] }));
    expect(r.cards.map((c) => [c.index, c.token])).toEqual([[0, "a"], [0, undefined]]);
    expect(r.steps).toEqual([]);
  });

  test("v2 item fields: kept when well formed, ignored when not; an unknown tone is neutral, an unknown icon none", () => {
    const item = decodeCard({ v: 1, kind: "list", style: "rows", items: [{ id: "1", title: "a", when: "后天 周四 08:00", date: "2026-11-26T08:00", tags: [{ text: "高", tone: "warning" }, { text: "x", tone: "loud" }, { nope: 1 }, { text: "c" }, { text: "d" }, { text: "e" }], image: "https://x/a.png", icon: "flag", value: "12", progress: 0.5 }] })!.items[0];
    expect(item).toEqual({ id: "1", title: "a", when: "后天 周四 08:00", date: "2026-11-26T08:00", tags: [{ text: "高", tone: "warning" }, { text: "x", tone: "neutral" }, { text: "c", tone: "neutral" }, { text: "d", tone: "neutral" }], image: "https://x/a.png", icon: "flag", value: "12", progress: 0.5 });
    const bad = decodeCard({ v: 1, kind: "list", items: [{ id: "1", title: "a", when: 5, date: "2026-02-30", tags: "高", image: "javascript:x", icon: "rocket", value: 12, progress: 2 }] })!.items[0];
    expect(bad).toEqual({ id: "1", title: "a" });
  });

  test("dates: a day, or a day and a time, that exist", () => {
    expect(parseCardDate("2026-11-26")).toEqual({ year: 2026, month: 11, day: 26 });
    expect(parseCardDate("2026-11-26T08:05")).toEqual({ year: 2026, month: 11, day: 26, time: "08:05" });
    for (const bad of ["2026-02-30", "2026-11-26T24:00", "2026-11-26 08:00", "26-11-2026", "2026-11-26T08:00Z", 20261126]) expect(parseCardDate(bad)).toBeUndefined();
  });

  test("state answers decode like items; a bad row is skipped", () => {
    expect(decodeItemStates([{ id: 72, status: "removed" }, { id: "73", status: "gone" }, { status: "done" }, { id: "74", status: "active", title: "新", changed: true, when: "明天", version: 3 }])).toEqual([{ id: "72", status: "removed" }, { id: "74", status: "active", title: "新", version: 3, changed: true, when: "明天" }]);
    expect(stateItems({ ok: false, items: [{ id: "1", status: "done" }] })).toEqual([]);
    expect(stateItems({ ok: true, items: [{ id: "1", status: "done" }] })).toEqual([{ id: "1", status: "done" }]);
  });
});

describe("styles", () => {
  const list = (style: unknown, items: object[], kind = "list"): Card => decodeCard({ v: 1, kind, style, items: items.map((x, i) => ({ id: String(i), title: `t${i}`, ...x })) })!;

  test("an unknown or missing style is rows", () => {
    expect(cardStyle(list(undefined, [{}]))).toBe("rows");
    expect(cardStyle(list("mosaic", [{}]))).toBe("rows");
    expect(cardStyle(list("compact", [{}]))).toBe("compact");
  });

  test("a style whose field is missing on any item falls back to rows", () => {
    expect(cardStyle(list("gallery", [{ image: "https://x/1.png" }, { image: "https://x/2.png" }]))).toBe("gallery");
    expect(cardStyle(list("gallery", [{ image: "https://x/1.png" }, {}]))).toBe("rows");
    expect(cardStyle(list("agenda", [{ date: "2026-11-26" }, { date: "2026-11-27T09:30" }]))).toBe("agenda");
    expect(cardStyle(list("agenda", [{ date: "2026-11-26" }, { date: "tomorrow" }]))).toBe("rows");
    expect(cardStyle(list("stat", [{ value: "12" }, { value: "85%" }]))).toBe("stat");
    expect(cardStyle(list("stat", [{ value: "12" }, {}]))).toBe("rows");
  });

  test("stat is for list and value cards; a receipt naming it is rows", () => {
    expect(cardStyle(list("stat", [{ value: "1" }], "receipt"))).toBe("rows");
    expect(cardStyle(list("stat", [{ value: "1" }], "list"))).toBe("stat");
  });

  test("compact and stat have only the header's Undo", () => {
    expect(["rows", "compact", "gallery", "agenda", "stat"].filter((s) => rowUndoStyle(s as never))).toEqual(["rows", "gallery", "agenda"]);
  });
});

describe("acting", () => {
  test("only the latest reply's card with a token and an undo can act, until ai-space refuses it", () => {
    const live = shown(receipt, "tok");
    expect(canUndo(live, true)).toBe(true);
    expect(canUndo(live, false)).toBe(false);
    expect(canUndo(shown(receipt), true)).toBe(false);
    expect(canUndo(shown({ ...receipt, actions: undefined }, "tok"), true)).toBe(false);
    live.readOnly = true;
    expect(canUndo(live, true)).toBe(false);
  });

  test("an undone or changed item is not undoable; the header takes the rest", () => {
    const s = shown(receipt, "tok");
    expect(openIds(s, true)).toEqual(["72", "73", "74"]);
    mergeStates(s, [{ id: "73", status: "removed" }]);
    mergeStates(s, [{ id: "74", status: "active", changed: true }]);
    expect(undoable(s, true, "72")).toBe(true);
    expect(undoable(s, true, "73")).toBe(false);
    expect(openIds(s, true)).toEqual(["72"]);
    expect(openIds(s, false)).toEqual([]);
  });

  test("the header's words are the web's, in both languages", () => {
    for (const lang of ["en", "zh"] as const) {
      const t = (key: string, vars?: Record<string, string | number>) => (MESSAGES[lang][key as keyof (typeof MESSAGES)["en"]] as string).replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));
      for (const [total, open] of [[1, 1], [3, 3], [3, 2], [2, 1]] as const) expect(undoLabel(t, total, open)).toBe(webUndoLabel(t as never, total, open));
    }
    const en = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;
    expect(undoLabel(en, 1, 1)).toBe("chat.card.undo");
    expect(undoLabel(en, 3, 3)).toBe("chat.card.undoAll");
    expect(undoLabel(en, 3, 2)).toBe('chat.card.undoRest{"n":2}');
  });

  test("every word a card shows is in the web's tables", () => {
    for (const key of ["chat.card.undo", "chat.card.undoAll", "chat.card.undoRest", "chat.card.undoItem", "chat.card.undone", "chat.card.done", "chat.card.changed", "chat.card.readOnly"]) {
      expect(MESSAGES.en[key as keyof (typeof MESSAGES)["en"]]).toBeTruthy();
      expect(MESSAGES.zh[key as keyof (typeof MESSAGES)["en"]]).toBeTruthy();
    }
  });

  test("the routes and bodies of the contract, here and on a peer", () => {
    expect(cardsBase("/api/agents/todo/planner")).toBe("/api/agents/cards");
    expect(cardsBase("/api/peers/mac/agents/todo/planner")).toBe("/api/peers/mac/agents/cards");
    expect(cardsBase("/api/peers/a%2Fb/agents/x/y")).toBe("/api/peers/a%2Fb/agents/cards");
    expect(stateBody("todo/planner", shown(receipt))).toEqual({ agent: "todo/planner", card: receipt });
    expect(actionBody("tok", 2, ["72", "74"])).toEqual({ token: "tok", card: 2, action: "undo", items: ["72", "74"] });
  });

  test("an action's answer: read-only on 409 readOnly, the error text or the status, else the items", () => {
    expect(actionOutcome(409, JSON.stringify({ ok: false, error: "x", readOnly: true }))).toEqual({ kind: "readOnly" });
    expect(actionOutcome(502, JSON.stringify({ ok: false, error: "app down" }))).toEqual({ kind: "error", note: "app down" });
    expect(actionOutcome(502, "<html>")).toEqual({ kind: "error", note: "HTTP 502" });
    expect(actionOutcome(200, JSON.stringify({ ok: false }))).toEqual({ kind: "error", note: "HTTP 200" });
    expect(actionOutcome(200, JSON.stringify({ ok: true, items: [{ id: "72", status: "removed" }] }))).toEqual({ kind: "ok", items: [{ id: "72", status: "removed" }] });
  });
});

describe("items as drawn", () => {
  const item = decodeCard({ v: 1, kind: "list", items: [{ id: "72", title: "开会", detail: "后天 · 高", url: "https://x/72", when: "后天 08:00", tags: [{ text: "高" }], image: "https://x/72.png", icon: "flag", progress: 0.3 }] })!.items[0]!;

  test("the app's answer replaces what was printed; an undone item keeps its title, id and picture only", () => {
    expect(shownItem(item, undefined)).toMatchObject({ title: "开会", detail: ["后天", "高"], url: "https://x/72", status: "active", changed: false, when: "后天 08:00" });
    expect(shownItem(item, { id: "72", status: "active", title: "开会（改到 B）", detail: "后天 09:30", when: "后天 09:30", changed: true })).toMatchObject({ title: "开会（改到 B）", detail: ["后天 09:30"], when: "后天 09:30", changed: true });
    const gone = shownItem(item, { id: "72", status: "removed", title: "ignored" });
    expect(gone).toMatchObject({ title: "开会", detail: [], status: "removed", image: "https://x/72.png" });
    expect(gone.url).toBeUndefined();
    expect(gone.when).toBeUndefined();
    expect(gone.tags).toBeUndefined();
    expect(gone.progress).toBeUndefined();
  });

  test("pills and what leads a row", () => {
    expect(pillOf({ status: "removed", changed: true })).toBe("undone");
    expect(pillOf({ status: "active", changed: true })).toBe("changed");
    expect(pillOf({ status: "done", changed: false })).toBe("done");
    expect(pillOf({ status: "active", changed: false })).toBeUndefined();
    expect(leadOf({ image: "https://x", icon: "flag", status: "done" }, "rows")).toBe("image");
    expect(leadOf({ image: "https://x", icon: "flag", status: "active" }, "agenda")).toBe("icon");
    expect(leadOf({ icon: "flag", status: "done" }, "rows")).toBe("mark");
    expect(leadOf({ status: "active" }, "rows")).toBe("mark");
  });

  test("compact's value and gallery's line fall back in the spec's order", () => {
    const base = { id: "1", title: "t", detail: ["a", "b"], status: "active" as const, changed: false };
    expect(compactValue({ ...base, value: "12", when: "w" })).toBe("12");
    expect(compactValue({ ...base, when: "w" })).toBe("w");
    expect(compactValue(base)).toBe("a");
    expect(galleryLine({ ...base, value: "12" })).toBe("a");
    expect(galleryLine({ ...base, when: "w" })).toBe("w");
  });

  test("agenda day blocks: weekday in the language, blank for the same day again, the month when it is not this month", () => {
    const today = { year: 2026, month: 11 };
    expect(agendaDays(["2026-11-26T08:00", "2026-11-26T14:30", "2026-11-27", "2026-12-01T09:00", "2027-11-02"], "zh", today)).toEqual([
      { day: "26", weekday: "周四", time: "08:00" },
      { time: "14:30" },
      { day: "27", weekday: "周五" },
      { day: "1", weekday: "周二", month: "12月", time: "09:00" },
      { day: "2", weekday: "周二", month: "11月" },
    ]);
    expect(agendaDays(["2026-12-24"], "en", today)).toEqual([{ day: "24", weekday: "Thu", month: "Dec" }]);
  });
});

describe("the card's heading", () => {
  const catalogue = decodeCatalogue({
    apps: { apps: [{ id: "todo", name: "todo", title: "Todo", i18n: { zh: { title: "待办" } }, icon: "/apps/todo/icon.svg", url: "/apps/todo/" }, { id: "mac/todo", name: "todo", peer: "mac", title: "Mac Todo", icon: "✅", url: "https://mac/todo/" }] },
    agents: { agents: [{ id: "todo/planner", app: "todo", name: "planner", title: "Planner", appIcon: "📋" }, { id: "space/assistant", app: "space", name: "assistant", title: "Assistant" }] },
    widgets: { widgets: [] },
  });

  test("the agent's app icon over its app's, and its app's name on the same machine", () => {
    expect(catalogue.agentInfo[0]!.appIcon).toBe("📋");
    expect(cardApp(catalogue, catalogue.agentInfo[0]!, "zh")).toEqual({ icon: "📋", name: "待办" });
    expect(cardApp(catalogue, { app: "todo" }, "en")).toEqual({ icon: "/apps/todo/icon.svg", name: "Todo" });
    expect(cardApp(catalogue, { app: "todo", peer: "mac" }, "en")).toEqual({ icon: "✅", name: "Mac Todo" });
    expect(cardApp(catalogue, catalogue.agentInfo[1]!, "en")).toEqual({});
  });
});

describe("v2 resolutions (ai-space #223)", () => {
  test("an undone item keeps its title, picture and value; the answer's own fields still lay over the card's", () => {
    const item = decodeCard({ v: 1, kind: "list", items: [{ id: "1", title: "t", value: "12", image: "https://x/a.png", when: "w", tags: [{ text: "x" }], progress: 1, url: "https://x/1", detail: "d" }] })!.items[0]!;
    const gone = shownItem(item, { id: "1", status: "removed", image: "https://x/b.png" });
    expect(gone).toEqual({ id: "1", title: "t", value: "12", image: "https://x/b.png", detail: [], status: "removed", changed: false });
  });
});
