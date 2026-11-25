/**
 * Copy Model Watch's prices into ai-space (docs/model-gateway.md#from-model-watch).
 *
 *   bun run sync-prices [path/to/model-watch/main.db]
 *
 * Reads Model Watch's database read-only (default ~/.ai-space/data/model-watch/main.db; the app
 * need not be running) and writes src/space/gateway/model-watch-prices.json in a stable order, so a
 * diff shows only what changed on the vendors' pages. Commit the file and deploy to publish it.
 */
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WatchFile, WatchRow, WatchSource } from "../src/space/gateway/model-watch.ts";

export const PRICES_OUT = join(import.meta.dir, "..", "src", "space", "gateway", "model-watch-prices.json");

const host = (url: string | null) => {
  try {
    return url ? new URL(url).host : null;
  } catch {
    return null;
  }
};

/** The prices still on their pages, from enabled sources with a pricing page, ordered by source and key. */
export function readModelWatch(dbPath: string, syncedAt = new Date()): WatchFile {
  const db = new Database(dbPath, { readonly: true });
  try {
    type S = { id: string; name: string; pricing_url: string | null; pricing_checked_at: string | null; pricing_error: string | null };
    type P = { source_id: string; price_key: string; model_id: string; name: string; variant: string; currency: string | null; unit: string | null; input: number | null; cached_input: number | null; output: number | null; text: string | null };
    const srcs = db.query("SELECT id, name, pricing_url, pricing_checked_at, pricing_error FROM sources WHERE enabled = 1 AND pricing_url IS NOT NULL ORDER BY id").all() as S[];
    const rows = db.query("SELECT p.* FROM prices p JOIN sources s ON s.id = p.source_id WHERE p.present = 1 AND s.enabled = 1 AND s.pricing_url IS NOT NULL ORDER BY p.source_id, p.price_key").all() as P[];
    const prices: (WatchRow & { text: string | null })[] = rows.map((r) => ({
      source: r.source_id, id: r.model_id, name: r.name, variant: r.variant ?? "", currency: r.currency, unit: r.unit,
      input: r.input, cachedInput: r.cached_input, output: r.output, text: r.text,
    }));
    const sources: WatchSource[] = srcs.map((s) => ({
      id: s.id, name: s.name, pricingUrl: s.pricing_url, site: host(s.pricing_url),
      currencies: [...new Set(prices.filter((r) => r.source === s.id && r.currency).map((r) => r.currency!))].sort(),
      checkedAt: s.pricing_checked_at, error: s.pricing_error,
    }));
    return { syncedAt: syncedAt.toISOString(), from: "Model Watch (model-watch/main.db)", sources, prices };
  } finally {
    db.close();
  }
}

/** The file's text: one source or row per line, so a diff names the rows that changed. */
export function formatPrices(f: WatchFile): string {
  const lines = (xs: unknown[]) => xs.map((x) => `    ${JSON.stringify(x)}`).join(",\n");
  return `{\n  "syncedAt": ${JSON.stringify(f.syncedAt)},\n  "from": ${JSON.stringify(f.from)},\n  "sources": [\n${lines(f.sources)}\n  ],\n  "prices": [\n${lines(f.prices)}\n  ]\n}\n`;
}

/** What changed between two copies, by row: added, removed, changed. */
export function diffPrices(before: WatchFile | undefined, after: WatchFile): { added: string[]; removed: string[]; changed: string[] } {
  const key = (r: WatchRow) => `${r.source}/${r.id}${r.variant ? ` [${r.variant}]` : ""} (${r.unit ?? "?"})`;
  const map = (f: WatchFile | undefined) => new Map((f?.prices ?? []).map((r) => [key(r), JSON.stringify(r)]));
  const a = map(before);
  const b = map(after);
  return {
    added: [...b.keys()].filter((k) => !a.has(k)),
    removed: [...a.keys()].filter((k) => !b.has(k)),
    changed: [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k)),
  };
}

if (import.meta.main) {
  const dbPath = process.argv[2] ?? join(homedir(), ".ai-space", "data", "model-watch", "main.db");
  if (!(await Bun.file(dbPath).exists())) {
    console.error(`no Model Watch database at ${dbPath}`);
    process.exit(1);
  }
  const before = await Bun.file(PRICES_OUT).json().catch(() => undefined) as WatchFile | undefined;
  const after = readModelWatch(dbPath);
  const d = diffPrices(before, after);
  if (before && !d.added.length && !d.removed.length && !d.changed.length && JSON.stringify(before.sources) === JSON.stringify(after.sources)) {
    console.log(`no change: ${after.prices.length} rows of ${after.sources.length} pages (file left as it was)`);
  } else {
    await Bun.write(PRICES_OUT, formatPrices(after));
    console.log(`${after.prices.length} rows of ${after.sources.length} pages written to ${PRICES_OUT}`);
    for (const [label, ks] of [["added", d.added], ["removed", d.removed], ["changed", d.changed]] as const) {
      if (ks.length) console.log(`${label} ${ks.length}: ${ks.slice(0, 20).join("; ")}${ks.length > 20 ? "; …" : ""}`);
    }
  }
}
