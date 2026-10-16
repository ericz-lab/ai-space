import { expect, test } from "bun:test";
import { compilePattern, matchPattern, validatePatterns } from "./pattern.ts";

const matches = (pattern: string, text: string) => matchPattern(compilePattern(pattern), text).matches;

test("literal alternatives, optional phrases and slots match entire Chinese sentences", () => {
  const p = "[帮我][查|看看](金融新闻|财经新闻)[ {q}]";
  for (const text of ["金融新闻", "财经新闻", "帮我查金融新闻", "看看财经新闻"]) expect(matches(p, text)).toEqual([{}]);
  expect(matches(p, "帮我查金融新闻 美联储")).toEqual([{ q: "美联储" }]);
  expect(matches(p, "不要查金融新闻")).toEqual([]);
  expect(matches(p, "金融新闻是什么")).toEqual([]);
});

test("literal regex metacharacters, escaped syntax, Unicode and normalized whitespace", () => {
  expect(matches("find   {q}", " FIND  Fed News ")).toEqual([{ q: "Fed News" }]);
  expect(matches("C++ \\(news\\)", "C++ (news)")).toEqual([{}]);
  expect(matches("📰 {q}", "📰 美联储")).toEqual([{ q: "美联储" }]);
  expect(matches("news.{q}", "newsXtopic")).toEqual([]);
});

test("invalid and catch-all patterns fail before publication", () => {
  for (const p of ["", "(a|)", "[a", "a)", "a|b", "{q}", "[news]{q}", "news{q}{q}", "news{constructor}", "news{timezone}", "news{bad-name}", "a\\", "[[[[[a]]]]]", "a".repeat(257)]) {
    expect(() => compilePattern(p)).toThrow();
  }
  expect(() => validatePatterns(["news {missing}"], ["q"])).toThrow(/Unknown input/);
  expect(() => validatePatterns(Array(17).fill("news"), [])).toThrow();
  expect(validatePatterns(["news {q}", "news {q}"], ["q"])).toEqual(["news {q}"]);
});

test("ambiguous capture boundaries remain distinct and typed slots reject invalid values", () => {
  expect(matches("send {who} to {where}", "send A to B to C")).toEqual([{ who: "A", where: "B to C" }, { who: "A to B", where: "C" }]);
  const machine = compilePattern("buy {amount} shares");
  const number = (_: string, text: string) => /^\d+$/.test(text) ? Number(text) : undefined;
  expect(matchPattern(machine, "buy 12 shares", number).matches).toEqual([{ amount: 12 }]);
  expect(matchPattern(machine, "buy lots shares", number).matches).toEqual([]);
});

test("bounded matching discards partial answers when the work or input limit is exceeded", () => {
  expect(matchPattern(compilePattern("news {q}"), "x".repeat(513))).toEqual({ matches: [], limited: true });
  expect(matchPattern(compilePattern("a{one}{two}{three}{four}"), "a".repeat(100))).toEqual({ matches: [], limited: true });
});


test("a shared work budget bounds a catalogue rather than only each pattern", () => {
  const budget = { remaining: 5 };
  const machine = compilePattern("news");
  expect(matchPattern(machine, "news", undefined, budget).matches).toEqual([{}]);
  expect(matchPattern(machine, "news", undefined, budget)).toEqual({ matches: [], limited: true });
});
