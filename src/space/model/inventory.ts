import { rename } from "node:fs/promises";
import { join } from "node:path";
import { isOperator } from "../auth.ts";
import { isHarnessAppCli } from "../local.ts";
import { RUNTIMES_FILE, parseRuntimesYaml, runtimesFromEnv } from "../runtimes/config.ts";
import type { RuntimeRegistry } from "../runtimes/registry.ts";
import { RUNTIME_NAME_PATTERN, type RuntimesConfig } from "../runtimes/types.ts";
import { AGENT_CLIS, type HealthCell, type RuntimeHealth } from "./health.ts";

/**
 * Which agent CLIs each machine has (docs/model-machines.md#inventory): this space, every
 * `machines:` login, and each peer as its snapshot reports itself. A CLI is listed whether or not a
 * runtime uses it, so the operator sees what is there; one found here that no runtime uses can be
 * added to `runtimes.yaml` from the panel. A peer's row is read-only: it is changed on the peer.
 *
 *   GET  /api/model/inventory          { ok, machines: MachineInventory[] }
 *   POST /api/model/status/probe       probe every runtime and CLI again now, refresh the peers; answers as GET
 *   POST /api/model/runtimes {kind}    add the CLI found here as a runtime in runtimes.yaml (operator only);
 *                                      { ok, runtime, restart: true }: it is offered after ai-space restarts
 */

export type CliEntry = {
  /** The command: claude, codex, dsh. */
  cli: string;
  kind: string;
  installed?: boolean;
  signedIn?: boolean;
  version?: string;
  /** Where it was found; only on this space's own row. */
  path?: string;
  detail?: string;
  checkedAt?: string;
  /** A runtime of this kind runs here. */
  configured: boolean;
  /** Those runtimes, by name. */
  runtimes: string[];
};

export type MachineInventory = {
  /** "" for this space, else the `machines:` or peer name. */
  machine: string;
  via: "local" | "ssh" | "peer";
  /** False when the ssh login failed. */
  reachable?: boolean;
  /** A peer that does not answer: its row is its last snapshot. */
  stale?: boolean;
  /** A peer that runs an older ai-space, whose snapshot has no inventory. */
  old?: boolean;
  clis: CliEntry[];
};

const pick = (c: HealthCell | undefined): Partial<CliEntry> => {
  if (!c) return {};
  const out: Partial<CliEntry> = {};
  for (const k of ["installed", "signedIn", "version", "path", "detail", "checkedAt"] as const) if (c[k] !== undefined) (out as Record<string, unknown>)[k] = c[k];
  return out;
};

/** One machine's row from this side's probes: a configured runtime's own cell first (its own command), the discovery for the rest. */
export function machineRow(health: RuntimeHealth, runtimes: RuntimeRegistry, machine: string, via: "local" | "ssh"): MachineInventory {
  const cells = health.list().filter((c) => c.machine === machine);
  const found = health.discovered().filter((c) => c.machine === machine);
  const clis = AGENT_CLIS.map(({ cli, kind }): CliEntry => {
    // Here, a runtime whose answers go over its own ssh still chats here; a `machines:` login runs every runtime of these kinds.
    const names = runtimes.list().filter((r) => r.kind === kind).map((r) => r.name);
    const own = cells.find((c) => names.includes(c.runtime) && c.installed !== undefined);
    const discovered = found.find((c) => c.runtime === cli);
    const entry: CliEntry = { cli, kind, configured: names.length > 0, runtimes: names, ...pick(own ?? discovered) };
    if (!entry.version && discovered?.version) entry.version = discovered.version;
    if (!entry.path && discovered?.path) entry.path = discovered.path;
    return entry;
  });
  const unreachable = [...cells, ...found].some((c) => c.reachable === false);
  return { machine, via, ...(unreachable ? { reachable: false } : {}), clis };
}

/** This space's own row as a peer hands it to a hub: no paths, nothing the hub could act on. */
export function peerRow(health: RuntimeHealth, runtimes: RuntimeRegistry): MachineInventory {
  const row = machineRow(health, runtimes, "", "local");
  return { ...row, clis: row.clis.map(({ path: _, ...c }) => c) };
}

export type InventoryOptions = {
  health: RuntimeHealth;
  runtimes: RuntimeRegistry;
  /** Each peer: its name, whether it answers, and the inventory its snapshot carries. */
  peers: () => { machine: string; stale: boolean; inventory?: MachineInventory }[];
  /** Probe every runtime and CLI here again, and refresh the peers' snapshots. */
  probe: () => Promise<void>;
  /** The workspace, where runtimes.yaml lives. */
  home: string;
  /** Operator token; with the owner's session it is who may change runtimes.yaml. */
  token: string;
  env?: Record<string, string | undefined>;
};

export function inventory(opts: Pick<InventoryOptions, "health" | "runtimes" | "peers">): MachineInventory[] {
  const rows = [machineRow(opts.health, opts.runtimes, "", "local"), ...opts.runtimes.machineList().map((m) => machineRow(opts.health, opts.runtimes, m.name, "ssh"))];
  for (const p of opts.peers()) {
    rows.push(p.inventory ? { ...p.inventory, machine: p.machine, via: "peer", ...(p.stale ? { stale: true } : {}), clis: p.inventory.clis.map(({ path: _, ...c }) => c) } : { machine: p.machine, via: "peer", ...(p.stale ? { stale: true } : {}), old: true, clis: [] });
  }
  return rows;
}

/**
 * runtimes.yaml with one more runtime for a CLI found here: its absolute path (the service's PATH
 * may not have it), under the CLI's name or the next free `<cli>-2`. The text is edited, not
 * re-serialized, so the operator's comments stay; the result must parse with the new runtime in it.
 * When the workspace has no file, it starts from the runtimes the environment describes.
 */
export function addRuntimeText(current: string | undefined, entry: { cli: string; kind: string; path: string }, env: Record<string, string | undefined> = process.env): { text: string; name: string } {
  const text = current ?? envRuntimesText(runtimesFromEnv(env));
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^runtimes:\s*(#.*)?$/.test(l));
  if (at < 0) throw new Error(`${RUNTIMES_FILE} has no block-style runtimes: mapping to add to; add the runtime by hand`);
  const { config } = parseRuntimesYaml(text, env);
  // Added earlier and not running yet: the file already has it, a restart is what is missing.
  const pending = config.runtimes.find((r) => r.kind === entry.kind);
  if (current !== undefined && pending) throw new Error(`${RUNTIMES_FILE} already has a ${entry.kind} runtime (${pending.name}); restart ai-space to use it`);
  const taken = new Set(config.runtimes.map((r) => r.name));
  let name = entry.cli;
  for (let i = 2; taken.has(name); i++) name = `${entry.cli}-${i}`;
  if (!RUNTIME_NAME_PATTERN.test(name)) throw new Error(`invalid runtime name ${name}`);
  const child = lines.slice(at + 1).find((l) => l.trim() && !l.trim().startsWith("#"));
  const indent = /^(\s+)/.exec(child ?? "")?.[1] ?? "  ";
  const block = [`${indent}${name}:`, `${indent}${indent}kind: ${entry.kind}`, `${indent}${indent}bin: [${JSON.stringify(entry.path)}]`];
  if (entry.kind === "deepseek-harness" && isHarnessAppCli(entry.path)) block.push(`${indent}${indent}provider: deepseek-account`);
  lines.splice(at + 1, 0, ...block);
  const next = lines.join("\n");
  const parsed = parseRuntimesYaml(next, env);
  if (!parsed.config.runtimes.some((r) => r.name === name && r.kind === entry.kind)) throw new Error(`the new ${RUNTIMES_FILE} does not carry runtime ${name}`);
  return { text: next, name };
}

/** The environment's runtimes as a file, so writing one keeps what the space runs today. Keys stay in the environment. */
function envRuntimesText(config: RuntimesConfig): string {
  const out = ["# Written by ai-space when a runtime was added from the panel; it replaces SPACE_MODEL_* (docs/runtimes.md).", ...(config.default ? [`default: ${config.default}`] : []), "runtimes:"];
  for (const r of config.runtimes) {
    out.push(`  ${r.name}:`, `    kind: ${r.kind}`);
    if (r.kind === "claude-code") {
      if (r.bin.length) out.push(`    bin: ${JSON.stringify(r.bin)}`);
      if (r.sshHost) out.push(`    ssh: ${r.sshHost}`);
      if (r.chatArgs.length) out.push(`    chatArgs: ${JSON.stringify(r.chatArgs)}`);
    } else if (r.kind === "anthropic-api") out.push("    apiKeyEnv: SPACE_MODEL_API_KEY", ...(r.apiUrl ? [`    url: ${r.apiUrl}`] : []));
  }
  return out.join("\n") + "\n";
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export function createInventoryRoutes(opts: InventoryOptions) {
  const list = () => json({ ok: true, machines: inventory(opts) });
  return {
    "/api/model/inventory": { GET: list },
    "/api/model/status/probe": {
      POST: async (req: Request) => {
        if (!isOperator(req, opts.token)) return json({ ok: false, error: "unauthorized" }, 401);
        await opts.probe();
        return list();
      },
    },
    "/api/model/runtimes": {
      POST: async (req: Request) => {
        if (!isOperator(req, opts.token)) return json({ ok: false, error: "unauthorized" }, 401);
        const body = (await req.json().catch(() => null)) as { kind?: unknown } | null;
        const known = AGENT_CLIS.find((c) => c.kind === body?.kind);
        if (!known) return json({ ok: false, error: `kind must be one of ${AGENT_CLIS.map((c) => c.kind).join(", ")}` }, 400);
        // Only what this space found itself: the path comes from its own probe, never from the request.
        const row = machineRow(opts.health, opts.runtimes, "", "local").clis.find((c) => c.kind === known.kind)!;
        if (row.configured) return json({ ok: false, error: `a ${known.cli} runtime is already configured (${row.runtimes.join(", ")})` }, 409);
        if (row.installed !== true || !row.path) return json({ ok: false, error: `${known.cli} was not found on this machine; install it, then check again` }, 409);
        const file = join(opts.home, RUNTIMES_FILE);
        const f = Bun.file(file);
        let next: { text: string; name: string };
        try {
          next = addRuntimeText((await f.exists()) ? await f.text() : undefined, { cli: known.cli, kind: known.kind, path: row.path }, opts.env);
        } catch (e) {
          return json({ ok: false, error: (e as Error).message }, 409);
        }
        const tmp = `${file}.${process.pid}.tmp`;
        await Bun.write(tmp, next.text);
        await rename(tmp, file);
        return json({ ok: true, runtime: next.name, restart: true });
      },
    },
  };
}
