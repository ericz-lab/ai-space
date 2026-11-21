import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathOf, whichUsable, withUserToolDirs } from "../host-tools.ts";
import { MODEL_TIERS, type ModelTier, type TierModels } from "./types.ts";

/**
 * magpie (https://github.com/yetone/magpie), a gateway on this machine in front of many model
 * providers: it holds their keys and sign-ins, speaks the Anthropic Messages API among others, and
 * fails over between them (docs/runtimes.md#magpie). ai-space does not install it or change its
 * settings. This file finds it (where it listens, whether it answers, the models it offers) and
 * says what a Claude Code process needs in its environment to answer through it, so GLM, Kimi,
 * MiniMax and the rest of magpie's providers serve chat, agent tasks and answers with Claude Code's
 * tools.
 */

/** Where magpie listens unless `MAGPIE_ADDR` or its `gateway.json` says otherwise. */
export const MAGPIE_DEFAULT_ADDR = "127.0.0.1:3425";

/**
 * The key ai-space presents. magpie needs none from loopback; a `magpie-<name>` key names the
 * caller, so its usage page counts these calls as ai-space's. Not a secret.
 */
export const MAGPIE_CALLER_KEY = "magpie-ai-space";

export type MagpieInfo = {
  /** The `magpie` command, when found on this machine. */
  bin?: string;
  /** The gateway's base URL as a program here reaches it (`http://127.0.0.1:3425`). */
  url: string;
  /** Where the address came from. */
  from: "env" | "gateway.json" | "default";
  /** The gateway answered its model list. */
  running: boolean;
  /** magpie's version, from its `gateway.json`. */
  version?: string;
  /** Its model ids (`provider/model`, and routing groups as `group/<id>`), in its own order. */
  models: string[];
  /** Why it did not answer. */
  error?: string;
};

export type MagpieDeps = {
  env?: Record<string, string | undefined>;
  home?: string;
  fetch?: typeof fetch;
  /** A file's text, or undefined when it cannot be read. */
  readText?: (path: string) => string | undefined;
  /** The `magpie` command's path, or undefined. */
  which?: (name: string) => string | undefined;
  timeoutMs?: number;
  /** Ask the gateway at this address instead of looking for where magpie listens. */
  url?: string;
};

/** magpie's settings folder: `$XDG_CONFIG_HOME/magpie`, else `~/.config/magpie` (every system). */
export function magpieConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "magpie");
}

/** A listening address (`0.0.0.0:3425`, `[::]:3425`, `127.0.0.1:3425`) as a URL a program here reaches. */
export function loopbackUrl(addr: string): string | undefined {
  const m = /^(?:\[([^\]]*)\]|([^:]*)):(\d{1,5})$/.exec(addr.trim());
  if (!m) return undefined;
  let host = m[1] ?? m[2] ?? "";
  if (host === "" || host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  return `http://${host.includes(":") ? `[${host}]` : host}:${m[3]}`;
}

/**
 * Where magpie's gateway is, in magpie's own order: `MAGPIE_ADDR` (the user's word), the address
 * the running gateway wrote to `gateway.json`, else the default port.
 */
export function magpieAddress(deps: MagpieDeps = {}): { url: string; from: MagpieInfo["from"]; version?: string } {
  const env = deps.env ?? process.env;
  const fromEnv = env.MAGPIE_ADDR?.trim() ? loopbackUrl(env.MAGPIE_ADDR.trim()) : undefined;
  if (fromEnv) return { url: fromEnv, from: "env" };
  const read = deps.readText ?? readText;
  const text = read(join(magpieConfigDir(env, deps.home), "gateway.json"));
  if (text) {
    try {
      const j = JSON.parse(text) as { addr?: unknown; version?: unknown };
      const url = typeof j.addr === "string" ? loopbackUrl(j.addr) : undefined;
      if (url) return { url, from: "gateway.json", ...(typeof j.version === "string" && j.version ? { version: j.version } : {}) };
    } catch {
      /* a half-written or foreign file: the default address */
    }
  }
  return { url: loopbackUrl(MAGPIE_DEFAULT_ADDR)!, from: "default" };
}

/** The ids of an OpenAI-style model list (`{ object: "list", data: [{ id }] }`), as magpie's `/v1/models` answers. */
export function readModelList(body: unknown): string[] | undefined {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return undefined;
  const ids = data.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string" && MAGPIE_MODEL_PATTERN.test(id));
  return [...new Set(ids)];
}

/** A model id ai-space passes on to magpie: its `provider/model` ids and group names. */
export const MAGPIE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

/** Is magpie here, does its gateway answer, and with which models. Costs no tokens: one GET of its model list. */
export async function findMagpie(deps: MagpieDeps = {}): Promise<MagpieInfo> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const which = deps.which ?? ((name: string) => whichUsable(name, { PATH: withUserToolDirs(pathOf(env) ?? "/usr/bin:/bin", home) }) ?? appBinary());
  const bin = which("magpie");
  const where: ReturnType<typeof magpieAddress> = deps.url ? { url: deps.url.replace(/\/+$/, ""), from: "env" } : magpieAddress({ ...deps, env, home });
  const base: MagpieInfo = { ...(bin ? { bin } : {}), url: where.url, from: where.from, ...(where.version ? { version: where.version } : {}), running: false, models: [] };
  const f = deps.fetch ?? fetch;
  try {
    const res = await f(`${where.url}/v1/models`, { headers: { authorization: `Bearer ${MAGPIE_CALLER_KEY}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? 3000) });
    if (!res.ok) return { ...base, error: `${where.url}/v1/models answered ${res.status}` };
    const models = readModelList(await res.json().catch(() => null));
    if (!models) return { ...base, error: `${where.url}/v1/models is not a model list` };
    return { ...base, running: true, models };
  } catch (e) {
    const err = e as Error;
    return { ...base, error: err.name === "TimeoutError" ? `no answer from ${where.url}` : `nothing answers at ${where.url}` };
  }
}

/** The Mac app's own command, when magpie is installed as an app and not on PATH. */
function appBinary(): string | undefined {
  const p = "/Applications/Magpie.app/Contents/MacOS/magpie";
  return process.platform === "darwin" && existsSync(p) ? p : undefined;
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Claude Code's names for its own model aliases, by ai-space tier: with them set, `--model haiku`
 * and the CLI's background calls (titles, summaries, subagents) also go to the pinned model.
 */
const TIER_ALIAS_ENV: Record<ModelTier, string> = {
  basic: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  junior: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  intermediate: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  advanced: "ANTHROPIC_DEFAULT_FABLE_MODEL",
};

/**
 * The environment of a Claude Code process that answers through magpie: the gateway as its API
 * address, ai-space's caller key as its token, and each pinned tier as the model behind the CLI's
 * alias for it. Only that process sees this; the user's `~/.claude` is not touched, and an
 * Anthropic key from the workspace `.env` is left out, so it never goes to the gateway.
 */
export function magpieClaudeEnv(url: string, models: TierModels | undefined, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  delete env.ANTHROPIC_API_KEY;
  env.ANTHROPIC_BASE_URL = url;
  env.ANTHROPIC_AUTH_TOKEN = MAGPIE_CALLER_KEY;
  for (const tier of MODEL_TIERS) {
    const pin = models?.[tier];
    if (pin) env[TIER_ALIAS_ENV[tier]] = pin;
  }
  if (models?.basic) env.ANTHROPIC_SMALL_FAST_MODEL = models.basic;
  return env;
}

/** Is `url` a gateway address runtimes.yaml may name: http(s), a host, no path beyond `/`. */
export function validGatewayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && Boolean(u.hostname) && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash && !u.username && !u.password;
  } catch {
    return false;
  }
}
