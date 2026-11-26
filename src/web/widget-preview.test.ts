import { expect, test } from "bun:test";
import { accentVars, previewAccent } from "./widget-preview-app.tsx";
import { previewFeed, previewOpacity, previewPage, previewStyle } from "./widget-preview.tsx";

test("preview defaults to 76 and bounds finite opacity inputs", () => {
  for (const value of [null, "", " ", "invalid", "Infinity"]) expect(previewOpacity(value)).toBe(76);
  expect(previewOpacity("68")).toBe(68);
  expect(previewOpacity("75.6")).toBe(76);
  expect(previewOpacity("-1")).toBe(0);
  expect(previewOpacity("120")).toBe(100);
});

test("preview renders fixtures and slider without reflecting arbitrary query markup", async () => {
  const html = await previewPage(new URL("http://localhost/?opacity=81&lang=zh&theme=light"));
  expect(html).toContain('--widget-alpha: 0.81');
  expect(html).toContain('data-theme="light"');
  expect(html).toContain('value="81"');
  expect(html).toContain("示例数据");
  expect(html).toContain("Market Board");
  const invalid = await previewPage(new URL("http://localhost/?opacity=%3Cscript%3E&theme=%3Cscript%3E"));
  expect(invalid).toContain('--widget-alpha: 0.76');
  expect(invalid).toContain('data-theme="dark"');
  expect(invalid).not.toContain("<script>alert");
});

test("the preview's cards are the production card, with views, actions and pages", async () => {
  const html = await previewPage(new URL("http://localhost/?lang=en"));
  // The segmented views of the usage card, the todo card's checks and input, the 2x2 card's pager.
  expect(html).toContain('role="tablist"');
  expect(html).toContain('role="checkbox"');
  expect(html).toContain('class="wa-input"');
  expect(html).toContain('class="wb-pager"');
  expect(html).toContain('id="preview-data"');
  const data = JSON.parse(html.match(/<script type="application\/json" id="preview-data">(.*?)<\/script>/s)![1]!);
  const peer = data.widgets.find((w: { peer?: string }) => w.peer);
  expect(peer).toMatchObject({ peer: "david" });
  expect(peer).not.toHaveProperty("actions");
});

test("the preview's sources: a check finishes a task, the bank call always fails, an input adds", async () => {
  const { feed } = previewFeed();
  const done = await feed.act("todo", "today", { action: "done:1" });
  if (!done.ok) throw new Error(done.error);
  expect(JSON.stringify(done.widget)).not.toContain("Buy milk");
  expect(await feed.act("todo", "today", { action: "done:2" })).toEqual({ ok: false, status: 502, error: "the bank list is read-only" });
  const add = await feed.act("todo", "today", { action: "add", value: "Write the report" });
  expect(add.ok && JSON.stringify(add.widget)).toContain("Write the report");
  const a = await feed.refresh("market", "watchlist");
  const b = await feed.refresh("market", "watchlist");
  if (!a.ok || !b.ok || !a.widget.ok || !b.widget.ok) throw new Error("market down");
  expect(a.widget.blocks?.[0]).not.toEqual(b.widget.blocks?.[0]);
});

test("the preview opens in the mono card style unless asked for the default one", async () => {
  expect(previewStyle(null)).toBe("mono");
  expect(previewStyle("<b>")).toBe("mono");
  expect(previewStyle("default")).toBe("default");
  expect(await previewPage(new URL("http://localhost/"))).toContain('data-widget-style="mono"');
  const plain = await previewPage(new URL("http://localhost/?style=default"));
  expect(plain).not.toContain('data-widget-style="mono"');
  expect(plain).toContain('data-style="default" aria-pressed="true"');
});

test("the preview paints the picked accent, Aurora's without one, and lists a swatch per preset", async () => {
  expect(previewAccent(null, "dark")).toBe("#8b5cf6");
  expect(previewAccent("C2410C", "light")).toBe("#c2410c");
  expect(previewAccent("#4be3a8", "dark")).toBe("#4be3a8");
  expect(previewAccent("red;x", "light")).toBe("#8b5cf6");
  expect(accentVars("#c2410c", "light")).toEqual({ "--accent": "#c2410c", "--on-accent": "#ffffff", "--link": "#c2410c", "--focus": "#c2410c" });
  const html = await previewPage(new URL("http://localhost/?accent=c2410c&theme=light"));
  expect(html).toContain('style="--accent: #c2410c; --on-accent: #ffffff;');
  expect(html.match(/<button type="button" data-accent=/g)).toHaveLength(7);
  expect(html).toContain('data-accent="#c2410c" aria-pressed="true" aria-label="Warm"');
  expect(await previewPage(new URL("http://localhost/?accent=%22%3E%3Cscript%3E"))).toContain('style="--accent: #8b5cf6;');
});
