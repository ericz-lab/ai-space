import type { CliInfo, MachineInventory } from "../../../../src/web/api.ts";
import type { Key as WebKey } from "../../../../src/web/messages.ts";

/**
 * The agent CLIs on each machine (`GET /api/model/inventory`, re-probed by `POST
 * /api/model/status/probe`; docs/model-machines.md#inventory), as the web panel's MachineClis.tsx
 * shows them: one row per machine, one column per CLI found anywhere.
 */

export type { CliInfo, MachineInventory };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function cliOf(c: Obj): CliInfo | undefined {
  const cli = str(c.cli), kind = str(c.kind);
  if (!cli || !kind) return undefined;
  const out: CliInfo = { cli, kind, configured: c.configured === true, runtimes: Array.isArray(c.runtimes) ? c.runtimes.filter((r): r is string => typeof r === "string") : [] };
  const installed = bool(c.installed), signedIn = bool(c.signedIn);
  if (installed !== undefined) out.installed = installed;
  if (signedIn !== undefined) out.signedIn = signedIn;
  for (const k of ["version", "path", "detail", "checkedAt"] as const) {
    const v = str(c[k]);
    if (v) out[k] = v;
  }
  return out;
}

/** `{ machines }` from either route; a malformed row is skipped. */
export function decodeInventory(body: unknown): MachineInventory[] {
  if (!isObj(body) || !Array.isArray(body.machines)) return [];
  const out: MachineInventory[] = [];
  for (const m of body.machines) {
    if (!isObj(m) || typeof m.machine !== "string") continue;
    const via = m.via === "ssh" || m.via === "peer" ? m.via : "local";
    const row: MachineInventory = { machine: m.machine, via, clis: Array.isArray(m.clis) ? m.clis.filter(isObj).map(cliOf).filter((c): c is CliInfo => Boolean(c)) : [] };
    const reachable = bool(m.reachable);
    if (reachable !== undefined) row.reachable = reachable;
    if (m.stale === true) row.stale = true;
    if (m.old === true) row.old = true;
    out.push(row);
  }
  return out;
}

/** The table's columns: every CLI any machine lists, in the order first seen. */
export const cliColumns = (rows: MachineInventory[]): string[] => [...new Set(rows.flatMap((r) => r.clis.map((c) => c.cli)))];

/** When the CLIs were last checked: the newest `checkedAt`. */
export const lastChecked = (rows: MachineInventory[]): string | undefined => rows.flatMap((r) => r.clis.map((c) => c.checkedAt ?? "")).filter(Boolean).sort().pop();

/** The note under a machine's name; undefined for this machine. */
export function machineNote(r: MachineInventory): WebKey | "ssh" | undefined {
  if (r.old) return "clis.old";
  if (r.stale) return "clis.offline";
  if (r.reachable === false) return "clis.unreachable";
  return r.via === "local" ? undefined : r.via === "ssh" ? "ssh" : "clis.peer";
}

export type CliCellState =
  | { kind: "dim"; text: WebKey; tip?: string }
  | { kind: "found"; version: string; sign: WebKey; signTone: "ok" | "warn" | "unknown"; runtime: { text: WebKey; names?: string } | "add"; tip?: string };

/** One cell: unknown, missing, or found with its sign-in and runtime (an Add button when it can be added here). */
export function cliCell(c: CliInfo | undefined, canAdd: boolean): CliCellState {
  if (!c || c.installed === undefined) return { kind: "dim", text: "clis.unknown", ...(c?.detail ? { tip: c.detail } : {}) };
  if (!c.installed) return { kind: "dim", text: "clis.missing", ...(c.detail ? { tip: c.detail } : {}) };
  const tip = [c.path, c.detail].filter(Boolean).join("\n");
  return {
    kind: "found",
    version: c.version ?? "✓",
    sign: c.signedIn === false ? "clis.signedOut" : c.signedIn ? "clis.signedIn" : "clis.unknown",
    signTone: c.signedIn === false ? "warn" : c.signedIn ? "ok" : "unknown",
    runtime: c.configured ? { text: "clis.runtime", names: c.runtimes.join(", ") } : canAdd ? "add" : { text: "clis.notConfigured" },
    ...(tip ? { tip } : {}),
  };
}

/** The CLIs the chat's machine menu names beside a machine: installed and not known to be signed out. */
export function usableClis(rows: MachineInventory[], peer: string | undefined): string[] {
  const row = rows.find((r) => r.machine === (peer ?? ""));
  return row?.clis.filter((c) => c.installed && c.signedIn !== false).map((c) => c.cli) ?? [];
}
