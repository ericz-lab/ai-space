import { join } from "node:path";
import { RUNTIME_KINDS, RUNTIME_NAME_PATTERN, type RuntimeKind, type RuntimeSpec, type RuntimesConfig } from "./types.ts";

/**
 * Which runtimes a space has: `<workspace>/runtimes.yaml`, or, when the file
 * is absent, the single Claude Code runtime the `SPACE_MODEL_*` and
 * `SPACE_CHAT_*` variables describe (the shape every space had before the
 * file existed, so nothing changes for them).
 *
 *   default: claude               # runtime a bare model name goes to
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
 *
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
  for (const key of Object.keys(doc)) if (key !== "default" && key !== "runtimes") throw new Error(`${RUNTIMES_FILE}: unknown key "${key}"`);
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
    else runtimes.push(spec);
  }
  if (runtimes.length === 0) throw new Error(`${RUNTIMES_FILE}: no usable runtime (${warnings.join("; ")})`);

  const def = doc.default === undefined ? runtimes[0]!.name : doc.default;
  if (typeof def !== "string" || !runtimes.some((r) => r.name === def)) throw new Error(`${RUNTIMES_FILE}: default must name a configured runtime`);
  return { config: { default: def, runtimes }, warnings };
}

function parseSpec(name: string, kind: RuntimeKind, raw: Record<string, unknown>, env: Record<string, string | undefined>): RuntimeSpec | { warning: string } {
  const ctx = `${RUNTIMES_FILE}: runtime ${name}`;
  const allowed: Record<RuntimeKind, string[]> = {
    "claude-code": ["kind", "ssh", "bin", "chatArgs"],
    "anthropic-api": ["kind", "apiKeyEnv", "url"],
  };
  for (const key of Object.keys(raw)) if (!allowed[kind].includes(key)) throw new Error(`${ctx} has unknown key "${key}"`);
  switch (kind) {
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
