import type { BlockText, Format, GaugeBlock, MetricBlock, ProgressBlock, StatusBlock, Tone, TrendBlock, WidgetBlock } from "../space/panel/blocks.ts";
import { relTime } from "./api.ts";
import { LOCALE, type Lang, useLang } from "./i18n.ts";

// A widget's blocks as a state card (docs/app-spec.md#blocks-a-state-card-instead-of-a-list): the
// first block is the hero, the rest compact rows, as many as the card's size holds. The layout
// changes with the size instead of stretching the same rows.

export type { WidgetBlock };

/** Compact rows beside the hero, per card size. */
const ROWS: Record<string, number> = { "1x1": 2, "2x1": 4, "1x2": 6, "2x2": 10 };

const TONE_VAR: Record<Tone, string> = { positive: "var(--success)", negative: "var(--danger)", warning: "var(--warning)", neutral: "var(--muted)" };

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
  }
}

/** A link wrapper when the block has a target, a plain element otherwise. */
function Box({ url, className, children }: { url?: string; className: string; children: React.ReactNode }) {
  return url ? (
    <a className={className} href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <div className={className}>{children}</div>
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
  if (b.style === "bar") {
    return (
      <svg className={cls} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={txt(b.label, lang)}>
        {b.signed && <line x1={0} x2={W} y1={zero} y2={zero} className="wb-zero" vectorEffect="non-scaling-stroke" />}
        {pts.map((p, i) => {
          const fill = p.v === null ? "none" : b.signed ? (p.v >= 0 ? "var(--success)" : "var(--danger)") : "var(--accent)";
          const top = p.v === null ? zero : Math.min(y(p.v), zero);
          const h = p.v === null ? 0 : Math.max(Math.abs(y(p.v) - zero), 0.5);
          return (
            <g key={i}>
              <rect x={i * 10 + 1.5} width={7} y={top} height={h} fill={fill} />
              <rect x={i * 10} width={10} y={0} height={H} fill="transparent">
                <title>{tip(p)}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    );
  }
  // A line breaks at a missing point rather than bridging it.
  let d = "";
  let pen = false;
  pts.forEach((p, i) => {
    if (p.v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${i * 10 + 5},${y(p.v).toFixed(2)}`;
    pen = true;
  });
  return (
    <svg className={cls} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={txt(b.label, lang)}>
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
    <Box url={b.url} className={`wb-hero wb-${b.type}`}>
      <span className="wb-label">{txt(b.label, lang)}</span>
      {b.type === "status" ? (
        <>
          <span className="wb-hero-value wb-status-value">
            <i className="wb-dot" style={{ background: tone ? TONE_VAR[tone] : "var(--muted)" }} />
            <span className="wb-v">{value}</span>
          </span>
          {b.time && <span className="wb-time">{relTime(b.time, lang)}</span>}
        </>
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
        <span className={`wb-row-value${value === undefined ? " missing" : ""}`} style={{ color: (b.type === "gauge" || b.type === "metric") && tone && tone !== "neutral" ? TONE_VAR[tone] : undefined }}>
          <span className="wb-v" title={value}>
            {value ?? t("widget.noData")}
          </span>
          {b.type === "metric" && b.delta && <Delta d={{ ...b.delta, label: undefined }} lang={lang} />}
          {b.type === "status" && b.time && <span className="wb-time">{relTime(b.time, lang)}</span>}
        </span>
      </span>
      {b.type === "trend" && <Spark b={b} lang={lang} />}
      {b.type === "progress" && <Bar b={b} />}
      {b.type === "gauge" && <Scale b={b} lang={lang} />}
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
