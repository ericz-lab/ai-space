import { Database } from "bun:sqlite";
import { MODEL_COST_SQL } from "./pricing.ts";
import { type CallStatus, type ModelCall, type ModelCallInput, type Origin, type Usage, type UsageTotals } from "./types.ts";

/**
 * The ledger: one row per model call, in ai-space's own database next to the
 * scheduler tables. Same migration rule: extend ADDED_COLUMNS with nullable
 * columns, never rewrite tables. With a retention set, rows older than it are
 * pruned on insert; by default everything is kept, since the panel's history
 * (days recorded, totals, the daily grid) is read from here.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS model_calls (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  app                 TEXT NOT NULL,
  tag                 TEXT NOT NULL,
  model               TEXT NOT NULL,
  backend             TEXT NOT NULL,
  origin              TEXT NOT NULL,
  status              TEXT NOT NULL,
  error               TEXT,
  started_at          INTEGER NOT NULL,
  duration_ms         INTEGER NOT NULL,
  prompt_chars        INTEGER NOT NULL,
  output_chars        INTEGER,
  input_tokens        INTEGER,
  cache_write_tokens  INTEGER,
  cache_read_tokens   INTEGER,
  output_tokens       INTEGER,
  cost_usd            REAL
);
CREATE INDEX IF NOT EXISTS model_calls_started ON model_calls(started_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_app_started ON model_calls(app, started_at DESC);
`;

const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [{ table: "model_calls", column: "runtime", ddl: "TEXT" }, { table: "model_calls", column: "mode", ddl: "TEXT" }];

/** Days of ledger kept; 0 keeps everything (the default: the ledger is the history the panel shows). */
export const DEFAULT_RETENTION_DAYS = 0;

type Row = {
  id: number;
  app: string;
  tag: string;
  model: string;
  runtime: string | null;
  mode: ModelCall["mode"] | null;
  backend: string;
  origin: string;
  status: string;
  error: string | null;
  started_at: number;
  duration_ms: number;
  prompt_chars: number;
  output_chars: number | null;
  input_tokens: number | null;
  cache_write_tokens: number | null;
  cache_read_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  effective_cost_usd: number | null;
};

const TOTALS_SQL = `
  COUNT(*) AS calls,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(${MODEL_COST_SQL}), 0) AS cost_usd,
  COALESCE(SUM(duration_ms), 0) AS duration_ms`;

type TotalsRow = { calls: number; errors: number; input_tokens: number; cache_write_tokens: number; cache_read_tokens: number; output_tokens: number; cost_usd: number; duration_ms: number };

export type GroupTotals<K extends Record<string, string>> = K & UsageTotals;

export class ModelStore {
  readonly db: Database;
  private readonly retentionMs: number;

  constructor(path: string, opts: { retentionDays?: number } = {}) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    for (const { table, column, ddl } of ADDED_COLUMNS) {
      const cols = this.db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
    const days = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.retentionMs = days > 0 ? days * 86400_000 : 0;
  }

  close(): void {
    this.db.close();
  }

  add(c: ModelCallInput): ModelCall {
    const r = this.db
      .query(
        `INSERT INTO model_calls (app, tag, model, runtime, mode, backend, origin, status, error, started_at, duration_ms, prompt_chars, output_chars,
                                  input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.app,
        c.tag,
        c.model,
        c.runtime ?? null,
        c.mode ?? null,
        c.backend,
        c.origin,
        c.status,
        c.error ?? null,
        c.startedAt,
        c.durationMs,
        c.promptChars,
        c.outputChars ?? null,
        c.usage?.inputTokens ?? null,
        c.usage?.cacheWriteTokens ?? null,
        c.usage?.cacheReadTokens ?? null,
        c.usage?.outputTokens ?? null,
        c.costUsd ?? null,
      );
    if (this.retentionMs) this.db.query("DELETE FROM model_calls WHERE started_at < ?").run(c.startedAt - this.retentionMs);
    return { ...c, id: Number(r.lastInsertRowid), costUsd: this.get(Number(r.lastInsertRowid))?.costUsd };
  }

  /** Insert imported rows in one transaction, skipping those already present (same app, start, tag, duration). */
  addImported(rows: ModelCallInput[]): { imported: number; skipped: number } {
    const exists = this.db.query<{ n: number }, [string, number, string, number]>(
      "SELECT 1 AS n FROM model_calls WHERE app = ? AND started_at = ? AND tag = ? AND duration_ms = ? AND origin = 'import' LIMIT 1",
    );
    const insert = this.db.query(
      `INSERT INTO model_calls (app, tag, model, backend, origin, status, error, started_at, duration_ms, prompt_chars, output_chars,
                                input_tokens, cache_write_tokens, cache_read_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, 'import', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction((list: ModelCallInput[]) => {
      let imported = 0;
      let skipped = 0;
      for (const c of list) {
        if (exists.get(c.app, c.startedAt, c.tag, c.durationMs)) {
          skipped++;
          continue;
        }
        insert.run(
          c.app,
          c.tag,
          c.model,
          c.backend,
          c.status,
          c.error ?? null,
          c.startedAt,
          c.durationMs,
          c.promptChars,
          c.outputChars ?? null,
          c.usage?.inputTokens ?? null,
          c.usage?.cacheWriteTokens ?? null,
          c.usage?.cacheReadTokens ?? null,
          c.usage?.outputTokens ?? null,
          c.costUsd ?? null,
        );
        imported++;
      }
      return { imported, skipped };
    });
    return run(rows);
  }

  /** Start of the earliest row, or undefined when the ledger is empty. */
  firstAt(): number | undefined {
    return this.db.query<{ t: number | null }, []>("SELECT MIN(started_at) AS t FROM model_calls").get()?.t ?? undefined;
  }

  get(id: number): ModelCall | undefined {
    const row = this.db.query<Row, [number]>(`SELECT *, ${MODEL_COST_SQL} AS effective_cost_usd FROM model_calls WHERE id = ?`).get(id);
    return row ? rowToCall(row) : undefined;
  }

  list(opts: { app?: string; tag?: string; since?: number; limit?: number } = {}): ModelCall[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.app) {
      where.push("app = ?");
      args.push(opts.app);
    }
    if (opts.tag) {
      where.push("tag = ?");
      args.push(opts.tag);
    }
    if (opts.since !== undefined) {
      where.push("started_at >= ?");
      args.push(opts.since);
    }
    const sql = `SELECT *, ${MODEL_COST_SQL} AS effective_cost_usd FROM model_calls ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, id DESC LIMIT ?`;
    return this.db.query<Row, (string | number)[]>(sql).all(...args, limit).map(rowToCall);
  }

  totals(since: number, app?: string): UsageTotals {
    const row = app
      ? this.db.query<TotalsRow, [number, string]>(`SELECT ${TOTALS_SQL} FROM model_calls WHERE started_at >= ? AND app = ?`).get(since, app)
      : this.db.query<TotalsRow, [number]>(`SELECT ${TOTALS_SQL} FROM model_calls WHERE started_at >= ?`).get(since);
    return totalsOf(row);
  }

  /** Sums grouped by one or more columns, largest first by tokens. */
  groupBy<K extends readonly ("app" | "tag" | "model" | "runtime" | "backend" | "origin")[]>(keys: K, since: number, app?: string): GroupTotals<Record<K[number], string>>[] {
    const cols = keys.join(", ");
    const sql = `SELECT ${cols}, ${TOTALS_SQL} FROM model_calls WHERE started_at >= ?${app ? " AND app = ?" : ""} GROUP BY ${cols}
                 ORDER BY (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(cache_write_tokens), 0) + COALESCE(SUM(cache_read_tokens), 0) + COALESCE(SUM(output_tokens), 0)) DESC, calls DESC`;
    const rows = app
      ? this.db.query<TotalsRow & Record<string, string | number>, [number, string]>(sql).all(since, app)
      : this.db.query<TotalsRow & Record<string, string | number>, [number]>(sql).all(since);
    return rows.map((r) => {
      const out = { ...totalsOf(r) } as Record<string, string | number>;
      // Rows from before runtimes were named have none; the panel shows them under the empty group.
      for (const k of keys) out[k] = r[k] === null || r[k] === undefined ? "" : String(r[k]);
      return out as GroupTotals<Record<K[number], string>>;
    });
  }

  /** Per-day sums (UTC days) since a point in time, oldest first. */
  days(since: number): (UsageTotals & { day: string })[] {
    return this.db
      .query<TotalsRow & { day: string }, [number]>(
        `SELECT strftime('%Y-%m-%d', started_at / 1000, 'unixepoch') AS day, ${TOTALS_SQL} FROM model_calls WHERE started_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(since)
      .map((r) => ({ day: r.day, ...totalsOf(r) }));
  }

  /** How many calls of an app are in flight or done since a point in time; for the API's concurrency view. */
  count(since: number): number {
    return this.db.query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM model_calls WHERE started_at >= ?").get(since)?.n ?? 0;
  }
}

function totalsOf(r: TotalsRow | null | undefined): UsageTotals {
  const inputTokens = r?.input_tokens ?? 0;
  const cacheWriteTokens = r?.cache_write_tokens ?? 0;
  const cacheReadTokens = r?.cache_read_tokens ?? 0;
  const outputTokens = r?.output_tokens ?? 0;
  return {
    calls: r?.calls ?? 0,
    errors: r?.errors ?? 0,
    inputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    outputTokens,
    tokens: inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens,
    costUsd: r?.cost_usd ?? 0,
    durationMs: r?.duration_ms ?? 0,
  };
}

function rowToCall(r: Row): ModelCall {
  const usage: Usage | undefined =
    r.input_tokens === null && r.output_tokens === null
      ? undefined
      : { inputTokens: r.input_tokens ?? 0, cacheWriteTokens: r.cache_write_tokens ?? 0, cacheReadTokens: r.cache_read_tokens ?? 0, outputTokens: r.output_tokens ?? 0 };
  return {
    id: r.id,
    app: r.app,
    tag: r.tag,
    model: r.model,
    runtime: r.runtime ?? undefined,
    ...(r.mode ? { mode: r.mode } : {}),
    backend: r.backend,
    origin: r.origin as Origin,
    status: r.status as CallStatus,
    error: r.error ?? undefined,
    startedAt: r.started_at,
    durationMs: r.duration_ms,
    promptChars: r.prompt_chars,
    outputChars: r.output_chars ?? undefined,
    usage,
    costUsd: r.effective_cost_usd ?? undefined,
  };
}
