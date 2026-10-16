/**
 * The calculator (docs/shortcuts.md#built-ins): a small recursive-descent parser over a fixed
 * grammar, never `eval`. Shared by the server (the `space/calc` action) and the page (the command
 * box shows the value while the operator types), so both read an expression the same way.
 *
 *   expr   := term (("+" | "-") term)*
 *   term   := unary (("*" | "/" | "×" | "÷") unary)*
 *   unary  := ("+" | "-") unary | power     so -2^2 is -4
 *   power  := postfix ("^" unary)?         right-associative; "**" is "^"
 *   postfix:= atom "%"*                    50% is 0.5
 *   atom   := number | "(" expr ")"        full-width parentheses and digits are accepted
 *   number := digits ("." digits)? | "." digits, with optional "," thousands separators (1,234.5)
 *
 * The value is rounded to 12 significant digits, so 0.1 + 0.2 is 0.3. Results that are not finite
 * (1/0, an overflow) are errors, not Infinity.
 */

export const MAX_EXPRESSION = 200;

export class CalcError extends Error {}

/** The value of `text`, or a CalcError naming what is wrong. */
export function evaluate(text: string): number {
  const src = normalize(text);
  if (!src) throw new CalcError("empty expression");
  if (src.length > MAX_EXPRESSION) throw new CalcError(`expression longer than ${MAX_EXPRESSION} characters`);
  const p = new Parser(src);
  const v = p.expr();
  p.end();
  if (!Number.isFinite(v)) throw new CalcError("the result is not a finite number");
  return round(v);
}

/**
 * True when `text` reads as arithmetic worth showing a result for: it parses and has at least one
 * operator, so a bare number ("2026") or a word is left to the other rows.
 */
export function isExpression(text: string): boolean {
  const src = normalize(text);
  if (!src || src.length > MAX_EXPRESSION || !/\d/.test(src) || !/[-+*/^%×÷(]/.test(src.replace(/^[-+]/, ""))) return false;
  try {
    evaluate(src);
    return true;
  } catch {
    return false;
  }
}

/** A value as the result card shows it: up to 10 decimals, no exponent below 1e21, no thousands separators. */
export function format(v: number): string {
  if (Math.abs(v) >= 1e21 || (v !== 0 && Math.abs(v) < 1e-10)) return String(v);
  return v.toLocaleString("en-US", { maximumFractionDigits: 10, useGrouping: false });
}

function round(v: number): number {
  if (v === 0) return 0;
  return Number(v.toPrecision(12));
}

function normalize(text: string): string {
  return text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/＋/g, "+")
    .replace(/[－−]/g, "-")
    .replace(/＊/g, "*")
    .replace(/／/g, "/")
    .replace(/％/g, "%")
    .replace(/\*\*/g, "^")
    .replace(/\s*=\s*$/, "");
}

class Parser {
  private i = 0;
  constructor(private readonly s: string) {}

  expr(): number {
    let v = this.term();
    for (;;) {
      if (this.eat("+")) v += this.term();
      else if (this.eat("-")) v -= this.term();
      else return v;
    }
  }

  private term(): number {
    let v = this.unary();
    for (;;) {
      if (this.eat("*") || this.eat("×")) v *= this.unary();
      else if (this.eat("/") || this.eat("÷")) {
        const d = this.unary();
        if (d === 0) throw new CalcError("division by zero");
        v /= d;
      } else return v;
    }
  }

  private unary(): number {
    if (this.eat("-")) return -this.unary();
    if (this.eat("+")) return this.unary();
    return this.power();
  }

  private power(): number {
    const base = this.postfix();
    if (this.eat("^")) return base ** this.unary();
    return base;
  }

  private postfix(): number {
    let v = this.atom();
    while (this.eat("%")) v /= 100;
    return v;
  }

  private atom(): number {
    this.space();
    if (this.eat("(")) {
      const v = this.expr();
      if (!this.eat(")")) throw new CalcError(`missing ")" at ${this.i + 1}`);
      return v;
    }
    const m = /^(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?/.exec(this.s.slice(this.i));
    const lit = m?.[0] ?? "";
    if (!lit || lit === ".") throw new CalcError(this.i >= this.s.length ? "the expression ends early" : `unexpected "${this.s[this.i]}" at ${this.i + 1}`);
    this.i += lit.length;
    return Number(lit.replace(/,/g, ""));
  }

  end(): void {
    this.space();
    if (this.i < this.s.length) throw new CalcError(`unexpected "${this.s[this.i]}" at ${this.i + 1}`);
  }

  private eat(c: string): boolean {
    this.space();
    if (this.s.startsWith(c, this.i)) {
      this.i += c.length;
      return true;
    }
    return false;
  }

  private space(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
}
