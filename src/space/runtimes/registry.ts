import { createAnthropicApi } from "./anthropic-api.ts";
import { createClaudeCode } from "./claude-code.ts";
import { createCodexCli } from "./codex-cli.ts";
import { createDeepseekHarness } from "./deepseek-harness.ts";
import { MACHINE_NAME_PATTERN, MODEL_TIERS, RUNTIME_NAME_PATTERN, type MachineSpec, type ModelTier, type TierModels, type RuntimeAdapter, type RuntimeSpec, type RuntimesConfig } from "./types.ts";

/**
 * The configured runtimes by name, and the rule that turns a model string
 * into one of them: `runtime/model` names the runtime, a bare model goes to
 * the default, and is an error when there is no default. Unknown names are errors the callers turn into 400s or 501s;
 * nothing falls back silently to another runtime.
 *
 * A model may also name a machine: `box:codex/basic` (docs/model-machines.md). The machine is an
 * ssh login under `machines:`, whose answers this space's own adapter runs over ssh, or a peer,
 * whose adapter the peers module supplies (`attachRemote`): the peer resolves the tier itself.
 */
export type RegistryDeps = { fetch?: typeof fetch };

/** Runtimes on other spaces (the peers): an adapter for `machine:runtime`, or why there is none. */
export type RemoteRuntimes = {
  names(): string[];
  adapter(machine: string, runtime: string): RuntimeAdapter | { error: string };
  /** What each peer offers, with its tier names, for the panel's model choices. */
  offered(): { machine: string; runtime: string; kind: string; image: boolean; tiers: TierModels }[];
};

/** A model choice on another machine: `machine:runtime/tier`. */
export type MachineTierOption = { value: string; machine: string; runtime: string; tier: ModelTier; model: string; capabilities: RuntimeAdapter["capabilities"] };

/** Kinds whose answers can run over ssh. */
const SSH_KINDS = new Set<RuntimeSpec["kind"]>(["claude-code", "codex-cli", "deepseek-harness"]);

/** `machine:runtime/model` → its parts; `undefined` when the string names no machine. */
export function splitMachine(model: string): { machine: string; runtime: string; model: string } | undefined {
  const slash = model.indexOf("/");
  if (slash < 0) return undefined;
  const head = model.slice(0, slash);
  const colon = head.indexOf(":");
  if (colon < 0) return undefined;
  return { machine: head.slice(0, colon), runtime: head.slice(colon + 1), model: model.slice(slash + 1) };
}

export type RuntimeView = { name: string; kind: string; backend: string; capabilities: RuntimeAdapter["capabilities"]; default: boolean };

/**
 * Operator vocabulary: basic/基础, junior/初级, intermediate/中级, advanced/高级.
 * Codex's names are only the fallback: at boot its tiers come from the installed
 * CLI's catalogue (codex-upgrade.ts, `applyCatalogTiers`), and runtimes.yaml pins win over both.
 */
export const TIER_DEFAULTS: Partial<Record<RuntimeSpec["kind"], TierModels>> = {
  "claude-code": { basic: "haiku", junior: "sonnet", intermediate: "opus", advanced: "fable" },
  "codex-cli": { basic: "gpt-6-luna", junior: "gpt-5.6-terra", intermediate: "gpt-6.1-sol", advanced: "gpt-6-astra" },
  // DeepSeek Harness has two routes: flash serves basic, junior and the default intermediate; only advanced is pro.
  "deepseek-harness": { basic: "deepseek-flash", junior: "deepseek-flash", intermediate: "deepseek-flash", advanced: "deepseek-v4-pro" },
};

export class RuntimeRegistry {
  private readonly byName = new Map<string, RuntimeAdapter>();
  private readonly models = new Map<string, TierModels>();
  private readonly specs = new Map<string, RuntimeSpec>();
  private readonly machines = new Map<string, MachineSpec>();
  private readonly machineAdapters = new Map<string, RuntimeAdapter>();
  private remote: RemoteRuntimes | undefined;
  private readonly deps: RegistryDeps;
  /** Where a bare model name goes; undefined when every model must name its runtime. */
  readonly default: RuntimeAdapter | undefined;

  constructor(config: RuntimesConfig, deps: RegistryDeps = {}) {
    this.deps = deps;
    for (const m of config.machines ?? []) {
      if (this.machines.has(m.name)) throw new Error(`duplicate machine name: ${m.name}`);
      this.machines.set(m.name, m);
    }
    for (const spec of config.runtimes) {
      if (this.byName.has(spec.name)) throw new Error(`duplicate runtime name: ${spec.name}`);
      const adapter = createAdapter(spec, deps);
      // A runtime's own ssh (the older shape): its answers run on that host, and the ledger says so.
      const sshHost = "sshHost" in spec ? spec.sshHost : undefined;
      this.byName.set(spec.name, sshHost ? { ...adapter, machine: sshHost } : adapter);
      this.specs.set(spec.name, spec);
      this.models.set(spec.name, { ...TIER_DEFAULTS[spec.kind], ...spec.models });
    }
    if (config.default === undefined) this.default = undefined;
    else {
      const def = this.byName.get(config.default);
      if (!def) throw new Error(`default runtime is not configured: ${config.default}`);
      this.default = def;
    }
  }

  /** Tier models read from a runtime's own catalogue; the runtimes.yaml `models` pins still win. */
  applyCatalogTiers(name: string, tiers: TierModels): void {
    const spec = this.specs.get(name);
    if (spec) this.models.set(name, { ...TIER_DEFAULTS[spec.kind], ...tiers, ...spec.models });
  }

  get(name: string): RuntimeAdapter | undefined {
    return this.byName.get(name);
  }

  /** Hand over the peers' runtimes. A peer named like a `machines:` entry is refused: a machine is a space or an ssh login, never both. */
  attachRemote(remote: RemoteRuntimes): void {
    const clash = remote.names().filter((n) => this.machines.has(n));
    if (clash.length) throw new Error(`machine ${clash.join(", ")} is both a peer and an entry under machines: in runtimes.yaml; rename one`);
    this.remote = remote;
  }

  /** A runtime's configuration, as runtimes.yaml (or the environment) gave it. */
  spec(name: string): RuntimeSpec | undefined {
    return this.specs.get(name);
  }

  /** The ssh logins under `machines:`. */
  machineList(): MachineSpec[] {
    return [...this.machines.values()];
  }

  /** This space's adapter for a runtime on a `machines:` login, made once. */
  machineAdapter(machine: string, runtime: string): RuntimeAdapter {
    const m = this.machines.get(machine);
    if (!m) throw new Error(`unknown machine: ${machine}`);
    const key = `${machine}:${runtime}`;
    const cached = this.machineAdapters.get(key);
    if (cached) return cached;
    const spec = this.specs.get(runtime);
    if (!spec) throw new Error(`unknown runtime: ${runtime}`);
    if (!SSH_KINDS.has(spec.kind)) throw new Error(`runtime ${runtime} (${spec.kind}) cannot run on another machine`);
    const { streamCompletions: _, ...rest } = spec as RuntimeSpec & { streamCompletions?: boolean };
    const adapter: RuntimeAdapter = { ...createAdapter({ ...rest, sshHost: m.ssh } as RuntimeSpec, this.deps), machine };
    this.machineAdapters.set(key, adapter);
    return adapter;
  }

  /** `runtime/model` → that runtime and the bare model; `model` → the default runtime. Throws on an unknown runtime. */
  resolve(model: string): { runtime: RuntimeAdapter; model: string } {
    const remote = splitMachine(model);
    if (remote) return this.resolveOn(remote.machine, remote.runtime, remote.model, model);
    const slash = model.indexOf("/");
    if (slash < 0) {
      if (!this.default) throw new Error(`model ${model} names no runtime: write it as ${[...this.byName.keys()].map((n) => `${n}/${model}`).join(" or ")}`);
      return { runtime: this.default, model: this.tierModel(this.default.name, model) };
    }
    const name = model.slice(0, slash);
    const bare = model.slice(slash + 1);
    if (!RUNTIME_NAME_PATTERN.test(name) || !bare) throw new Error(`invalid model: ${model}`);
    const runtime = this.byName.get(name);
    if (!runtime) throw new Error(`unknown runtime: ${name}`);
    return { runtime, model: this.tierModel(name, bare) };
  }

  private resolveOn(machine: string, name: string, bare: string, model: string): { runtime: RuntimeAdapter; model: string } {
    if (!MACHINE_NAME_PATTERN.test(machine) || !RUNTIME_NAME_PATTERN.test(name) || !bare) throw new Error(`invalid model: ${model}`);
    if (this.machines.has(machine)) return { runtime: this.machineAdapter(machine, name), model: this.tierModel(name, bare) };
    if (this.remote?.names().includes(machine)) {
      const r = this.remote.adapter(machine, name);
      if ("error" in r) throw new Error(r.error);
      // The peer resolves the tier with its own catalogue.
      return { runtime: r, model: bare };
    }
    throw new Error(`unknown machine: ${machine} (neither a peer nor under machines: in runtimes.yaml)`);
  }

  private tierModel(name: string, model: string): string {
    if (!(MODEL_TIERS as readonly string[]).includes(model)) return model;
    const resolved = this.models.get(name)?.[model as ModelTier];
    if (!resolved) throw new Error(`runtime ${name} has no model for tier ${model}`);
    return resolved;
  }

  list(): RuntimeView[] {
    return [...this.byName.values()].map((r) => ({ name: r.name, kind: r.kind, backend: r.backend, capabilities: r.capabilities, default: r === this.default }));
  }

  /** Close every runtime's live chat processes (service shutdown; docs/runtimes.md#live-chat). */
  closeLive(): void {
    for (const r of this.byName.values()) r.closeLive?.();
    for (const r of this.machineAdapters.values()) r.closeLive?.();
  }

  /** Choices on other machines: every `machines:` login × runtime that runs over ssh, and what the peers offer. */
  machineTierOptions(): MachineTierOption[] {
    const out: MachineTierOption[] = [];
    const push = (machine: string, runtime: string, image: boolean, tiers: TierModels) => {
      for (const tier of MODEL_TIERS) {
        const model = tiers[tier];
        if (model) out.push({ value: `${machine}:${runtime}/${tier}`, machine, runtime, tier, model, capabilities: { complete: true, agent: false, chat: false, image } });
      }
    };
    for (const m of this.machines.values()) for (const spec of this.specs.values()) if (SSH_KINDS.has(spec.kind)) push(m.name, spec.name, spec.kind === "codex-cli", this.models.get(spec.name) ?? {});
    for (const o of this.remote?.offered() ?? []) push(o.machine, o.runtime, o.image, o.tiers);
    return out;
  }

  tierOptions() {
    return this.list().flatMap((runtime) => Object.entries(this.models.get(runtime.name) ?? {}).map(([tier, model]) => ({ value: `${runtime.name}/${tier}`, runtime: runtime.name, tier: tier as ModelTier, model: model!, capabilities: runtime.capabilities })));
  }

  /** One line for the boot log: `claude (claude-code, ssh:box)*, api (anthropic-api, api)`. */
  describe(): string {
    const runtimes = this.list()
      .map((r) => `${r.name} (${r.kind}, ${r.backend})${r.default ? "*" : ""}`)
      .join(", ");
    const machines = this.machineList().map((m) => `${m.name} (ssh:${m.ssh})`);
    return machines.length ? `${runtimes} · machines ${machines.join(", ")}` : runtimes;
  }
}

function createAdapter(spec: RuntimeSpec, deps: RegistryDeps): RuntimeAdapter {
  switch (spec.kind) {
    case "codex-cli":
      return createCodexCli(spec);
    case "claude-code":
      return createClaudeCode(spec);
    case "anthropic-api":
      return createAnthropicApi(spec, deps);
    case "deepseek-harness":
      return createDeepseekHarness(spec);
  }
}

/** A registry with one local Claude Code runtime; what tests and small tools start from. */
export function claudeOnly(bin: string[] = [], over: { sshHost?: string; chatArgs?: string[] } = {}): RuntimeRegistry {
  return new RuntimeRegistry({ default: "claude", runtimes: [{ name: "claude", kind: "claude-code", bin, chatArgs: over.chatArgs ?? [], ...(over.sshHost ? { sshHost: over.sshHost } : {}) }] });
}
