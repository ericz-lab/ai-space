import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Blocks, type WidgetBlock } from "./WidgetBlocks.tsx";
import { LangContext } from "./i18n.ts";

const hero: WidgetBlock = { type: "metric", label: "Today", value: 12 };
const render = (blocks: WidgetBlock[], size = "1x1") => renderToStaticMarkup(<Blocks blocks={blocks} size={size} />);

test("repeated neutral status labels share a heading without losing links or text", () => {
  const html = render([hero,
    { type: "status", label: "Latest", value: "First headline", url: "https://example.com/first" },
    { type: "status", label: "Latest", value: "Second headline", url: "https://example.com/second" },
  ]);
  expect(html.match(/Latest/g)).toHaveLength(1);
  expect(html).toContain("First headline");
  expect(html).toContain("Second headline");
  expect(html).toContain('href="https://example.com/first"');
  expect(html).toContain('href="https://example.com/second"');
  expect(html).not.toContain("wb-dot");
});

test("distinct labels, status tones and caption tooltips remain on individual rows", () => {
  const html = render([hero,
    { type: "status", label: "Review", value: "Pending", tone: "warning" },
    { type: "status", label: "Review", value: "Ready", caption: "Checked by the owner" },
  ]);
  expect(html).not.toContain("wb-grouped");
  expect(html).toContain("wb-dot");
  expect(html).toContain("Checked by the owner");
  expect(render([hero,
    { type: "status", label: "First", value: "One" },
    { type: "status", label: "Second", value: "Two" },
  ])).not.toContain("wb-grouped");
});

test("grouping compares localized labels and only the visible rows", () => {
  const blocks: WidgetBlock[] = [hero,
    { type: "status", label: { en: "Latest", zh: "最新" }, value: "One" },
    { type: "status", label: { en: "Latest", zh: "最新" }, value: "Two" },
    { type: "status", label: "Other", value: "Hidden" },
  ];
  const html = renderToStaticMarkup(<LangContext.Provider value="zh"><Blocks blocks={blocks} size="1x1" /></LangContext.Provider>);
  expect(html.match(/最新/g)).toHaveLength(1);
  expect(html).not.toContain("Hidden");
});

test("bar emphasis follows the last available point, including gaps and negative values", () => {
  const html = render([{ type: "trend", label: "Flow", style: "bar", signed: true,
    points: [
      { t: "2026-10-18T00:00:00Z", v: 10 },
      { t: "2026-10-19T00:00:00Z", v: -5 },
      { t: "2026-10-20T00:00:00Z", v: null },
    ],
  }]);
  expect(html.match(/wb-spark-bar latest/g)).toHaveLength(1);
  expect(html).toMatch(/class="wb-spark-bar latest"[^>]+fill="var\(--danger\)"/);
  expect(render([{ type: "trend", label: "Missing", style: "bar", points: [] }])).toContain("wb-missing");
  expect(render([])).toBe("");
});
