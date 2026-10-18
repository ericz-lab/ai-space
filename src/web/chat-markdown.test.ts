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
test("code remains literal, incomplete fences remain visible and HTML is inert", () => {
  expect(mdHtml('`**literal** https://example.com`')).toBe('<p><code>**literal** https://example.com</code></p>');
  expect(mdHtml('```sh\n\n<script>\n**literal**')).toBe('<pre>\n&lt;script&gt;\n**literal**</pre>');
  expect(mdHtml('[bad](javascript:alert(1)) <img src=x onerror=alert(1)>')).not.toContain('<a');
  expect(mdHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  expect(mdHtml('[link](https://example.com/?q="x")')).toContain('q=&quot;x&quot;');
  expect(mdHtml('**bold** *italic*')).toContain('<strong>bold</strong> <em>italic</em>');
});
