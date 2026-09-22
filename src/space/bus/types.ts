import type { SpaceEvent } from "../scheduler/types.ts";

/**
 * Bus data model: what apps declare (`events:` and `provides:` in space.yaml),
 * what the bus records (deliveries and calls), and the limits.
 *
 * Three ways an event reaches an app, all declared under `events.consumes`:
 * `task` (the scheduler's triggers, coalesced and debounced), `http` (one POST
 * per event to the app's own service, retried until it answers 2xx) and
 * `stream` (the app holds `GET /api/events/stream` open and acks each delivery).
 * A capability under `provides:` is a request/response call another app makes
 * through `POST /api/call/<app>/<capability>`; the bus forwards it to the app's
 * service and records it.
 */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** `events.publishes[]`: documentation of an event the app emits, for the capabilities listing and agents. */
export type EventPublication = {
  name: string;
  description?: string;
  example?: Record<string, unknown>;
};

export type EventFilter = Record<string, string | string[]>;

/** `events.consumes[]`: one subscription. `task` becomes a trigger on the named task; the other two are the bus's. */
export type EventConsumption = { event: string; filter?: EventFilter } & (
  | { kind: "task"; task: string; debounceMs?: number }
  | { kind: "http"; method: HttpMethod; path: string }
  | { kind: "stream" }
);

export type EventsSpec = { publishes: EventPublication[]; consumes: EventConsumption[] };

/** `provides.<name>`: a request/response entry point on the app's service. */
export type Capability = {
  name: string;
  description?: string;
  method: HttpMethod;
  path: string;
  timeoutMs: number;
  /** Apps allowed to call it; undefined = every app on this space. */
  callers?: string[];
};

export type DeliveryKind = "http" | "stream";

/**
 * pending: waiting for an attempt (http) or for a consumer (stream);
 * sent: pushed to a stream consumer, waiting for its ack;
 * ok: answered 2xx / acked; dead: given up; skipped: the app or its service was gone when it was due.
 */
export type DeliveryStatus = "pending" | "sent" | "ok" | "dead" | "skipped";
export const FINAL_DELIVERY_STATUSES: readonly DeliveryStatus[] = ["ok", "dead", "skipped"];

export type Delivery = {
  id: number;
  eventId: number;
  /** Qualified event name, kept so a delivery still reads after its event was pruned. */
  event: string;
  app: string;
  kind: DeliveryKind;
  /** http: where it goes on the app's service. */
  method?: HttpMethod;
  path?: string;
  status: DeliveryStatus;
  attempts: number;
  /** When the next attempt (http) or the ack deadline (stream) is due. */
  nextAt?: number;
  lastError?: string;
  /** http: the status code of the last answer. */
  lastStatus?: number;
  sentAt?: number;
  endedAt?: number;
  createdAt: number;
};

export type CallRecord = {
  id: number;
  caller: string;
  app: string;
  capability: string;
  /** HTTP status the app answered, 0 when it did not answer. */
  status: number;
  ok: boolean;
  durationMs: number;
  error?: string;
  at: number;
};

/** What a stream consumer and an http target receive. */
export type DeliveryPayload = {
  delivery: { id: number; attempt: number };
  event: { id: number; name: string; app: string; at: string; data: Record<string, unknown> };
  /** Always one element; the same shape a task's http target gets. */
  events: DeliveryPayload["event"][];
};

export function deliveryPayload(d: Delivery, e: SpaceEvent): DeliveryPayload {
  const event = { id: e.id, name: e.name, app: e.app, at: new Date(e.at).toISOString(), data: e.data };
  return { delivery: { id: d.id, attempt: d.attempts }, event, events: [event] };
}

/** http deliveries: wait before each retry; after the last one the delivery is dead. */
export const RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000, 5 * 60_000, 10 * 60_000, 10 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** stream deliveries: a pushed delivery not acked by then goes back to pending. */
export const ACK_TIMEOUT_MS = 5 * 60_000;
/** One http delivery attempt. */
export const DELIVERY_TIMEOUT_MS = 30_000;
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const MAX_CALL_TIMEOUT_MS = 15 * 60_000;
/** Largest request body forwarded by a call. */
export const MAX_CALL_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_DELIVERIES = 20_000;
export const MAX_CALLS = 5_000;
