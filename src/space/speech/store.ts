import { Database } from "bun:sqlite";
import { repriceBasis, type Price } from "../prices/price.ts";
import type { PriceBasis } from "../runtimes/types.ts";
import type { SpeechCall, SpeechCallInput, SpeechTotals, SpeechTrace } from "./types.ts";

/**
 * The speech ledger (docs/speech.md#ledger): one row per call in ai-space's own database, next to the
 * model ledger and with its rules: a failure is a row too, sizes are kept and audio and text are not,
 * new columns are added nullable and tables never rewritten.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS speech_calls (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  app            TEXT NOT NULL,
  tag            TEXT NOT NULL,
  capability     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  kind           TEXT NOT NULL,
  machine        TEXT,
  status         TEXT NOT NULL,
  error          TEXT,
  started_at     INTEGER NOT NULL,
  duration_ms    INTEGER NOT NULL,
  input_bytes    INTEGER,
  audio_seconds  REAL,
  chars          INTEGER,
  voice          TEXT,
  language       TEXT,
  cost_usd       REAL,
  fallback_from  TEXT,
  tries          INTEGER,
  trace          TEXT
);
CREATE INDEX IF NOT EXISTS speech_calls_started ON speech_calls(started_at DESC);
CREATE INDEX IF NOT EXISTS speech_calls_app_started ON speech_calls(app, started_at DESC);
`;

type Row = {
  id: number; app: string; tag: string; capability: string; provider: string; kind: string; machine: string | null;
  status: string; error: string | null; started_at: number; duration_ms: number; input_bytes: number | null;
  audio_seconds: number | null; chars: number | null; voice: string | null; language: string | null; cost_usd: number | null;
  fallback_from: string | null; tries: number | null; trace: string | null;
};

const TOTALS_SQL = `
  COUNT(*) AS calls,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  COALESCE(SUM(audio_seconds), 0) AS audio_seconds,
  COALESCE(SUM(chars), 0) AS chars,
  COALESCE(SUM(cost_usd), 0) AS cost_usd,
  SUM(CASE WHEN price_basis IS NOT NULL AND cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
  COALESCE(SUM(duration_ms), 0) AS duration_ms`;

type TotalsRow = { calls: number; errors: number | null; audio_seconds: number; chars: number; cost_usd: number; unpriced: number | null; duration_ms: number };

export const SPEECH_WINDOWS = { "5h": 5 * 3600_000, "24h": 86400_000, "7d": 7 * 86400_000, "30d": 30 * 86400_000 } as const;
export type SpeechWindow = keyof typeof SPEECH_WINDOWS;

export type SpeechUsage = {
  window: SpeechWindow;
  since: number;
  totals: SpeechTotals;
  byProvider: (SpeechTotals & { provider: string; kind: string; capability: string })[];
  byApp: (SpeechTotals & { app: string; tag: string; capability: string })[];
};

export class SpeechStore {
  readonly db: Database;

  constructor(path: string | Database) {
    this.db = typeof path === "string" ? new Database(path, { create: true }) : path;
    if (typeof path === "string") this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Added later, nullable (docs/speech.md#ledger): the gateway's answer, to price the call again.
    if (!this.db.query<{ name: string }, []>("PRAGMA table_info(speech_calls)").all().some((c) => c.name === "price_basis")) this.db.exec("ALTER TABLE speech_calls ADD COLUMN price_basis TEXT");
  }

  /** Cost the built-in gateway's rows again at today's prices; a row whose provider is gone is left. Returns the rows changed. */
  reprice(priceOf: (served: string) => Price | undefined | null): number {
    const rows = this.db.query<{ id: number; cost_usd: number | null; price_basis: string }, []>("SELECT id, cost_usd, price_basis FROM speech_calls WHERE price_basis IS NOT NULL").all();
    const update = this.db.query("UPDATE speech_calls SET cost_usd = ? WHERE id = ?");
    let changed = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        let basis: PriceBasis;
        try {
          basis = JSON.parse(r.price_basis) as PriceBasis;
        } catch {
          continue;
        }
        if (!Array.isArray(basis)) continue;
        const next = repriceBasis(basis, priceOf);
        if (next === "keep") continue;
        const cost = next.costUsd === undefined ? null : Math.round(next.costUsd * 1e6) / 1e6;
        if (cost === r.cost_usd) continue;
        update.run(cost, r.id);
        changed++;
      }
    })();
    return changed;
  }

  add(input: SpeechCallInput): SpeechCall {
    const row = this.db
      .query<{ id: number }, (string | number | null)[]>(
        `INSERT INTO speech_calls (app, tag, capability, provider, kind, machine, status, error, started_at, duration_ms, input_bytes, audio_seconds, chars, voice, language, cost_usd, fallback_from, tries, trace, price_basis)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.app, input.tag, input.capability, input.provider, input.kind, input.machine || null, input.status, input.error?.slice(0, 1000) ?? null,
        input.startedAt, Math.max(0, Math.round(input.durationMs)), input.inputBytes ?? null, input.audioSeconds ?? null, input.chars ?? null,
        input.voice || null, input.language || null, input.costUsd ?? null, input.fallbackFrom ?? null, input.tries ?? null, input.trace ? JSON.stringify(input.trace) : null,
        input.priceBasis?.length ? JSON.stringify(input.priceBasis) : null,
      )!;
    return { ...input, id: row.id };
  }

  recent(opts: { app?: string; limit?: number } = {}): SpeechCall[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const rows = opts.app
      ? this.db.query<Row, [string, number]>("SELECT * FROM speech_calls WHERE app = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(opts.app, limit)
      : this.db.query<Row, [number]>("SELECT * FROM speech_calls ORDER BY started_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map(fromRow);
  }

  usage(window: SpeechWindow, opts: { app?: string; now?: number } = {}): SpeechUsage {
    const since = (opts.now ?? Date.now()) - SPEECH_WINDOWS[window];
    const where = opts.app ? "WHERE started_at >= ? AND app = ?" : "WHERE started_at >= ?";
    const args: (string | number)[] = opts.app ? [since, opts.app] : [since];
    const totals = this.db.query<TotalsRow, (string | number)[]>(`SELECT ${TOTALS_SQL} FROM speech_calls ${where}`).get(...args)!;
    const byProvider = this.db
      .query<TotalsRow & { provider: string; kind: string; capability: string }, (string | number)[]>(`SELECT provider, kind, capability, ${TOTALS_SQL} FROM speech_calls ${where} GROUP BY provider, kind, capability ORDER BY calls DESC`)
      .all(...args)
      .map((r) => ({ provider: r.provider, kind: r.kind, capability: r.capability, ...totalsOf(r) }));
    const byApp = this.db
      .query<TotalsRow & { app: string; tag: string; capability: string }, (string | number)[]>(`SELECT app, tag, capability, ${TOTALS_SQL} FROM speech_calls ${where} GROUP BY app, tag, capability ORDER BY calls DESC`)
      .all(...args)
      .map((r) => ({ app: r.app, tag: r.tag, capability: r.capability, ...totalsOf(r) }));
    return { window, since, totals: totalsOf(totals), byProvider, byApp };
  }

  /** The newest success of each provider, to seed the status cells at boot. */
  lastOk(): Map<string, number> {
    const rows = this.db.query<{ provider: string; at: number }, []>("SELECT provider, MAX(started_at) AS at FROM speech_calls WHERE status = 'ok' GROUP BY provider").all();
    return new Map(rows.map((r) => [r.provider, r.at]));
  }
}

function totalsOf(r: TotalsRow): SpeechTotals {
  return { calls: r.calls, errors: r.errors ?? 0, audioSeconds: Math.round(r.audio_seconds * 1000) / 1000, chars: r.chars, costUsd: Math.round(r.cost_usd * 1e6) / 1e6, unpriced: r.unpriced ?? 0, durationMs: r.duration_ms };
}

function fromRow(r: Row): SpeechCall {
  return {
    id: r.id, app: r.app, tag: r.tag, capability: r.capability as SpeechCall["capability"], provider: r.provider, kind: r.kind,
    ...(r.machine ? { machine: r.machine } : {}), status: r.status as SpeechCall["status"], ...(r.error ? { error: r.error } : {}),
    startedAt: r.started_at, durationMs: r.duration_ms,
    ...(r.input_bytes !== null ? { inputBytes: r.input_bytes } : {}), ...(r.audio_seconds !== null ? { audioSeconds: r.audio_seconds } : {}),
    ...(r.chars !== null ? { chars: r.chars } : {}), ...(r.voice ? { voice: r.voice } : {}), ...(r.language ? { language: r.language } : {}),
    ...(r.cost_usd !== null ? { costUsd: r.cost_usd } : {}), ...(r.fallback_from ? { fallbackFrom: r.fallback_from } : {}),
    ...(r.tries !== null ? { tries: r.tries } : {}), ...(r.trace ? { trace: JSON.parse(r.trace) as SpeechTrace } : {}),
  };
}
