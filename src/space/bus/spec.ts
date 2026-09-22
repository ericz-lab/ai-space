import { assertEventName, assertTriggerEvent, parseTriggers } from "../scheduler/events.ts";
import { parseDuration } from "../scheduler/schedule.ts";
import type { EventTrigger } from "../scheduler/types.ts";
import { type Capability, DEFAULT_CALL_TIMEOUT_MS, type EventConsumption, type EventPublication, type EventsSpec, HTTP_METHODS, type HttpMethod, MAX_CALL_TIMEOUT_MS } from "./types.ts";

/**
 * The `events:` and `provides:` sections of space.yaml.
 *
 * ```yaml
 * events:
 *   publishes:
 *     - name: digest.added                       # bare string, or with description / example
 *       description: A video got its transcript and digest.
 *       example: { id: abc, channel: Weekly }
 *   consumes:
 *     - event: video-digest/digest.added         # one of task / http / neither (stream)
 *       filter: { channel: Weekly }
 *       task: import-weekly                      # → a trigger on that task (debounce allowed)
 *     - { event: feed/item.added, http: { method: POST, path: /api/ingest } }
 *     - { event: feed/* }                        # read from GET /api/events/stream
 * provides:
 *   research:
 *     description: Research a symbol and return a verdict.
 *     http: { method: POST, path: /api/research }
 *     timeout: 2m
 *     callers: [portfolio]                       # default: every app on this space
 * ```
 *
 * Parsing is strict, like the rest of the manifest: an unknown key or a bad value rejects the app.
 */

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const APP_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const CONSUME_KEYS = ["event", "filter", "debounce", "task", "http"];

export const EMPTY_EVENTS_SPEC: EventsSpec = { publishes: [], consumes: [] };

export function parseEventsSpec(raw: unknown, ctx = "events"): EventsSpec {
  if (raw === undefined || raw === null) return EMPTY_EVENTS_SPEC;
  if (!isRecord(raw)) throw new Error(`${ctx} must be a mapping with publishes / consumes`);
  for (const key of Object.keys(raw)) if (key !== "publishes" && key !== "consumes") throw new Error(`${ctx} has unknown key "${key}"`);
  const publishes = parsePublishes(raw.publishes, `${ctx}.publishes`);
  const consumes = parseConsumes(raw.consumes, `${ctx}.consumes`);
  return { publishes, consumes };
}

function parsePublishes(raw: unknown, ctx: string): EventPublication[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${ctx} must be a list`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `${ctx}[${i}]`;
    const p = typeof item === "string" ? { name: item } : item;
    if (!isRecord(p)) throw new Error(`${where} must be an event name or a mapping with name / description / example`);
    for (const key of Object.keys(p)) if (!["name", "description", "example"].includes(key)) throw new Error(`${where} has unknown key "${key}"`);
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) throw new Error(`${where}: name is required`);
    assertEventName(name);
    if (seen.has(name)) throw new Error(`${ctx}: "${name}" is declared twice`);
    seen.add(name);
    const description = optionalString(p.description, `${where}.description`);
    if (p.example !== undefined && !isRecord(p.example)) throw new Error(`${where}.example must be a mapping (the event's data)`);
    return { name, ...(description !== undefined ? { description } : {}), ...(p.example ? { example: p.example } : {}) };
  });
}

function parseConsumes(raw: unknown, ctx: string): EventConsumption[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${ctx} must be a list`);
  return raw.map((item, i) => {
    const where = `${ctx}[${i}]`;
    const c = typeof item === "string" ? { event: item } : item;
    if (!isRecord(c)) throw new Error(`${where} must be an event name or a mapping with event / filter / task / http`);
    for (const key of Object.keys(c)) if (!CONSUME_KEYS.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
    // The event / filter / debounce part is exactly a trigger.
    const [trigger] = parseTriggers({ event: c.event, ...(c.filter !== undefined ? { filter: c.filter } : {}), ...(c.debounce !== undefined ? { debounce: c.debounce } : {}) }, where);
    if (!trigger) throw new Error(`${where}: event is required`);
    const base = { event: trigger.event, ...(trigger.filter ? { filter: trigger.filter } : {}) };
    const forms = ["task", "http"].filter((k) => c[k] !== undefined);
    if (forms.length > 1) throw new Error(`${where}: declare task or http, not both`);
    if (c.task !== undefined) {
      if (typeof c.task !== "string" || !NAME_RE.test(c.task.trim())) throw new Error(`${where}: task must be the name of one of the app's tasks`);
      return { ...base, kind: "task", task: c.task.trim(), ...(trigger.debounceMs !== undefined ? { debounceMs: trigger.debounceMs } : {}) };
    }
    if (trigger.debounceMs !== undefined) throw new Error(`${where}: debounce applies to task subscriptions only; http and stream deliver every event`);
    if (c.http !== undefined) {
      const { method, path } = parseHttp(c.http, `${where}.http`);
      return { ...base, kind: "http", method, path };
    }
    return { ...base, kind: "stream" };
  });
}

/** Task subscriptions as triggers on the named task, so the scheduler needs no new concept. */
export function triggersFromConsumes(spec: EventsSpec, taskNames: string[], ctx = "events.consumes"): Map<string, EventTrigger[]> {
  const out = new Map<string, EventTrigger[]>();
  for (const c of spec.consumes) {
    if (c.kind !== "task") continue;
    if (!taskNames.includes(c.task)) throw new Error(`${ctx}: task "${c.task}" is not declared under tasks`);
    const list = out.get(c.task) ?? [];
    list.push({ event: c.event, ...(c.filter ? { filter: c.filter } : {}), ...(c.debounceMs !== undefined ? { debounceMs: c.debounceMs } : {}) });
    out.set(c.task, list);
  }
  return out;
}

export function parseProvidesSpec(raw: unknown, ctx = "provides"): Capability[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) throw new Error(`${ctx} must map capability names to mappings`);
  return Object.entries(raw).map(([name, item]) => {
    const where = `${ctx}.${name}`;
    if (!NAME_RE.test(name)) throw new Error(`${ctx}: "${name}" is not a capability name (letters, digits, dots, dashes, underscores)`);
    if (!isRecord(item)) throw new Error(`${where} must be a mapping with http / description / timeout / callers`);
    for (const key of Object.keys(item)) if (!["description", "http", "timeout", "callers"].includes(key)) throw new Error(`${where} has unknown key "${key}"`);
    if (item.http === undefined) throw new Error(`${where}: http is required`);
    const { method, path } = parseHttp(item.http, `${where}.http`);
    const description = optionalString(item.description, `${where}.description`);
    const timeoutMs = item.timeout === undefined ? DEFAULT_CALL_TIMEOUT_MS : parseDuration(item.timeout as string | number);
    if (timeoutMs < 1_000 || timeoutMs > MAX_CALL_TIMEOUT_MS) throw new Error(`${where}: timeout must be between 1s and 15m`);
    let callers: string[] | undefined;
    if (item.callers !== undefined) {
      if (!Array.isArray(item.callers) || !item.callers.length || !item.callers.every((x) => typeof x === "string" && APP_RE.test(x))) throw new Error(`${where}: callers must be a non-empty list of app names`);
      callers = [...new Set(item.callers as string[])];
    }
    return { name, ...(description !== undefined ? { description } : {}), method, path, timeoutMs, ...(callers ? { callers } : {}) };
  });
}

function parseHttp(raw: unknown, ctx: string): { method: HttpMethod; path: string } {
  if (!isRecord(raw)) throw new Error(`${ctx} must be a mapping with path (and method)`);
  for (const key of Object.keys(raw)) if (key !== "method" && key !== "path") throw new Error(`${ctx} has unknown key "${key}"`);
  const method = String(raw.method ?? "POST").toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method)) throw new Error(`${ctx}: unsupported method ${method}`);
  if (typeof raw.path !== "string" || !raw.path.startsWith("/")) throw new Error(`${ctx}: path must start with / (on the app's own service)`);
  return { method: method as HttpMethod, path: raw.path };
}

/** The trigger event names an app subscribes to, checked once more here so a bad manifest fails early. */
export function assertConsumedEvents(spec: EventsSpec): void {
  for (const c of spec.consumes) assertTriggerEvent(c.event);
}

function optionalString(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} must be a non-empty string`);
  return v.trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
