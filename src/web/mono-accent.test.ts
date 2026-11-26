import { expect, test } from "bun:test";
import { contrast, deepen, MONO_MIX, MONO_SURFACES, type MonoSurface, monoAccent, monoOn } from "./mono-accent.ts";
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
