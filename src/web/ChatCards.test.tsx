import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../space/agents/cards.ts";
import { cardApp, ChatCards, undoLabel, type CardApp } from "./ChatCards.tsx";
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
