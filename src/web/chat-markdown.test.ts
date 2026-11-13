import { expect, test } from "bun:test";
import { mdHtml } from "./chat-markdown.ts";

test("Markdown preserves numbered and nested lists, headings and quotes", () => {
  const html = mdHtml("# Title\n\n3. First\n   - Nested\n4. Second\n\n> Quote\n\n---");
  expect(html).toContain('<h1>Title</h1>');
  expect(html).toContain('<ol start="3"><li>First<ul><li>Nested</li></ul></li><li>Second</li></ol>');
  expect(html).toContain('<blockquote>Quote</blockquote><hr>');
});
test("tables require separator rows, keep alignment and escaped pipes", () => {
  const html = mdHtml("Name | State\n:--- | ---:\nx\\|y | **ready**");
  expect(html).toContain('<td style="text-align:left">x|y</td>');
  expect(html).toContain('<td style="text-align:right"><strong>ready</strong></td>');
  expect(mdHtml("| just text | and pipes |")).not.toContain('<table>');
});
test("tables fit the reply and wrap their cells, scrolling only when the columns cannot fit", async () => {
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const rule = (selector: string) => css.split("\n").find((line) => line.startsWith(`${selector} {`)) ?? "";
  expect(mdHtml("a | b\n--- | ---\n1 | 2")).toStartWith('<div class="tblwrap"><table>');
  expect(rule(".md .tblwrap")).toContain("overflow-x: auto");
  expect(rule(".md table")).not.toContain("max-content");
  expect(rule(".md th, .md td")).toContain("overflow-wrap: break-word");
  expect(rule(".md th, .md td")).toContain("min-width:");
  expect(rule(".md :is(th, td) :is(code, a)")).toContain("overflow-wrap: anywhere");
});
test("code remains literal, incomplete fences remain visible and HTML is inert", () => {
  expect(mdHtml('`**literal** https://example.com`')).toBe('<p><code>**literal** https://example.com</code></p>');
  expect(mdHtml('```sh\n\n<script>\n**literal**')).toBe('<pre>\n&lt;script&gt;\n**literal**</pre>');
  expect(mdHtml('[bad](javascript:alert(1)) <img src=x onerror=alert(1)>')).not.toContain('<a');
  expect(mdHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  expect(mdHtml('[link](https://example.com/?q="x")')).toContain('q=&quot;x&quot;');
  expect(mdHtml('**bold** *italic*')).toContain('<strong>bold</strong> <em>italic</em>');
});
