import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "../space/agents/cards.ts";
import { ChatCards } from "./ChatCards.tsx";

const card: Card = { v: 1, kind: "receipt", title: "Added 2 todos", items: [{ id: "128", title: "Write the report", detail: "tomorrow", url: "https://todo.example.com/?todo=128", version: 1 }, { id: "129", title: "Call Ann", version: 1 }], state: "card-state", actions: { undo: "card-undo" } };
const render = (token: string | undefined, actionable: boolean) => renderToStaticMarkup(<ChatCards cards={[{ card, index: 0, ...(token ? { token } : {}) }]} apiBase="/api" agent="ai-todo/planner" actionable={actionable} />);

test("a live card on the latest reply offers undo for each item and for all", () => {
  const html = render("t", true);
  expect(html).toContain("Added 2 todos");
  expect(html).toContain('href="https://todo.example.com/?todo=128"');
  expect(html).toContain("#129");
  expect(html.match(/class="sc-link"/g)).toHaveLength(2);
  expect(html).toContain("Undo all 2");
});

test("a restored card, or one under an older reply, is read-only", () => {
  expect(render(undefined, true)).not.toContain("Undo");
  expect(render("t", false)).not.toContain("Undo");
});
