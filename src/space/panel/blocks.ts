/**
 * Widget blocks (docs/app-spec.md#blocks-a-state-card-instead-of-a-list): the structured values an
 * `items` widget may send next to its list. Only the contract's fields pass, with their types
 * checked; anything else is dropped, a malformed block is skipped, and nothing is filled in.
 */

/** A string, or the same text by language tag. */
export type BlockText = string | Record<string, string>;
export type Tone = "positive" | "negative" | "warning" | "neutral";
export type Format = "number" | "compact" | "currency" | "percent";

/** A write-back control on one block (docs/app-spec.md#views-copy-and-actions). */
export type BlockAction = { id: string; kind: "check" | "button"; label: BlockText; confirm?: BlockText };
/** A control in the card's footer; at most one `input`. */
export type CardAction = { id: string; kind: "input" | "button"; label: BlockText; placeholder?: BlockText; confirm?: BlockText };
/** A read-only switch inside a card: the same rules for its blocks as the top-level ones. */
export type WidgetViewDef = { id: string; label: BlockText; blocks: WidgetBlock[] };

type Common = { label: BlockText; caption?: BlockText; url?: string; tone?: Tone; copy?: string; action?: BlockAction };
type Numeric = { format?: Format; currency?: string; decimals?: number; unit?: BlockText };

export type MetricBlock = Common &
  Numeric & { type: "metric"; value: number | null; display?: BlockText; delta?: Numeric & { value: number; label?: BlockText; tone?: Tone } };
export type TrendBlock = Common & Numeric & { type: "trend"; style: "line" | "bar"; signed?: boolean; points: { t: string; v: number | null }[] };
export type ProgressBlock = Common & Numeric & { type: "progress"; value: number | null; max: number; display?: BlockText };
export type GaugeBlock = Common & { type: "gauge"; value: number | null; min: number; max: number; display?: BlockText; zones?: { to: number; tone: Tone; label?: BlockText }[] };
export type StatusBlock = Common & { type: "status"; value: BlockText; time?: string };
/** One upright tank of a `tanks` block: `value` of `max`, filled to their ratio and spilling over past it. */
export type Tank = { label: BlockText; value: number | null; max: number; display?: BlockText; tone?: Tone; url?: string };
export type TanksBlock = Common & Numeric & { type: "tanks"; tanks: Tank[] };
export type WidgetBlock = MetricBlock | TrendBlock | ProgressBlock | GaugeBlock | StatusBlock | TanksBlock;

export const MAX_BLOCKS = 12;
const MAX_POINTS = 90;
const MAX_ZONES = 8;
export const MAX_TANKS = 3;
const MAX_TEXT = 160;
export const MAX_COPY = 8000;
export const MIN_VIEWS = 2;
export const MAX_VIEWS = 4;
export const MAX_CARD_ACTIONS = 3;
export const MAX_ACTION_VALUE = 2000;
const VIEW_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ACTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
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
    copy: typeof r.copy === "string" && r.copy.length >= 1 && r.copy.length <= MAX_COPY ? r.copy : undefined,
    action: blockAction(r.action),
  });
}

function blockAction(v: unknown): BlockAction | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !ACTION_ID.test(v.id) || (v.kind !== "check" && v.kind !== "button")) return undefined;
  const label = text(v.label);
  if (!label) return undefined;
  return opt({ id: v.id, kind: v.kind as BlockAction["kind"], label, confirm: text(v.confirm) });
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
    case "tanks": {
      if (!Array.isArray(r.tanks)) return undefined;
      const tanks: Tank[] = [];
      for (const k of r.tanks) {
        if (!isObj(k)) continue;
        const label = text(k.label);
        const value = numOrNull(k.value);
        const max = num(k.max) ?? 100;
        if (!label || value === undefined || max <= 0) continue;
        tanks.push(opt({ label, value, max, display: text(k.display), tone: typeof k.tone === "string" && TONES.has(k.tone) ? (k.tone as Tone) : undefined,
          url: typeof k.url === "string" && k.url.length <= 2048 ? k.url : undefined }));
        if (tanks.length >= MAX_TANKS) break;
      }
      if (!tanks.length) return undefined;
      return opt({ type: "tanks" as const, ...c, ...numeric(r), tanks });
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

/**
 * The card-level actions: valid ones only, at most `MAX_CARD_ACTIONS`, one `input` (a second is
 * dropped), ids unique (a repeated id drops the later entry); undefined when none is valid.
 */
export function sanitizeActions(v: unknown): CardAction[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CardAction[] = [];
  const seen = new Set<string>();
  for (const r of v) {
    if (out.length >= MAX_CARD_ACTIONS) break;
    if (!isObj(r) || typeof r.id !== "string" || !ACTION_ID.test(r.id) || seen.has(r.id)) continue;
    if (r.kind !== "input" && r.kind !== "button") continue;
    if (r.kind === "input" && out.some((a) => a.kind === "input")) continue;
    const label = text(r.label);
    if (!label) continue;
    seen.add(r.id);
    out.push(opt({ id: r.id, kind: r.kind as CardAction["kind"], label, placeholder: r.kind === "input" ? text(r.placeholder) : undefined, confirm: text(r.confirm) }));
  }
  return out.length ? out : undefined;
}

/**
 * The views of a payload: 2 to 4 with a valid, unique id, a label and at least one valid block;
 * undefined when fewer than two remain.
 */
export function sanitizeViews(v: unknown): WidgetViewDef[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WidgetViewDef[] = [];
  for (const r of v) {
    if (out.length >= MAX_VIEWS) break;
    if (!isObj(r) || typeof r.id !== "string" || !VIEW_ID.test(r.id) || out.some((x) => x.id === r.id)) continue;
    const label = text(r.label);
    const blocks = sanitizeBlocks(r.blocks);
    if (!label || !blocks?.length) continue;
    out.push({ id: r.id, label, blocks });
  }
  return out.length >= MIN_VIEWS ? out : undefined;
}

/**
 * Makes action ids unique across a payload, in place. The same id may stand for the same action in
 * several block lists (the top-level blocks repeat the default view's, and a task can be in two
 * views), so a repeat is kept when it has the same kind in another list; a repeat in the same
 * list, or with another kind, or between the card and a block, is dropped (the later one).
 */
export function dedupeActionIds(p: { blocks?: WidgetBlock[]; views?: WidgetViewDef[]; actions?: CardAction[] }): void {
  const kinds = new Map<string, { kind: string; list: number }>();
  if (p.actions) for (const a of p.actions) kinds.set(a.id, { kind: a.kind, list: -1 });
  const lists = [p.blocks ?? [], ...(p.views ?? []).map((x) => x.blocks)];
  lists.forEach((list, li) => {
    const here = new Set<string>();
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!.action;
      if (!a) continue;
      const prev = kinds.get(a.id);
      if (here.has(a.id) || (prev && (prev.list === -1 || prev.kind !== a.kind))) {
        const { action: _, ...rest } = list[i]!;
        list[i] = rest as WidgetBlock;
        continue;
      }
      here.add(a.id);
      if (!prev) kinds.set(a.id, { kind: a.kind, list: li });
    }
  });
}

/** Every action id the payload declares, with its kind: the ids ai-space forwards to the app. */
export function declaredActions(p: { blocks?: WidgetBlock[]; views?: WidgetViewDef[]; actions?: CardAction[] }): Map<string, CardAction["kind"] | BlockAction["kind"]> {
  const out = new Map<string, CardAction["kind"] | BlockAction["kind"]>();
  for (const a of p.actions ?? []) out.set(a.id, a.kind);
  for (const list of [p.blocks ?? [], ...(p.views ?? []).map((x) => x.blocks)]) for (const b of list) if (b.action && !out.has(b.action.id)) out.set(b.action.id, b.action.kind);
  return out;
}
