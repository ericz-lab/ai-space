import { parseDuration } from "../scheduler/schedule.ts";

/**
 * The `checks:` section of space.yaml: what an app declares a space's operator should inspect each
 * day, read by an inspection page (space-ops). A check is not a fault: it says whether today's work
 * is done, not yet due, late, or not expected today. See docs/app-spec.md#checks.
 *
 * ```yaml
 * checks:
 *   - name: hk-today
 *     title: Hong Kong bars for today
 *     http: { path: "/api/sync-status?market=hk" }   # GET on the app's service port
 *     when: [{ path: $.today.open, eq: true }]       # optional: otherwise nothing is due today
 *     done: [{ path: $.today.done, eq: true }]       # every assertion holds: done
 *     due: "18:00"                                   # optional: before it, not done is pending
 *     timezone: Asia/Hong_Kong                       # required by due and by `today` assertions
 * ```
 *
 * Parsing is strict, like the rest of the manifest: an unknown key or a bad value rejects the app.
 */

export type CheckOperator = "exists" | "eq" | "lt" | "gt" | "ageLessThan" | "today";
/** `ageLessThan` holds milliseconds; `today` compares a timestamp's local date with today's in the check's timezone. */
export type CheckAssertion = { path: string; operator: CheckOperator; value?: string | number | boolean };
export type ManifestCheck = {
  name: string;
  title?: string;
  description?: string;
  /** Path and query on the app's service, starting with `/`. */
  path: string;
  done: CheckAssertion[];
  when?: CheckAssertion[];
  /** Local `HH:MM` in `timezone`. */
  due?: string;
  timezone?: string;
};

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const PATH_RE = /^\$(?:\.[a-zA-Z0-9_-]+|\[\d+\])*$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const KEYS = ["name", "title", "description", "http", "done", "when", "due", "timezone"];
const MAX_ASSERTIONS = 20;

export function parseChecksSpec(raw: unknown, ctx = "checks"): ManifestCheck[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${ctx} must be a list`);
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const where = `${ctx}[${i}]`;
    if (!isRecord(item)) throw new Error(`${where} must be a mapping with name / http / done`);
    for (const key of Object.keys(item)) if (!KEYS.includes(key)) throw new Error(`${where} has unknown key "${key}"`);
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!NAME_RE.test(name)) throw new Error(`${where}: name must be letters, digits, '.', '_' or '-'`);
    if (seen.has(name)) throw new Error(`duplicate checks name: ${name}`);
    seen.add(name);
    const title = optionalString(item.title, `${where}.title`);
    const description = optionalString(item.description, `${where}.description`);
    if (!isRecord(item.http)) throw new Error(`${where}.http must be a mapping with path`);
    for (const key of Object.keys(item.http)) if (key !== "path") throw new Error(`${where}.http has unknown key "${key}" (checks are GET on the app's service)`);
    const path = typeof item.http.path === "string" ? item.http.path.trim() : "";
    if (!path.startsWith("/") || path.startsWith("//") || path.length > 500) throw new Error(`${where}.http.path must start with / (a path on the app's service)`);
    const done = parseAssertions(item.done, `${where}.done`);
    if (!done.length) throw new Error(`${where}.done needs at least one assertion`);
    const when = item.when === undefined ? undefined : parseAssertions(item.when, `${where}.when`);
    const due = optionalString(item.due, `${where}.due`);
    if (due !== undefined && !TIME_RE.test(due)) throw new Error(`${where}.due must be a local time such as "18:00"`);
    const timezone = optionalString(item.timezone, `${where}.timezone`);
    if (timezone !== undefined && !validZone(timezone)) throw new Error(`${where}.timezone must be an IANA zone such as Asia/Shanghai`);
    const usesToday = [...done, ...(when ?? [])].some((a) => a.operator === "today");
    if ((due !== undefined || usesToday) && timezone === undefined) throw new Error(`${where}: due and "today" assertions need a timezone`);
    return {
      name,
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      path,
      done,
      ...(when?.length ? { when } : {}),
      ...(due !== undefined ? { due } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    };
  });
}

/** `{ path: $.x, eq: ok }`: a field path and exactly one operator. `age` takes a duration and becomes `ageLessThan` in milliseconds. */
function parseAssertions(raw: unknown, ctx: string): CheckAssertion[] {
  if (!Array.isArray(raw)) throw new Error(`${ctx} must be a list of assertions such as { path: $.done, eq: true }`);
  if (raw.length > MAX_ASSERTIONS) throw new Error(`${ctx}: at most ${MAX_ASSERTIONS} assertions`);
  return raw.map((a, i) => {
    const where = `${ctx}[${i}]`;
    if (!isRecord(a)) throw new Error(`${where} must be a mapping such as { path: $.done, eq: true }`);
    const path = typeof a.path === "string" ? a.path.trim() : "";
    if (!PATH_RE.test(path) || path.length > 200) throw new Error(`${where}.path must be a field path such as $.latest.status or $.items[0].count`);
    const ops = Object.keys(a).filter((k) => k !== "path");
    if (ops.length !== 1) throw new Error(`${where} needs exactly one of exists / eq / lt / gt / age / today`);
    const op = ops[0]!, value = a[op];
    switch (op) {
      case "exists":
      case "today":
        if (value !== true) throw new Error(`${where}.${op} must be true`);
        return { path, operator: op };
      case "eq":
        if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`${where}.eq must be a string, number or boolean`);
        return { path, operator: "eq", value: value as string | number | boolean };
      case "lt":
      case "gt":
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${where}.${op} must be a number`);
        return { path, operator: op, value };
      case "age":
        if (typeof value !== "string" && typeof value !== "number") throw new Error(`${where}.age must be a duration such as 26h`);
        return { path, operator: "ageLessThan", value: parseDuration(value) };
      default:
        throw new Error(`${where} has unknown operator "${op}" (exists / eq / lt / gt / age / today)`);
    }
  });
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone);
  } catch {
    return false;
  }
}

function optionalString(v: unknown, ctx: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${ctx} must be a non-empty string`);
  return v.trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
