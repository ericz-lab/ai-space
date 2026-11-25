import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../space/agents/cards.ts";
import { agendaDate, cardApp, ChatCards, drawnStyle, itemView, undoLabel, type CardApp } from "./ChatCards.tsx";
import { LangContext } from "./i18n.ts";
import { translate } from "./messages.ts";

const card: Card = { v: 1, kind: "receipt", title: "Added 2 todos", items: [{ id: "128", title: "Write the report", detail: "tomorrow 15:00 · high", url: "https://todo.example.com/?todo=128", version: 1 }, { id: "129", title: "Call Ann", version: 1 }], state: "card-state", actions: { undo: "card-undo" } };
const todo: CardApp = { icon: "/api/apps/ai-todo/icon", name: "Todo" };
const render = (token: string | undefined, actionable: boolean, c: Card = card, app: CardApp | undefined = todo) => renderToStaticMarkup(<ChatCards cards={[{ card: c, index: 0, ...(token ? { token } : {}) }]} apiBase="/api" agent="ai-todo/planner" actionable={actionable} app={app} />);

test("a live card on the latest reply is headed by its app and offers undo for each item and for all", () => {
  const html = render("t", true);
  expect(html).toContain('<img src="/api/apps/ai-todo/icon"');
  expect(html).toContain(">Todo</b>");
  expect(html).toContain("Added 2 todos");
  expect(html).toContain('href="https://todo.example.com/?todo=128"');
  expect(html).toContain("#129");
  expect(html.match(/class="chat-card-row-undo"/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Undo: Write the report"');
  expect(html).toContain("Undo all</button>");
});

test("an item's detail shows as separate segments before its id", () => {
  expect(render("t", true)).toContain('<span class="chat-card-meta"><span>tomorrow 15:00</span><span>high</span><span class="chat-card-id">#128</span></span>');
});

test("a single-item card has only the header's Undo", () => {
  const html = render("t", true, { ...card, items: [card.items[0]!] });
  expect(html).toContain("Undo</button>");
  expect(html).not.toContain("chat-card-row-undo");
});

test("a restored card, or one under an older reply, is read-only: whole rows open the item", () => {
  for (const html of [render(undefined, true), render("t", false)]) {
    expect(html).not.toContain("Undo");
    expect(html).toContain('<a class="chat-card-row active" href="https://todo.example.com/?todo=128"');
    expect(html.match(/class="chat-card-chevron"/g)).toHaveLength(1);
  }
});

test("without the app's data the card keeps its title, and value cards draw the value", () => {
  const html = render("t", true, card, {});
  expect(html).not.toContain("chat-card-app");
  expect(html).toContain("Added 2 todos");
  expect(render(undefined, true, { v: 1, kind: "value", title: "Total", items: [], text: "42" })).toContain('<div class="chat-card-value">42</div>');
});

test("the header button names one item, all, or the rest", () => {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) => translate("en", key, vars);
  expect(undoLabel(t, 1, 1)).toBe("Undo");
  expect(undoLabel(t, 3, 3)).toBe("Undo all");
  expect(undoLabel(t, 3, 2)).toBe("Undo the other 2");
  expect(undoLabel((key, vars) => translate("zh", key, vars), 3, 2)).toBe("撤回其余 2 条");
});

test("the app comes from the agent's icon and the app list on the same machine", () => {
  const apps = [{ name: "ai-todo", title: "Todo", i18n: { zh: { title: "待办" } }, icon: "/a.png" }, { name: "ai-todo", peer: "david", title: "Todo (david)", icon: "/b.png" }];
  expect(cardApp({ app: "ai-todo", appIcon: "/pack.png" }, apps, "zh")).toEqual({ icon: "/pack.png", name: "待办" });
  expect(cardApp({ app: "ai-todo", peer: "david", appIcon: "" }, apps, "en")).toEqual({ icon: "/b.png", name: "Todo (david)" });
  expect(cardApp({ app: "ai-todo", peer: "eric", appIcon: "📝" }, apps, "en")).toEqual({ icon: "📝" });
});

// v2: built-in styles (docs/chat-cards.md#styles).
const list = (style: Card["style"], items: Card["items"], kind: Card["kind"] = "list"): Card => ({ v: 1, kind, style, title: "T", items, ...(kind === "value" ? { text: "42" } : {}) });
const renderIn = (c: Card, lang: "en" | "zh" = "en", token?: string) => renderToStaticMarkup(<LangContext.Provider value={lang}><ChatCards cards={[{ card: c, index: 0, ...(token ? { token } : {}) }]} apiBase="/api" agent="ai-todo/planner" actionable={true} app={todo} /></LangContext.Provider>);

test("rows: when with its calendar glyph, detail, tags, id in that order; icon in place of the circle; image thumbnail; progress bar", () => {
  const html = renderIn(list("rows", [
    { id: "1", title: "A", when: "Thu 08:00", detail: "work · Q4", tags: [{ text: "high", tone: "negative" }, { text: "x" }], icon: "bell", progress: 0.25 },
    { id: "2", title: "B", image: "https://x.example/a.png", icon: "bell" },
  ]));
  expect(html).toContain('class="chat-card list rows"');
  const meta = html.slice(html.indexOf('class="chat-card-meta"'));
  const order = ['class="chat-card-when"', ">Thu 08:00<", "<span>work</span><span>Q4</span>", 'class="chat-card-tag negative">high<', 'class="chat-card-tag neutral">x<', "#1"].map((s) => meta.indexOf(s));
  expect(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]!))).toBe(true);
  expect(html).toContain('class="chat-card-icon"');
  expect(html).toContain('aria-valuenow="25"');
  expect(html).toContain('style="width:25%"');
  expect(html).toContain('<span class="chat-card-pic thumb">');
  expect(html).toContain('src="https://x.example/a.png"');
  // The image takes the circle's place: one icon (item 1's), one circle-free row.
  expect(html.match(/class="chat-card-icon"/g)).toHaveLength(1);
  expect(html).not.toContain("chat-card-mark");
});

test("compact: one line per item with the value, else when, else the first detail segment; no per-item undo", () => {
  const html = renderIn({ ...list("compact", [{ id: "1", title: "A", value: "12", when: "Fri", url: "https://x.example/1" }, { id: "2", title: "B", when: "Fri", detail: "d1 · d2" }, { id: "3", title: "C", detail: "d1 · d2" }, { id: "4", title: "D" }], "receipt"), actions: { undo: "card-undo" } }, "en", "t");
  expect(html.match(/class="chat-card-line /g)).toHaveLength(4);
  expect(html).toContain('<a class="chat-card-line active" href="https://x.example/1"');
  expect(html.match(/class="chat-card-line-value">[^<]*</g)).toEqual(['class="chat-card-line-value">12<', 'class="chat-card-line-value">Fri<', 'class="chat-card-line-value">d1<']);
  expect(html).not.toContain("chat-card-row-undo");
  expect(html).toContain("Undo all</button>");
});

test("gallery: tiles with the picture, title and when or first detail; an undo on each tile while it can act", () => {
  const items = [{ id: "1", title: "A", image: "https://x.example/1.png", when: "now", url: "https://x.example/1", version: 1 }, { id: "2", title: "B", image: "https://x.example/2.png", detail: "png · 1MB", version: 1 }];
  const html = renderIn({ ...list("gallery", items, "receipt"), actions: { undo: "card-undo" } }, "en", "t");
  expect(html).toContain('class="chat-card-gallery"');
  expect(html.match(/class="chat-card-tile /g)).toHaveLength(2);
  expect(html).toContain('<a class="chat-card-tile-hit" href="https://x.example/1"');
  expect(html).toContain('<span class="chat-card-tile-sub">now</span>');
  expect(html).toContain('<span class="chat-card-tile-sub">png</span>');
  expect(html.match(/class="chat-card-tile-undo"/g)).toHaveLength(2);
  // The placeholder glyph is always under the picture, so a picture that fails or has not loaded shows it.
  expect(html.match(/class="chat-card-pic-ph"/g)).toHaveLength(2);
  expect(renderIn(list("gallery", items))).not.toContain("chat-card-tile-undo");
});

test("agenda: a date block on the first item of each day, weekday and month words in the page language, the time not the when", () => {
  const items = [{ id: "1", title: "A", date: "2031-12-04T08:05", when: "Thu", detail: "Zoom" }, { id: "2", title: "B", date: "2031-12-04" }, { id: "3", title: "C", date: "2031-12-06", icon: "flag" as const }];
  const en = renderIn(list("agenda", items));
  expect(en.match(/<b>\d+<\/b>/g)).toEqual(["<b>4</b>", "<b>6</b>"]);
  expect(en).toContain("<small>Thu</small><small>Dec</small>");
  expect(en).toContain('<span class="chat-card-time">08:05</span><span>Zoom</span>');
  expect(en).not.toContain("chat-card-when");
  expect(en).toContain('class="chat-card-icon"');
  expect(renderIn(list("agenda", items), "zh")).toContain("<small>周四</small><small>12月</small>");
});

test("agendaDate: the month shows only off this month of this year", () => {
  const today = new Date(2026, 10, 24);
  expect(agendaDate("2026-11-26T09:00", "en", today)).toEqual({ key: "2026-11-26", day: 26, weekday: "Thu", time: "09:00" });
  expect(agendaDate("2026-12-02", "zh", today)).toEqual({ key: "2026-12-02", day: 2, weekday: "周三", month: "12月" });
  expect(agendaDate("2027-11-02", "en", today).month).toBe("Nov");
});

test("stat: a cell per item with its value, title and first tag only; no marks", () => {
  const html = renderIn(list("stat", [{ id: "1", title: "Done", value: "12", tags: [{ text: "+4", tone: "positive" }, { text: "y" }], url: "https://x.example/1" }, { id: "2", title: "Spent", value: "¥3,200" }]));
  expect(html).toContain('<a class="chat-card-stat active" href="https://x.example/1"');
  expect(html).toContain('<span class="chat-card-stat-value">12</span><span class="chat-card-stat-label"><span class="chat-card-stat-name">Done</span><span class="chat-card-tag positive">+4</span></span>');
  expect(html).not.toContain(">y<");
  expect(html).not.toContain("chat-card-mark");
  const value = renderIn(list("stat", [{ id: "1", title: "Food", value: "3" }], "value"));
  expect(value).toContain('<div class="chat-card-value">42</div>');
  expect(value).toContain('class="chat-card-stats"');
});

test("a style whose field is missing on any item, a stat receipt, or no style at all draws rows", () => {
  expect(drawnStyle(list("gallery", [{ id: "1", title: "A", image: "https://x/1.png" }, { id: "2", title: "B" }]))).toBe("rows");
  expect(drawnStyle(list("agenda", [{ id: "1", title: "A", date: "2026-11-26" }, { id: "2", title: "B" }]))).toBe("rows");
  expect(drawnStyle(list("stat", [{ id: "1", title: "A", value: "1" }, { id: "2", title: "B" }]))).toBe("rows");
  expect(drawnStyle(list("stat", [{ id: "1", title: "A", value: "1" }], "receipt"))).toBe("rows");
  expect(drawnStyle(list(undefined, [{ id: "1", title: "A" }]))).toBe("rows");
  expect(drawnStyle(list("compact", [{ id: "1", title: "A" }]))).toBe("compact");
  expect(drawnStyle(list("stat", [{ id: "1", title: "A", value: "1" }], "value"))).toBe("stat");
  const html = renderIn(list("gallery", [{ id: "1", title: "A", image: "https://x/1.png" }, { id: "2", title: "B" }]));
  expect(html).not.toContain("chat-card-gallery");
  expect(html.match(/class="chat-card-row /g)).toHaveLength(2);
});

test("a state answer overrides the fields; a removed item keeps its title, image and value only", () => {
  const item = { id: "1", title: "A", detail: "d", url: "https://x/1", when: "Fri", tags: [{ text: "t" }], image: "https://x/1.png", value: "3", progress: 0.5 };
  expect(itemView(item, { id: "1", status: "done", when: "Sat", progress: 1, value: "4" })).toMatchObject({ state: "done", when: "Sat", progress: 1, value: "4", detail: "d", url: "https://x/1" });
  const gone = itemView(item, { id: "1", status: "removed" });
  expect(gone).toEqual({ id: "1", title: "A", image: "https://x/1.png", value: "3", state: "removed", changed: false });
});
