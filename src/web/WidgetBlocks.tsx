import { type ReactNode, useEffect, useRef, useState } from "react";
import type { BlockAction, BlockText, Format, GaugeBlock, MetricBlock, ProgressBlock, StatusBlock, Tank, TanksBlock, Tone, TrendBlock, WidgetBlock } from "../space/panel/blocks.ts";
import { relTime } from "./api.ts";
import { LOCALE, type Lang, useLang } from "./i18n.ts";
import { type Change, copyText, nearestIndex, pagesOf, swipePage } from "./widget-interact.ts";

// A widget's blocks as a state card (docs/app-spec.md#blocks-a-state-card-instead-of-a-list): the
// first block is the hero, the rest compact rows, as many as the card's size holds. The layout
// changes with the size instead of stretching the same rows.

export type { WidgetBlock };

/**
 * What a card lets its blocks do. `live`: the controls respond (not in edit mode, not a library
 * preview). `acts`: the write-back controls are drawn (a local widget); `actLive`: they respond.
 */
export type BlockCtx = {
  live: boolean;
  acts: boolean;
  actLive: boolean;
  /** The action being sent, if any: the others wait. */
  busy: string | null;
  /** Checks ticked while their action is on the way. */
  ticked: ReadonlySet<string>;
  onAction: (a: BlockAction) => void;
};
const INERT: BlockCtx = { live: false, acts: false, actLive: false, busy: null, ticked: new Set(), onAction: () => {} };

/** A value that changed since the last payload: flashes once (`n` restarts it). */
export type Flash = { n: number; marks: (Change | undefined)[] };

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A number counting up from 0 over about 600 ms when the block first mounts; later values show at once. */
function useCountUp(target: number | null): number | null {
  const [v, setV] = useState<number | null>(() => (target !== null && typeof window !== "undefined" && !reducedMotion() ? 0 : target));
  const first = useRef(true);
  useEffect(() => {
    if (!first.current || target === null || reducedMotion()) {
      first.current = false;
      setV(target);
      return;
    }
    first.current = false;
    const t0 = performance.now();
    const whole = Number.isInteger(target);
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 600);
      const x = target * (1 - (1 - k) ** 3);
      setV(k >= 1 ? target : whole ? Math.round(x) : x);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

/** Compact rows beside the hero, per card size. */
const ROWS: Record<string, number> = { "1x1": 2, "2x1": 4, "1x2": 6, "2x2": 10 };

const TONE_VAR: Record<Tone, string> = { positive: "var(--tone-positive)", negative: "var(--tone-negative)", warning: "var(--tone-warning)", neutral: "var(--muted)" };
/**
 * A tone that colours text. A card style may set `--tone-*-text` where the fill colour is too light
 * for words (4.5:1); without it the fill colour is used, as before.
 */
const TONE_TEXT: Record<Tone, string> = {
  positive: "var(--tone-positive-text, var(--tone-positive))",
  negative: "var(--tone-negative-text, var(--tone-negative))",
  warning: "var(--tone-warning-text, var(--tone-warning))",
  neutral: "var(--muted)",
};

export function txt(t: BlockText | undefined, lang: Lang): string {
  if (t === undefined) return "";
  if (typeof t === "string") return t;
  return t[lang] ?? Object.entries(t).find(([k]) => k.split("-")[0] === lang)?.[1] ?? t.en ?? Object.values(t)[0] ?? "";
}

type Num = { format?: Format; currency?: string; decimals?: number; unit?: BlockText };

const percentFormat = (lang: Lang, d: number | undefined, signed: boolean) =>
  new Intl.NumberFormat(LOCALE[lang], { style: "percent", minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 1, ...(signed ? { signDisplay: "exceptZero" as const } : {}) });

/** A number in the reader's language; `compact` and large currency values abbreviate. */
export function fmt(v: number, n: Num, lang: Lang, signed = false): string {
  const locale = LOCALE[lang];
  const d = n.decimals;
  const sign: Intl.NumberFormatOptions = signed ? { signDisplay: "exceptZero" } : {};
  let s: string;
  if (n.format === "percent") {
    s = percentFormat(lang, d, signed).format(v / 100);
  } else if (n.format === "currency") {
    const big = Math.abs(v) >= 100_000;
    s = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: n.currency ?? "USD",
      currencyDisplay: "narrowSymbol",
      ...(big ? { notation: "compact", maximumFractionDigits: d ?? 2 } : { minimumFractionDigits: d ?? 2, maximumFractionDigits: d ?? 2 }),
      ...sign,
    }).format(v);
  } else if (n.format === "compact") {
    s = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: d ?? 1, ...sign }).format(v);
  } else {
    s = new Intl.NumberFormat(locale, { minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 2, ...sign }).format(v);
  }
  const unit = txt(n.unit, lang);
  return unit ? `${s} ${unit}` : s;
}

/** A formatted number split into the number and its unit; `num + sep + unit` is always `fmt(...)`. */
export type Parts = { num: string; sep: string; unit: string };

/**
 * `fmt` in two pieces, so a card style can draw the unit smaller than the number. The unit comes
 * only from the data: the block's `unit`, or the percent sign of `format: "percent"` (from the
 * formatter's own parts). Anything else, a currency symbol included, stays one string.
 */
export function fmtParts(v: number, n: Num, lang: Lang, signed = false): Parts {
  const unit = txt(n.unit, lang);
  if (unit) return { num: fmt(v, { ...n, unit: undefined }, lang, signed), sep: " ", unit };
  const whole = fmt(v, n, lang, signed);
  if (n.format !== "percent") return { num: whole, sep: "", unit: "" };
  const parts = percentFormat(lang, n.decimals, signed).formatToParts(v / 100);
  const at = parts.findIndex((p) => p.type === "percentSign");
  // Only a trailing sign splits ("50%", "50 %"); a leading one ("%50") stays whole.
  if (at < 0 || parts.slice(at + 1).length || parts.slice(0, at).every((p) => p.type === "literal")) return { num: whole, sep: "", unit: "" };
  let end = at;
  while (end > 0 && parts[end - 1]!.type === "literal") end--;
  const join = (ps: Intl.NumberFormatPart[]) => ps.map((p) => p.value).join("");
  return { num: join(parts.slice(0, end)), sep: join(parts.slice(end, at)), unit: parts[at]!.value };
}

/** A hero value with its unit in a span of its own (smaller in the mono card style); the text reads the same. */
function Value({ p }: { p: Parts }) {
  if (!p.unit) return <>{p.num}</>;
  return (
    <>
      {p.num}
      <span className="wb-usep">{p.sep}</span>
      <span className="wb-unit">{p.unit}</span>
    </>
  );
}

/** The value a block leads with, or undefined when the app could not obtain it. */
function shown(b: WidgetBlock, lang: Lang): string | undefined {
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

/** `shown` as parts, where the block's own number is formatted here (not the app's `display` text). */
function shownParts(b: WidgetBlock, lang: Lang): Parts | undefined {
  switch (b.type) {
    case "metric":
    case "progress":
      return b.display || b.value === null ? undefined : fmtParts(b.value, b, lang);
    case "trend": {
      const last = [...b.points].reverse().find((p) => p.v !== null);
      return last?.v == null ? undefined : fmtParts(last.v, b, lang, !!b.signed);
    }
    default:
      return undefined;
  }
}

/** A tank's short value: the app's own text, else its share of `max` in percent. */
export function tankValue(k: Tank, n: Num, lang: Lang): string | undefined {
  if (k.display) return txt(k.display, lang);
  return k.value === null ? undefined : fmt((k.value / k.max) * 100, { ...n, format: "percent", decimals: 0, unit: undefined }, lang);
}

/** Tank geometry in its own units (viewBox 0 0 64 84): straight sides, elliptical top and bottom. */
const TK = { l: 8, r: 56, top: 12, bottom: 72, rx: 24, ry: 6 };

/** One upright cylinder filled to value / max in the tank's tone (the accent without one); past max it fills and spills over the rim. */
function TankSvg({ k, label }: { k: Tank; label: string }) {
  const { l, r, top, bottom, rx, ry } = TK;
  const f = k.value === null ? 0 : Math.max(0, k.value / k.max);
  const y = bottom - Math.min(1, f) * (bottom - top);
  const color = k.tone && k.tone !== "neutral" ? TONE_VAR[k.tone] : "var(--accent)";
  const cx = (l + r) / 2;
  const side = (x1: number, x2: number, yy: number) => `M${x1} ${yy}V${bottom}A${rx} ${ry} 0 0 0 ${x2} ${bottom}V${yy}Z`;
  return (
    <svg className="wb-tank" viewBox="0 0 64 84" role="img" aria-label={label}>
      <ellipse cx={cx} cy={bottom + ry + 3} rx={rx + 4} ry={3} className="wb-tank-shadow" />
      <path d={side(l, r, top)} className="wb-tank-body" />
      {k.value !== null && f > 0.002 && (
        <g className="wb-tank-fill">
          <path d={side(l + 1.5, r - 1.5, y)} fill={color} />
          <path d={side(cx + 8, r - 1.5, y)} fill="#000" opacity={0.14} />
          <ellipse cx={cx} cy={y} rx={rx - 1.5} ry={ry - 0.8} fill={color} />
          <ellipse cx={cx} cy={y} rx={rx - 1.5} ry={ry - 0.8} fill="#fff" opacity={0.28} />
        </g>
      )}
      <path d={`M${l + 5} ${top + 4}V${bottom - 1}h3V${top + 5}Z`} fill="#fff" opacity={0.22} />
      <ellipse cx={cx} cy={top} rx={rx} ry={ry} className="wb-tank-rim" />
      {f > 1 && <path d={`M${cx - 12} ${top + 1}q5-4 12-1q1 9-1 20q-2 5-4 0q-1-9-7-19Z`} fill={color} />}
    </svg>
  );
}

/** Up to three tanks side by side, each with its label and a short value. */
function Tanks({ b, lang, small }: { b: TanksBlock; lang: Lang; small?: boolean }) {
  const { t } = useLang();
  return (
    <span className={`wb-tankrow${small ? " small" : ""}`}>
      {b.tanks.map((k, i) => {
        const name = txt(k.label, lang);
        const value = tankValue(k, b, lang);
        const body = (
          <>
            <TankSvg k={k} label={`${name}: ${value ?? t("widget.noData")}`} />
            <span className="wb-tank-name" title={name}>{name}</span>
            <span className={`wb-tank-value${value === undefined ? " missing" : ""}`}>{value ?? t("widget.noData")}</span>
          </>
        );
        return k.url ? (
          <a key={i} className="wb-tank-cell" href={k.url} target="_blank" rel="noopener noreferrer">{body}</a>
        ) : (
          <span key={i} className="wb-tank-cell">{body}</span>
        );
      })}
    </span>
  );
}

/**
 * A link wrapper when the block has a target, a plain element otherwise. A block with its own
 * controls is never an anchor (a button inside a link would follow it): the link is a sibling that
 * covers the block, and the controls sit above it.
 */
function Box({ url, className, tone, label, cover, children }: { url?: string; className: string; tone?: Tone; label: string; cover: boolean; children: ReactNode }) {
  if (url && !cover)
    return (
      <a className={className} data-tone={tone} href={url} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  return (
    <div className={`${className}${url ? " wb-linked" : cover ? " wb-live" : ""}`} data-tone={tone}>
      {url && <a className="wb-cover" href={url} target="_blank" rel="noopener noreferrer" aria-label={label} />}
      {children}
    </div>
  );
}

const stop = (e: React.SyntheticEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

const CheckMark = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A round checkbox in place of the status dot; ticked at once, rolled back by the card when the action fails. */
function Check({ a, ctx, lang }: { a: BlockAction; ctx: BlockCtx; lang: Lang }) {
  const on = ctx.ticked.has(a.id);
  const label = txt(a.label, lang);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={`wb-check wb-ctl${on ? " on" : ""}`}
      disabled={!ctx.actLive || (ctx.busy !== null && !on)}
      onClick={(e) => {
        stop(e);
        if (!on) ctx.onAction(a);
      }}
    >
      {on && <CheckMark />}
    </button>
  );
}

/** A small pill at the end of the block. */
function ActButton({ a, ctx, lang }: { a: BlockAction; ctx: BlockCtx; lang: Lang }) {
  return (
    <button
      type="button"
      className={`wb-btn wb-ctl${ctx.busy === a.id ? " busy" : ""}`}
      disabled={!ctx.actLive || ctx.busy !== null}
      onClick={(e) => {
        stop(e);
        ctx.onAction(a);
      }}
    >
      {txt(a.label, lang)}
    </button>
  );
}

/** Copies the block's `copy` text and says so in place for 1.5 s. */
function Copy({ text, live }: { text: string; live: boolean }) {
  const { t } = useLang();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const h = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(h);
  }, [done]);
  const label = done ? t("widget.copied") : t("widget.copy");
  return (
    <button
      type="button"
      className={`wb-copy wb-ctl${done ? " done" : ""}`}
      aria-label={label}
      title={label}
      disabled={!live}
      onClick={(e) => {
        stop(e);
        void copyText(text).then((ok) => ok && setDone(true));
      }}
    >
      {done ? (
        <CheckMark />
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.8" fill="none" stroke="currentColor" strokeWidth={1.4} />
          <path d="M10.5 3.5v-.2c0-1-.8-1.8-1.8-1.8H4.3c-1 0-1.8.8-1.8 1.8v4.4c0 1 .8 1.8 1.8 1.8h.2" fill="none" stroke="currentColor" strokeWidth={1.4} />
        </svg>
      )}
      <span className="wb-copy-tip" aria-hidden="true">{done ? t("widget.copied") : ""}</span>
    </button>
  );
}

/** The trailing controls of a block: copy, then a block button. */
function Controls({ b, ctx, lang }: { b: WidgetBlock; ctx: BlockCtx; lang: Lang }) {
  const button = ctx.acts && b.action?.kind === "button" ? b.action : undefined;
  if (!b.copy && !button) return null;
  return (
    <span className="wb-ctls">
      {b.copy && <Copy text={b.copy} live={ctx.live} />}
      {button && <ActButton a={button} ctx={ctx} lang={lang} />}
    </span>
  );
}

/** Whether the block draws a control of its own (and so is not an anchor). */
const hasControl = (b: WidgetBlock, ctx: BlockCtx) => !!b.copy || (ctx.acts && !!b.action);

/** A point's date, with the time when the series is finer than a day. */
function pointDate(t: string, lang: Lang): string {
  const d = new Date(t);
  const timed = t.length > 10 && !/T00:00(:00(\.0+)?)?(Z|[+-]00:?00)?$/.test(t);
  return timed ? d.toLocaleString(LOCALE[lang], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(LOCALE[lang]);
}

type Point = { t: string; v: number | null };

/** The value and date a trend shows while the pointer rests on one of its points. */
function readout(b: WidgetBlock, p: Point | null, lang: Lang): { value: string | undefined; date: string } | undefined {
  if (!p || b.type !== "trend") return undefined;
  return { value: p.v === null ? undefined : fmt(p.v, b, lang, !!b.signed), date: pointDate(p.t, lang) };
}

function Delta({ d, lang }: { d: NonNullable<MetricBlock["delta"]>; lang: Lang }) {
  // A change is colored only when the app says whether it is good or bad: up is not always good.
  return (
    <span className="wb-delta" data-tone={d.tone} style={{ color: d.tone ? TONE_TEXT[d.tone] : undefined }}>
      {d.value > 0 ? "▲ " : d.value < 0 ? "▼ " : ""}
      {fmt(Math.abs(d.value), d, lang)}
      {d.label && <span className="wb-delta-label"> {txt(d.label, lang)}</span>}
    </span>
  );
}

/**
 * A sparkline or bars. Moving the pointer over it (or dragging a finger) picks the nearest point:
 * its bar at full strength, or a dot on a thin rule over a line; the block shows that point's value
 * and date while the pointer stays (`onPoint`). The dot is an element over the svg, so the
 * `preserveAspectRatio="none"` stretch does not distort it.
 */
function Spark({ b, lang, big, onPoint }: { b: TrendBlock; lang: Lang; big?: boolean; onPoint?: (p: Point | null) => void }) {
  const { t } = useLang();
  const [hover, setHover] = useState<number | null>(null);
  const pts = b.points;
  const vals = pts.map((p) => p.v).filter((v): v is number => v !== null);
  if (!vals.length) return <span className="wb-missing">{t("widget.noHistory")}</span>;
  const W = Math.max(pts.length, 2) * 10;
  const H = 40;
  const lo = b.signed || b.style === "bar" ? Math.min(0, ...vals) : Math.min(...vals);
  const hi = b.signed || b.style === "bar" ? Math.max(0, ...vals) : Math.max(...vals);
  const span = hi - lo || 1;
  const y = (v: number) => H - ((v - lo) / span) * H;
  const zero = y(0);
  const last = pts.map((p) => p.v).findLastIndex((v) => v !== null);
  const pick = (e: React.PointerEvent<HTMLSpanElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = nearestIndex(e.clientX - r.left, r.width, pts.length);
    if (i < 0 || i === hover) return;
    setHover(i);
    onPoint?.(pts[i] ?? null);
  };
  const leave = () => {
    setHover(null);
    onPoint?.(null);
  };
  const latest = pts[last];
  const aria = `${txt(b.label, lang)}${latest?.v != null ? `: ${fmt(latest.v, b, lang, !!b.signed)}` : ""}`;
  const wrap = (svg: ReactNode, over?: ReactNode) => (
    <span
      className={`wb-spark-wrap${big ? " big" : ""}`}
      onPointerMove={pick}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        // A finger on the chart reads it; it does not swipe the card's pages.
        e.stopPropagation();
        pick(e);
      }}
      onPointerUp={(e) => e.pointerType !== "mouse" && leave()}
      onPointerCancel={leave}
      onPointerLeave={leave}
    >
      {svg}
      {over}
    </span>
  );
  const cls = `wb-spark${big ? " big" : ""}`;
  const xPct = (i: number) => `${((i * 10 + 5) / W) * 100}%`;
  if (b.style === "bar") {
    const strong = hover ?? last;
    const pct = (n: number, of: number) => `${(n / of) * 100}%`;
    return wrap(
      <svg className={cls} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={aria}>
        {pts.map((p, i) => {
          const fill = p.v === null ? "none" : b.signed ? (p.v >= 0 ? "var(--tone-positive)" : "var(--tone-negative)") : "var(--accent)";
          const top = p.v === null ? zero : Math.min(y(p.v), zero);
          const h = p.v === null ? 0 : Math.max(Math.abs(y(p.v) - zero), 0.5);
          // The latest bar (or the one under the pointer) at full strength, the rest quieter: today reads at a glance.
          return (
            <rect
              key={i}
              x={i * 10 + 1.5}
              width={7}
              y={top}
              height={h}
              rx={1.2}
              fill={fill}
              className={`wb-sb${i === strong ? "" : " past"}`}
              style={{ transformOrigin: p.v !== null && p.v < 0 ? "50% 0" : "50% 100%", animationDelay: `${Math.min(i, 30) * 16}ms` }}
            />
          );
        })}
        <line x1={0} x2={W} y1={zero} y2={zero} className="wb-zero" vectorEffect="non-scaling-stroke" />
      </svg>,
      // The same bars as boxes, for a card style that draws them as capsules (an svg rect's radius
      // stretches with the chart); hidden in the default style.
      <span className="wb-hbars" aria-hidden="true">
        {pts.map((p, i) => {
          if (p.v === null) return null;
          const top = Math.min(y(p.v), zero);
          const h = Math.max(Math.abs(y(p.v) - zero), 0.5);
          const neg = p.v < 0;
          return (
            <i
              key={i}
              className={`wb-hb${i === strong ? "" : " past"}${neg ? " neg" : ""}`}
              style={{
                // Centred in its slot; the card style sets the width, so a capsule stays a capsule on a short chart.
                left: pct(i * 10 + 5, W),
                width: pct(7, W),
                top: pct(top, H),
                height: pct(h, H),
                background: b.signed ? (neg ? "var(--tone-negative)" : "var(--tone-positive)") : "var(--accent)",
                animationDelay: `${Math.min(i, 30) * 16}ms`,
              }}
            />
          );
        })}
      </span>,
    );
  }
  // A line breaks at a missing point rather than bridging it; each unbroken run gets a faint area
  // down to the chart's floor.
  let d = "";
  let area = "";
  let run: string[] = [];
  const close = () => {
    if (run.length > 1) area += `M${run[0]!.split(",")[0]},${H}L${run.join("L")}L${run[run.length - 1]!.split(",")[0]},${H}Z`;
    run = [];
  };
  pts.forEach((p, i) => {
    if (p.v === null) {
      close();
      return;
    }
    const xy = `${i * 10 + 5},${y(p.v).toFixed(2)}`;
    d += `${run.length ? "L" : "M"}${xy}`;
    run.push(xy);
  });
  close();
  const hp = hover === null ? undefined : pts[hover];
  return wrap(
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={aria}>
      <g className="wb-line">
        {area && <path d={area} className="wb-area" fill="var(--accent)" />}
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </g>
    </svg>,
    hp && (
      <>
        <span className="wb-spark-rule" style={{ left: xPct(hover!) }} />
        {hp.v !== null && <span className="wb-spark-dot" style={{ left: xPct(hover!), top: `${(y(hp.v) / H) * 100}%` }} />}
      </>
    ),
  );
}

function Bar({ b }: { b: ProgressBlock }) {
  const pct = b.value === null ? 0 : Math.max(0, Math.min(100, (b.value / b.max) * 100));
  return (
    <span className="wb-bar">
      <span style={{ width: `${pct}%`, background: b.tone && b.tone !== "neutral" ? TONE_VAR[b.tone] : "var(--accent)" }} />
    </span>
  );
}

function Scale({ b, lang }: { b: GaugeBlock; lang: Lang }) {
  const range = b.max - b.min;
  const pos = (v: number) => Math.max(0, Math.min(100, ((v - b.min) / range) * 100));
  let from = b.min;
  const zones = (b.zones ?? []).map((z) => {
    const seg = { left: pos(from), width: pos(Math.min(z.to, b.max)) - pos(from), tone: z.tone, label: txt(z.label, lang) };
    from = z.to;
    return seg;
  });
  return (
    <span className="wb-scale">
      {zones.length ? (
        zones.map((z, i) => <span key={i} className="wb-zone" title={z.label} style={{ left: `${z.left}%`, width: `${z.width}%`, background: TONE_VAR[z.tone] }} />)
      ) : (
        <span className="wb-zone" style={{ left: 0, width: "100%", background: "var(--hairline)" }} />
      )}
      {b.value !== null && <span className="wb-marker" style={{ left: `${pos(b.value)}%` }} />}
    </span>
  );
}

/** The arc a gauge hero draws in the mono card style: 270 degrees, open at the bottom, in a 100 x 80 box. */
export const ARC = { cx: 50, cy: 46, r: 40, sweep: 270 } as const;

/** An svg path of a circular arc of `sweep` degrees, symmetric about the vertical, open at the bottom, drawn clockwise. */
export function arcPath(cx: number, cy: number, r: number, sweep: number): string {
  const a0 = ((90 + (360 - sweep) / 2) * Math.PI) / 180;
  const a1 = a0 + (sweep * Math.PI) / 180;
  const pt = (a: number) => `${+(cx + r * Math.cos(a)).toFixed(2)} ${+(cy + r * Math.sin(a)).toFixed(2)}`;
  return `M${pt(a0)}A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${pt(a1)}`;
}

/** A gauge as shares of its arc (0 to 100, for `pathLength="100"`): the value, and each zone's start and length. */
export function arcShares(b: Pick<GaugeBlock, "min" | "max" | "value" | "zones">): { value: number | null; zones: { start: number; len: number; tone: Tone }[] } {
  const range = b.max - b.min || 1;
  const at = (v: number) => Math.round(Math.max(0, Math.min(100, ((v - b.min) / range) * 100)) * 100) / 100;
  let from = b.min;
  const zones = (b.zones ?? []).map((z) => {
    const start = at(from);
    from = z.to;
    return { start, len: Math.max(0, Math.round((at(Math.min(z.to, b.max)) - start) * 100) / 100), tone: z.tone };
  });
  return { value: b.value === null ? null : at(b.value), zones };
}

/** The gauge as an arc: track, faint zones, the value's share in its zone's tone (the accent without one). Hidden in the default style. */
function Arc({ b, tone }: { b: GaugeBlock; tone: Tone | undefined }) {
  const d = arcPath(ARC.cx, ARC.cy, ARC.r, ARC.sweep);
  const s = arcShares(b);
  return (
    <svg className="wb-arc" viewBox="0 0 100 80" aria-hidden="true">
      <path d={d} className="wb-arc-track" />
      {s.zones.map((z, i) => (
        <path key={i} d={d} pathLength={100} className="wb-arc-zone" stroke={TONE_VAR[z.tone]} strokeDasharray={`${z.len} 100`} strokeDashoffset={-z.start} />
      ))}
      {s.value !== null && <path d={d} pathLength={100} className="wb-arc-meter" stroke={tone && tone !== "neutral" ? TONE_VAR[tone] : "var(--accent)"} strokeDasharray={`${s.value} 100`} />}
    </svg>
  );
}

/** The current zone's tone, for coloring a gauge's value. */
function gaugeTone(b: GaugeBlock): Tone | undefined {
  if (b.tone) return b.tone;
  if (b.value === null) return undefined;
  return b.zones?.find((z) => b.value! <= z.to)?.tone;
}

/** The class that flashes a changed value, keyed so a second change restarts it. */
const flashCls = (f: { dir: Change; n: number } | undefined) => (f ? ` wb-flash-${f.dir}` : "");

function Hero({ b, lang, ctx, flash }: { b: WidgetBlock; lang: Lang; ctx: BlockCtx; flash?: { dir: Change; n: number } }) {
  const { t } = useLang();
  const [point, setPoint] = useState<Point | null>(null);
  const counting = useCountUp(b.type === "metric" && !b.display ? b.value : null);
  const read = readout(b, point, lang);
  let value = shown(b, lang);
  let parts = shownParts(b, lang);
  if (read) {
    value = read.value;
    parts = point?.v != null && b.type === "trend" ? fmtParts(point.v, b, lang, !!b.signed) : undefined;
  } else if (b.type === "metric" && !b.display && b.value !== null && counting !== null) {
    value = fmt(counting, b, lang);
    parts = fmtParts(counting, b, lang);
  }
  const tone = b.type === "gauge" ? gaugeTone(b) : b.tone;
  const label = txt(b.label, lang);
  const check = ctx.acts && b.action?.kind === "check" ? b.action : undefined;
  const done = !!check && ctx.ticked.has(check.id);
  const ctl = hasControl(b, ctx);
  const caption = read ? read.date : txt(b.caption, lang);
  return (
    <Box url={b.url} className={`wb-hero wb-${b.type}${done ? " wb-done" : ""}`} tone={tone} label={label} cover={ctl}>
      <span className="wb-hero-top">
        <span className="wb-label">
          {check && b.type !== "status" && <Check a={check} ctx={ctx} lang={lang} />}
          <span className="wb-lt">{label}</span>
        </span>
        <Controls b={b} ctx={ctx} lang={lang} />
      </span>
      {b.type === "status" ? (
        <>
          <span className="wb-hero-value wb-status-value">
            {check ? <Check a={check} ctx={ctx} lang={lang} /> : <i className="wb-dot" style={{ background: tone ? TONE_VAR[tone] : "var(--muted)" }} />}
            <span key={flash?.n} className={`wb-v${flashCls(flash)}`}>{value}</span>
          </span>
          {b.time && <span className="wb-time">{relTime(b.time, lang)}</span>}
        </>
      ) : b.type === "tanks" ? (
        <Tanks b={b} lang={lang} />
      ) : (
        <span
          key={flash?.n}
          className={`wb-hero-value${value === undefined ? " missing" : ""}${flashCls(flash)}`}
          style={{ color: b.type === "gauge" && tone && tone !== "neutral" ? TONE_TEXT[tone] : undefined }}
        >
          {value === undefined ? t("widget.noData") : parts ? <Value p={parts} /> : value}
        </span>
      )}
      {b.type === "gauge" && <Arc b={b} tone={tone} />}
      {b.type === "metric" && b.delta && <Delta d={b.delta} lang={lang} />}
      {b.type === "trend" && <Spark b={b} lang={lang} big onPoint={setPoint} />}
      {b.type === "progress" && <Bar b={b} />}
      {b.type === "gauge" && <Scale b={b} lang={lang} />}
      {caption && <span className={`wb-caption${read ? " wb-readout" : ""}`}>{caption}</span>}
    </Box>
  );
}

function Row({ b, lang, ctx, flash }: { b: WidgetBlock; lang: Lang; ctx: BlockCtx; flash?: { dir: Change; n: number } }) {
  const { t } = useLang();
  const [point, setPoint] = useState<Point | null>(null);
  const read = readout(b, point, lang);
  const value = read ? read.value : shown(b, lang);
  const tone = b.type === "gauge" ? gaugeTone(b) : b.tone;
  const label = txt(b.label, lang);
  const caption = txt(b.caption, lang);
  const check = ctx.acts && b.action?.kind === "check" ? b.action : undefined;
  const done = !!check && ctx.ticked.has(check.id);
  return (
    <Box url={b.url} className={`wb-row wb-${b.type}${done ? " wb-done" : ""}`} label={label} cover={hasControl(b, ctx)}>
      <span className="wb-row-head">
        <span className="wb-label" title={[label, caption].filter(Boolean).join(" · ")}>
          {check ? <Check a={check} ctx={ctx} lang={lang} /> : b.type === "status" && <i className="wb-dot" style={{ background: tone ? TONE_VAR[tone] : "var(--muted)" }} />}
          <span className="wb-lt">{label}</span>
        </span>
        {b.type !== "tanks" && (
          <span className={`wb-row-value${value === undefined ? " missing" : ""}`} style={{ color: (b.type === "gauge" || b.type === "metric") && tone && tone !== "neutral" ? TONE_TEXT[tone] : undefined }}>
            <span key={flash?.n} className={`wb-v${flashCls(flash)}`} title={value}>
              {value ?? t("widget.noData")}
            </span>
            {b.type === "metric" && b.delta && <Delta d={{ ...b.delta, label: undefined }} lang={lang} />}
            {b.type === "status" && b.time && <span className="wb-time">{relTime(b.time, lang)}</span>}
            {read && <span className="wb-time wb-readout">{read.date}</span>}
          </span>
        )}
        <Controls b={b} ctx={ctx} lang={lang} />
      </span>
      {b.type === "trend" && <Spark b={b} lang={lang} onPoint={setPoint} />}
      {b.type === "progress" && <Bar b={b} />}
      {b.type === "gauge" && <Scale b={b} lang={lang} />}
      {b.type === "tanks" && <Tanks b={b} lang={lang} small />}
    </Box>
  );
}

/** Round dots under the rows: one per page, the current one marked; Left and Right move between them. */
function Pager({ n, page, onPage, live }: { n: number; page: number; onPage: (i: number) => void; live: boolean }) {
  const { t } = useLang();
  const ref = useRef<HTMLDivElement>(null);
  const go = (i: number) => {
    onPage(i);
    ref.current?.querySelectorAll("button")[i]?.focus();
  };
  return (
    <div
      ref={ref}
      className="wb-pager"
      role="group"
      aria-label={t("widget.pages")}
      onKeyDown={(e) => {
        if (!live || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        go(Math.max(0, Math.min(n - 1, page + (e.key === "ArrowRight" ? 1 : -1))));
      }}
    >
      {Array.from({ length: n }, (_, i) => (
        <button key={i} type="button" className="wb-pdot" aria-label={t("widget.page", { n: i + 1, total: n })} aria-current={i === page ? "page" : undefined} disabled={!live} onClick={() => onPage(i)} />
      ))}
    </div>
  );
}

export function Blocks({ blocks, size, ctx = INERT, flash }: { blocks: WidgetBlock[]; size: string; ctx?: BlockCtx; flash?: Flash }) {
  const { lang } = useLang();
  const [page, setPage] = useState(0);
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const [hero, ...rest] = blocks;
  if (!hero) return null;
  const per = ROWS[size] ?? 2;
  const pages = pagesOf(rest, per);
  const cur = Math.min(page, pages.length - 1);
  const mark = (i: number) => {
    const dir = flash?.marks[i];
    return dir ? { dir, n: flash!.n } : undefined;
  };
  const row = (b: WidgetBlock, i: number) => <Row key={`${i}:${b.type}:${b.action?.id ?? ""}`} b={b} lang={lang} ctx={ctx} flash={mark(i + 1)} />;
  return (
    <div className={`wb wb-s${size}`}>
      <Hero b={hero} lang={lang} ctx={ctx} flash={mark(0)} />
      {pages.length === 1 ? (
        rest.length > 0 && <div className="wb-rows">{rest.map((b, i) => row(b, i))}</div>
      ) : (
        <div className="wb-paged">
          {/* Every page is laid out in the same cell, the others hidden, so the card keeps the height of its tallest page. */}
          <div
            className="wb-pages"
            onPointerDown={(e) => {
              if (e.pointerType !== "mouse") swipe.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerUp={(e) => {
              const s = swipe.current;
              swipe.current = null;
              if (s && ctx.live) setPage(swipePage(cur, pages.length, e.clientX - s.x, e.clientY - s.y));
            }}
            onPointerCancel={() => (swipe.current = null)}
          >
            {pages.map((p, pi) => (
              <div key={pi === cur ? `page-${cur}` : `sizer-${pi}`} className={`wb-rows${pi === cur ? "" : " wb-sizer"}`} aria-hidden={pi === cur ? undefined : true} inert={pi !== cur}>
                {p.map((b, j) => row(b, pi * per + j))}
              </div>
            ))}
          </div>
          <Pager n={pages.length} page={cur} onPage={setPage} live={ctx.live} />
        </div>
      )}
    </div>
  );
}

/** Whether the payload is older than the app said it stays true. */
export function isOutdated(asOf: string | undefined, staleAfterMs: number | undefined, now = Date.now()): boolean {
  return !!asOf && !!staleAfterMs && now - Date.parse(asOf) > staleAfterMs;
}

export type { MetricBlock, StatusBlock };
