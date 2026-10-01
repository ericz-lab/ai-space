import { createHash, randomBytes } from "node:crypto";
import { filterMatches, parseTriggers } from "../scheduler/events.ts";
import type { Bus } from "./bus.ts";
import type { BusStore } from "./store.ts";
import {
  CONSUMER_TOKEN_PREFIX,
  type Consumer,
  type ConsumerCall,
  type ConsumerSubscription,
  type EventFilter,
  MAX_CONSUMERS,
  MAX_CONSUMER_CALLS,
  MAX_CONSUMER_SUBSCRIPTIONS,
  consumerKey,
} from "./types.ts";

/**
 * External consumers (docs/events.md#external-consumers): programs on other
 * devices that read bus events without being Space apps.
 *
 * The operator creates one with a name, its event subscriptions and the
 * calls it may make. The credential is shown once, at creation and on
 * rotation; only its SHA-256 is stored (it is 32 random bytes, so a plain
 * hash is enough). Removing or rotating takes effect at once: the bus closes
 * the consumer's open streams, and the next request with the old credential
 * is a 401. Subscriptions and calls are fixed at creation; to change them,
 * remove and add again.
 */

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const CAPABILITY_RE = /^([a-z0-9][a-z0-9._-]*)\/([a-z0-9][a-z0-9._-]*)$/i;

export type ConsumerInput = { name: string; description?: string; subscriptions: ConsumerSubscription[]; calls: ConsumerCall[] };

/** A refusal with the status the API answers. */
export class ConsumerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * The body of `POST /api/consumers`:
 *
 * ```json
 * { "name": "hub-sync",
 *   "description": "Mirrors asset groups on the office NAS",
 *   "subscriptions": [{ "event": "asset-center/group.changed", "filter": { "groupId": ["g1", "g2"] } }],
 *   "calls": [{ "capability": "asset-center/group-members", "filter": { "groupId": ["g1", "g2"] } }] }
 * ```
 */
export function parseConsumerInput(raw: unknown): ConsumerInput {
  if (!isRecord(raw)) throw new ConsumerError(400, "body must be a JSON object with name / subscriptions / calls");
  for (const key of Object.keys(raw)) if (!["name", "description", "subscriptions", "calls"].includes(key)) throw new ConsumerError(400, `unknown key "${key}"`);
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!NAME_RE.test(name)) throw new ConsumerError(400, "name must be 1-63 letters, digits, dots, dashes or underscores");
  let description: string | undefined;
  if (raw.description !== undefined && raw.description !== null) {
    if (typeof raw.description !== "string") throw new ConsumerError(400, "description must be a string");
    description = raw.description.trim().slice(0, 500) || undefined;
  }
  const subs = raw.subscriptions;
  if (!Array.isArray(subs) || !subs.length) throw new ConsumerError(400, "subscriptions must name at least one event");
  if (subs.length > MAX_CONSUMER_SUBSCRIPTIONS) throw new ConsumerError(400, `at most ${MAX_CONSUMER_SUBSCRIPTIONS} subscriptions`);
  const subscriptions = subs.map((s, i): ConsumerSubscription => {
    const item = typeof s === "string" ? { event: s } : s;
    if (!isRecord(item)) throw new ConsumerError(400, `subscriptions[${i}] must be an event name or { event, filter }`);
    for (const key of Object.keys(item)) if (key !== "event" && key !== "filter") throw new ConsumerError(400, `subscriptions[${i}] has unknown key "${key}"`);
    try {
      // Same rules as a manifest's events.consumes: exact name or <app>/*, string equality filters.
      const [t] = parseTriggers(item, `subscriptions[${i}]`);
      return { event: t!.event, ...(t!.filter ? { filter: t!.filter } : {}) };
    } catch (e) {
      throw new ConsumerError(400, (e as Error).message);
    }
  });
  const rawCalls = raw.calls ?? [];
  if (!Array.isArray(rawCalls)) throw new ConsumerError(400, "calls must be a list");
  if (rawCalls.length > MAX_CONSUMER_CALLS) throw new ConsumerError(400, `at most ${MAX_CONSUMER_CALLS} calls`);
  const calls = rawCalls.map((c, i): ConsumerCall => {
    const item = typeof c === "string" ? { capability: c } : c;
    if (!isRecord(item)) throw new ConsumerError(400, `calls[${i}] must be "<app>/<capability>" or { capability, filter }`);
    for (const key of Object.keys(item)) if (key !== "capability" && key !== "filter") throw new ConsumerError(400, `calls[${i}] has unknown key "${key}"`);
    const m = typeof item.capability === "string" ? CAPABILITY_RE.exec(item.capability.trim()) : null;
    if (!m) throw new ConsumerError(400, `calls[${i}].capability must be <app>/<capability>`);
    const filter = item.filter === undefined ? undefined : parseFilter(item.filter, `calls[${i}].filter`);
    return { app: m[1]!, capability: m[2]!, ...(filter ? { filter } : {}) };
  });
  return { name, ...(description ? { description } : {}), subscriptions, calls };
}

function parseFilter(raw: unknown, where: string): EventFilter {
  if (!isRecord(raw) || !Object.keys(raw).length) throw new ConsumerError(400, `${where} must map body fields to a value or a list of values`);
  const out: EventFilter = {};
  for (const [k, v] of Object.entries(raw)) {
    const scalar = (x: unknown) => typeof x === "string" || typeof x === "number" || typeof x === "boolean";
    if (Array.isArray(v) && v.length && v.every(scalar)) out[k] = v.map(String);
    else if (scalar(v)) out[k] = String(v);
    else throw new ConsumerError(400, `${where}.${k} must be a scalar or a non-empty list of scalars`);
  }
  return out;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newToken(): string {
  return `${CONSUMER_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function hint(token: string): string {
  return `${token.slice(0, CONSUMER_TOKEN_PREFIX.length + 6)}…`;
}

export type ConsumersOptions = { store: BusStore; bus: Bus; now?: () => number; log?: (message: string) => void };

export class Consumers {
  private readonly store: BusStore;
  private readonly bus: Bus;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  /** Loads every stored consumer into the bus, so deliveries resume after a restart. */
  constructor(opts: ConsumersOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.log(`[bus] ${m}`));
    for (const c of this.store.listConsumers()) this.bus.setConsumer(c.name, c.subscriptions);
  }

  list(): Consumer[] {
    return this.store.listConsumers();
  }

  get(name: string): Consumer | undefined {
    return this.store.getConsumer(name);
  }

  /** Create one; the answer carries the credential, which is not kept. */
  create(input: ConsumerInput): { consumer: Consumer; token: string } {
    if (this.store.getConsumer(input.name)) throw new ConsumerError(409, `consumer ${input.name} exists (rotate its credential, or remove it first)`);
    if (this.store.countConsumers() >= MAX_CONSUMERS) throw new ConsumerError(429, `at most ${MAX_CONSUMERS} consumers`);
    const token = newToken();
    this.store.addConsumer({ ...input, tokenHash: hashToken(token), tokenHint: hint(token), createdAt: this.now() });
    this.bus.setConsumer(input.name, input.subscriptions);
    this.log(`consumer ${input.name} added: ${input.subscriptions.map((s) => s.event).join(", ")}${input.calls.length ? `; calls ${input.calls.map((c) => `${c.app}/${c.capability}`).join(", ")}` : ""}`);
    return { consumer: this.store.getConsumer(input.name)!, token };
  }

  /** A new credential; the old one stops working at once and open streams close. */
  rotate(name: string): { consumer: Consumer; token: string } {
    const token = newToken();
    if (!this.store.setConsumerToken(name, hashToken(token), hint(token), this.now())) throw new ConsumerError(404, `unknown consumer: ${name}`);
    this.bus.disconnect(consumerKey(name));
    this.log(`consumer ${name}: credential rotated`);
    return { consumer: this.store.getConsumer(name)!, token };
  }

  /** Revoke: the credential stops working, open streams close, waiting deliveries are skipped. */
  remove(name: string): boolean {
    if (!this.store.removeConsumer(name)) return false;
    this.bus.removeConsumer(name);
    this.log(`consumer ${name} removed`);
    return true;
  }

  /** The consumer behind a presented credential, recorded as seen; undefined for anything else. */
  authenticate(token: string): Consumer | undefined {
    if (!token.startsWith(CONSUMER_TOKEN_PREFIX)) return undefined;
    const c = this.store.consumerByTokenHash(hashToken(token));
    if (c) this.store.touchConsumer(c.name, this.now());
    return c;
  }

  /**
   * May the consumer call `<app>/<capability>` with this body? Allowed only when the
   * capability is on its list and, when that entry has a filter, the body is a JSON
   * object whose fields match it.
   */
  checkCall(consumer: Consumer, app: string, capability: string, body: ArrayBuffer): void {
    const entries = consumer.calls.filter((c) => c.app === app && c.capability === capability);
    if (!entries.length) throw new ConsumerError(403, `consumer ${consumer.name} may not call ${app}/${capability}`);
    if (entries.some((c) => !c.filter)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new ConsumerError(403, `${app}/${capability} is limited for consumer ${consumer.name}: the body must be a JSON object`);
    }
    if (!isRecord(parsed) || !entries.some((c) => filterMatches(c.filter, parsed as Record<string, unknown>))) {
      const allowed = entries.map((c) => JSON.stringify(c.filter)).join(" or ");
      throw new ConsumerError(403, `consumer ${consumer.name} may call ${app}/${capability} only with ${allowed}`);
    }
  }
}

export function consumerView(c: Consumer) {
  const iso = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());
  return {
    name: c.name,
    description: c.description,
    subscriptions: c.subscriptions,
    calls: c.calls.map((x) => ({ capability: `${x.app}/${x.capability}`, ...(x.filter ? { filter: x.filter } : {}) })),
    tokenHint: c.tokenHint,
    createdAt: iso(c.createdAt),
    rotatedAt: iso(c.rotatedAt),
    lastSeenAt: iso(c.lastSeenAt),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
