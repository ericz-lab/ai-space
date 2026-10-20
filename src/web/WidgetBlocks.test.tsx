import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Blocks, type WidgetBlock } from "./WidgetBlocks.tsx";

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
  expect(html).toMatch(/fill="var\(--tone-positive\)" class="past"/);
  expect(html).toContain('fill="var(--tone-negative)"');
  expect(html).not.toContain('fill="var(--tone-negative)" class="past"');
  expect(render([{ type: "trend", label: "Missing", style: "bar", points: [] }])).toContain("wb-missing");
  expect(render([])).toBe("");
});
