import { expect, test } from "bun:test";
import { contrast, deepen, MONO_MIX, MONO_SURFACES, type MonoSurface, markRelColorMath, monoAccent, monoOn, REL_COLOR_MATH_ATTR, REL_COLOR_MATH_TEST } from "./mono-accent.ts";
import { defaultPreferences, luminance, PRESETS, resolveTokens, toHex } from "./theme.ts";

const accentOf = (id: string, scheme: "light" | "dark") => toHex(resolveTokens({ ...defaultPreferences(scheme), presetId: id }, scheme).accent);
const surfaces = Object.keys(MONO_SURFACES) as MonoSurface[];

/**
 * Presets whose light accent is under 3:1 on the coal card of the light scheme even undeepened
 * (deepening could only make it worse). A new preset that joins them fails here until it is
 * looked at and listed.
 */
const SHORT_ON_LIGHT_COAL = ["orbit"];

test("deepen matches color-mix(in oklab, x N%, #000) as Chrome computes it", () => {
  // The values Chrome computes for the same mixes (read back through a canvas).
  expect(deepen("#8b5cf6", 75)).toBe("#5d3ca7");
  expect(deepen("#f0a46b", 90)).toBe("#d18e5c");
  expect(deepen("#7257ff", 100)).toBe("#7257ff");
  expect(deepen("#ffffff", 0)).toBe("#000000");
});

test("every preset's mono accent holds its contrast on each card surface", () => {
  for (const p of PRESETS)
    for (const s of surfaces) {
      const { card, scheme } = MONO_SURFACES[s];
      const theme = accentOf(p.id, scheme);
      const { accent, on } = monoAccent(theme, s);
      const where = `${p.id} ${s} ${theme} -> ${accent}`;
      // Never lighter than the theme's own accent.
      expect(luminance(accent), where).toBeLessThanOrEqual(luminance(theme) + 1e-9);
      if (s === "light") {
        // Light card: clearly deeper, and dark enough to carry small text and icons.
        expect(luminance(accent), where).toBeLessThan(luminance(theme) * 0.6);
        expect(contrast(accent, card), where).toBeGreaterThanOrEqual(4.5);
        expect(contrast(accent, "#e7e7e7"), `${where} on the board`).toBeGreaterThanOrEqual(4.5);
      } else if (s === "coalLight" && SHORT_ON_LIGHT_COAL.includes(p.id)) {
        expect(contrast(accent, card), where).toBeLessThan(3);
      } else {
        expect(contrast(accent, card), where).toBeGreaterThanOrEqual(3);
      }
      // The mark on an accent fill (send arrow, check mark) reads as a graphic.
      expect(contrast(on, accent), where).toBeGreaterThanOrEqual(3);
    }
});

test("the mark is black or white by the deepened accent, not the theme's on-accent", () => {
  expect(monoOn("#5d3ca7")).toBe("#ffffff");
  expect(monoOn("#d18e5c")).toBe("#000000");
  // Aurora's on-accent is white, but undeepened on the light-scheme coal card black reads better.
  expect(monoAccent("#8b5cf6", "coalLight").on).toBe("#000000");
});

test("styles.css mixes with the same percentages as MONO_MIX", async () => {
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const mono = css.slice(css.indexOf("Mono widget style"));
  const at = (re: RegExp) => Number(re.exec(mono)?.[1]);
  expect(at(/:root\[data-widget-style="mono"\] \.widget \{[^}]*--c-mix: (\d+)%/)).toBe(MONO_MIX.light);
  expect(at(/\[data-theme="dark"\] \.widget \{ --c-mix: (\d+)%/)).toBe(MONO_MIX.dark);
  expect(at(/:not\(\[data-theme="dark"\]\) \.widgets > \.widget:nth-child\(even\) \{ --c-mix: (\d+)%/)).toBe(MONO_MIX.coalLight);
  expect(at(/\[data-theme="dark"\] \.widgets > \.widget:nth-child\(even\) \{ --c-mix: (\d+)%/)).toBe(MONO_MIX.coalDark);
  expect(mono).toContain("--accent: color-mix(in oklab, var(--m-accent-src) var(--c-mix), #000)");
  // No fixed accent colour is left in the mono section.
  expect(mono.toLowerCase()).not.toContain("#fd4a1b");
});

test("the black-or-white mark is gated on data-rel-color-math, set from the same test string", async () => {
  const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
  const rule = /:root\[data-widget-style="mono"\]\[data-rel-color-math\] \.widget \{\s*--on-accent: color\(from var\(--accent\) xyz-d65 clamp\(0, \(0\.179 - y\) \* 1e6/;
  expect(css).toMatch(rule);
  expect(REL_COLOR_MATH_ATTR).toBe("data-rel-color-math");
  // The test string's math is the declaration's: the same threshold and steepness.
  expect(REL_COLOR_MATH_TEST.value).toContain("clamp(0, (0.179 - y) * 1e6, 1)");
  // Channel math in an @supports condition fails Bun's CSS parser (bundle.test.ts), so none is left.
  expect(css).not.toMatch(/@supports[^{]*\bfrom\b/);
});

test("markRelColorMath sets the attribute only where CSS.supports says yes", () => {
  const g = globalThis as { CSS?: unknown };
  const saved = g.CSS;
  const root = () => {
    const attrs = new Map<string, string>();
    return { attrs, setAttribute: (k: string, v: string) => void attrs.set(k, v) };
  };
  try {
    delete g.CSS;
    const none = root();
    expect(markRelColorMath(none)).toBe(false);
    expect(markRelColorMath(undefined)).toBe(false);
    const asked: string[][] = [];
    g.CSS = { supports: (p: string, v: string) => (asked.push([p, v]), true) };
    const yes = root();
    expect(markRelColorMath(yes)).toBe(true);
    expect(yes.attrs.get("data-rel-color-math")).toBe("");
    expect(asked).toEqual([[REL_COLOR_MATH_TEST.property, REL_COLOR_MATH_TEST.value]]);
    g.CSS = { supports: () => false };
    const no = root();
    expect(markRelColorMath(no)).toBe(false);
    expect(no.attrs.size).toBe(0);
  } finally {
    if (saved === undefined) delete g.CSS;
    else g.CSS = saved;
  }
});
