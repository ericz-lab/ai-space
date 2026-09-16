import { APP_PATTERN, type ModelCallInput, TAG_PATTERN } from "./types.ts";
import type { ModelStore } from "./store.ts";

/**
 * Import of an app's own call history into the ledger, for apps that kept
 * their own table before the model service existed. One JSON object per
 * line; the shape mirrors a ledger row with the names an app is likely to
 * have used. Imported rows carry `origin: import` so the panel can tell them
 * from calls the service ran, and a row already imported (same app, start
 * time, tag and duration) is skipped, so the command can be run again.
 *
 *   { "ts": "2026-07-13T03:56:41.893Z", "tag": "translate", "model": "haiku", "backend": "ssh:box",
 *     "ok": true, "durationMs": 5399, "promptChars": 592, "outputChars": 199,
 *     "inputTokens": 10, "outputTokens": 150, "cacheReadTokens": 22000, "cacheWriteTokens": 0, "costUsd": 0.0027 }
 *
 * `cacheTokens` (one figure for both cache kinds) is accepted and stored as
 * cache reads: an app that did not split them cannot be split now, and reads
 * are what the CLI's fixed prefix produces.
 */

export type ImportLine = {
  ts: string;
  tag?: string;
  model: string;
  backend?: string;
  ok: boolean;
  error?: string;
  durationMs: number;
  promptChars?: number;
  outputChars?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  cacheTokens?: number | null;
  costUsd?: number | null;
};

export function parseImportLine(app: string, raw: unknown, lineNo: number): ModelCallInput {
  const at = `line ${lineNo}`;
  if (!raw || typeof raw !== "object") throw new Error(`${at}: not an object`);
  const r = raw as Record<string, unknown>;
  const startedAt = typeof r.ts === "string" ? Date.parse(r.ts) : typeof r.ts === "number" ? r.ts : Number.NaN;
  if (!Number.isFinite(startedAt)) throw new Error(`${at}: ts must be an ISO date or epoch milliseconds`);
  const tag = r.tag === undefined ? "other" : r.tag;
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) throw new Error(`${at}: invalid tag`);
  if (typeof r.model !== "string" || !r.model.trim()) throw new Error(`${at}: model is required`);
  const backend = r.backend === undefined ? "unknown" : r.backend;
  if (typeof backend !== "string" || !backend.trim()) throw new Error(`${at}: backend must be a string`);
  const ok = r.ok === true || r.ok === 1;
  if (r.ok !== true && r.ok !== false && r.ok !== 0 && r.ok !== 1) throw new Error(`${at}: ok must be boolean`);
  const num = (k: string, required = false): number | undefined => {
    const v = r[k];
    if (v === undefined || v === null) {
      if (required) throw new Error(`${at}: ${k} is required`);
      return undefined;
    }
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${at}: ${k} must be a number`);
    return v;
  };
  const inputTokens = num("inputTokens");
  const outputTokens = num("outputTokens");
  const cacheReadTokens = num("cacheReadTokens") ?? num("cacheTokens");
  const cacheWriteTokens = num("cacheWriteTokens");
  const usage =
    inputTokens === undefined && outputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined
      ? undefined
      : { inputTokens: inputTokens ?? 0, cacheWriteTokens: cacheWriteTokens ?? 0, cacheReadTokens: cacheReadTokens ?? 0, outputTokens: outputTokens ?? 0 };
  return {
    app,
    tag,
    model: r.model.trim(),
    backend: backend.trim(),
    origin: "import",
    status: ok ? "ok" : "error",
    error: ok ? undefined : typeof r.error === "string" ? r.error : "failed",
    startedAt: Math.round(startedAt),
    durationMs: Math.max(0, Math.round(num("durationMs", true)!)),
    promptChars: Math.max(0, Math.round(num("promptChars") ?? 0)),
    outputChars: num("outputChars"),
    usage,
    costUsd: num("costUsd"),
  };
}

export type ImportSummary = { read: number; imported: number; skipped: number };

/** Import JSON lines text for an app. Throws on the first malformed line; nothing is written then. */
export function importCalls(store: ModelStore, app: string, text: string): ImportSummary {
  if (!APP_PATTERN.test(app)) throw new Error(`invalid app name: ${app}`);
  const rows: ModelCallInput[] = [];
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo++;
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`line ${lineNo}: not JSON`);
    }
    rows.push(parseImportLine(app, parsed, lineNo));
  }
  const result = store.addImported(rows);
  return { read: rows.length, ...result };
}
