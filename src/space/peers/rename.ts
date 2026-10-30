import type { Database } from "bun:sqlite";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { ENV_PREFIX, nameToEnv } from "./config.ts";
import type { PeerHub } from "./hub.ts";

/**
 * Renaming a peer (docs/peers.md#renaming-a-peer): the name is only the
 * `SPACE_PEER_<NAME>` line in the hub's `.env`, but the hub keys a lot of its own
 * state by that name. A rename moves all of it, so the peer keeps its hidden
 * apps, its tile order, its ledger and its event cursor instead of starting
 * over as a new peer while the old name's rows are pruned.
 *
 * What moves (each only where the table exists in this space.db):
 *
 *   .env               SPACE_PEER_<OLD>[_TOKEN|_HEADERS|_REFRESH] and model values `old:runtime/tier`
 *   peer_snapshots     the cached snapshot, so the peer's apps stay listed while it is down
 *   peer_cursors       the event cursor, so nothing is mirrored twice
 *   events.peer        the mirrored events' origin
 *   panel_kv layout    hidden apps, tile order, widget sizes and screens (`old/<id>` ids)
 *   model_calls        machine, backend `peer:old`, and the rows the peer sent here (`old/<app>`)
 *   model choices      `old:runtime/tier` in app overrides, chat choices and the default model
 *   bus_calls          calls forwarded to the peer (`old/<app>`) and the ones it made here
 *   shortcut_*         patterns and runs keyed by peer
 *   feedback           where a fix ran, its to-do's peer, and the fix machine in the settings
 *   usage_*            opens and time of the peer's entries (`old/<id>` keys)
 */

export type RenameCounts = Record<string, number>;

/** Why a rename cannot go ahead; the message is meant for the operator. */
export class RenameError extends Error {}

/** Check the two names before anything changes. `taken` lists names a peer may not take (local apps, other peers). */
export function checkRename(from: string, to: string, peers: string[], taken: (name: string) => boolean = () => false): void {
  if (!peers.includes(from)) throw new RenameError(`unknown peer: ${from}`);
  if (from === to) throw new RenameError("the new name is the old one");
  // Stricter than PEER_NAME_RE: the name must survive the round trip through an env key.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(to)) throw new RenameError(`invalid peer name "${to}": lowercase letters, digits and dashes`);
  if (to === "model") throw new RenameError(`"model" is not a peer name (SPACE_PEER_MODEL is a setting)`);
  if (peers.includes(to)) throw new RenameError(`peer ${to} already exists`);
  if (taken(to)) throw new RenameError(`"${to}" is the name of a local app; a peer cannot take it`);
}

/** The model variables whose value may name a peer as its machine (`peer:runtime/tier`). */
const MODEL_KEYS = ["SPACE_CHAT_MODEL", "SPACE_MODEL_DEFAULT"];
const PEER_SUFFIXES = ["", "_TOKEN", "_HEADERS", "_REFRESH"];

/**
 * The `.env` text with the peer's lines renamed in place: the key changes, the
 * value and the line's position stay. Model values that name the peer as their
 * machine follow. Every other line is untouched.
 */
export function renameEnvText(text: string, from: string, to: string): string {
  const keys = new Map(PEER_SUFFIXES.map((s) => [`${ENV_PREFIX}${nameToEnv(from)}${s}`, `${ENV_PREFIX}${nameToEnv(to)}${s}`]));
  return text
    .split("\n")
    .map((line) => {
      const m = /^(\s*(?:export\s+)?)([A-Z][A-Z0-9_]*)(\s*=)(.*)$/.exec(line);
      if (!m) return line;
      const [, lead, key, eq, value] = m as unknown as [string, string, string, string, string];
      const renamed = keys.get(key);
      if (renamed) return `${lead}${renamed}${eq}${value}`;
      if (MODEL_KEYS.includes(key)) return `${lead}${key}${eq}${value.replace(new RegExp(`^(\\s*["']?)${escape(from)}:`), `$1${to}:`)}`;
      return line;
    })
    .join("\n");
}

/** The environment map with the peer's keys renamed and its model values following, as the `.env` rewrite does. */
export function renameEnvMap(env: Record<string, string | undefined>, from: string, to: string): void {
  for (const s of PEER_SUFFIXES) {
    const a = `${ENV_PREFIX}${nameToEnv(from)}${s}`;
    if (env[a] === undefined) continue;
    env[`${ENV_PREFIX}${nameToEnv(to)}${s}`] = env[a];
    delete env[a];
  }
  for (const k of MODEL_KEYS) if (env[k]?.startsWith(`${from}:`)) env[k] = `${to}:${env[k]!.slice(from.length + 1)}`;
}

/**
 * Move every row the hub keys by the peer's name, in one transaction. `also`
 * runs inside it last (the `.env` rewrite): when it throws, nothing moved.
 * Returns how many rows or values changed per area.
 */
export function renamePeerData(db: Database, from: string, to: string, also?: () => void): RenameCounts {
  const counts: RenameCounts = {};
  const tables = new Set(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
  const has = (table: string, column?: string) => tables.has(table) && (!column || db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column));
  const add = (area: string, n: number) => {
    if (n) counts[area] = (counts[area] ?? 0) + n;
  };
  const run = (sql: string, ...args: (string | number)[]) => db.query(sql).run(...args).changes;
  const prefix = `${from}/`;
  const len = prefix.length + 1;
  /** `old/<rest>` → `new/<rest>` in a column. */
  const movePrefix = (area: string, table: string, column: string, where = "") => {
    if (has(table, column)) add(area, run(`UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?${where}`, `${to}/`, len, prefix.length, prefix));
  };
  /** `old:<rest>` (a model on the peer) → `new:<rest>`. */
  const moveModel = (area: string, table: string, column: string) => {
    if (has(table, column)) add(area, run(`UPDATE ${table} SET ${column} = ? || substr(${column}, ?) WHERE substr(${column}, 1, ?) = ?`, `${to}:`, from.length + 2, from.length + 1, `${from}:`));
  };
  const moveValue = (area: string, table: string, column: string, old = from, next = to) => {
    if (has(table, column)) add(area, run(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`, next, old));
  };

  db.transaction(() => {
    // Rows under the new name are leftovers of an earlier peer of that name: the moved ones win.
    for (const t of ["peer_snapshots", "peer_cursors"]) {
      if (!has(t)) continue;
      run(`DELETE FROM ${t} WHERE peer = ?`, to);
      add(t === "peer_snapshots" ? "snapshots" : "cursors", run(`UPDATE ${t} SET peer = ? WHERE peer = ?`, to, from));
    }
    moveValue("events", "events", "peer");

    if (has("panel_kv")) {
      const row = db.query<{ value: string }, []>("SELECT value FROM panel_kv WHERE key = 'layout'").get();
      if (row) {
        let n = 0;
        const next = JSON.stringify(renameIds(JSON.parse(row.value), from, to, () => n++));
        if (n) db.query("UPDATE panel_kv SET value = ? WHERE key = 'layout'").run(next);
        add("layout", n);
      }
    }

    moveValue("model ledger", "model_calls", "machine");
    moveValue("model ledger", "model_calls", "backend", `peer:${from}`, `peer:${to}`);
    // The calls the peer sent here, recorded under `<its name>/<app>`.
    movePrefix("model ledger", "model_calls", "app", " AND origin = 'peer'");
    moveModel("model choices", "model_overrides", "model");
    moveModel("model choices", "chat_model_choices", "model");
    moveModel("model choices", "model_preferences", "value");

    movePrefix("bus calls", "bus_calls", "app");
    movePrefix("bus calls", "bus_calls", "caller");

    if (has("shortcut_patterns", "peer")) add("shortcuts", run("UPDATE OR REPLACE shortcut_patterns SET peer = ? WHERE peer = ?", to, from));
    moveValue("shortcuts", "shortcut_runs", "peer");

    moveValue("feedback", "feedback", "todo_peer");
    moveValue("feedback", "feedback", "run_machine");
    moveValue("feedback", "feedback", "fix_machine");
    if (has("feedback_settings")) {
      const row = db.query<{ value: string }, []>("SELECT value FROM feedback_settings WHERE key = 'settings'").get();
      const settings = row ? (JSON.parse(row.value) as { machine?: unknown }) : undefined;
      if (settings?.machine === from) {
        db.query("UPDATE feedback_settings SET value = ? WHERE key = 'settings'").run(JSON.stringify({ ...settings, machine: to }));
        add("feedback", 1);
      }
    }

    movePrefix("usage", "usage_opens", "key");
    movePrefix("usage", "usage_sessions", "key");
    movePrefix("usage", "usage_device_opens", "key");
    movePrefix("usage", "usage_device_segments", "app");

    also?.();
  })();
  return counts;
}

/** Every string in a JSON value (object keys too) that is a peer id, `old/<id>` or `<kind>:old/<id>`, renamed. */
function renameIds(v: unknown, from: string, to: string, hit: () => void): unknown {
  const re = new RegExp(`^([a-z]+:)?${escape(from)}/`);
  const one = (s: string) => {
    if (!re.test(s)) return s;
    hit();
    return s.replace(re, `$1${to}/`);
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === "string") return one(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, val]) => [one(k), walk(val)]));
    return x;
  };
  return walk(v);
}

/** Rewrite the workspace `.env` atomically (a temporary file renamed over it). */
export function rewriteEnvFile(path: string, from: string, to: string): void {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new RenameError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const next = renameEnvText(text, from, to);
  if (next === text) throw new RenameError(`${ENV_PREFIX}${nameToEnv(from)} is not in ${path}; rename it where it is set`);
  const tmp = `${path}.rename-${process.pid}`;
  writeFileSync(tmp, next, { mode: statSync(path).mode & 0o777 });
  renameSync(tmp, path);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type PeerRenameOptions = {
  hub: PeerHub;
  /** space.db, where the hub keeps what it knows per peer. */
  db: Database;
  /** The workspace `.env`, where `SPACE_PEER_<NAME>` lives. */
  envFile: string;
  /** The running service's environment, renamed too so it matches the file until the next start. */
  env?: Record<string, string | undefined>;
  /** Names a peer may not take (local apps). */
  taken?: (name: string) => boolean;
  /** Publish `space/peer.renamed` for the apps to follow. */
  publish?: (data: PeerRenamed) => void;
};

/** The `space/peer.renamed` event's data (docs/events.md#peer-renamed). */
export type PeerRenamed = { from: string; to: string; id: string | null };

/** Rename a configured peer: check, move its data and its `.env` lines together, swap the live client, tell the apps. */
export async function renamePeer(o: PeerRenameOptions, from: string, to: string): Promise<PeerRenamed & { moved: RenameCounts }> {
  checkRename(from, to, o.hub.names(), o.taken);
  let moved: RenameCounts = {};
  await o.hub.rename(from, to, () => {
    moved = renamePeerData(o.db, from, to, () => rewriteEnvFile(o.envFile, from, to));
  });
  if (o.env) renameEnvMap(o.env, from, to);
  const event: PeerRenamed = { from, to, id: o.hub.get(to)?.snapshot?.id ?? null };
  try {
    o.publish?.(event);
  } catch (e) {
    console.error(`[peers] ${from} → ${to}: peer.renamed not published: ${(e as Error).message}`);
  }
  return { ...event, moved };
}
