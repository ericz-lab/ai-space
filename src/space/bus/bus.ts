import { matches } from "../scheduler/events.ts";
import type { SpaceEvent } from "../scheduler/types.ts";
import type { BusStore } from "./store.ts";
import {
  ACK_TIMEOUT_MS,
  type CallRecord,
  type Capability,
  DELIVERY_TIMEOUT_MS,
  type Delivery,
  type DeliveryPayload,
  type EventConsumption,
  type EventPublication,
  type EventsSpec,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  deliveryPayload,
} from "./types.ts";

/**
 * The bus: deliveries and calls between apps, through ai-space.
 *
 * Every event the scheduler stores comes through `onEvent`. For each app whose
 * `events.consumes` matches it (http or stream kinds; task kinds are the
 * scheduler's triggers) one delivery row is written. Then:
 *
 * - http: a worker POSTs the event to the app's service on loopback. 2xx ends
 *   it; a 5xx, 408, 429 or a connection error retries after RETRY_DELAYS_MS,
 *   any other 4xx is final; after MAX_ATTEMPTS the delivery is dead and
 *   `onDead` fires once (the notify hook).
 * - stream: the delivery waits for the app to hold `GET /api/events/stream`
 *   open; it is pushed as `sent`, and the app acks it. Not acked within
 *   ACK_TIMEOUT_MS, it goes back to pending and is pushed again on the next
 *   connection, MAX_ATTEMPTS times.
 *
 * At-least-once, in order per app and kind; consumers dedupe on the event id.
 * A call (`call`) is synchronous: forwarded to the capability's path on the
 * app's service with the caller's name in a header, answered with whatever the
 * app answered, and recorded.
 *
 * Like the scheduler, the worker is one timer aimed at the earliest due row,
 * clamped so it recovers after a suspend; a tick delivers to different apps in
 * parallel and to one app in order.
 */

const MAX_TIMER_DELAY_MS = 60_000;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type BusOptions = {
  store: BusStore;
  /** The scheduler's event store: a delivery carries an event id, the payload comes from here. */
  events: { getEvent(id: number): SpaceEvent | undefined };
  /** Loopback port of an app's service; undefined = it has none (deliveries are skipped, calls answer 503). */
  servicePort: (app: string) => number | undefined;
  fetch?: Fetch;
  now?: () => number;
  log?: (message: string) => void;
  /** Called once per delivery the bus gives up on. */
  onDead?: (delivery: Delivery, event: SpaceEvent | undefined) => void;
};

export type AppBusSpec = { events?: EventsSpec; provides?: Capability[] };

export type StreamListener = (payload: DeliveryPayload) => void;

export type CallRequest = {
  body?: ArrayBuffer | string | null;
  contentType?: string;
  accept?: string;
  signal?: AbortSignal;
};

export type CallResult = { status: number; contentType?: string; body: ArrayBuffer; record: CallRecord };

/** A call that never reached the app: `status` is what the API answers with. */
export class CallError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AppCapabilities = { app: string; provides: Capability[]; publishes: EventPublication[]; consumes: EventConsumption[] };

export class Bus {
  private readonly store: BusStore;
  private readonly events: BusOptions["events"];
  private readonly servicePort: BusOptions["servicePort"];
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly onDead?: BusOptions["onDead"];
  private readonly specs = new Map<string, { events: EventsSpec; provides: Capability[] }>();
  private readonly listeners = new Map<string, Set<StreamListener>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private ticking: Promise<void> | null = null;

  constructor(opts: BusOptions) {
    this.store = opts.store;
    this.events = opts.events;
    this.servicePort = opts.servicePort;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[bus] ${m}`));
    this.onDead = opts.onDead;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.tick();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resolves once no tick is in flight. */
  async idle(): Promise<void> {
    while (this.ticking) await this.ticking.catch(() => {});
  }

  // ---------------------------------------------------------------- manifests

  /** Register (or replace) what an app publishes, consumes and provides. */
  syncApp(app: string, spec: AppBusSpec): void {
    const events = spec.events ?? { publishes: [], consumes: [] };
    const provides = spec.provides ?? [];
    this.specs.set(app, { events, provides });
    const http = events.consumes.filter((c) => c.kind === "http").length;
    const stream = events.consumes.filter((c) => c.kind === "stream").length;
    if (http || stream || provides.length || events.publishes.length) {
      this.log(`synced ${app}: publishes ${events.publishes.length}, subscribes http ${http} stream ${stream}, provides ${provides.length}`);
    }
  }

  forget(app: string): void {
    this.specs.delete(app);
  }

  apps(): string[] {
    return [...this.specs.keys()].sort();
  }

  capabilities(): AppCapabilities[] {
    return this.apps().map((app) => {
      const s = this.specs.get(app)!;
      return { app, provides: s.provides, publishes: s.events.publishes, consumes: s.events.consumes };
    });
  }

  capability(app: string, name: string): Capability | undefined {
    return this.specs.get(app)?.provides.find((c) => c.name === name);
  }

  // ---------------------------------------------------------------- events in

  /** One delivery per matching http / stream subscription of every app; pushes stream ones right away. */
  onEvent(event: SpaceEvent): Delivery[] {
    const now = this.now();
    const created: Delivery[] = [];
    let kick = false;
    for (const [app, spec] of this.specs) {
      const targets = new Set<string>();
      for (const c of spec.events.consumes) {
        if (c.kind === "task") continue;
        if (!matches({ event: c.event, ...(c.filter ? { filter: c.filter } : {}) }, event)) continue;
        // Two subscriptions of one app landing on the same target (`feed/*` and `feed/x`) deliver once.
        const key = c.kind === "http" ? `http ${c.method} ${c.path}` : "stream";
        if (targets.has(key)) continue;
        targets.add(key);
        const d = this.store.addDelivery({ eventId: event.id, event: event.name, app, kind: c.kind, ...(c.kind === "http" ? { method: c.method, path: c.path } : {}), createdAt: now });
        created.push(d);
        if (c.kind === "stream") this.push(d, event);
        else kick = true;
      }
    }
    if (created.length) this.log(`event ${event.name} #${event.id}: ${created.map((d) => `${d.app} (${d.kind})`).join(", ")}`);
    if (kick && this.started) void this.tick();
    return created;
  }

  // ---------------------------------------------------------------- streams

  /** Attach a consumer for the app; what is pending for it is pushed at once. Returns the detach function. */
  subscribe(app: string, listener: StreamListener): () => void {
    let set = this.listeners.get(app);
    if (!set) {
      set = new Set();
      this.listeners.set(app, set);
    }
    set.add(listener);
    for (const d of this.store.pendingStream(app)) this.push(d);
    return () => {
      const s = this.listeners.get(app);
      s?.delete(listener);
      if (s && !s.size) this.listeners.delete(app);
    };
  }

  /** The app confirms a pushed delivery. Returns the delivery, or undefined when it is not the app's, not sent, or unknown. */
  ack(app: string, id: number): Delivery | undefined {
    const d = this.store.getDelivery(id);
    if (!d || d.app !== app || d.kind !== "stream") return undefined;
    if (d.status === "ok") return d;
    if (d.status !== "sent") return undefined;
    const now = this.now();
    this.store.patchDelivery(id, { status: "ok", endedAt: now, nextAt: undefined });
    this.armTimer();
    return this.store.getDelivery(id);
  }

  private push(d: Delivery, event?: SpaceEvent): boolean {
    const set = this.listeners.get(d.app);
    if (!set?.size) return false;
    const e = event ?? this.events.getEvent(d.eventId);
    const now = this.now();
    if (!e) {
      this.store.patchDelivery(d.id, { status: "skipped", lastError: "event pruned before delivery", endedAt: now, nextAt: undefined });
      return false;
    }
    const attempts = d.attempts + 1;
    this.store.patchDelivery(d.id, { status: "sent", attempts, sentAt: now, nextAt: now + ACK_TIMEOUT_MS, lastError: undefined });
    const payload = deliveryPayload({ ...d, attempts }, e);
    for (const l of set) {
      try {
        l(payload);
      } catch (err) {
        this.log(`stream listener for ${d.app} failed: ${(err as Error).message ?? String(err)}`);
      }
    }
    this.armTimer();
    return true;
  }

  // ---------------------------------------------------------------- worker

  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => {
      this.ticking = null;
      this.armTimer();
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    // Stream deliveries nobody acked go back to the queue, and out again if a consumer is there.
    for (const d of this.store.unacked(now)) {
      if (d.attempts >= MAX_ATTEMPTS) this.giveUp(d, "not acked", now);
      else {
        this.store.patchDelivery(d.id, { status: "pending", nextAt: now, lastError: "not acked in time", sentAt: undefined });
        const again = this.store.getDelivery(d.id);
        if (again) this.push(again);
      }
    }
    const due = this.store.dueHttp(now);
    const byApp = new Map<string, Delivery[]>();
    for (const d of due) byApp.set(d.app, [...(byApp.get(d.app) ?? []), d]);
    await Promise.all(
      [...byApp.values()].map(async (list) => {
        for (const d of list) await this.deliver(d);
      }),
    );
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const next = this.store.nextDueAt();
    if (next === undefined) return;
    const delay = Math.min(Math.max(next - this.now(), 0), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => void this.tick().catch((e) => this.log(`tick failed: ${String(e)}`)), delay);
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private async deliver(d: Delivery): Promise<void> {
    const now = this.now();
    const e = this.events.getEvent(d.eventId);
    if (!e) return this.skip(d, "event pruned before delivery", now);
    if (!this.specs.has(d.app)) return this.skip(d, "app left the space", now);
    const port = this.servicePort(d.app);
    if (!port) return this.skip(d, "app has no service port", now);
    const attempts = d.attempts + 1;
    const url = `http://127.0.0.1:${port}${d.path}`;
    try {
      const res = await this.fetch(url, {
        method: d.method ?? "POST",
        headers: {
          "content-type": "application/json",
          "x-space-event": e.name,
          "x-space-event-id": String(e.id),
          "x-space-delivery-id": String(d.id),
          "x-space-delivery-attempt": String(attempts),
        },
        body: JSON.stringify(deliveryPayload({ ...d, attempts }, e)),
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      const ended = this.now();
      if (res.ok) {
        this.store.patchDelivery(d.id, { status: "ok", attempts, lastStatus: res.status, lastError: undefined, endedAt: ended, nextAt: undefined });
        return;
      }
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const error = `${res.status}${text ? ` ${text}` : ""}`;
      if (retryable(res.status)) this.fail(d, attempts, error, res.status, ended);
      else {
        this.store.patchDelivery(d.id, { status: "dead", attempts, lastStatus: res.status, lastError: error, endedAt: ended, nextAt: undefined });
        this.dead(d, attempts, error, e);
      }
    } catch (err) {
      this.fail(d, attempts, (err as Error).message ?? String(err), undefined, this.now());
    }
  }

  private fail(d: Delivery, attempts: number, error: string, status: number | undefined, now: number): void {
    if (attempts >= MAX_ATTEMPTS) {
      this.store.patchDelivery(d.id, { status: "dead", attempts, lastStatus: status, lastError: error, endedAt: now, nextAt: undefined });
      this.dead(d, attempts, error, this.events.getEvent(d.eventId));
      return;
    }
    const delay = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
    this.store.patchDelivery(d.id, { status: "pending", attempts, lastStatus: status, lastError: error, nextAt: now + delay });
    this.log(`delivery #${d.id} ${d.event} → ${d.app}: attempt ${attempts} failed (${error}); next in ${Math.round(delay / 1000)}s`);
  }

  private giveUp(d: Delivery, error: string, now: number): void {
    this.store.patchDelivery(d.id, { status: "dead", lastError: error, endedAt: now, nextAt: undefined });
    this.dead(d, d.attempts, error, this.events.getEvent(d.eventId));
  }

  private dead(d: Delivery, attempts: number, error: string, event: SpaceEvent | undefined): void {
    this.log(`delivery #${d.id} ${d.event} → ${d.app}: dead after ${attempts} attempt(s): ${error}`);
    if (!this.onDead) return;
    const fresh = this.store.getDelivery(d.id) ?? d;
    try {
      this.onDead(fresh, event);
    } catch (e) {
      this.log(`onDead hook failed: ${(e as Error).message ?? String(e)}`);
    }
  }

  private skip(d: Delivery, reason: string, now: number): void {
    this.store.patchDelivery(d.id, { status: "skipped", lastError: reason, endedAt: now, nextAt: undefined });
    this.log(`delivery #${d.id} ${d.event} → ${d.app}: skipped (${reason})`);
  }

  /** Operator: queue a dead or skipped delivery again, from attempt zero. Any other status is returned unchanged. */
  retry(id: number): Delivery | undefined {
    const d = this.store.getDelivery(id);
    if (!d) return undefined;
    if (d.status !== "dead" && d.status !== "skipped") return d;
    const now = this.now();
    this.store.patchDelivery(id, { status: "pending", attempts: 0, nextAt: now, lastError: undefined, lastStatus: undefined, sentAt: undefined, endedAt: undefined });
    const fresh = this.store.getDelivery(id);
    if (fresh?.kind === "stream") this.push(fresh);
    else if (this.started) void this.tick();
    return this.store.getDelivery(id);
  }

  // ---------------------------------------------------------------- calls

  /**
   * Forward one request to `app`'s capability `name` as `caller`. Throws CallError when the
   * call cannot be made (unknown, not allowed, no service, timeout, unreachable); otherwise
   * answers with whatever the app answered, including its error statuses.
   */
  async call(caller: string, app: string, name: string, req: CallRequest = {}): Promise<CallResult> {
    const cap = this.capability(app, name);
    if (!cap) throw new CallError(404, this.specs.has(app) ? `${app} does not provide "${name}"` : `unknown app: ${app}`);
    if (cap.callers && !cap.callers.includes(caller)) throw new CallError(403, `${app}/${name} does not accept calls from ${caller}`);
    const port = this.servicePort(app);
    if (!port) throw new CallError(503, `${app} has no running service to call`);
    const startedAt = this.now();
    const record = (status: number, ok: boolean, error?: string): CallRecord =>
      this.store.addCall({ caller, app, capability: name, status, ok, durationMs: Math.max(0, this.now() - startedAt), ...(error ? { error } : {}), at: startedAt });
    const signals = [AbortSignal.timeout(cap.timeoutMs), ...(req.signal ? [req.signal] : [])];
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
    let res: Response;
    try {
      res = await this.fetch(`http://127.0.0.1:${port}${cap.path}`, {
        method: cap.method,
        headers: {
          ...(req.contentType ? { "content-type": req.contentType } : {}),
          ...(req.accept ? { accept: req.accept } : {}),
          "x-space-caller": caller,
          "x-space-capability": name,
        },
        ...(req.body !== undefined && req.body !== null && cap.method !== "GET" ? { body: req.body } : {}),
        signal,
      });
    } catch (err) {
      const timedOut = (err as Error).name === "TimeoutError" || signal?.aborted;
      const error = timedOut ? `no answer within ${Math.round(cap.timeoutMs / 1000)}s` : `unreachable: ${(err as Error).message ?? String(err)}`;
      const rec = record(0, false, error);
      this.log(`call ${caller} → ${app}/${name}: ${error}`);
      throw Object.assign(new CallError(timedOut ? 504 : 502, error), { record: rec });
    }
    const body = await res.arrayBuffer();
    const rec = record(res.status, res.ok, res.ok ? undefined : `${res.status}`);
    this.log(`call ${caller} → ${app}/${name}: ${res.status} in ${rec.durationMs}ms`);
    const contentType = res.headers.get("content-type") ?? undefined;
    return { status: res.status, ...(contentType ? { contentType } : {}), body, record: rec };
  }
}

function retryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}
