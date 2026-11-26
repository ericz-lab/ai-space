import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ARC, Blocks, arcPath, arcShares, fmt, fmtParts, type WidgetBlock } from "./WidgetBlocks.tsx";

const hero: WidgetBlock = { type: "metric", label: "Today", value: 12 };
const render = (blocks: WidgetBlock[], size = "1x1") => renderToStaticMarkup(<Blocks blocks={blocks} size={size} />);

test("status rows retain individual labels, tones, captions and links", () => {
  const html = render([hero,
    { type: "status", label: "Latest", value: "First headline", url: "https://example.com/first", tone: "warning" },
    { type: "status", label: "Latest", value: "Second headline", caption: "Checked by the owner" },
  ]);
  expect(html.match(/class="wb-lt">Latest/g)).toHaveLength(2);
  expect(html).toContain('href="https://example.com/first"');
  expect(html).toContain("Second headline");
  expect(html).toContain("Checked by the owner");
  expect(html).toContain("var(--tone-warning)");
});

test("bar emphasis follows the last available point, including gaps and negative values", () => {
  const html = render([{ type: "trend", label: "Flow", style: "bar", signed: true,
    points: [
      { t: "2026-10-18T00:00:00Z", v: 10 },
      { t: "2026-10-19T00:00:00Z", v: -5 },
      { t: "2026-10-20T00:00:00Z", v: null },
    ],
  }]);
  expect(html).toMatch(/fill="var\(--tone-positive\)" class="wb-sb past"/);
  expect(html).toContain('fill="var(--tone-negative)"');
  expect(html).toContain('fill="var(--tone-negative)" class="wb-sb"');
  expect(render([{ type: "trend", label: "Missing", style: "bar", points: [] }])).toContain("wb-missing");
  expect(render([])).toBe("");
});

test("rows beyond the size are paged, not dropped; controls are inert without a live card", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ type: "metric" as const, label: `r${i}`, value: i }));
  const html = render([{ type: "status", label: "Hero", value: "ok", copy: "hello", action: { id: "done:1", kind: "check" as const, label: "Done" } }, ...rows]);
  expect(html).toContain("r4");
  expect(html.match(/class="wb-pdot"/g)?.length).toBe(3);
  expect(html).toContain('aria-current="page"');
  expect(html).toMatch(/class="wb-copy wb-ctl"[^>]*disabled/);
  // Without a card that acts, no check is drawn: the status dot stays.
  expect(html).not.toContain('role="checkbox"');
  expect(html).toContain("wb-dot");
});

test("fmtParts splits a unit or a trailing percent sign from data, and always joins back to fmt", () => {
  expect(fmtParts(14.7, { unit: "GB" }, "en")).toEqual({ num: "14.7", sep: " ", unit: "GB" });
  expect(fmtParts(-29.38, { unit: { en: "k", zh: "千" } }, "zh", true)).toEqual({ num: "-29.38", sep: " ", unit: "千" });
  expect(fmtParts(50, { format: "percent" }, "en")).toEqual({ num: "50", sep: "", unit: "%" });
  expect(fmtParts(0.42, { format: "percent", decimals: 2 }, "zh")).toEqual({ num: "0.42", sep: "", unit: "%" });
  // A currency symbol is never split off, nor is anything parsed out of text.
  expect(fmtParts(74.69, { format: "currency" }, "en")).toEqual({ num: "$74.69", sep: "", unit: "" });
  expect(fmtParts(1840, { format: "compact" }, "en").unit).toBe("");
  const cases: [number, Parameters<typeof fmt>[1], boolean][] = [
    [14.7, { unit: "GB" }, false], [50, { format: "percent" }, false], [-12.4, { format: "percent" }, true], [12.4, { format: "percent", unit: "pts" }, false],
    [91.69, { format: "currency" }, false], [231498, { unit: "BTC" }, false], [1840, { format: "compact" }, true], [0, { format: "percent" }, true],
  ];
  for (const lang of ["en", "zh"] as const)
    for (const [v, n, signed] of cases) {
      const p = fmtParts(v, n, lang, signed);
      expect(p.num + p.sep + p.unit).toBe(fmt(v, n, lang, signed));
    }
});

test("a hero draws its unit in its own span; the text reads the same", () => {
  const html = render([{ type: "metric", label: "Total", value: 14.7, unit: "GB" }]);
  expect(html).toContain('14.7<span class="wb-usep"> </span><span class="wb-unit">GB</span>');
  // The app's own display text stays one string.
  expect(render([{ type: "progress", label: "Read", value: 50, max: 100, display: "half way" }])).not.toContain("wb-unit");
});

test("the gauge arc is 270 degrees, open at the bottom, and its shares follow the range", () => {
  expect(arcPath(50, 50, 40, 270)).toBe("M21.72 78.28A40 40 0 1 1 78.28 78.28");
  expect(arcPath(ARC.cx, ARC.cy, ARC.r, 180)).toBe("M10 46A40 40 0 0 1 90 46");
  const s = arcShares({ min: 0, max: 100, value: 55, zones: [{ to: 25, tone: "negative" }, { to: 45, tone: "warning" }, { to: 60, tone: "positive" }, { to: 100, tone: "warning" }] });
  expect(s.value).toBe(55);
  expect(s.zones).toEqual([
    { start: 0, len: 25, tone: "negative" }, { start: 25, len: 20, tone: "warning" }, { start: 45, len: 15, tone: "positive" }, { start: 60, len: 40, tone: "warning" },
  ]);
  expect(arcShares({ min: 10, max: 20, value: 30, zones: [{ to: 50, tone: "positive" }] })).toEqual({ value: 100, zones: [{ start: 0, len: 100, tone: "positive" }] });
  expect(arcShares({ min: 0, max: 10, value: null }).value).toBeNull();
  const html = render([{ type: "gauge", label: "Fear", value: 55, min: 0, max: 100 }]);
  expect(html).toContain('class="wb-arc"');
  expect(html).toContain('stroke-dasharray="55 100"');
});

test("bars are also drawn as boxes for capsules, and a toned value uses the text colour of its tone", () => {
  const html = render([{ type: "trend", label: "Flow", style: "bar", signed: true, points: [{ t: "2026-10-18T00:00:00Z", v: 10 }, { t: "2026-10-19T00:00:00Z", v: -5 }] }]);
  expect(html.match(/class="wb-hb( [^"]*)?"/g)).toEqual(['class="wb-hb past"', 'class="wb-hb neg"']);
  const delta = render([{ type: "metric", label: "x", value: 1, delta: { value: 2, tone: "positive" } }]);
  expect(delta).toContain('data-tone="positive"');
  expect(delta).toContain("var(--tone-positive-text, var(--tone-positive))");
});
