import { describe, expect, test } from "bun:test";
import { buildWidget } from "./build.ts";
import { renderMd } from "./md.ts";
import { readSse } from "./sse.ts";

describe("chat widget", () => {
  test("bundles to one browser script that defines SpaceChat and carries the stylesheet", async () => {
    const w = await buildWidget()();
    expect(w.js).toContain("SpaceChat");
    expect(w.js).toContain("--sc-accent");
    expect(w.js).not.toContain("process.env");
    expect(w.css).toContain(":host");
    expect(w.etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("markdown escapes first and renders the usual blocks", () => {
    expect(renderMd("# T\n\n- a <b>\n\n`x`")).toBe("<h2>T</h2><ul><li>a &lt;b&gt;</li></ul><p><code>x</code></p>");
    expect(renderMd("![p](/x/1.png)")).toContain('<img src="/x/1.png"');
    expect(renderMd("![p](javascript:alert(1))")).not.toContain("<img");
  });

  test("readSse splits events across chunks and skips comments", async () => {
    const chunks = ["event: delta\ndata: {\"text\":\"he", "llo\"}\n\n: keepalive\n\nevent: done\ndata: {\"ok\":true}\n\n"];
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
    const out: unknown[] = [];
    for await (const ev of readSse(body)) out.push(ev);
    expect(out).toEqual([{ event: "delta", data: '{"text":"hello"}' }, { event: "done", data: '{"ok":true}' }]);
  });
});
