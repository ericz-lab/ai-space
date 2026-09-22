import type { Io } from "./types.ts";

/**
 * Tables for people, JSON for scripts. A table has fixed columns, widths
 * from its rows, relative times and no colour; `--json` prints exactly what
 * the route returned, `-q` drops the header line.
 */

export type Column<R> = {
  title: string;
  /** The cell: a value formatted by `cell`, or a function of the row. */
  get: (row: R) => unknown;
  align?: "left" | "right";
};

export class Printer {
  constructor(
    private readonly io: Io,
    readonly json: boolean,
    private readonly quiet: boolean,
  ) {}

  /** The route's answer, verbatim, on stdout. */
  data(value: unknown): void {
    this.io.out(JSON.stringify(value, null, 2));
  }

  line(text: string): void {
    this.io.out(text);
  }

  lines(text: string[]): void {
    for (const l of text) this.io.out(l);
  }

  /** `key  value` pairs, keys padded. Empty values are skipped. */
  kv(pairs: [string, unknown][]): void {
    const rows = pairs.filter(([, v]) => v !== undefined && v !== null && v !== "");
    const width = Math.max(0, ...rows.map(([k]) => k.length));
    for (const [k, v] of rows) this.io.out(`${k.padEnd(width)}  ${cell(v)}`);
  }

  table<R>(rows: R[], columns: Column<R>[], empty = "nothing to show"): void {
    if (rows.length === 0) {
      if (!this.quiet) this.io.err(empty);
      return;
    }
    for (const l of renderTable(rows, columns, { header: !this.quiet })) this.io.out(l);
  }
}

export function renderTable<R>(rows: R[], columns: Column<R>[], opts: { header?: boolean } = {}): string[] {
  const cells = rows.map((r) => columns.map((c) => cell(c.get(r))));
  const widths = columns.map((c, i) => Math.max(opts.header === false ? 0 : c.title.length, ...cells.map((row) => row[i]!.length)));
  const fmt = (row: string[]) =>
    row
      .map((v, i) => (columns[i]!.align === "right" ? v.padStart(widths[i]!) : v.padEnd(widths[i]!)))
      .join("  ")
      .replace(/\s+$/, "");
  const out: string[] = [];
  if (opts.header !== false) out.push(fmt(columns.map((c) => c.title.toUpperCase())));
  for (const row of cells) out.push(fmt(row));
  return out;
}

export function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return v.map(cell).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v).replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- formatters

/** `3m ago`, `2h ago`, `5d ago`; empty for nothing. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  if (ms < 0) return `in ${span(-ms)}`;
  if (ms < 5_000) return "just now";
  return `${span(ms)} ago`;
}

/** `in 12m`, `in 3h`; `overdue 4m` when the time has passed. */
export function until(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return iso;
  if (ms < 0) return `overdue ${span(-ms)}`;
  return `in ${span(ms)}`;
}

export function span(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ""}`;
}

export function duration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return span(ms);
}

export function bytes(n: number | undefined): string {
  if (n === undefined) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** `1.2k`, `3.4M` tokens. */
export function tokens(n: number | undefined): string {
  if (n === undefined) return "";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function usd(n: number | undefined): string {
  if (n === undefined) return "";
  return n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

export function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
