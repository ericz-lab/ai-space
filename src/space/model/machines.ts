import { splitMachine, type RuntimeRegistry } from "../runtimes/registry.ts";
import type { RuntimeSpec } from "../runtimes/types.ts";
import type { MachineCell } from "./api.ts";
import { problemOf, type HealthCell, type ProbeTarget, type RuntimeHealth } from "./health.ts";

/**
 * The status table across machines (docs/model-machines.md#status): this
 * space's cells, each peer's own cells as its snapshot reports them (under the
 * peer's name, merged with what this side saw of calls it forwarded there),
 * and which cells something here uses, so a used cell that cannot answer is
 * flagged.
 */

/** What a peer reports: its own cells and the runtimes it offers. */
export type PeerCells = { machine: string; cells: HealthCell[]; serves: { name: string; kind: string }[] };

/** Every runtime to probe: here, a runtime's own ssh host, and each `machines:` login. */
export function probeTargets(runtimes: RuntimeRegistry): ProbeTarget[] {
  const out: ProbeTarget[] = [];
  for (const { name } of runtimes.list()) {
    const spec = runtimes.spec(name);
    if (!spec) continue;
    const ssh = "sshHost" in spec ? spec.sshHost : undefined;
    // Chat and agent tasks always run here, so this machine's own CLI is probed even when answers go over ssh.
    out.push({ machine: "", spec: withoutSsh(spec) });
    if (ssh) out.push({ machine: ssh, spec, ssh });
  }
  for (const m of runtimes.machineList()) {
    for (const { name } of runtimes.list()) {
      const spec = runtimes.spec(name);
      if (spec && spec.kind !== "anthropic-api") out.push({ machine: m.name, spec: withoutSsh(spec), ssh: m.ssh });
    }
  }
  return out;
}

function withoutSsh(spec: RuntimeSpec): RuntimeSpec {
  if (!("sshHost" in spec)) return spec;
  const { sshHost: _, ...rest } = spec;
  return rest as RuntimeSpec;
}

/** `machine|runtime` for a model string as it resolves here; undefined when it names nothing this space knows. */
export function cellOf(model: string, runtimes: RuntimeRegistry): string | undefined {
  const remote = splitMachine(model);
  if (remote) return `${remote.machine}|${remote.runtime}`;
  const slash = model.indexOf("/");
  const name = slash < 0 ? runtimes.default?.name : model.slice(0, slash);
  if (!name) return undefined;
  const adapter = runtimes.get(name);
  return adapter ? `${adapter.machine ?? ""}|${name}` : `|${name}`;
}

export function statusTable(opts: { health: RuntimeHealth; runtimes: RuntimeRegistry; peers: PeerCells[]; used: string[]; now?: number }): MachineCell[] {
  const now = opts.now ?? Date.now();
  const cells = new Map<string, HealthCell>();
  for (const c of opts.health.list()) cells.set(`${c.machine}|${c.runtime}`, c);
  for (const p of opts.peers) {
    for (const s of p.serves) {
      const key = `${p.machine}|${s.name}`;
      const own = p.cells.find((c) => c.machine === "" && c.runtime === s.name);
      const seen = cells.get(key);
      cells.set(key, merge({ machine: p.machine, runtime: s.name, kind: s.kind, ...(own ? strip(own) : {}) }, seen));
    }
  }
  const used = new Set(opts.used.map((m) => cellOf(m, opts.runtimes)).filter((k): k is string => Boolean(k)));
  for (const key of used) {
    if (cells.has(key)) continue;
    const [machine = "", runtime = ""] = key.split("|");
    cells.set(key, { machine, runtime, kind: "", installed: false, detail: machine ? `${machine} does not offer ${runtime}` : `runtime ${runtime} is not configured` });
  }
  return [...cells.entries()]
    .map(([key, c]) => {
      const isUsed = used.has(key);
      const problem = isUsed ? problemOf(c, now) : undefined;
      return { ...c, used: isUsed, ...(problem ? { problem } : {}) };
    })
    .sort((a, b) => a.machine.localeCompare(b.machine) || a.runtime.localeCompare(b.runtime));
}

/** What the peer probed itself, without the fields this side keeps from its own calls. */
function strip(c: HealthCell): Partial<HealthCell> {
  const { machine: _m, runtime: _r, ...rest } = c;
  return rest;
}

/** The peer's report, with this side's newer success and longer rest (and that rest's cause). */
function merge(peer: HealthCell, seen?: HealthCell): HealthCell {
  if (!seen) return peer;
  const later = (a?: string, b?: string) => (!a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b);
  const lastOkAt = later(peer.lastOkAt, seen.lastOkAt);
  const limitedUntil = later(peer.limitedUntil, seen.limitedUntil);
  const rest = !limitedUntil ? {} : limitedUntil === peer.limitedUntil ? pick(peer) : pick(seen);
  const { restKind: _k, restSaid: _s, ...base } = peer;
  return {
    ...base, ...(lastOkAt ? { lastOkAt } : {}), ...(limitedUntil ? { limitedUntil, ...rest } : {}),
    ...(seen.lastError ? { lastError: seen.lastError, ...(seen.lastErrorKind ? { lastErrorKind: seen.lastErrorKind } : {}) } : {}),
  };
}

const pick = (c: HealthCell): Partial<HealthCell> => ({ ...(c.restKind ? { restKind: c.restKind } : {}), ...(c.restSaid ? { restSaid: true } : {}) });
