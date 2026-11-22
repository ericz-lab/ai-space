// The Windows client's words: every English string the interface passes to L.T or L.F has its
// Chinese in one of the tables (Strings.zh.cs and Strings.zh.<Area>.cs, one per area so their
// owners never edit the same file), with the same placeholders; no string is in two tables, and
// the tables keep no string nobody uses.
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const APP = join(import.meta.dir, "AISpace");
// A C# regular string literal, escapes kept as written: both sides are compared as source text.
const LITERAL = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const isTable = (file: string) => /^Strings\.zh(\.[A-Za-z]+)?\.cs$/.test(file);

async function used(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for await (const file of new Glob("**/*.cs").scan(APP)) {
    if (file.startsWith("bin/") || file.startsWith("obj/") || file.startsWith("bin\\") || file.startsWith("obj\\") || isTable(file)) continue;
    const text = await Bun.file(join(APP, file)).text();
    for (const m of text.matchAll(new RegExp(String.raw`\bL\.[TF]\(\s*` + LITERAL, "g"))) out.set(m[1]!, file);
  }
  return out;
}

async function tables(): Promise<{ table: Map<string, string>; files: string[]; duplicates: string[] }> {
  const table = new Map<string, string>();
  const where = new Map<string, string>();
  const duplicates: string[] = [];
  const files = [...new Glob("Strings.zh*.cs").scanSync(APP)].filter(isTable).sort();
  for (const file of files) {
    const text = await Bun.file(join(APP, file)).text();
    for (const m of text.matchAll(new RegExp(String.raw`\[` + LITERAL + String.raw`\] = ` + LITERAL, "g"))) {
      if (where.has(m[1]!)) duplicates.push(`${m[1]} (${where.get(m[1]!)}, ${file})`);
      where.set(m[1]!, file);
      table.set(m[1]!, m[2]!);
    }
  }
  return { table, files, duplicates };
}

const placeholders = (s: string) => [...new Set(s.match(/\{\d+\}/g) ?? [])].sort();

describe("the Windows client's strings", () => {
  test("the tables are the shell's and the areas'", async () => {
    const { files } = await tables();
    expect(files).toEqual(["Strings.zh.Home.cs", "Strings.zh.Inbox.cs", "Strings.zh.SpaceSettings.cs", "Strings.zh.cs"]);
    // Every table is merged at startup (Strings.cs).
    const merge = await Bun.file(join(APP, "Strings.cs")).text();
    for (const f of files) expect(merge).toContain(`Zh${f.split(".")[2] === "cs" ? "Core" : f.split(".")[2]}`);
  });

  test("no string is in two tables", async () => {
    expect((await tables()).duplicates).toEqual([]);
  });

  test("each has its Chinese", async () => {
    const [u, { table: zh }] = [await used(), await tables()];
    expect(u.size).toBeGreaterThan(50);
    expect([...u].filter(([s]) => !zh.has(s)).map(([s, file]) => `${file}: ${s}`)).toEqual([]);
  });

  test("the tables hold only strings in use", async () => {
    const [u, { table: zh }] = [await used(), await tables()];
    expect([...zh.keys()].filter((s) => !u.has(s))).toEqual([]);
  });

  test("a translation keeps the placeholders", async () => {
    const { table: zh } = await tables();
    expect([...zh].filter(([en, cn]) => placeholders(en).join() !== placeholders(cn).join()).map(([en]) => en)).toEqual([]);
  });
});
