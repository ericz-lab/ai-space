// The Windows client's words: every English string the interface passes to L.T or L.F has its
// Chinese in Strings.zh.cs, with the same placeholders, and the table keeps no string nobody uses.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const APP = join(import.meta.dir, "AISpace");
// A C# regular string literal, escapes kept as written: both sides are compared as source text.
const LITERAL = String.raw`"((?:[^"\\\n]|\\.)*)"`;

async function used(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const file of new Glob("**/*.cs").scan(APP)) {
    if (file.startsWith("bin/") || file.startsWith("obj/") || file === "Strings.zh.cs") continue;
    const text = await Bun.file(join(APP, file)).text();
    for (const m of text.matchAll(new RegExp(String.raw`\bL\.[TF]\(\s*` + LITERAL, "g"))) out.set(m[1]!, file);
  }
  return out;
}

async function table(): Promise<Map<string, string>> {
  const text = await Bun.file(join(APP, "Strings.zh.cs")).text();
  const out = new Map<string, string>();
  for (const m of text.matchAll(new RegExp(String.raw`\[` + LITERAL + String.raw`\] = ` + LITERAL, "g"))) {
    expect({ duplicate: out.has(m[1]!) ? m[1] : null }).toEqual({ duplicate: null });
    out.set(m[1]!, m[2]!);
  }
  return out;
}

const placeholders = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();

describe("the Windows client's strings", () => {
  test("each has its Chinese", async () => {
    const [u, zh] = [await used(), await table()];
    expect(u.size).toBeGreaterThan(50);
    expect([...u].filter(([s]) => !zh.has(s)).map(([s, file]) => `${file}: ${s}`)).toEqual([]);
  });

  test("the table holds only strings in use", async () => {
    const [u, zh] = [await used(), await table()];
    expect([...zh.keys()].filter((s) => !u.has(s))).toEqual([]);
  });

  test("a translation keeps the placeholders", async () => {
    const zh = await table();
    expect([...zh].filter(([en, cn]) => placeholders(en).join() !== placeholders(cn).join()).map(([en]) => en)).toEqual([]);
  });
});
