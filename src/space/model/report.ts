import type { LedgerScope, ModelStore } from "./store.ts";
import { type UsageTotals, type Window, WINDOW_MS } from "./types.ts";

/**
 * What `GET /api/model/usage` answers, and how a hub folds its peers' answers
 * into its own (docs/model-machines.md#ledger). A peer's rows keep who started
 * the call and where it ran: the app becomes `<peer>/<app>`, a row the peer ran
 * itself gets the peer as its machine, and a row the peer sent on to another
 * machine keeps that machine. So `david:gpt-6-luna` reads the same whether the
 * hub or a peer made the call.
 */

type Group<K extends string> = Record<K, string> & UsageTotals;

export type UsageReport = {
  window: Window;
  since: string;
  backend: string;
  totals: UsageTotals;
  byApp: Group<"app">[];
  byTag: Group<"app" | "tag" | "model" | "machine">[];
  byModel: Group<"model" | "machine">[];
  byRuntime: Group<"runtime" | "model">[];
  byBackend: Group<"backend" | "origin">[];
  byMachine: Group<"machine" | "runtime">[];
  /** The whole history, by UTC day: what the panel's grid, weekly bars and lifetime cards read. */
  history: { firstAt?: string; totals: UsageTotals; days: (UsageTotals & { day: string })[] };
};

/** One machine's ledger over a window. `scope.app` narrows the sums; the history stays the whole ledger's days. */
export function usageReport(store: ModelStore, window: Window, backend: string, scope: LedgerScope = {}, now = Date.now()): UsageReport {
  const since = now - WINDOW_MS[window];
  const all: LedgerScope = { skipCallers: scope.skipCallers, skipApps: scope.skipApps };
  const firstAt = store.firstAt(all);
  return {
    window,
    since: new Date(since).toISOString(),
    backend,
    totals: store.totals(since, scope),
    byApp: store.groupBy(["app"], since, scope),
    byTag: store.groupBy(["app", "tag", "model", "machine"], since, scope),
    byModel: store.groupBy(["model", "machine"], since, scope),
    byRuntime: store.groupBy(["runtime", "model"], since, scope),
    byBackend: store.groupBy(["backend", "origin"], since, scope),
    byMachine: store.groupBy(["machine", "runtime"], since, scope),
    history: { firstAt: firstAt === undefined ? undefined : new Date(firstAt).toISOString(), totals: store.totals(0, scope), days: store.days(0, all) },
  };
}

/** A peer's report as the hub shows it: apps under `<peer>/`, its own machine named, its backends marked. */
export function peerReport(peer: string, r: UsageReport): UsageReport {
  const app = (a: string) => `${peer}/${a}`;
  const machine = (m: string) => m || peer;
  return {
    ...r,
    byApp: r.byApp.map((g) => ({ ...g, app: app(g.app) })),
    byTag: r.byTag.map((g) => ({ ...g, app: app(g.app), machine: machine(g.machine ?? "") })),
    byModel: r.byModel.map((g) => ({ ...g, machine: machine(g.machine ?? "") })),
    byBackend: r.byBackend.map((g) => ({ ...g, backend: `${peer}:${g.backend}` })),
    byMachine: r.byMachine.map((g) => ({ ...g, machine: machine(g.machine) })),
  };
}

/** The hub's report with its peers' (already passed through `peerReport`) added in. */
export function mergeReports(local: UsageReport, peers: UsageReport[]): UsageReport {
  if (!peers.length) return local;
  const all = [local, ...peers];
  const firsts = all.map((r) => r.history.firstAt).filter((t): t is string => !!t).sort();
  return {
    ...local,
    totals: sum(all.map((r) => r.totals)),
    byApp: mergeGroups(all.map((r) => r.byApp), ["app"]),
    byTag: mergeGroups(all.map((r) => r.byTag), ["app", "tag", "model", "machine"]),
    byModel: mergeGroups(all.map((r) => r.byModel), ["model", "machine"]),
    byRuntime: mergeGroups(all.map((r) => r.byRuntime), ["runtime", "model"]),
    byBackend: mergeGroups(all.map((r) => r.byBackend), ["backend", "origin"]),
    byMachine: mergeGroups(all.map((r) => r.byMachine), ["machine", "runtime"]),
    history: {
      firstAt: firsts[0],
      totals: sum(all.map((r) => r.history.totals)),
      days: mergeGroups(all.map((r) => r.history.days), ["day"]).sort((a, b) => a.day.localeCompare(b.day)),
    },
  };
}

const TOTAL_KEYS = ["calls", "errors", "inputTokens", "cacheWriteTokens", "cacheReadTokens", "outputTokens", "tokens", "costUsd", "durationMs"] as const;

function sum(list: UsageTotals[]): UsageTotals {
  const out = Object.fromEntries(TOTAL_KEYS.map((k) => [k, 0])) as UsageTotals;
  for (const t of list) for (const k of TOTAL_KEYS) out[k] += t[k] ?? 0;
  return out;
}

/** Rows with the same keys added up, largest first by tokens, then by calls, as the store orders them. */
function mergeGroups<K extends string>(lists: (Record<K, string> & UsageTotals)[][], keys: readonly K[]): (Record<K, string> & UsageTotals)[] {
  const byKey = new Map<string, Record<K, string> & UsageTotals>();
  for (const list of lists) {
    for (const g of list) {
      const id = JSON.stringify(keys.map((k) => g[k] ?? ""));
      const prev = byKey.get(id);
      if (!prev) byKey.set(id, { ...g });
      else Object.assign(prev, sum([prev, g]));
    }
  }
  return [...byKey.values()].sort((a, b) => b.tokens - a.tokens || b.calls - a.calls);
}
