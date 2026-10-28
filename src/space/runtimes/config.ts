import { join } from "node:path";
import { FALLBACK_MODEL_PATTERN, MACHINE_NAME_PATTERN, MODEL_TIERS, RUNTIME_KINDS, RUNTIME_NAME_PATTERN, type MachineSpec, type ModelTier, type RuntimeKind, type RuntimeSpec, type RuntimesConfig, type TierModels } from "./types.ts";

/**
 * Which runtimes a space has: `<workspace>/runtimes.yaml`, or, when the file
 * is absent, the single Claude Code runtime the `SPACE_MODEL_*` and
 * `SPACE_CHAT_*` variables describe (the shape every space had before the
 * file existed, so nothing changes for them).
 *
 *   default: claude               # optional: runtime a bare model name goes to; without it, every
 *                                 # model must be `runtime/model` (a bare one is an error)
 *   runtimes:
 *     claude:
 *       kind: claude-code
 *       ssh: box                  # optional: answers borrow that machine's login
 *       bin: /usr/local/bin/claude   # optional: the CLI command, string or list
 *       chatArgs: [--foo]         # optional: appended to every chat turn
 *     api:
 *       kind: anthropic-api
 *       apiKeyEnv: ANTHROPIC_API_KEY   # variable holding the key (default shown)
 *       url: https://…            # optional
 *     dsh:
 *       kind: deepseek-harness
 *       ssh: box                  # optional: answers run on that machine's harness
 *       bin: /home/me/.npm-global/bin/dsh   # optional: the CLI command; default dsh
 *       home: /home/me/.dsh       # optional: DSH_HOME; default the CLI's own
 *       profile: headless         # optional: answers and agent runs; default shown
 *       liveProfile: acp          # optional: live chat; default shown
 *       provider: deepseek-account   # optional: model route; default deepseek-official
 *   machines:                     # optional: ssh logins that answer as `<machine>:<runtime>/<model>`
 *     bare:
 *       ssh: bare-alias           # an alias from the operator's ~/.ssh/config
 *   fallback:                     # optional: where a call goes when its model's account or link fails
 *     codex/basic: [box:codex/basic, dsh/basic]   # tiers only, never a higher one than the key's
 *
 * A runtime's own `ssh:` still works (answers on that machine under the runtime's own name) and
 * draws a warning: naming the machine shows in the model string where the call runs
 * (docs/model-machines.md).
 * Keys stay in the environment, never in the file: `apiKeyEnv` names the
 * variable. A runtime whose key variable is empty is dropped with a warning
 * rather than failing the boot, so a space keeps running when one login is
 * missing.
 */

export const RUNTIMES_FILE = "runtimes.yaml";

export type LoadedRuntimes = { config: RuntimesConfig; source: "file" | "env"; warnings: string[] };

export function runtimesFromEnv(env: Record<string, string | undefined> = process.env): RuntimesConfig {
  const bin = (env.SPACE_MODEL_BIN?.trim() || env.SPACE_CHAT_BIN?.trim() || "").split(/\s+/).filter(Boolean);
  const sshHost = env.SPACE_MODEL_SSH_HOST?.trim() ?? "";
  const apiKey = env.SPACE_MODEL_API_KEY?.trim() ?? "";
  const runtimes: RuntimeSpec[] = [{ name: "claude", kind: "claude-code", bin, ...(sshHost ? { sshHost } : {}), chatArgs: (env.SPACE_CHAT_ARGS ?? "").split(/\s+/).filter(Boolean) }];
  if (apiKey) runtimes.push({ name: "api", kind: "anthropic-api", apiKey, apiUrl: "" });
  return { default: apiKey ? "api" : "claude", runtimes };
}

export function parseRuntimesYaml(text: string, env: Record<string, string | undefined> = process.env): { config: RuntimesConfig; warnings: string[] } {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch (e) {
    throw new Error(`${RUNTIMES_FILE}: invalid YAML: ${(e as Error).message}`);
  }
  if (!isRecord(doc)) throw new Error(`${RUNTIMES_FILE}: must be a mapping`);
  for (const key of Object.keys(doc)) if (key !== "default" && key !== "runtimes" && key !== "machines" && key !== "fallback") throw new Error(`${RUNTIMES_FILE}: unknown key "${key}"`);
  if (!isRecord(doc.runtimes) || Object.keys(doc.runtimes).length === 0) throw new Error(`${RUNTIMES_FILE}: runtimes must be a non-empty mapping`);

  const warnings: string[] = [];
  const runtimes: RuntimeSpec[] = [];
  for (const [name, raw] of Object.entries(doc.runtimes)) {
    if (!RUNTIME_NAME_PATTERN.test(name)) throw new Error(`${RUNTIMES_FILE}: invalid runtime name "${name}"`);
    if (!isRecord(raw)) throw new Error(`${RUNTIMES_FILE}: runtime ${name} must be a mapping`);
    const kind = raw.kind;
    if (typeof kind !== "string" || !(RUNTIME_KINDS as readonly string[]).includes(kind)) throw new Error(`${RUNTIMES_FILE}: runtime ${name}: kind must be one of ${RUNTIME_KINDS.join(", ")}`);
    const spec = parseSpec(name, kind as RuntimeKind, raw, env);
    if ("warning" in spec) warnings.push(spec.warning);
    else {
      if (raw.models !== undefined) {
        if (!isRecord(raw.models)) throw new Error(`${RUNTIMES_FILE}: runtime ${name}: models must be a mapping`);
        const models: TierModels = {};
        for (const [tier, model] of Object.entries(raw.models)) {
          if (!(MODEL_TIERS as readonly string[]).includes(tier)) throw new Error(`${RUNTIMES_FILE}: unknown model tier ${tier}`);
          // An API runtime's model never meets a shell: a gateway's `provider/model` id (magpie's) is taken as is.
          const id = kind === "anthropic-api" ? /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
          if (typeof model !== "string" || !id.test(model) || (MODEL_TIERS as readonly string[]).includes(model)) throw new Error(`${RUNTIMES_FILE}: ${tier} must name a concrete model`);
          models[tier as ModelTier] = model;
        }
        spec.models = models;
      }
      if ("sshHost" in spec && spec.sshHost) warnings.push(`runtime ${name}: ssh is deprecated; name the machine under machines: and call it as <machine>:${name}/<model> (docs/model-machines.md)`);
      runtimes.push(spec);
    }
  }
  const machines = parseMachines(doc.machines);
  if (runtimes.length === 0) throw new Error(`${RUNTIMES_FILE}: no usable runtime (${warnings.join("; ")})`);

  // No `default`: no runtime takes a bare model name; every model names its runtime.
  const def = doc.default;
  if (def !== undefined && (typeof def !== "string" || !runtimes.some((r) => r.name === def))) throw new Error(`${RUNTIMES_FILE}: default must name a configured runtime`);
  const skipped = new Set(Object.keys(doc.runtimes).filter((n) => !runtimes.some((r) => r.name === n)));
  const fallback = parseFallback(doc.fallback, runtimes, machines, skipped, warnings);
  return { config: { ...(def !== undefined ? { default: def as string } : {}), runtimes, ...(machines.length ? { machines } : {}), ...(Object.keys(fallback).length ? { fallback } : {}) }, warnings };
}

/**
 * `fallback:` (docs/model-machines.md#fallback): `[machine:]runtime/<tier>` → a list of the same.
 * Tiers only, so cost is comparable: an entry above its key's tier is refused, and so is a runtime
 * this file does not configure (on this machine or a `machines:` login). A machine that is not under
 * `machines:` is taken for a peer, checked when a call uses it. An entry naming a runtime that was
 * skipped for a missing key is dropped with a warning, like the runtime itself.
 */
function parseFallback(raw: unknown, runtimes: RuntimeSpec[], machines: MachineSpec[], skipped: Set<string>, warnings: string[]): Record<string, string[]> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${RUNTIMES_FILE}: fallback must map a model to a list of models`);
  const rank = (tier: string) => (MODEL_TIERS as readonly string[]).indexOf(tier);
  /** The model's tier, or undefined when it names a runtime that was skipped. */
  const check = (model: string, where: string): string | undefined => {
    const m = FALLBACK_MODEL_PATTERN.exec(model);
    if (!m) throw new Error(`${where}: ${model} must be [machine:]runtime/<tier> (basic, junior, intermediate or advanced)`);
    const [, machine, runtime, tier] = m;
    const spec = runtimes.find((r) => r.name === runtime);
    if (!machine || machines.some((x) => x.name === machine)) {
      if (!spec && skipped.has(runtime!)) return undefined;
      if (!spec) throw new Error(`${where}: runtime ${runtime} is not configured`);
      if (machine && spec.kind === "anthropic-api") throw new Error(`${where}: runtime ${runtime} (anthropic-api) cannot run on another machine`);
    }
    return tier;
  };
  const out: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(raw)) {
    const ctx = `${RUNTIMES_FILE}: fallback ${key}`;
    const keyTier = check(key, `${RUNTIMES_FILE}: fallback`);
    if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === "string")) throw new Error(`${ctx} must be a non-empty list of models`);
    if (keyTier === undefined) {
      warnings.push(`fallback ${key} skipped: its runtime was skipped`);
      continue;
    }
    const entries: string[] = [];
    for (const raw of list as string[]) {
      const entry = raw.trim();
      const tier = check(entry, ctx);
      if (entry === key) throw new Error(`${ctx}: lists itself`);
      if (entries.includes(entry)) throw new Error(`${ctx}: lists ${entry} twice`);
      if (tier === undefined) {
        warnings.push(`fallback ${key}: ${entry} dropped: its runtime was skipped`);
        continue;
      }
      if (rank(tier) > rank(keyTier)) throw new Error(`${ctx}: ${entry} is a higher tier than ${keyTier}; a fallback never raises cost`);
      entries.push(entry);
    }
    if (entries.length) out[key] = entries;
  }
  return out;
}

function parseMachines(raw: unknown): MachineSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) throw new Error(`${RUNTIMES_FILE}: machines must be a mapping`);
  return Object.entries(raw).map(([name, m]) => {
    const ctx = `${RUNTIMES_FILE}: machine ${name}`;
    if (!MACHINE_NAME_PATTERN.test(name)) throw new Error(`${RUNTIMES_FILE}: invalid machine name "${name}"`);
    if (!isRecord(m)) throw new Error(`${ctx} must be a mapping`);
    for (const key of Object.keys(m)) if (key !== "ssh") throw new Error(`${ctx} has unknown key "${key}"`);
    const ssh = optionalString(m.ssh, `${ctx}: ssh`);
    if (!ssh || !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(ssh)) throw new Error(`${ctx}: ssh must be a host name or alias`);
    return { name, ssh };
  });
}

function parseSpec(name: string, kind: RuntimeKind, raw: Record<string, unknown>, env: Record<string, string | undefined>): RuntimeSpec | { warning: string } {
  const ctx = `${RUNTIMES_FILE}: runtime ${name}`;
  const allowed: Record<RuntimeKind, string[]> = {
    "claude-code": ["kind", "ssh", "bin", "chatArgs"],
    "anthropic-api": ["kind", "apiKeyEnv", "url"],
    "deepseek-harness": ["kind", "ssh", "bin", "home", "profile", "liveProfile", "provider"],
    "codex-cli": ["kind", "ssh", "bin", "streamCompletions"],
  };
  for (const key of Object.keys(raw)) if (key !== "models" && !allowed[kind].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  switch (kind) {
    case "codex-cli": {
      if (raw.streamCompletions !== undefined && typeof raw.streamCompletions !== "boolean") throw new Error(`${ctx}: streamCompletions must be boolean`);
      const sshHost = optionalString(raw.ssh, `${ctx}: ssh`);
      if (sshHost && !/^[A-Za-z0-9][A-Za-z0-9._@-]*$/.test(sshHost)) throw new Error(`${ctx}: ssh is not a host name`);
      if (sshHost && raw.streamCompletions) throw new Error(`${ctx}: streamCompletions requires a local runtime`);
      return { name, kind, bin: command(raw.bin, `${ctx}: bin`), ...(sshHost ? { sshHost } : {}), ...(raw.streamCompletions !== undefined ? { streamCompletions: raw.streamCompletions as boolean } : {}) };
    }
    case "claude-code": {
      const sshHost = optionalString(raw.ssh, `${ctx}: ssh`);
      if (sshHost && !/^[A-Za-z0-9._@-]+$/.test(sshHost)) throw new Error(`${ctx}: ssh is not a host name`);
      return { name, kind, bin: command(raw.bin, `${ctx}: bin`), ...(sshHost ? { sshHost } : {}), chatArgs: command(raw.chatArgs, `${ctx}: chatArgs`) };
    }
    case "anthropic-api": {
      const keyEnv = optionalString(raw.apiKeyEnv, `${ctx}: apiKeyEnv`) ?? "ANTHROPIC_API_KEY";
      const apiKey = env[keyEnv]?.trim() ?? "";
      if (!apiKey) return { warning: `runtime ${name} skipped: ${keyEnv} is not set` };
      return { name, kind, apiKey, apiUrl: optionalString(raw.url, `${ctx}: url`) ?? "" };
    }
    case "deepseek-harness": {
      const sshHost = optionalString(raw.ssh, `${ctx}: ssh`);
      if (sshHost && !/^[A-Za-z0-9._@-]+$/.test(sshHost)) throw new Error(`${ctx}: ssh is not a host name`);
      const home = optionalString(raw.home, `${ctx}: home`);
      const profile = optionalString(raw.profile, `${ctx}: profile`) ?? "headless";
      if (!/^[a-z][a-z0-9-]*$/.test(profile)) throw new Error(`${ctx}: profile must be a profile name`);
      const liveProfile = optionalString(raw.liveProfile, `${ctx}: liveProfile`) ?? "acp";
      if (!/^[a-z][a-z0-9-]*$/.test(liveProfile)) throw new Error(`${ctx}: liveProfile must be a profile name`);
      const provider = optionalString(raw.provider, `${ctx}: provider`) ?? "deepseek-official";
      if (!/^[a-z][a-z0-9.-]*$/.test(provider)) throw new Error(`${ctx}: provider must be a provider name`);
      return {
        name, kind, bin: command(raw.bin, `${ctx}: bin`), profile, liveProfile, provider,
        ...(home ? { home } : {}), ...(sshHost ? { sshHost } : {}),
      };
    }
  }
}

/** Load the file when present, else the environment's single runtime. */
export async function loadRuntimes(workspaceHome: string, env: Record<string, string | undefined> = process.env): Promise<LoadedRuntimes> {
  const file = Bun.file(join(workspaceHome, RUNTIMES_FILE));
  if (!(await file.exists())) return { config: runtimesFromEnv(env), source: "env", warnings: [] };
  const { config, warnings } = parseRuntimesYaml(await file.text(), env);
  return { config, source: "file", warnings };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalString(v: unknown, ctx: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new Error(`${ctx} must be a string`);
  return v.trim() || undefined;
}

/** A command as one string (split on whitespace) or a list of words. */
function command(v: unknown, ctx: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return v.split(/\s+/).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).map((x) => x.trim()).filter(Boolean);
  throw new Error(`${ctx} must be a string or a list of strings`);
}
