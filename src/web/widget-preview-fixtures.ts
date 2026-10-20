import type { WidgetBlock } from "./WidgetBlocks.tsx";

// Fixed demonstration data; this preview never reads a live Space.
export const previewCards: { title: string; icon: string; color: string; size?: string; blocks: WidgetBlock[] }[] = [
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
  },
  {
    "title": "Market Board · Watchlist",
    "icon": "⌁",
    "color": "#182e2c",
    "size": "2x1",
    "blocks": [
      {
        "type": "metric",
        "label": "BTC · Spot",
        "value": 81400.3,
        "decimals": 1,
        "caption": "okx BTC-USDT",
        "delta": {
          "value": -1.9,
          "format": "percent",
          "label": "24h",
          "tone": "negative"
        }
      },
      {
        "type": "metric",
        "label": "ETH · Spot",
        "value": 2381.17,
        "delta": {
          "value": -2.6,
          "format": "percent",
          "tone": "negative"
        }
      },
      {
        "type": "metric",
        "label": "ZHIPU · Perp",
        "value": 61.47,
        "delta": {
          "value": -3.6,
          "format": "percent",
          "tone": "negative"
        }
      },
      {
        "type": "metric",
        "label": "XAU · Spot",
        "value": 4114.5,
        "delta": {
          "value": -1.2,
          "format": "percent",
          "tone": "negative"
        }
      },
      {
        "type": "metric",
        "label": "SOXL · Perp",
        "value": 94.58,
        "delta": {
          "value": -7,
          "format": "percent",
          "tone": "negative"
        }
      }
    ]
  }
];
