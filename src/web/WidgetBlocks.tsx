import type { BlockText, Format, GaugeBlock, MetricBlock, ProgressBlock, StatusBlock, Tank, TanksBlock, Tone, TrendBlock, WidgetBlock } from "../space/panel/blocks.ts";
import { relTime } from "./api.ts";
import { LOCALE, type Lang, useLang } from "./i18n.ts";

// A widget's blocks as a state card (docs/app-spec.md#blocks-a-state-card-instead-of-a-list): the
// first block is the hero, the rest compact rows, as many as the card's size holds. The layout
// changes with the size instead of stretching the same rows.

export type { WidgetBlock };

/** Compact rows beside the hero, per card size. */
const ROWS: Record<string, number> = { "1x1": 2, "2x1": 4, "1x2": 6, "2x2": 10 };

const TONE_VAR: Record<Tone, string> = { positive: "var(--tone-positive)", negative: "var(--tone-negative)", warning: "var(--tone-warning)", neutral: "var(--muted)" };

export function txt(t: BlockText | undefined, lang: Lang): string {
  if (t === undefined) return "";
  if (typeof t === "string") return t;
  return t[lang] ?? Object.entries(t).find(([k]) => k.split("-")[0] === lang)?.[1] ?? t.en ?? Object.values(t)[0] ?? "";
}

type Num = { format?: Format; currency?: string; decimals?: number; unit?: BlockText };

/** A number in the reader's language; `compact` and large currency values abbreviate. */
export function fmt(v: number, n: Num, lang: Lang, signed = false): string {
  const locale = LOCALE[lang];
  const d = n.decimals;
  const sign: Intl.NumberFormatOptions = signed ? { signDisplay: "exceptZero" } : {};
  let s: string;
  if (n.format === "percent") {
    s = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: d ?? 0, maximumFractionDigits: d ?? 1, ...sign }).format(v / 100);
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
        <g>
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

/** A link wrapper when the block has a target, a plain element otherwise. */
function Box({ url, className, tone, children }: { url?: string; className: string; tone?: Tone; children: React.ReactNode }) {
  return url ? (
    <a className={className} data-tone={tone} href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <div className={className} data-tone={tone}>
      {children}
    </div>
  );
}

function Delta({ d, lang }: { d: NonNullable<MetricBlock["delta"]>; lang: Lang }) {
  // A change is colored only when the app says whether it is good or bad: up is not always good.
  return (
    <span className="wb-delta" style={{ color: d.tone ? TONE_VAR[d.tone] : undefined }}>
      {d.value > 0 ? "▲ " : d.value < 0 ? "▼ " : ""}
      {fmt(Math.abs(d.value), d, lang)}
      {d.label && <span className="wb-delta-label"> {txt(d.label, lang)}</span>}
    </span>
  );
}

function Spark({ b, lang, big }: { b: TrendBlock; lang: Lang; big?: boolean }) {
  const { t } = useLang();
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
  const tip = (p: { t: string; v: number | null }) => `${new Date(p.t).toLocaleDateString(LOCALE[lang])} · ${p.v === null ? t("widget.noData") : fmt(p.v, b, lang, !!b.signed)}`;
  const cls = `wb-spark${big ? " big" : ""}`;
  const last = pts.map((p) => p.v).findLastIndex((v) => v !== null);
  if (b.style === "bar") {
    return (
      <svg className={cls} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={txt(b.label, lang)}>
        {pts.map((p, i) => {
          const fill = p.v === null ? "none" : b.signed ? (p.v >= 0 ? "var(--tone-positive)" : "var(--tone-negative)") : "var(--accent)";
          const top = p.v === null ? zero : Math.min(y(p.v), zero);
          const h = p.v === null ? 0 : Math.max(Math.abs(y(p.v) - zero), 0.5);
          // The latest bar at full strength, the history behind it quieter: today reads at a glance.
          return (
            <g key={i}>
              <rect x={i * 10 + 1.5} width={7} y={top} height={h} rx={1.2} fill={fill} className={i === last ? undefined : "past"} />
              <rect x={i * 10} width={10} y={0} height={H} fill="transparent">
                <title>{tip(p)}</title>
              </rect>
            </g>
          );
        })}
        <line x1={0} x2={W} y1={zero} y2={zero} className="wb-zero" vectorEffect="non-scaling-stroke" />
      </svg>
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
  return (
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={txt(b.label, lang)}>
      {area && <path d={area} className="wb-area" fill="var(--accent)" />}
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {pts.map((p, i) => (
        <rect key={i} x={i * 10} width={10} y={0} height={H} fill="transparent">
          <title>{tip(p)}</title>
        </rect>
      ))}
    </svg>
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

/** The current zone's tone, for coloring a gauge's value. */
function gaugeTone(b: GaugeBlock): Tone | undefined {
  if (b.tone) return b.tone;
  if (b.value === null) return undefined;
  return b.zones?.find((z) => b.value! <= z.to)?.tone;
}

function Hero({ b, lang }: { b: WidgetBlock; lang: Lang }) {
  const { t } = useLang();
  const value = shown(b, lang);
  const tone = b.type === "gauge" ? gaugeTone(b) : b.tone;
  return (
    <Box url={b.url} className={`wb-hero wb-${b.type}`} tone={tone}>
      <span className="wb-label">{txt(b.label, lang)}</span>
      {b.type === "status" ? (
        <>
          <span className="wb-hero-value wb-status-value">
            <i className="wb-dot" style={{ background: tone ? TONE_VAR[tone] : "var(--muted)" }} />
            <span className="wb-v">{value}</span>
          </span>
          {b.time && <span className="wb-time">{relTime(b.time, lang)}</span>}
        </>
      ) : b.type === "tanks" ? (
        <Tanks b={b} lang={lang} />
      ) : (
        <span className={`wb-hero-value${value === undefined ? " missing" : ""}`} style={{ color: b.type === "gauge" && tone && tone !== "neutral" ? TONE_VAR[tone] : undefined }}>
          {value ?? t("widget.noData")}
        </span>
      )}
      {b.type === "metric" && b.delta && <Delta d={b.delta} lang={lang} />}
      {b.type === "trend" && <Spark b={b} lang={lang} big />}
      {b.type === "progress" && <Bar b={b} />}
      {b.type === "gauge" && <Scale b={b} lang={lang} />}
      {b.caption && <span className="wb-caption">{txt(b.caption, lang)}</span>}
    </Box>
  );
}

function Row({ b, lang }: { b: WidgetBlock; lang: Lang }) {
  const { t } = useLang();
  const value = shown(b, lang);
  const tone = b.type === "gauge" ? gaugeTone(b) : b.tone;
  const caption = txt(b.caption, lang);
  return (
    <Box url={b.url} className={`wb-row wb-${b.type}`}>
      <span className="wb-row-head">
        <span className="wb-label" title={[txt(b.label, lang), caption].filter(Boolean).join(" · ")}>
          {b.type === "status" && <i className="wb-dot" style={{ background: tone ? TONE_VAR[tone] : "var(--muted)" }} />}
          <span className="wb-lt">{txt(b.label, lang)}</span>
        </span>
        {b.type !== "tanks" && (
          <span className={`wb-row-value${value === undefined ? " missing" : ""}`} style={{ color: (b.type === "gauge" || b.type === "metric") && tone && tone !== "neutral" ? TONE_VAR[tone] : undefined }}>
            <span className="wb-v" title={value}>
              {value ?? t("widget.noData")}
            </span>
            {b.type === "metric" && b.delta && <Delta d={{ ...b.delta, label: undefined }} lang={lang} />}
            {b.type === "status" && b.time && <span className="wb-time">{relTime(b.time, lang)}</span>}
          </span>
        )}
      </span>
      {b.type === "trend" && <Spark b={b} lang={lang} />}
      {b.type === "progress" && <Bar b={b} />}
      {b.type === "gauge" && <Scale b={b} lang={lang} />}
      {b.type === "tanks" && <Tanks b={b} lang={lang} small />}
    </Box>
  );
}

export function Blocks({ blocks, size }: { blocks: WidgetBlock[]; size: string }) {
  const { lang } = useLang();
  const [hero, ...rest] = blocks;
  if (!hero) return null;
  const rows = rest.slice(0, ROWS[size] ?? 2);
  return (
    <div className={`wb wb-s${size}`}>
      <Hero b={hero} lang={lang} />
      {rows.length > 0 && (
        <div className="wb-rows">
          {rows.map((b, i) => (
            <Row key={i} b={b} lang={lang} />
          ))}
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
