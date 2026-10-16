import { expect, test } from "bun:test";
import { CalcError, evaluate, format, isExpression } from "./calc.ts";

test("arithmetic follows precedence, associativity and the documented symbols", () => {
  expect(evaluate("128 * 3 + 56")).toBe(440);
  expect(evaluate("2 ^ 3 ^ 2")).toBe(512);
  expect(evaluate("2 ** 10")).toBe(1024);
  expect(evaluate("-2 ^ 2")).toBe(-4);
  expect(evaluate("2 ^ -1")).toBe(0.5);
  expect(evaluate("(1 + 2) × 3 ÷ 4")).toBe(2.25);
  expect(evaluate("50% * 80")).toBe(40);
  expect(evaluate("1,234.5 + 0.5")).toBe(1235);
  expect(evaluate("（１＋２）＊３")).toBe(9);
  expect(evaluate("0.1 + 0.2")).toBe(0.3);
  expect(evaluate("10 - 2 - 3")).toBe(5);
  expect(evaluate("7 =")).toBe(7);
});

test("errors are named, never evaluated as code", () => {
  for (const bad of ["", "1 / 0", "2 +", "(1 + 2", "alert(1)", "1 2", "Math.PI", "10 ^ 400"]) expect(() => evaluate(bad)).toThrow(CalcError);
  expect(() => evaluate("1".repeat(201))).toThrow(/longer than/);
});

test("only text with an operator counts as an expression for the command box", () => {
  expect(isExpression("128 * 3 + 56")).toBe(true);
  expect(isExpression("(5)")).toBe(true);
  expect(isExpression("2026")).toBe(false);
  expect(isExpression("-5")).toBe(false);
  expect(isExpression("news")).toBe(false);
  expect(isExpression("100 USD to CNY")).toBe(false);
  expect(isExpression("1 +")).toBe(false);
});

test("values print without grouping and with at most ten decimals", () => {
  expect(format(440)).toBe("440");
  expect(format(1 / 3)).toBe("0.3333333333");
  expect(format(1234567.5)).toBe("1234567.5");
  expect(format(1e22)).toBe("1e+22");
});
