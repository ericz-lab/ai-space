import { expect, test } from "bun:test";
import { previewOpacity, previewPage } from "./widget-preview.tsx";

test("preview defaults to 76 and bounds finite opacity inputs", () => {
  for (const value of [null, "", " ", "invalid", "Infinity"]) expect(previewOpacity(value)).toBe(76);
  expect(previewOpacity("68")).toBe(68);
  expect(previewOpacity("75.6")).toBe(76);
  expect(previewOpacity("-1")).toBe(0);
  expect(previewOpacity("120")).toBe(100);
});

test("preview renders fixtures and slider without reflecting arbitrary query markup", () => {
  const html = previewPage(new URL("http://localhost/?opacity=81&lang=zh&theme=light"));
  expect(html).toContain('--widget-alpha: 0.81');
  expect(html).toContain('data-theme="light"');
  expect(html).toContain('value="81"');
  expect(html).toContain("示例数据");
  expect(html).toContain("Market Board");
  const invalid = previewPage(new URL("http://localhost/?opacity=%3Cscript%3E&theme=%3Cscript%3E"));
  expect(invalid).toContain('--widget-alpha: 0.76');
  expect(invalid).toContain('data-theme="dark"');
});
