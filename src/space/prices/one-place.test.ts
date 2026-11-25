import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

/**
 * Prices live in one place (docs/prices.md): the data files under src/space/prices/tables and the
 * module beside them. This fails when a price table reappears anywhere else in the server: a JSON
 * price file imported from outside the module, a `PRICES` constant, or a row of four figures
 * (input, cache write, cache read, output) written as a literal.
 */
const ROOT = join(import.meta.dir, "..", "..", "..");

test("no price table outside src/space/prices", async () => {
  const found: string[] = [];
  for await (const file of new Glob("src/**/*.{ts,tsx}").scan(ROOT)) {
    if (file.startsWith("src/space/prices/") || /\.test\.tsx?$/.test(file) || file.includes("/fixtures/") || file.startsWith("src/web/")) continue;
    const text = await Bun.file(join(ROOT, file)).text();
    text.split("\n").forEach((line, i) => {
      const at = `${file}:${i + 1}: ${line.trim().slice(0, 120)}`;
      if (/from\s+["'][^"']*price[^"']*\.json["']/i.test(line)) found.push(at);
      if (/\b(const|let)\s+[A-Z_]*PRICES?\b\s*[:=]/.test(line)) found.push(at);
      if (/\[\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*,\s*\d+(\.\d+)?\s*\]/.test(line) && /price|cost|usd|\$/i.test(text.slice(Math.max(0, text.indexOf(line) - 400), text.indexOf(line)))) found.push(at);
      if (/per\s*million|perMillion|\/\s*1e6\b|\/\s*1_000_000\b/i.test(line) && /\b\d+\.\d+\b/.test(line) && !/Math\.round/.test(line)) found.push(at);
    });
  }
  expect(found).toEqual([]);
});
