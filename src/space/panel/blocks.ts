/**
 * Widget blocks (docs/app-spec.md#blocks-a-state-card-instead-of-a-list): the structured values an
 * `items` widget may send next to its list. Only the contract's fields pass, with their types
 * checked; anything else is dropped, a malformed block is skipped, and nothing is filled in.
 */

/** A string, or the same text by language tag. */
export type BlockText = string | Record<string, string>;
export type Tone = "positive" | "negative" | "warning" | "neutral";
export type Format = "number" | "compact" | "currency" | "percent";

type Common = { label: BlockText; caption?: BlockText; url?: string; tone?: Tone };
type Numeric = { format?: Format; currency?: string; decimals?: number; unit?: BlockText };

export type MetricBlock = Common &
  Numeric & { type: "metric"; value: number | null; display?: BlockText; delta?: Numeric & { value: number; label?: BlockText; tone?: Tone } };
export type TrendBlock = Common & Numeric & { type: "trend"; style: "line" | "bar"; signed?: boolean; points: { t: string; v: number | null }[] };
export type ProgressBlock = Common & Numeric & { type: "progress"; value: number | null; max: number; display?: BlockText };
export type GaugeBlock = Common & { type: "gauge"; value: number | null; min: number; max: number; display?: BlockText; zones?: { to: number; tone: Tone; label?: BlockText }[] };
export type StatusBlock = Common & { type: "status"; value: BlockText; time?: string };
export type WidgetBlock = MetricBlock | TrendBlock | ProgressBlock | GaugeBlock | StatusBlock;

export const MAX_BLOCKS = 12;
const MAX_POINTS = 90;
const MAX_ZONES = 8;
const MAX_TEXT = 160;
const TONES = new Set<string>(["positive", "negative", "warning", "neutral"]);
const FORMATS = new Set<string>(["number", "compact", "currency", "percent"]);

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** A number, or `null` for a value the app could not obtain; undefined when it is neither. */
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : num(v));

function text(v: unknown): BlockText | undefined {
  if (typeof v === "string") return v.trim() ? v.slice(0, MAX_TEXT) : undefined;
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(v)) if (/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(k) && typeof s === "string" && s.trim()) out[k] = s.slice(0, MAX_TEXT);
  return Object.keys(out).length ? out : undefined;
}

function opt<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function common(r: Raw): Common | undefined {
  const label = text(r.label);
  if (!label) return undefined;
  return opt({
    label,
    caption: text(r.caption),
    url: typeof r.url === "string" && r.url.length <= 2048 ? r.url : undefined,
    tone: typeof r.tone === "string" && TONES.has(r.tone) ? (r.tone as Tone) : undefined,
  });
}

function numeric(r: Raw): Numeric {
  const decimals = num(r.decimals);
  return opt({
    format: typeof r.format === "string" && FORMATS.has(r.format) ? (r.format as Format) : undefined,
    currency: typeof r.currency === "string" && /^[A-Z]{3}$/.test(r.currency) ? r.currency : undefined,
    decimals: decimals !== undefined && decimals >= 0 && decimals <= 8 ? Math.round(decimals) : undefined,
    unit: text(r.unit),
  });
}

const isoish = (v: unknown): v is string => typeof v === "string" && v.length <= 40 && !Number.isNaN(Date.parse(v));

export function sanitizeBlock(r: unknown): WidgetBlock | undefined {
  if (!isObj(r)) return undefined;
  const c = common(r);
  if (!c) return undefined;
  switch (r.type) {
    case "metric": {
      const value = numOrNull(r.value);
      if (value === undefined) return undefined;
      let delta: MetricBlock["delta"];
      if (isObj(r.delta) && num(r.delta.value) !== undefined) {
        const d = r.delta;
        delta = opt({ value: num(d.value) as number, ...numeric(d), label: text(d.label), tone: typeof d.tone === "string" && TONES.has(d.tone) ? (d.tone as Tone) : undefined });
      }
      return opt({ type: "metric" as const, ...c, ...numeric(r), value, display: text(r.display), delta });
    }
    case "trend": {
      if (!Array.isArray(r.points)) return undefined;
      const points: TrendBlock["points"] = [];
      for (const p of r.points) {
        if (!isObj(p) || !isoish(p.t)) continue;
        const v = numOrNull(p.v);
        points.push({ t: p.t, v: v === undefined ? null : v });
      }
      return opt({ type: "trend" as const, ...c, ...numeric(r), style: r.style === "bar" ? ("bar" as const) : ("line" as const), signed: r.signed === true ? true : undefined, points: points.slice(-MAX_POINTS) });
    }
    case "progress": {
      const value = numOrNull(r.value);
      const max = num(r.max) ?? 100;
      if (value === undefined || max <= 0) return undefined;
      return opt({ type: "progress" as const, ...c, ...numeric(r), value, max, display: text(r.display) });
    }
    case "gauge": {
      const value = numOrNull(r.value);
      const min = num(r.min) ?? 0;
      const max = num(r.max) ?? 100;
      if (value === undefined || max <= min) return undefined;
      const zones = Array.isArray(r.zones)
        ? r.zones
            .slice(0, MAX_ZONES)
            .filter((z): z is Raw => isObj(z) && num(z.to) !== undefined && typeof z.tone === "string" && TONES.has(z.tone))
            .map((z) => opt({ to: z.to as number, tone: z.tone as Tone, label: text(z.label) }))
            .sort((a, b) => a.to - b.to)
        : undefined;
      return opt({ type: "gauge" as const, ...c, value, min, max, display: text(r.display), zones: zones?.length ? zones : undefined });
    }
    case "status": {
      const value = text(r.value);
      if (!value) return undefined;
      return opt({ type: "status" as const, ...c, value, time: isoish(r.time) ? r.time : undefined });
    }
  }
  return undefined;
}

/** The blocks of a widget payload, valid ones only, at most `MAX_BLOCKS`; undefined when it sent none. */
export function sanitizeBlocks(v: unknown): WidgetBlock[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WidgetBlock[] = [];
  for (const r of v) {
    const b = sanitizeBlock(r);
    if (b) out.push(b);
    if (out.length >= MAX_BLOCKS) break;
  }
  return out;
}
