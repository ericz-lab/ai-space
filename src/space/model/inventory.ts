import { chmod, rename } from "node:fs/promises";
import { join } from "node:path";
import { isOperator } from "../auth.ts";
import { isHarnessAppCli } from "../local.ts";
import { RUNTIMES_FILE, parseRuntimesYaml, runtimesFromEnv } from "../runtimes/config.ts";
import { MAGPIE_CALLER_KEY, MAGPIE_MODEL_PATTERN, type MagpieInfo, findMagpie, suggestMagpieTiers } from "../runtimes/magpie.ts";
import type { RuntimeRegistry } from "../runtimes/registry.ts";
import { MODEL_TIERS, RUNTIME_NAME_PATTERN, type RuntimeSpec, type RuntimesConfig, type TierModels } from "../runtimes/types.ts";
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
 *   POST /api/model/runtimes {kind: "magpie", model | models}
 *                                      add magpie's gateway as a runtime (docs/runtimes.md#magpie): Claude Code
 *                                      through it when this machine has Claude Code, else its Messages API;
 *                                      the models must be ones magpie offers now; Claude Code's tiers may be
 *                                      left out (the CLI's own model then)
 *   PUT  /api/model/runtimes/models {runtime, models}
 *                                      the tier pins of a runtime through magpie (operator only), written to its
 *                                      `models:` in runtimes.yaml and applied at once when the runtime runs;
 *                                      "" clears a tier. A new pin must be one magpie offers now; a saved one
 *                                      it no longer lists may stay
 *
 * The inventory's `magpie` says whether magpie is on this machine, what it offers (its routing
 * groups marked), and each runtime through it with its tier pins as runtimes.yaml has them.
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
  /** Look for magpie on this machine; tests replace it. */
  magpie?: () => Promise<MagpieInfo>;
};

/** A runtime through magpie and its tier pins, as runtimes.yaml has them. */
export type MagpiePins = {
  runtime: string;
  kind: "claude-code" | "anthropic-api";
  models: TierModels;
  /** This space runs it now; else it was added to the file and a restart loads it. */
  loaded: boolean;
};

/** magpie on this machine, as the panel shows it (docs/runtimes.md#magpie). */
export type MagpieView = MagpieInfo & {
  /** Some runtime answers through this gateway (a Claude Code runtime with `magpie:`, or an API runtime at its `/v1/messages`). */
  configured: boolean;
  runtimes: string[];
  /** Those runtimes with their tier pins. */
  pins: MagpiePins[];
  /** Pins to offer when it is added: routing groups named for a tier. */
  suggested: TierModels;
  /** What adding it makes: Claude Code through magpie (chat, agents, tools), or its Messages API (answers only). */
  adds: "claude-code" | "anthropic-api";
};

/** A runtime that answers through the gateway at `url`: Claude Code with `magpie:` there, or an API runtime at its `/v1/messages`. */
export function usesGateway(spec: RuntimeSpec, url: string): boolean {
  if (spec.kind === "claude-code") return spec.magpie === url;
  if (spec.kind === "anthropic-api") return spec.apiUrl.replace(/\/v1\/messages\/?$/, "") === url;
  return false;
}

/**
 * magpie's row: what the probe found, which runtimes use that gateway with their pins, and what
 * adding it would make. The pins come from runtimes.yaml when it is given (`file`), so a runtime
 * just added shows before a restart loads it; else from the runtimes this space runs.
 */
export function magpieView(info: MagpieInfo, runtimes: RuntimeRegistry, claude: CliEntry | undefined, file?: RuntimesConfig): MagpieView {
  const loaded = new Set(runtimes.list().filter((r) => {
    const spec = runtimes.spec(r.name);
    return spec ? usesGateway(spec, info.url) : false;
  }).map((r) => r.name));
  const specs = file ? file.runtimes : runtimes.list().map((r) => runtimes.spec(r.name)).filter((x): x is RuntimeSpec => Boolean(x));
  const pins: MagpiePins[] = specs
    .filter((spec) => usesGateway(spec, info.url))
    .map((spec) => ({ runtime: spec.name, kind: spec.kind as MagpiePins["kind"], models: { ...spec.models }, loaded: loaded.has(spec.name) }));
  const names = [...new Set([...pins.map((p) => p.runtime), ...loaded])];
  return { ...info, configured: names.length > 0, runtimes: names, pins, suggested: suggestMagpieTiers(info), adds: claude?.installed && claude.path ? "claude-code" : "anthropic-api" };
}

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

/**
 * runtimes.yaml with a runtime that answers through magpie, as `magpie` or the next free `magpie-<n>`:
 * Claude Code through the gateway when `claude` is its path (chat, agent tasks and answers, with
 * tools), else the gateway's Messages API (answers only), whose caller key goes in `.env` as
 * MAGPIE_API_KEY. The API form needs a pin for each tier it serves; Claude Code's unpinned tiers
 * are the CLI's own models.
 */
export function addMagpieRuntimeText(current: string | undefined, entry: { url: string; models: TierModels; claude?: string }, env: Record<string, string | undefined> = process.env): { text: string; name: string; envUpdates: Record<string, string> } {
  const text = current ?? envRuntimesText(runtimesFromEnv(env));
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^runtimes:\s*(#.*)?$/.test(l));
  if (at < 0) throw new Error(`${RUNTIMES_FILE} has no block-style runtimes: mapping to add to; add the runtime by hand`);
  const { config } = parseRuntimesYaml(text, { ...env, MAGPIE_API_KEY: env.MAGPIE_API_KEY || MAGPIE_CALLER_KEY });
  const already = config.runtimes.find((r) => usesGateway(r, entry.url));
  if (current !== undefined && already) throw new Error(`${RUNTIMES_FILE} already has runtime ${already.name} through magpie; restart ai-space to use it`);
  const taken = new Set(config.runtimes.map((r) => r.name));
  let name = "magpie";
  for (let i = 2; taken.has(name); i++) name = `magpie-${i}`;
  const child = lines.slice(at + 1).find((l) => l.trim() && !l.trim().startsWith("#"));
  const i1 = /^(\s+)/.exec(child ?? "")?.[1] ?? "  ";
  const i2 = i1 + i1;
  const block = [`${i1}${name}:`];
  const envUpdates: Record<string, string> = {};
  if (entry.claude) {
    block.push(`${i2}# Claude Code answering through magpie: GLM, Kimi, MiniMax and the other providers magpie holds (docs/runtimes.md#magpie)`, `${i2}kind: claude-code`, `${i2}bin: [${JSON.stringify(entry.claude)}]`, `${i2}magpie: ${entry.url}`);
  } else {
    block.push(`${i2}# magpie's Messages API: answers only, no tools or chat (docs/runtimes.md#magpie)`, `${i2}kind: anthropic-api`, `${i2}url: ${entry.url}/v1/messages`, `${i2}apiKeyEnv: MAGPIE_API_KEY`);
    if (!env.MAGPIE_API_KEY?.trim()) envUpdates.MAGPIE_API_KEY = MAGPIE_CALLER_KEY;
  }
  // Claude Code's tiers left out are the CLI's own; set them later in Settings → Models.
  if (MODEL_TIERS.some((t) => entry.models[t])) block.push(`${i2}models:`);
  for (const tier of MODEL_TIERS) if (entry.models[tier]) block.push(`${i2}${i1}${tier}: ${JSON.stringify(entry.models[tier])}`);
  lines.splice(at + 1, 0, ...block);
  const next = lines.join("\n");
  const parsed = parseRuntimesYaml(next, { ...env, ...envUpdates });
  if (!parsed.config.runtimes.some((r) => r.name === name)) throw new Error(`the new ${RUNTIMES_FILE} does not carry runtime ${name}`);
  return { text: next, name, envUpdates };
}

/**
 * The tiers a request names: one model for all four, or a model per tier; each one magpie offers.
 * `allowNone` (Claude Code through magpie) accepts none: every tier is then the CLI's own.
 */
export function magpieTiers(body: { model?: unknown; models?: unknown }, offered: string[], allowNone = false): TierModels | { error: string } {
  const out: TierModels = {};
  if (typeof body.model === "string" && body.model) for (const tier of MODEL_TIERS) out[tier] = body.model;
  if (body.models && typeof body.models === "object") {
    for (const [tier, model] of Object.entries(body.models as Record<string, unknown>)) {
      if (!(MODEL_TIERS as readonly string[]).includes(tier)) return { error: `unknown tier ${tier}` };
      if (typeof model === "string" && model) out[tier as keyof TierModels] = model;
    }
  }
  const picked = Object.values(out);
  if (!picked.length && !allowNone) return { error: "name the model magpie should answer with (model, or models by tier)" };
  const bad = picked.find((m) => !MAGPIE_MODEL_PATTERN.test(m!) || !offered.includes(m!));
  if (bad) return { error: `magpie does not offer ${bad}; check again and pick one of its models` };
  return out;
}

/**
 * runtimes.yaml with a runtime's `models:` set to `models` (an empty one removes it). The text is
 * edited, not re-serialized, so the operator's comments stay; the result must parse with exactly
 * these pins on that runtime and every other runtime as it was, or nothing is written.
 */
export function setTierPinsText(current: string, runtime: string, models: TierModels, env: Record<string, string | undefined> = process.env): string {
  const lines = current.split("\n");
  const content = (l: string) => l.trim() !== "" && !l.trim().startsWith("#");
  const indent = (l: string) => /^(\s*)/.exec(l)![1]!.length;
  const at = lines.findIndex((l) => /^runtimes:\s*(#.*)?$/.test(l));
  if (at < 0) throw new Error(`${RUNTIMES_FILE} has no block-style runtimes: mapping; set the models by hand`);
  let start = -1;
  let i1 = -1;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!content(l)) continue;
    const ind = indent(l);
    if (ind === 0) break;
    if (i1 < 0) i1 = ind;
    const m = /^\s*(["']?)([A-Za-z0-9._-]+)\1:\s*(#.*)?$/.exec(l);
    if (ind === i1 && m?.[2] === runtime) {
      start = i;
      break;
    }
  }
  if (start < 0) throw new Error(`${RUNTIMES_FILE} has no block-style runtime ${runtime}; set its models by hand`);
  let end = start + 1;
  let lastContent = start;
  for (; end < lines.length; end++) {
    const l = lines[end]!;
    if (!content(l)) continue;
    if (indent(l) <= i1) break;
    lastContent = end;
  }
  const childAt = lines.slice(start + 1, lastContent + 1).find(content);
  const i2 = childAt ? indent(childAt) : i1 * 2;
  const pad2 = " ".repeat(i2);
  const pad3 = " ".repeat(i2 + (i2 - i1 || 2));
  const block = MODEL_TIERS.some((t) => models[t]) ? [`${pad2}models:`, ...MODEL_TIERS.filter((t) => models[t]).map((t) => `${pad3}${t}: ${JSON.stringify(models[t])}`)] : [];
  let from = -1;
  let to = -1;
  for (let i = start + 1; i <= lastContent; i++) {
    const l = lines[i]!;
    if (content(l) && indent(l) === i2 && /^\s*models:/.test(l)) {
      from = i;
      to = i;
      for (let j = i + 1; j <= lastContent; j++) {
        if (!content(lines[j]!)) continue;
        if (indent(lines[j]!) <= i2) break;
        to = j;
      }
      break;
    }
  }
  if (from >= 0) lines.splice(from, to - from + 1, ...block);
  else lines.splice(lastContent + 1, 0, ...block);
  const next = lines.join("\n");
  const before = parseRuntimesYaml(current, env).config;
  const after = parseRuntimesYaml(next, env).config;
  const want = JSON.stringify(Object.fromEntries(MODEL_TIERS.filter((t) => models[t]).map((t) => [t, models[t]])));
  const got = after.runtimes.find((r) => r.name === runtime);
  const pinsOf = (r: RuntimeSpec | undefined) => JSON.stringify(Object.fromEntries(MODEL_TIERS.filter((t) => r?.models?.[t]).map((t) => [t, r!.models![t]])));
  const others = (c: RuntimesConfig) => JSON.stringify({ ...c, runtimes: c.runtimes.map((r) => (r.name === runtime ? { ...r, models: undefined } : r)) });
  if (!got || pinsOf(got) !== want || others(before) !== others(after)) throw new Error(`could not set the models of ${runtime} in ${RUNTIMES_FILE} safely; set them by hand`);
  return next;
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
  const env = opts.env ?? process.env;
  const findMagpieHere = opts.magpie ?? (() => findMagpie({ env }));
  const localClaude = () => machineRow(opts.health, opts.runtimes, "", "local").clis.find((c) => c.kind === "claude-code");
  const runtimesFile = join(opts.home, RUNTIMES_FILE);
  /** runtimes.yaml as it is now, or undefined when there is none or it does not parse. */
  const fileConfig = async (): Promise<RuntimesConfig | undefined> => {
    const f = Bun.file(runtimesFile);
    if (!(await f.exists())) return undefined;
    try {
      return parseRuntimesYaml(await f.text(), { ...env, MAGPIE_API_KEY: env.MAGPIE_API_KEY || MAGPIE_CALLER_KEY }).config;
    } catch {
      return undefined;
    }
  };
  const list = async () => json({ ok: true, machines: inventory(opts), magpie: magpieView(await findMagpieHere(), opts.runtimes, localClaude(), await fileConfig()) });
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
        const body = (await req.json().catch(() => null)) as { kind?: unknown; model?: unknown; models?: unknown } | null;
        if (body?.kind === "magpie") return addMagpie(body);
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
    "/api/model/runtimes/models": {
      PUT: async (req: Request) => {
        if (!isOperator(req, opts.token)) return json({ ok: false, error: "unauthorized" }, 401);
        const body = (await req.json().catch(() => null)) as { runtime?: unknown; models?: unknown } | null;
        if (typeof body?.runtime !== "string" || !RUNTIME_NAME_PATTERN.test(body.runtime)) return json({ ok: false, error: "runtime must name a runtime" }, 400);
        if (!body.models || typeof body.models !== "object" || Array.isArray(body.models)) return json({ ok: false, error: "models must map tiers to magpie's model ids" }, 400);
        return saveTierPins(body.runtime, body.models as Record<string, unknown>);
      },
    },
  };

  /**
   * A magpie runtime's tier pins from Settings: each one magpie offers now, or the one already saved
   * (kept while magpie is down, or after it stopped listing it); "" clears the tier.
   */
  async function saveTierPins(runtime: string, asked: Record<string, unknown>): Promise<Response> {
    const f = Bun.file(runtimesFile);
    if (!(await f.exists())) return json({ ok: false, error: `${RUNTIMES_FILE} has no runtime ${runtime}` }, 404);
    const text = await f.text();
    const config = await fileConfig();
    if (!config) return json({ ok: false, error: `${RUNTIMES_FILE} does not parse; fix it first` }, 409);
    const info = await findMagpieHere();
    const spec = config.runtimes.find((r) => r.name === runtime);
    if (!spec) return json({ ok: false, error: `${RUNTIMES_FILE} has no runtime ${runtime}` }, 404);
    if (!usesGateway(spec, info.url)) return json({ ok: false, error: `runtime ${runtime} does not answer through magpie at ${info.url}` }, 409);
    const models: TierModels = {};
    for (const [tier, value] of Object.entries(asked)) {
      if (!(MODEL_TIERS as readonly string[]).includes(tier)) return json({ ok: false, error: `unknown tier ${tier}` }, 400);
      if (value === "" || value === null || value === undefined) continue;
      if (typeof value !== "string" || !MAGPIE_MODEL_PATTERN.test(value)) return json({ ok: false, error: `${tier}: not a model id` }, 400);
      const saved = spec.models?.[tier as keyof TierModels];
      if (value !== saved && !info.models.includes(value)) {
        return json({ ok: false, error: info.running ? `magpie does not offer ${value}; check again and pick one of its models` : `magpie does not answer (${info.error ?? info.url}); a new model can be picked once it does` }, info.running ? 400 : 409);
      }
      models[tier as keyof TierModels] = value;
    }
    if (spec.kind === "anthropic-api" && !Object.keys(models).length) return json({ ok: false, error: "magpie's Messages API needs a model for at least one tier" }, 400);
    let next: string;
    try {
      next = setTierPinsText(text, runtime, models, { ...env, MAGPIE_API_KEY: env.MAGPIE_API_KEY || MAGPIE_CALLER_KEY });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 409);
    }
    await writeAtomic(runtimesFile, next);
    // Running already: its tiers and the next process it starts use the new pins; else a restart loads it.
    const applied = Boolean(opts.runtimes.spec(runtime) && usesGateway(opts.runtimes.spec(runtime)!, info.url)) && opts.runtimes.setTierPins(runtime, models);
    return json({ ok: true, runtime, models, applied, ...(applied ? {} : { restart: true }) });
  }

  /** Add magpie as a runtime: only a gateway this space found answering, with models it offers. */
  async function addMagpie(body: { model?: unknown; models?: unknown }): Promise<Response> {
    const info = await findMagpieHere();
    if (!info.running) return json({ ok: false, error: `magpie does not answer (${info.error ?? info.url}); start it, then check again` }, 409);
    const view = magpieView(info, opts.runtimes, localClaude(), await fileConfig());
    if (view.configured) {
      const waiting = view.pins.filter((p) => !p.loaded).map((p) => p.runtime);
      return json({ ok: false, error: waiting.length ? `${RUNTIMES_FILE} already has runtime ${waiting.join(", ")} through magpie; restart ai-space to use it` : `magpie is already a runtime (${view.runtimes.join(", ")})` }, 409);
    }
    const tiers = magpieTiers(body, info.models, view.adds === "claude-code");
    if ("error" in tiers) return json({ ok: false, error: tiers.error }, 400);
    const file = runtimesFile;
    const f = Bun.file(file);
    const claude = localClaude();
    let next: ReturnType<typeof addMagpieRuntimeText>;
    try {
      next = addMagpieRuntimeText((await f.exists()) ? await f.text() : undefined, { url: info.url, models: tiers, ...(view.adds === "claude-code" ? { claude: claude!.path! } : {}) }, env);
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 409);
    }
    if (Object.keys(next.envUpdates).length) {
      // The caller key is not a secret (magpie needs none from loopback); it names ai-space in magpie's usage.
      // Loaded here, not at the top: setup.ts imports this file for the same runtimes.yaml edit.
      const { updateEnvText } = await import("../setup.ts");
      const envFile = join(opts.home, ".env");
      const ef = Bun.file(envFile);
      await writeAtomic(envFile, updateEnvText((await ef.exists()) ? await ef.text() : "", next.envUpdates), 0o600);
    }
    await writeAtomic(file, next.text);
    return json({ ok: true, runtime: next.name, kind: view.adds, restart: true });
  }
}

async function writeAtomic(file: string, text: string, mode?: number): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await Bun.write(tmp, text);
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, file);
}
