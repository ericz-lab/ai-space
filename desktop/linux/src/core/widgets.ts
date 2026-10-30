import type { BlockText, Format, GaugeBlock, ProgressBlock, Tank, Tone, TrendBlock, WidgetBlock } from "../../../../src/space/panel/blocks.ts";
import type { Widget } from "./catalogue.ts";
import { escapeSegment } from "./url.ts";

/**
 * A widget card as the panel draws it (src/web/WidgetBlocks.tsx, docs/panel.md#widgets) and the
 * Mac does (WidgetBlocksView.swift): the first block is the hero, the rest compact rows, as many
 * as the card's size holds; a card without blocks is its list; an `embed` widget is the app's own
 * page. The numbers read as the panel writes them. Pure: the GTK card draws what this returns.
 */

export type { Tank, Tone, WidgetBlock };

/** Compact rows beside the hero, per card size (WidgetBlocks.tsx `ROWS`). */
const ROWS: Record<string, number> = { "1x1": 2, "2x1": 4, "1x2": 6, "2x2": 10 };
export const rowsFor = (size: string | undefined) => ROWS[size ?? ""] ?? 2;

/** List rows a card without blocks shows: more on a tall card. */
export const itemsFor = (size: string | undefined) => (size === "1x2" || size === "2x2" ? 8 : 4);

/** A tall card is two rows high; an embed page gets that much room. */
export const embedHeight = (size: string | undefined) => (size === "1x2" || size === "2x2" ? 420 : 200);

export function txt(t: BlockText | undefined, lang: string): string {
  if (t === undefined) return "";
  if (typeof t === "string") return t;
  return t[lang] ?? Object.entries(t).find(([k]) => k.split("-")[0] === lang)?.[1] ?? t.en ?? Object.values(t)[0] ?? "";
}

type Num = { format?: Format; currency?: string; decimals?: number; unit?: BlockText };

const locale = (lang: string) => (lang === "zh" ? "zh-CN" : "en");

/** A number in the reader's language; `compact` and large currency values abbreviate (WidgetBlocks.tsx `fmt`). */
export function fmt(v: number, n: Num, lang: string, signed = false): string {
  const loc = locale(lang);
  const d = n.decimals;
  const sign: Intl.NumberFormatOptions = signed ? { signDisplay: "exceptZero" } : {};
  let s: string;
  if (n.format === "percent") {
    s = new Intl.NumberFormat(loc, { style: "percent", minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 1, ...sign }).format(v / 100);
  } else if (n.format === "currency") {
    const big = Math.abs(v) >= 100_000;
    s = new Intl.NumberFormat(loc, {
      style: "currency",
      currency: n.currency ?? "USD",
      currencyDisplay: "narrowSymbol",
      ...(big ? { notation: "compact", maximumFractionDigits: d ?? 2 } : { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }),
      ...sign,
    }).format(v);
  } else if (n.format === "compact") {
    s = new Intl.NumberFormat(loc, { notation: "compact", maximumFractionDigits: d ?? 1, ...sign }).format(v);
  } else {
    s = new Intl.NumberFormat(loc, { minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 2, ...sign }).format(v);
  }
  const unit = txt(n.unit, lang);
  return unit ? `${s} ${unit}` : s;
}

/** The value a block leads with, or undefined when the app could not obtain it. */
export function shown(b: WidgetBlock, lang: string): string | undefined {
  switch (b.type) {
    case "metric":
    case "progress":
      return b.display ? txt(b.display, lang) : b.value === null ? undefined : fmt(b.value, b, lang);
    case "gauge":
      return b.display ? txt(b.display, lang) : b.value === null ? undefined : fmt(b.value, {}, lang);
    case "trend": {
      const last = [...b.points].reverse().find((p) => p.v !== null);
      return last?.v == null ? undefined : fmt(last.v, b, lang, !!b.signed);
    }
    case "status":
      return txt(b.value, lang);
    case "tanks":
      return undefined;
  }
}

/** A tank's short value: the app's own text, else its share of `max` in percent (WidgetBlocks.tsx `tankValue`). */
export function tankValue(k: Tank, lang: string): string | undefined {
  if (k.display) return txt(k.display, lang);
  return k.value === null ? undefined : fmt((k.value / k.max) * 100, { format: "percent", decimals: 0 }, lang);
}

/** How full a tank is, 0 and up; above 1 it spills over. */
export const tankLevel = (k: Tank) => (k.value === null || !(k.max > 0) ? 0 : Math.max(0, k.value / k.max));

/** A metric's change, arrow first; colored only when the app says whether it is good or bad. */
export function deltaText(b: WidgetBlock, lang: string, withLabel: boolean): { text: string; tone?: Tone } | undefined {
  if (b.type !== "metric" || !b.delta) return undefined;
  const d = b.delta;
  const arrow = d.value > 0 ? "▲ " : d.value < 0 ? "▼ " : "";
  const label = withLabel ? txt(d.label, lang) : "";
  return { text: arrow + fmt(Math.abs(d.value), d, lang) + (label ? ` ${label}` : ""), ...(d.tone ? { tone: d.tone } : {}) };
}

/** The tone a value is drawn in: the block's own, or for a gauge the zone its value is in. */
export function toneOf(b: WidgetBlock): Tone | undefined {
  if (b.tone) return b.tone;
  if (b.type !== "gauge" || b.value === null) return undefined;
  return b.zones?.find((z) => b.value! <= z.to)?.tone;
}

/** A progress as a share of its bar, 0…1. */
export const fraction = (b: ProgressBlock) => (b.value === null || !(b.max > 0) ? 0 : Math.max(0, Math.min(1, b.value / b.max)));

/** Where a value sits on a gauge's scale, 0…1. */
export function position(b: GaugeBlock, v: number): number {
  const lo = b.min ?? 0, hi = b.max ?? 100;
  return hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : 0;
}

/** A gauge's zones as stretches of its scale, 0…1. */
export function gaugeSegments(b: GaugeBlock): { start: number; end: number; tone: Tone }[] {
  let from = b.min ?? 0;
  return (b.zones ?? []).map((z) => {
    const s = { start: position(b, from), end: position(b, Math.min(z.to, b.max ?? 100)), tone: z.tone };
    from = z.to;
    return s;
  });
}

/**
 * A trend in a unit square (x right, y down, 0…1): a line as runs broken at missing points, or
 * bars from the zero line, the latest one marked so it can be drawn at full strength.
 */
export type Spark =
  | { kind: "line"; runs: { x: number; y: number }[][] }
  | { kind: "bars"; zero: number; bars: { x: number; width: number; top: number; bottom: number; negative: boolean; latest: boolean }[] };

export function spark(b: TrendBlock): Spark | undefined {
  const values = b.points.map((p) => p.v).filter((v): v is number => v !== null);
  if (!values.length) return undefined;
  const fromZero = b.signed === true || b.style === "bar";
  const lo = fromZero ? Math.min(0, ...values) : Math.min(...values);
  const hi = fromZero ? Math.max(0, ...values) : Math.max(...values);
  const span = hi - lo || 1;
  const n = Math.max(b.points.length, 2);
  const step = 1 / n;
  const y = (v: number) => 1 - (v - lo) / span;
  if (b.style === "bar") {
    let last = -1;
    b.points.forEach((p, i) => p.v !== null && (last = i));
    const zero = y(0);
    const bars = b.points.flatMap((p, i) => {
      if (p.v === null) return [];
      const top = Math.min(y(p.v), zero), bottom = Math.max(y(p.v), zero);
      return [{ x: i * step + step * 0.15, width: step * 0.7, top, bottom: Math.max(bottom, top + 0.01), negative: b.signed === true && p.v < 0, latest: i === last }];
    });
    return { kind: "bars", zero, bars };
  }
  const runs: { x: number; y: number }[][] = [];
  let run: { x: number; y: number }[] = [];
  b.points.forEach((p, i) => {
    if (p.v === null) {
      if (run.length) runs.push(run);
      run = [];
      return;
    }
    run.push({ x: i * step + step / 2, y: y(p.v) });
  });
  if (run.length) runs.push(run);
  return { kind: "line", runs };
}

/** A block card whose `asOf` is older than its `staleAfter` says so (WidgetBlocks.tsx `isOutdated`). */
export const isOutdated = (asOf: string | undefined, staleAfterMs: number | undefined, now = Date.now()) => !!asOf && !!staleAfterMs && now - Date.parse(asOf) > staleAfterMs;

/** What the card's body is. */
export type CardBody = "error" | "embed" | "blocks" | "items" | "empty";

export function cardBody(w: Widget): CardBody {
  if (w.ok === false) return "error";
  if (w.kind === "embed") return "embed";
  if (w.blocks?.length) return "blocks";
  if (w.items?.length) return "items";
  return "empty";
}

/** The page of an `embed` widget, proxied by the Space (and by the hub for a peer's). */
export function embedPath(w: Pick<Widget, "app" | "name" | "peer">, dark: boolean, lang: string): string {
  const base = w.peer ? `/api/peers/${escapeSegment(w.peer)}/widgets` : "/api/widgets";
  return `${base}/${escapeSegment(w.app)}/${escapeSegment(w.name)}/embed?theme=${dark ? "dark" : "light"}&lang=${encodeURIComponent(lang)}`;
}
