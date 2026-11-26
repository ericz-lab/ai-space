import type { WidgetBlock } from "./WidgetBlocks.tsx";

// Fixed demonstration data; this preview never reads a live Space. `previewCards` are static
// payloads; `PreviewSources` below holds the cards that answer actions, in memory (the market board
// among them, whose prices move on every read).
export const previewCards: { title: string; icon: string; color: string; size?: string; blocks: WidgetBlock[] }[] = [
  { "title": "R2 Monitor · Usage", "icon": "R2", "color": "#f38020", "size": "2x1", "blocks": [
    { "type": "tanks", "label": { "en": "Nearest 10 GB", "zh": "最接近 10 GB" }, "tanks": [
      { "label": "yansense", "value": 7.47, "max": 10, "display": "7.47 GB", "tone": "warning" },
      { "label": "Kandicakirlamon", "value": 7.26, "max": 10, "display": "7.26 GB", "tone": "warning" },
      { "label": "studio", "value": 11.2, "max": 10, "display": "11.2 GB", "tone": "negative" } ] } ] },
  { "title": "R2 Monitor · Small", "icon": "R2", "color": "#f38020", "size": "1x1", "blocks": [
    { "type": "tanks", "label": { "en": "Nearest 10 GB", "zh": "最接近 10 GB" }, "tanks": [
      { "label": "yansense", "value": 7.47, "max": 10, "display": "7.47 GB", "tone": "warning" },
      { "label": "Kandicakirlamon", "value": 7.26, "max": 10, "display": "7.26 GB", "tone": "warning" },
      { "label": "studio", "value": 11.2, "max": 10, "display": "11.2 GB", "tone": "negative" } ] },
    { "type": "metric", "label": "Total", "value": 14.7, "unit": "GB" } ] },
  {
    "title": "BTC Macro · Indicators",
    "icon": "₿",
    "color": "#f59e0b",
    "blocks": [
      {
        "type": "gauge",
        "label": "Fear & Greed",
        "value": 55,
        "min": 0,
        "max": 100,
        "display": "55 Greed",
        "caption": "yesterday 59 · week ago 57",
        "zones": [
          {
            "to": 25,
            "tone": "negative"
          },
          {
            "to": 45,
            "tone": "warning"
          },
          {
            "to": 60,
            "tone": "positive"
          },
          {
            "to": 100,
            "tone": "warning"
          }
        ]
      },
      {
        "type": "trend",
        "label": "ETF daily net flow",
        "style": "bar",
        "signed": true,
        "format": "currency",
        "points": [
          {
            "t": "2026-10-14T00:00:00Z",
            "v": 50000000
          },
          {
            "t": "2026-10-15T00:00:00Z",
            "v": 120000000
          },
          {
            "t": "2026-10-16T00:00:00Z",
            "v": -160000000
          },
          {
            "t": "2026-10-17T00:00:00Z",
            "v": 60000000
          },
          {
            "t": "2026-10-18T00:00:00Z",
            "v": -220000000
          },
          {
            "t": "2026-10-19T00:00:00Z",
            "v": -100000000
          },
          {
            "t": "2026-10-20T00:00:00Z",
            "v": 526700000
          }
        ]
      },
      {
        "type": "metric",
        "label": "Open interest",
        "value": 231498,
        "unit": "BTC",
        "delta": {
          "value": 0.7,
          "format": "percent"
        }
      }
    ]
  },
  {
    "title": "News Radar · Topics",
    "icon": "晓",
    "color": "#2589f5",
    "blocks": [
      {
        "type": "status",
        "label": "Most reported",
        "value": "美国房屋建筑商信心降至2012年以来最低，加拿大企业普遍考虑提价",
        "caption": "274 reports"
      },
      {
        "type": "status",
        "label": "Latest",
        "value": "Upbit上线MPLX韩元交易对，市场关注流动性变化"
      },
      {
        "type": "status",
        "label": "Latest",
        "value": "俄乌互袭升级：俄称打击乌物资设施"
      }
    ]
  },
  {
    "title": "Reading Room · Now Reading",
    "icon": "▣",
    "color": "#f59e0b",
    "blocks": [
      {
        "type": "progress",
        "label": "日本蜡烛图技术新解（典藏版）",
        "value": 50,
        "max": 100,
        "format": "percent",
        "caption": "史蒂夫·尼森 (Steve Nison)"
      },
      {
        "type": "progress",
        "label": "Trading Price Action Trends",
        "value": 5,
        "max": 100,
        "format": "percent"
      },
      {
        "type": "progress",
        "label": "技术革命与金融资本",
        "value": 82,
        "max": 100,
        "format": "percent"
      }
    ]
  },
  {
    "title": "AI Usage · Summary",
    "icon": "▥",
    "color": "#141823",
    "blocks": [
      {
        "type": "metric",
        "label": "Today · all 4 machines",
        "value": 91.69,
        "format": "currency",
        "delta": {
          "value": -44.7,
          "format": "percent",
          "label": "vs 7-day avg"
        }
      },
      {
        "type": "trend",
        "label": "Last 7 days",
        "style": "bar",
        "format": "currency",
        "points": [
          {
            "t": "2026-10-14T00:00:00Z",
            "v": 150
          },
          {
            "t": "2026-10-15T00:00:00Z",
            "v": 210
          },
          {
            "t": "2026-10-16T00:00:00Z",
            "v": 125
          },
          {
            "t": "2026-10-17T00:00:00Z",
            "v": 110
          },
          {
            "t": "2026-10-18T00:00:00Z",
            "v": 160
          },
          {
            "t": "2026-10-19T00:00:00Z",
            "v": 85
          },
          {
            "t": "2026-10-20T00:00:00Z",
            "v": 91.69
          }
        ]
      },
      {
        "type": "progress",
        "label": "Codex week used",
        "value": 5,
        "max": 100,
        "format": "percent"
      }
    ]
  }
];

// ---------------------------------------------------------------- cards with state

type Json = Record<string, unknown>;
const DAY = 86_400_000;
const isoDay = (back: number, now: number) => new Date(Math.floor(now / DAY) * DAY - back * DAY).toISOString();
const isoHour = (back: number, now: number) => new Date(Math.floor(now / 3_600_000) * 3_600_000 - back * 3_600_000).toISOString();
/** A repeatable wave for the fixtures' series (no randomness: every load draws the same). */
const wave = (i: number, base: number, amp: number) => Math.round((base + amp * Math.sin(i * 0.9) + (amp / 2) * Math.cos(i * 2.3)) * 100) / 100;

/** The interactive cards: app, widget, title, size, icon text and colour. */
export const liveCards = [
  { app: "todo", name: "today", title: "Todo · Today", size: "1x2", icon: "✓", color: "#16a34a" },
  { app: "capture", name: "inbox", title: "Quick Capture", size: "1x1", icon: "✎", color: "#7c3aed" },
  { app: "usage", name: "spend", title: "AI Usage · Spend", size: "2x1", icon: "▥", color: "#141823" },
  { app: "prompts", name: "library", title: "Prompt Shelf", size: "1x1", icon: "❝", color: "#0e7490" },
  { app: "market", name: "watchlist", title: "Market Board · Watchlist", size: "2x1", icon: "⌁", color: "#182e2c" },
  { app: "monitor", name: "sites", title: "Site Monitor · Checks", size: "1x1", icon: "◉", color: "#b45309" },
  { app: "ops", name: "overview", title: "Ops Overview", size: "2x2", icon: "▦", color: "#334155" },
] as const;

/**
 * The sources of the interactive cards, as an app would answer them: GET is the payload, POST an
 * action (`{ action, value }`). One action always fails (the bank call), so the error shows.
 */
export class PreviewSources {
  private todos = [
    { id: 1, text: "Buy milk", when: "today" },
    { id: 2, text: "Call the bank", when: "today" },
    { id: 3, text: "Review PR 241", when: "today" },
    { id: 4, text: "Book dentist", when: "this week" },
    { id: 5, text: "Renew passport", when: "this week" },
    { id: 6, text: "Water the plants", when: "today" },
    { id: 7, text: "Send invoice #118", when: "tomorrow" },
    { id: 8, text: "Plan the offsite", when: "next week" },
    { id: 9, text: "Backup the NAS", when: "Sunday" },
  ];
  private nextTodo = 10;
  private captured: { text: string; at: number }[] = [{ text: "Idea: widget views", at: Date.now() - 3_600_000 }];
  private prices = [
    { label: "BTC · Spot", value: 81400.3, decimals: 1, caption: "okx BTC-USDT" },
    { label: "ETH · Spot", value: 2381.17 },
    { label: "ZHIPU · Perp", value: 61.47 },
    { label: "XAU · Spot", value: 4114.5 },
    { label: "SOXL · Perp", value: 94.58 },
  ].map((p) => ({ ...p, open: p.value }));
  private ticks = 0;
  private lastRun = Date.now() - 12 * 60_000;
  private restarted = false;

  constructor(private readonly now = () => Date.now()) {}

  handle(app: string, name: string, method: string, body: Json | undefined): Json {
    const key = `${app}/${name}`;
    if (method === "POST") return this.act(key, body ?? {});
    switch (key) {
      case "todo/today": return this.todo();
      case "capture/inbox": return this.capture();
      case "usage/spend": return this.usage();
      case "prompts/library": return this.prompts();
      case "market/watchlist": return this.market();
      case "monitor/sites": return this.monitor();
      case "ops/overview": return this.ops();
    }
    return { ok: false, error: `no preview source ${key}` };
  }

  private act(key: string, b: Json): Json {
    const action = typeof b.action === "string" ? b.action : "";
    const value = typeof b.value === "string" ? b.value : "";
    if (key === "todo/today") {
      if (action === "add") {
        this.todos.push({ id: this.nextTodo++, text: value, when: "today" });
        return { ok: true, message: { en: "Added", zh: "已添加" } };
      }
      const id = Number(action.replace(/^done:/, ""));
      if (id === 2) return { ok: false, error: "the bank list is read-only" };
      this.todos = this.todos.filter((t) => t.id !== id);
      return { ok: true };
    }
    if (key === "capture/inbox" && action === "capture") {
      this.captured.push({ text: value, at: this.now() });
      return { ok: true, message: { en: "Saved to the inbox", zh: "已存入收件箱" } };
    }
    if (key === "monitor/sites") {
      if (action === "rerun") {
        this.lastRun = this.now();
        return { ok: true, message: { en: "Checks started", zh: "已开始检查" } };
      }
      if (action === "restart:api-center") {
        this.restarted = true;
        return { ok: true, message: { en: "api-center restarted", zh: "api-center 已重启" } };
      }
    }
    return { ok: false, error: "unknown action" };
  }

  private todo(): Json {
    const open = this.todos.length;
    return {
      ok: true,
      items: this.todos.map((t) => ({ text: t.text })),
      asOf: new Date(this.now()).toISOString(),
      blocks: [
        { type: "metric", label: { en: "Open tasks", zh: "待办" }, value: open, caption: { en: "tick one to finish it", zh: "勾选即完成" } },
        ...this.todos.map((t) => ({ type: "status", label: t.text, value: t.when, action: { id: `done:${t.id}`, kind: "check", label: { en: `Mark “${t.text}” done`, zh: `完成「${t.text}」` } } })),
      ],
      actions: [{ id: "add", kind: "input", label: { en: "Add", zh: "添加" }, placeholder: { en: "Add a task…", zh: "添加待办…" } }],
    };
  }

  private capture(): Json {
    const today = this.captured.length;
    const last = this.captured.at(-1);
    return {
      ok: true,
      items: this.captured.map((c) => ({ text: c.text })),
      asOf: new Date(this.now()).toISOString(),
      blocks: [
        { type: "metric", label: { en: "Captured today", zh: "今日记录" }, value: today },
        ...(last ? [{ type: "status", label: { en: "Last", zh: "最近" }, value: last.text, time: new Date(last.at).toISOString() }] : []),
      ],
      actions: [{ id: "capture", kind: "input", label: { en: "Capture", zh: "记录" }, placeholder: { en: "Jot something down…", zh: "随手记一笔…" } }],
    };
  }

  private usage(): Json {
    const now = this.now();
    const hours = Array.from({ length: 24 }, (_, i) => ({ t: isoHour(23 - i, now), v: i > 20 ? (i === 22 ? null : wave(i, 3.2, 1.8)) : wave(i, 3.2, 1.8) }));
    const week = Array.from({ length: 7 }, (_, i) => ({ t: isoDay(6 - i, now), v: wave(i, 120, 40) }));
    const month = Array.from({ length: 30 }, (_, i) => ({ t: isoDay(29 - i, now), v: i === 11 ? null : wave(i, 110, 45) }));
    const sum = (ps: { v: number | null }[]) => Math.round(ps.reduce((a, p) => a + (p.v ?? 0), 0) * 100) / 100;
    const view = (id: string, label: Json, spend: number, series: unknown[], style: string, deltaPct: number, calls: number) => ({
      id, label,
      blocks: [
        { type: "metric", label: { en: "Spend", zh: "费用" }, value: spend, format: "currency", delta: { value: deltaPct, format: "percent", label: { en: "vs previous", zh: "较上期" } } },
        { type: "trend", label: { en: "Spend over time", zh: "费用走势" }, style, format: "currency", points: series },
        { type: "metric", label: { en: "Model calls", zh: "模型调用" }, value: calls, format: "compact" },
        { type: "progress", label: { en: "Monthly budget", zh: "月度预算" }, value: Math.min(100, Math.round(sum(month) / 40)), max: 100, format: "percent" },
      ],
    });
    const views = [
      view("today", { en: "Today", zh: "今日" }, sum(hours), hours, "line", -12.4, 1840),
      view("7d", { en: "7 days", zh: "7 天" }, sum(week), week, "bar", 8.1, 12_960),
      view("30d", { en: "30 days", zh: "30 天" }, sum(month), month, "line", 3.6, 54_200),
    ];
    return { ok: true, items: [{ text: `Today $${sum(hours)}` }], asOf: new Date(now - 4 * 60_000).toISOString(), staleAfter: 3600, blocks: views[0]!.blocks, views };
  }

  private prompts(): Json {
    const p = [
      { label: "Daily standup", value: "Summarise yesterday", copy: "Summarise what I did yesterday from my commits and notes, in three bullet points, then list today's top two priorities." },
      { label: "Code review", value: "Strict reviewer", copy: "Review this diff as a strict senior engineer: correctness first, then naming, then tests. Quote the lines you mean." },
      { label: "Translate", value: "zh ⇄ en", copy: "Translate the following text between Chinese and English, keeping technical terms and Markdown intact.", url: "https://example.com/prompts/translate" },
    ];
    return {
      ok: true,
      items: p.map((x) => ({ text: x.label })),
      asOf: new Date(this.now() - 26 * 60_000).toISOString(),
      blocks: p.map((x) => ({ type: "status", label: x.label, value: x.value, copy: x.copy, ...(x.url ? { url: x.url } : {}) })),
    };
  }

  private market(): Json {
    // Every read moves the prices a little, as a live board would between two refreshes.
    this.ticks++;
    for (const [i, p] of this.prices.entries()) {
      const step = Math.sin(this.ticks * 1.7 + i * 2.1) * 0.004 + Math.cos(this.ticks * 0.6 + i) * 0.002;
      p.value = Math.round(p.value * (1 + step) * 100) / 100;
    }
    const now = this.now();
    const btc = this.prices[0]!;
    const history = Array.from({ length: 24 }, (_, i) => ({ t: isoHour(23 - i, now), v: Math.round(btc.open * (1 + Math.sin(i * 0.5) * 0.012 + i * 0.0006)) }));
    history.push({ t: new Date(now).toISOString(), v: Math.round(btc.value) });
    history.shift();
    return {
      ok: true,
      items: this.prices.map((p) => ({ text: `${p.label} ${p.value}` })),
      asOf: new Date(now).toISOString(),
      blocks: [
        ...this.prices.map((p, i) => {
          const change = Math.round(((p.value - p.open) / p.open) * 1000) / 10 - [1.9, 2.6, 3.6, 1.2, 7][i]!;
          return { type: "metric", label: p.label, value: p.value, ...(p.decimals ? { decimals: p.decimals } : {}), ...(p.caption ? { caption: p.caption } : {}),
            delta: { value: Math.round(change * 10) / 10, format: "percent", ...(i === 0 ? { label: "24h" } : {}), tone: change >= 0 ? "positive" : "negative" } };
        }),
        { type: "trend", label: "BTC · 24h", style: "line", decimals: 0, points: history },
      ],
    };
  }

  private monitor(): Json {
    const down = !this.restarted;
    return {
      ok: true,
      items: [{ text: down ? "3 of 4 sites up" : "4 of 4 sites up" }],
      asOf: new Date(this.lastRun).toISOString(),
      blocks: [
        { type: "status", label: { en: "Sites", zh: "站点" }, value: down ? { en: "3 of 4 up", zh: "4 个中 3 个正常" } : { en: "All 4 up", zh: "4 个全部正常" }, tone: down ? "warning" : "positive", time: new Date(this.lastRun).toISOString() },
        { type: "status", label: "api-center", value: down ? "down" : "up", tone: down ? "negative" : "positive",
          ...(down ? { action: { id: "restart:api-center", kind: "button", label: { en: "Restart", zh: "重启" }, confirm: { en: "Restart api-center now?", zh: "现在重启 api-center？" } } } : {}) },
        { type: "status", label: "ai-space.me", value: "up", tone: "positive" },
      ],
      actions: [{ id: "rerun", kind: "button", label: { en: "Run checks now", zh: "立即检查" }, confirm: { en: "Run all checks now?", zh: "现在运行全部检查？" } }],
    };
  }

  private ops(): Json {
    const now = this.now();
    const flow = Array.from({ length: 14 }, (_, i) => ({ t: isoDay(13 - i, now), v: wave(i, 0, 40) }));
    return {
      ok: true,
      items: [{ text: "Ops" }],
      asOf: new Date(now - 90_000).toISOString(),
      blocks: [
        { type: "trend", label: { en: "Requests, net change per day", zh: "请求量每日净变化" }, style: "bar", signed: true, unit: "k", points: flow },
        { type: "metric", label: "p95 latency", value: 182, unit: "ms", delta: { value: -6, format: "percent", tone: "positive" } },
        { type: "metric", label: "Error rate", value: 0.42, format: "percent", decimals: 2, tone: "positive" },
        { type: "progress", label: "Disk · seoul", value: 71, max: 100, format: "percent", tone: "warning" },
        { type: "progress", label: "Disk · david", value: 38, max: 100, format: "percent" },
        { type: "gauge", label: "CPU · mac", value: 64, display: "64%", zones: [{ to: 60, tone: "positive" }, { to: 85, tone: "warning" }, { to: 100, tone: "negative" }] },
        { type: "status", label: "Last deploy", value: "0.3.6 · seoul", time: new Date(now - 5 * 3_600_000).toISOString() },
        { type: "status", label: "Backups", value: "ok", tone: "positive", time: new Date(now - 9 * 3_600_000).toISOString() },
        { type: "metric", label: "Active apps", value: 23 },
        { type: "metric", label: "Agent runs today", value: 148, delta: { value: 12, format: "percent" } },
        { type: "trend", label: "Queue depth", style: "line", points: flow.map((p, i) => ({ t: p.t, v: Math.abs(wave(i, 12, 6)) })) },
        { type: "status", label: "Certificates", value: "renew in 21 days", tone: "neutral" },
      ],
    };
  }
}
