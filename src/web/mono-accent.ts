import { formatColor, luminance, parseColor } from "./theme.ts";

// The mono widget style's accent (styles.css, "Mono widget style"): the theme's accent made
// deeper with `color-mix(in oklab, <accent> N%, #000)`, N per card surface. The stylesheet does
// the mixing; this module does the same arithmetic so tests can check the percentages against
// every preset, and the preview can show the values.

/** The card surfaces of the mono style and their colours. */
export const MONO_SURFACES = {
  light: { card: "#fafaf8", scheme: "light" },
  coalLight: { card: "#1e1e1e", scheme: "light" },
  dark: { card: "#1c1c1e", scheme: "dark" },
  coalDark: { card: "#000000", scheme: "dark" },
} as const;
export type MonoSurface = keyof typeof MONO_SURFACES;

/**
 * How much of the theme's accent each surface keeps (the rest is black), as in styles.css. Light
 * cards deepen clearly; dark cards barely, since the dark accents are light tints that must keep
 * 3:1 against a near-black card.
 */
export const MONO_MIX: Record<MonoSurface, number> = { light: 75, coalLight: 100, dark: 90, coalDark: 85 };

const toLin = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLin = (v: number) => {
  const x = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, x)) * 255);
};

/** `color-mix(in oklab, color pct%, #000)` as `#rrggbb`: black is the origin of OKLab, so the mix scales L, a and b alike. */
export function deepen(color: string, pct: number): string {
  const c = parseColor(color);
  if (!c) return color;
  const [r, g, b] = [toLin(c.r), toLin(c.g), toLin(c.b)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363015581 * g + 0.0514459929 * b) * (pct / 100);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b) * (pct / 100);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b) * (pct / 100);
  const [l3, m3, s3] = [l ** 3, m ** 3, s ** 3];
  return formatColor({
    r: fromLin(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3),
    g: fromLin(-1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3),
    b: fromLin(-0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3),
    a: 1,
  });
}

/** WCAG contrast of two opaque colours. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Black or white, whichever has more contrast on the colour (the mark on an accent fill). */
export const monoOn = (fill: string): "#000000" | "#ffffff" => (contrast(fill, "#000000") >= contrast(fill, "#ffffff") ? "#000000" : "#ffffff");

/** The accent a mono card of this surface draws with, and the mark colour on it. */
export function monoAccent(themeAccent: string, surface: MonoSurface): { accent: string; on: string; contrast: number } {
  const accent = deepen(themeAccent, MONO_MIX[surface]);
  return { accent, on: monoOn(accent), contrast: contrast(accent, MONO_SURFACES[surface].card) };
}

/**
 * The mark on a mono card's accent fill is black or white in css too, by relative-colour math on
 * the deepened accent (styles.css, "Black or white on the accent"). Whether the browser can do
 * that math is tested here, not in an `@supports` condition: Bun's CSS parser, which bundles the
 * panel, rejects channel math there and fails the whole page. Without the attribute the card's
 * fixed `--c-on` stays.
 */
export const REL_COLOR_MATH_ATTR = "data-rel-color-math";
export const REL_COLOR_MATH_TEST = { property: "color", value: "color(from red xyz-d65 clamp(0, (0.179 - y) * 1e6, 1) y z)" } as const;

/** Sets `data-rel-color-math` on <html> when the browser computes relative-colour math; a no-op without `CSS.supports`. */
export function markRelColorMath(root: { setAttribute(name: string, value: string): void } | undefined = globalThis.document?.documentElement): boolean {
  const css = (globalThis as { CSS?: { supports?: (property: string, value: string) => boolean } }).CSS;
  const ok = !!root && typeof css?.supports === "function" && css.supports(REL_COLOR_MATH_TEST.property, REL_COLOR_MATH_TEST.value);
  if (ok) root.setAttribute(REL_COLOR_MATH_ATTR, "");
  return ok;
}
