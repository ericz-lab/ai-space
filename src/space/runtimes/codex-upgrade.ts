import { join } from "node:path";
import { GPT_PRICING } from "../model/pricing.ts";
import { RUNTIMES_FILE, parseRuntimesYaml } from "./config.ts";
import { spawnCollect } from "./process.ts";
import type { RuntimeRegistry } from "./registry.ts";
import { MODEL_TIERS, type CodexCliSpec, type ModelTier, type RuntimeSpec, type TierModels } from "./types.ts";

/**
 * Codex tiers follow the installed CLI: at boot each codex runtime reads
 * `codex debug models` on every machine it uses and gives each tier the newest
 * listed model of its family (basic = Luna, junior = Terra, intermediate = Sol,
 * advanced = Astra). No model name is written down: a new one arrives with
 * `codex update`. `space codex-upgrade` runs that update, checks each new tier
 * model answers, and restarts ai-space so the next boot reads the catalogue.
 */

export const TIER_FAMILY: Record<ModelTier, string> = { basic: "luna", junior: "terra", intermediate: "sol", advanced: "astra" };

/** One entry of `codex debug models`. */
export type CatalogModel = { slug: string; visibility?: string; upgrade?: { model: string } | null };

/** `gpt-6.1-sol` → [6, 1] for family `sol`; undefined when the slug is not of that family. */
export function familyVersion(slug: string, family: string): number[] | undefined {
  const m = new RegExp(`^gpt-(\\d+(?:\\.\\d+)*)-${family}$`).exec(slug);
  return m ? m[1]!.split(".").map(Number) : undefined;
}

function compare(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest listed model of a family, preferring those the catalogue does not mark for upgrade. */
export function latestOfFamily(catalog: CatalogModel[], family: string): string | undefined {
  const listed = catalog.filter((m) => (m.visibility ?? "list") === "list" && familyVersion(m.slug, family));
  const current = listed.filter((m) => !m.upgrade);
  const pool = current.length ? current : listed;
  return pool.sort((a, b) => compare(familyVersion(b.slug, family)!, familyVersion(a.slug, family)!))[0]?.slug;
}

/** Each tier's newest model; a family the catalogue lacks leaves its tier to the fallback. */
export function catalogTiers(catalog: CatalogModel[]): TierModels {
  const out: TierModels = {};
  for (const tier of MODEL_TIERS) {
    const latest = latestOfFamily(catalog, TIER_FAMILY[tier]);
    if (latest) out[tier] = latest;
  }
  return out;
}

/** The catalogue as every machine sees it: a model counts only if all of them list it. */
export function intersectCatalogs(catalogs: CatalogModel[][]): CatalogModel[] {
  const [first, ...rest] = catalogs;
  if (!first) return [];
  return first.filter((m) => rest.every((c) => c.some((o) => o.slug === m.slug)));
}

/** A runtime's pin that the catalogue has a newer model for: the pin keeps the older one. */
export function stalePins(pinned: TierModels | undefined, tiers: TierModels): { tier: ModelTier; pinned: string; latest: string }[] {
  return MODEL_TIERS.flatMap((tier) => {
    const pin = pinned?.[tier];
    const latest = tiers[tier];
    const a = pin && familyVersion(pin, TIER_FAMILY[tier]);
    const b = latest && familyVersion(latest, TIER_FAMILY[tier]);
    return a && b && compare(b, a) > 0 ? [{ tier, pinned: pin!, latest: latest! }] : [];
  });
}

export type Run = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The same login shell locally and over ssh, so `codex` resolves as it does for the operator. */
function onHost(host: string | undefined, script: string): string[] {
  return host ? ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, `bash -lc ${quote(script)}`] : ["bash", "-lc", script];
}

const defaultRun: Run = async (cmd, opts) => {
  const r = await spawnCollect(cmd, { timeoutMs: opts?.timeoutMs ?? 300_000 });
  return { code: r.timedOut ? 124 : r.code, stdout: r.stdout, stderr: r.stderr };
};

type Machine = { host?: string; bin: string };

/** Agent runs and chat are always local; completions go to the runtime's ssh host. */
function machinesOf(spec: CodexCliSpec): Machine[] {
  const bin = (spec.bin.length ? spec.bin : ["codex"]).map(quote).join(" ");
  return [{ bin }, ...(spec.sshHost ? [{ host: spec.sshHost, bin }] : [])];
}

async function readCatalog(run: Run, m: Machine): Promise<CatalogModel[]> {
  const r = await run(onHost(m.host, `${m.bin} debug models < /dev/null`), { timeoutMs: 120_000 });
  const models = (JSON.parse(r.stdout) as { models?: CatalogModel[] }).models;
  if (!Array.isArray(models)) throw new Error("no models in `codex debug models`");
  return models;
}

async function tiersFor(run: Run, spec: CodexCliSpec): Promise<TierModels> {
  return catalogTiers(intersectCatalogs(await Promise.all(machinesOf(spec).map((m) => readCatalog(run, m)))));
}

/** Boot: every codex runtime's tiers from its catalogue. A machine that cannot answer leaves the fallback names. */
export async function refreshCodexTiers(registry: RuntimeRegistry, specs: RuntimeSpec[], log: (line: string) => void, run: Run = defaultRun): Promise<void> {
  await Promise.all(specs.filter((s): s is CodexCliSpec & { models?: TierModels } => s.kind === "codex-cli").map(async (spec) => {
    try {
      const tiers = await tiersFor(run, spec);
      registry.applyCatalogTiers(spec.name, tiers);
      log(`${spec.name} tiers from the codex catalogue: ${MODEL_TIERS.map((t) => `${t}=${tiers[t] ?? "fallback"}`).join(" ")}`);
      for (const p of stalePins(spec.models, tiers)) log(`${spec.name}/${p.tier} is pinned to ${p.pinned} in ${RUNTIMES_FILE}; the catalogue has ${p.latest}`);
    } catch (e) {
      log(`${spec.name}: could not read the codex catalogue (${(e as Error).message.slice(0, 200)}); tiers keep the built-in names`);
    }
  }));
}

export type UpgradeOptions = {
  home: string;
  /** Report the tiers the installed CLI gives; update, probe and restart nothing. */
  dryRun?: boolean;
  /** Keep the installed CLI; only check the tiers and restart. */
  skipUpdate?: boolean;
  /** Restart ai-space so it reads the new catalogue (it does at boot). */
  restart?: boolean;
  log: (line: string) => void;
  run?: Run;
};

export type UpgradeResult = { tiers: Record<string, TierModels>; unpriced: string[]; restarted: boolean; failures: string[] };

/** `space codex-upgrade`: `codex update` on every machine, a one-line probe of each tier's model, then a restart. */
export async function codexUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const run = opts.run ?? defaultRun;
  const log = opts.log;
  const result: UpgradeResult = { tiers: {}, unpriced: [], restarted: false, failures: [] };
  const file = Bun.file(join(opts.home, RUNTIMES_FILE));
  const codex = (await file.exists()) ? parseRuntimesYaml(await file.text()).config.runtimes.filter((r): r is CodexCliSpec & { models?: TierModels } => r.kind === "codex-cli") : [];
  if (!codex.length) {
    log(`no codex-cli runtime in ${join(opts.home, RUNTIMES_FILE)}; nothing to update`);
    return result;
  }

  const machines = new Map<string, Machine>();
  for (const spec of codex) for (const m of machinesOf(spec)) machines.set(`${m.host ?? ""} ${m.bin}`, m);
  for (const m of machines.values()) {
    const where = m.host ?? "local";
    const version = async () => (await run(onHost(m.host, `${m.bin} --version`), { timeoutMs: 60_000 })).stdout.trim() || "unknown";
    const before = await version();
    if (opts.dryRun || opts.skipUpdate) {
      log(`${where}: ${before}`);
      continue;
    }
    const u = await run(onHost(m.host, `${m.bin} update < /dev/null`));
    if (u.code !== 0) result.failures.push(`${where}: codex update failed: ${(u.stderr || u.stdout).trim().slice(-300)}`);
    const after = await version();
    log(`${where}: ${before === after ? `${after} (no newer version)` : `${before} → ${after}`}`);
  }

  for (const spec of codex) {
    let tiers: TierModels;
    try {
      tiers = await tiersFor(run, spec);
    } catch (e) {
      result.failures.push(`${spec.name}: could not read the codex catalogue: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    const effective = { ...tiers, ...spec.models };
    result.tiers[spec.name] = effective;
    for (const tier of MODEL_TIERS) {
      const model = effective[tier];
      if (!model) continue;
      const pinned = spec.models?.[tier] ? ` (pinned in ${RUNTIMES_FILE})` : "";
      if (opts.dryRun) {
        log(`${spec.name}/${tier}: ${model}${pinned}`);
        continue;
      }
      const refused: string[] = [];
      for (const m of machinesOf(spec)) {
        const probe = await run(onHost(m.host, `${m.bin} exec --ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only --model ${quote(model)} ${quote("Reply with just: ok")} < /dev/null`), { timeoutMs: 180_000 });
        if (probe.code !== 0) {
          const why = (probe.stderr || probe.stdout).trim().split("\n").filter((l) => /error/i.test(l)).at(-1) ?? `exit ${probe.code}`;
          refused.push(m.host ?? "local");
          result.failures.push(`${spec.name}/${tier}: ${model} did not answer on ${m.host ?? "local"}: ${why.slice(0, 300)}`);
        }
      }
      log(`${spec.name}/${tier}: ${model}${pinned}${refused.length ? ` — did not answer on ${refused.join(", ")}; pin a working model in ${RUNTIMES_FILE}` : " ok"}`);
    }
    for (const p of stalePins(spec.models, tiers)) log(`${spec.name}/${p.tier}: the pin ${p.pinned} keeps an older model than ${p.latest}; remove the line in ${RUNTIMES_FILE} to follow the catalogue`);
  }

  const prices = GPT_PRICING.models as Record<string, unknown>;
  result.unpriced = [...new Set(Object.values(result.tiers).flatMap((t) => Object.values(t)))].filter((m) => !prices[m!]) as string[];
  for (const m of result.unpriced) log(`${m} has no price in src/space/model/gpt-prices.json; its ledger rows show no cost until it is added`);

  if (opts.dryRun) return result;
  if (opts.restart) {
    const r = await run(["systemctl", "--user", "restart", "ai-space"], { timeoutMs: 60_000 });
    result.restarted = r.code === 0;
    log(result.restarted ? "restarted ai-space; it reads the catalogue at boot" : `could not restart ai-space (${r.stderr.trim() || `exit ${r.code}`}); restart it to use the new tiers`);
  } else log("restart ai-space to use the new tiers");
  return result;
}
