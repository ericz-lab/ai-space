import type { CallView, PeerLedger, PeerLedgerSource, UsageReport } from "../model/index.ts";
import type { Window } from "../model/types.ts";
import type { PeerHub } from "./hub.ts";

/**
 * The peers' model ledgers for the hub's usage page (docs/model-machines.md#ledger).
 * Each read asks every peer at once and waits a short time; a peer that does
 * not answer in time, or fails, is shown from its last good answer, marked
 * with the error. A peer that never answered contributes nothing, and its
 * calls the hub ran stay in the hub's own figures.
 */

export const LEDGER_TIMEOUT_MS = 4_000;

type Cached<T> = { space: string; data: T; asOf: string };

export class PeerLedgers implements PeerLedgerSource {
  private readonly cache = new Map<string, Cached<unknown>>();

  constructor(
    private readonly hub: PeerHub,
    /** This space's name (`SPACE_NAME`): a peer leaves out the calls this space sent it. */
    private readonly self: string,
    private readonly opts: { timeoutMs?: number; now?: () => number } = {},
  ) {}

  usage(window: Window): Promise<PeerLedger<UsageReport>[]> {
    return this.read<UsageReport>(`usage:${window}`, `/api/peer/model/usage?window=${window}`, (j) => {
      const { ok: _ok, name: _name, ...report } = j as UsageReport & { ok: true; name: string };
      return Array.isArray(report.byTag) && report.totals && report.history ? report : undefined;
    });
  }

  calls(limit: number): Promise<PeerLedger<CallView[]>[]> {
    return this.read<CallView[]>(`calls:${limit}`, `/api/peer/model/calls?limit=${limit}`, (j) => {
      const calls = (j as { calls?: unknown }).calls;
      return Array.isArray(calls) ? (calls as CallView[]).filter((c) => typeof c?.app === "string" && typeof c?.startedAt === "string") : undefined;
    });
  }

  private read<T>(key: string, path: string, parse: (j: unknown) => T | undefined): Promise<PeerLedger<T>[]> {
    const url = `${path}&skip=${encodeURIComponent(this.self)}`;
    return Promise.all(
      this.hub.names().map(async (peer): Promise<PeerLedger<T>> => {
        const client = this.hub.get(peer)!;
        const cacheKey = `${peer}|${key}`;
        const fallback = (error: string): PeerLedger<T> => {
          const c = this.cache.get(cacheKey) as Cached<T> | undefined;
          return c ? { peer, space: c.space, data: c.data, asOf: c.asOf, error } : { peer, space: client.snapshot?.name ?? "", error };
        };
        try {
          const r = await client.request(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? LEDGER_TIMEOUT_MS) });
          if (r.status === 404) return fallback("this peer runs an older ai-space without the ledger route");
          if (r.status === 401 || r.status === 403) return fallback("token rejected");
          if (!r.ok) return fallback(`HTTP ${r.status}`);
          const j = (await r.json()) as { ok?: boolean; name?: unknown; error?: unknown };
          if (j?.ok !== true) return fallback(typeof j?.error === "string" ? j.error : "not a ledger");
          const data = parse(j);
          if (data === undefined) return fallback("not a ledger");
          const space = typeof j.name === "string" ? j.name : (client.snapshot?.name ?? "");
          const asOf = new Date(this.now()).toISOString();
          this.cache.set(cacheKey, { space, data, asOf });
          return { peer, space, data, asOf };
        } catch (e) {
          const err = e as Error;
          return fallback(err.name === "TimeoutError" ? "no answer in time" : String(err.message ?? e).slice(0, 200));
        }
      }),
    );
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }
}
