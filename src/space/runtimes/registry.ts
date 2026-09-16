import { createAnthropicApi } from "./anthropic-api.ts";
import { createClaudeCode } from "./claude-code.ts";
import { createDeepseekHarness } from "./deepseek-harness.ts";
import { RUNTIME_NAME_PATTERN, type RuntimeAdapter, type RuntimeSpec, type RuntimesConfig } from "./types.ts";

/**
 * The configured runtimes by name, and the rule that turns a model string
 * into one of them: `runtime/model` names the runtime, a bare model goes to
 * the default. Unknown names are errors the callers turn into 400s or 501s;
 * nothing falls back silently to another runtime.
 */

export type RegistryDeps = { fetch?: typeof fetch };

export type RuntimeView = { name: string; kind: string; backend: string; capabilities: RuntimeAdapter["capabilities"]; default: boolean };

export class RuntimeRegistry {
  private readonly byName = new Map<string, RuntimeAdapter>();
  readonly default: RuntimeAdapter;

  constructor(config: RuntimesConfig, deps: RegistryDeps = {}) {
    for (const spec of config.runtimes) {
      if (this.byName.has(spec.name)) throw new Error(`duplicate runtime name: ${spec.name}`);
      this.byName.set(spec.name, createAdapter(spec, deps));
    }
    const def = this.byName.get(config.default);
    if (!def) throw new Error(`default runtime is not configured: ${config.default}`);
    this.default = def;
  }

  get(name: string): RuntimeAdapter | undefined {
    return this.byName.get(name);
  }

  /** `runtime/model` → that runtime and the bare model; `model` → the default runtime. Throws on an unknown runtime. */
  resolve(model: string): { runtime: RuntimeAdapter; model: string } {
    const slash = model.indexOf("/");
    if (slash < 0) return { runtime: this.default, model };
    const name = model.slice(0, slash);
    const bare = model.slice(slash + 1);
    if (!RUNTIME_NAME_PATTERN.test(name) || !bare) throw new Error(`invalid model: ${model}`);
    const runtime = this.byName.get(name);
    if (!runtime) throw new Error(`unknown runtime: ${name}`);
    return { runtime, model: bare };
  }

  list(): RuntimeView[] {
    return [...this.byName.values()].map((r) => ({ name: r.name, kind: r.kind, backend: r.backend, capabilities: r.capabilities, default: r === this.default }));
  }

  /** One line for the boot log: `claude (claude-code, ssh:box)*, api (anthropic-api, api)`. */
  describe(): string {
    return this.list()
      .map((r) => `${r.name} (${r.kind}, ${r.backend})${r.default ? "*" : ""}`)
      .join(", ");
  }
}

function createAdapter(spec: RuntimeSpec, deps: RegistryDeps): RuntimeAdapter {
  switch (spec.kind) {
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
