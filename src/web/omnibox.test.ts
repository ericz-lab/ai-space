import { describe, expect, test } from "bun:test";
import { opensByDefault, rank, score, SCORE } from "./omnibox.ts";

const notes = { names: ["AI Notes", "AI 笔记", "ai-notes"], text: "AI Notes Write and search notes AI 笔记 ai-notes" };
const todo = { names: ["Todo", "待办", "ai-todo"], text: "Todo Plan the day; notes on tasks 待办 ai-todo" };
const draw = { names: ["Draw", "画板", "ai-draw"], text: "Draw Sketch ideas 画板 ai-draw" };

describe("omnibox ranking", () => {
  test("a name that equals, starts with, has a word starting with, or holds the query scores in that order", () => {
    expect(score("todo", todo)).toBe(SCORE.exact);
    expect(score("待", todo)).toBe(SCORE.prefix);
    expect(score("notes", notes)).toBe(SCORE.word);
    expect(score("记", notes)).toBe(SCORE.inside);
    expect(score("tasks", todo)).toBe(SCORE.text);
    expect(score("paint", draw)).toBe(0);
    expect(score("  ", draw)).toBe(0);
  });

  test("best names first, the given order between equals, at most `limit`", () => {
    expect(rank("notes", [todo, notes])).toEqual([notes, todo]);
    expect(rank("ai", [todo, notes, draw])).toEqual([todo, notes, draw]);
    expect(rank("ai", [todo, notes, draw], 2)).toEqual([todo, notes]);
  });

  test("Enter opens a name the operator typed and asks the assistant otherwise", () => {
    expect(opensByDefault("笔记", notes)).toBe(true);
    expect(opensByDefault("tasks", todo)).toBe(false);
    expect(opensByDefault("帮我记一下明天下午三点开会", undefined)).toBe(false);
  });
});
