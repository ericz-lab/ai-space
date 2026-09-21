/**
 * Service health probe with a short cache, so listing apps costs at most one
 * loopback request per service every `ttlMs`. Service supervision is not
 * implemented yet; the probe is what tells the panel "up" from "down".
 *
 * `check` waits for the probe; `peek` answers from the cache at once (the
 * last result, or "unknown" before the first) and refreshes it in the
 * background, so a list of apps never waits on a service that is slow to
 * answer or not answering at all.
 */

export type Health = "ok" | "down";

export class HealthProbe {
  private readonly cache = new Map<string, { at: number; health: Health }>();
  private readonly inflight = new Map<string, Promise<Health>>();

  constructor(
    private readonly opts: { ttlMs?: number; timeoutMs?: number; fetch?: typeof fetch } = {},
  ) {}

  async check(port: number, path: string): Promise<Health> {
    const url = `http://127.0.0.1:${port}${path}`;
    const hit = this.cache.get(url);
    if (hit && !this.expired(hit)) return hit.health;
    return this.probe(url);
  }

  peek(port: number, path: string): Health | "unknown" {
    const url = `http://127.0.0.1:${port}${path}`;
    const hit = this.cache.get(url);
    if (!hit || this.expired(hit)) void this.probe(url);
    return hit?.health ?? "unknown";
  }

  /** Resolves once every probe started so far has recorded its result. */
  async settle(): Promise<void> {
    await Promise.all(this.inflight.values());
  }

  private expired(hit: { at: number }) {
    return Date.now() - hit.at >= (this.opts.ttlMs ?? 15_000);
  }

  /** One probe per url at a time: concurrent callers share the request in flight. */
  private probe(url: string): Promise<Health> {
    let p = this.inflight.get(url);
    if (p) return p;
    p = (async () => {
      let health: Health = "down";
      try {
        const r = await (this.opts.fetch ?? fetch)(url, { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 2_000) });
        health = r.ok ? "ok" : "down";
      } catch {
        health = "down";
      }
      this.cache.set(url, { at: Date.now(), health });
      this.inflight.delete(url);
      return health;
    })();
    this.inflight.set(url, p);
    return p;
  }
}
