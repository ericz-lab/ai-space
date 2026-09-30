import { join } from "node:path";
import { GPT_PRICING } from "../model/pricing.ts";
import { RUNTIMES_FILE, parseRuntimesYaml } from "./config.ts";
import { spawnCollect } from "./process.ts";
import { TIER_DEFAULTS } from "./registry.ts";
import { MODEL_TIERS, type CodexCliSpec, type ModelTier, type TierModels } from "./types.ts";

/**
 * `space codex-upgrade`: update the Codex CLI on every machine a codex
 * runtime uses, read the model catalogue the new CLI ships with, and point
 * each tier of `runtimes.yaml` at the newest model of its family
 * (basic = Luna, junior = Terra, intermediate = Sol, advanced = Astra).
 * A new model is written only when every machine lists it and answers a
 * one-line prompt on it; the account may refuse a model the catalogue shows.
 */

export const TIER_FAMILY: Record<ModelTier, string> = { basic: "luna", junior: "terra", intermediate: "sol", advanced: "astra" };

/** One entry of `codex debug models`. */
export type CatalogModel = { slug: string; visibility?: string; upgrade?: { model: string } | null };

export type Change = { runtime: string; tier: ModelTier; from: string; to: string };

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

/** Tiers whose model has a newer one in the catalogue. A model outside the gpt-<version>-<family> form is the operator's choice and stays. */
export function proposeTiers(catalog: CatalogModel[], current: TierModels): Partial<Record<ModelTier, string>> {
  const out: Partial<Record<ModelTier, string>> = {};
  for (const tier of MODEL_TIERS) {
    const family = TIER_FAMILY[tier];
    const now = current[tier];
    const nowVersion = now ? familyVersion(now, family) : undefined;
    if (now && !nowVersion) continue;
    const latest = latestOfFamily(catalog, family);
    if (latest && latest !== now && (!nowVersion || compare(familyVersion(latest, family)!, nowVersion) > 0)) out[tier] = latest;
  }
  return out;
}

/** The catalogue as every machine sees it: a model counts only if all of them list it. */
export function intersectCatalogs(catalogs: CatalogModel[][]): CatalogModel[] {
  const [first, ...rest] = catalogs;
  if (!first) return [];
  return first.filter((m) => rest.every((c) => c.some((o) => o.slug === m.slug)));
}

/**
 * Set tier models of one runtime in the text of `runtimes.yaml`, keeping its
 * comments and layout: replaces a tier's line, adds missing tiers under
 * `models:`, or adds the `models:` block at the end of the runtime.
 */
export function setTierModels(text: string, runtime: string, models: Partial<Record<ModelTier, string>>): string {
  const lines = text.split("\n");
  const indent = (l: string) => l.length - l.trimStart().length;
  const blank = (l: string) => !l.trim() || l.trimStart().startsWith("#");
  const top = lines.findIndex((l) => /^runtimes:\s*(#.*)?$/.test(l));
  const start = lines.findIndex((l, i) => i > top && new RegExp(`^\\s+${runtime}:\\s*(#.*)?$`).test(l));
  if (top < 0 || start < 0) throw new Error(`${RUNTIMES_FILE}: runtime ${runtime} not found`);
  const own = indent(lines[start]!);
  let end = start + 1;
  while (end < lines.length && (blank(lines[end]!) || indent(lines[end]!) > own)) end++;
  while (end > start + 1 && !lines[end - 1]!.trim()) end--;

  const at = lines.findIndex((l, i) => i > start && i < end && /^\s+models:\s*(#.*)?$/.test(l));
  const pending = { ...models };
  if (at < 0) {
    const pad = " ".repeat(own + 2);
    const block = [`${pad}models:`, ...MODEL_TIERS.filter((t) => pending[t]).map((t) => `${pad}  ${t}: ${pending[t]}`)];
    lines.splice(end, 0, ...block);
    return lines.join("\n");
  }
  const modelsIndent = indent(lines[at]!);
  let last = at;
  for (let i = at + 1; i < end && (blank(lines[i]!) || indent(lines[i]!) > modelsIndent); i++) {
    if (blank(lines[i]!)) continue;
    last = i;
    const m = /^(\s+)([a-z]+):(\s*)([^\s#]+)(.*)$/.exec(lines[i]!);
    const tier = m?.[2] as ModelTier | undefined;
    if (m && tier && pending[tier]) {
      lines[i] = `${m[1]}${tier}:${m[3] || " "}${pending[tier]}${m[5]}`;
      delete pending[tier];
    }
  }
  const pad = " ".repeat(modelsIndent + 2);
  lines.splice(last + 1, 0, ...MODEL_TIERS.filter((t) => pending[t]).map((t) => `${pad}${t}: ${pending[t]}`));
  return lines.join("\n");
}

export type Run = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type UpgradeOptions = {
  home: string;
  /** Report what would change; write nothing, upgrade nothing, restart nothing. */
  dryRun?: boolean;
  /** Keep the installed CLI; only read the catalogue and update the tiers. */
  skipUpgrade?: boolean;
  /** Restart ai-space after writing, so it reads the new tiers (the file is read at boot). */
  restart?: boolean;
  log: (line: string) => void;
  run?: Run;
};

export type UpgradeResult = { changes: Change[]; unpriced: string[]; written: boolean; restarted: boolean; failures: string[] };

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** The same login shell locally and over ssh, so `codex` resolves as it does for the operator. */
function onHost(host: string | undefined, script: string): string[] {
  return host ? ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host, `bash -lc ${quote(script)}`] : ["bash", "-lc", script];
}

const defaultRun: Run = async (cmd, opts) => {
  const r = await spawnCollect(cmd, { timeoutMs: opts?.timeoutMs ?? 300_000 });
  return { code: r.timedOut ? 124 : r.code, stdout: r.stdout, stderr: r.stderr };
};

export async function codexUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const run = opts.run ?? defaultRun;
  const log = opts.log;
  const path = join(opts.home, RUNTIMES_FILE);
  const file = Bun.file(path);
  const result: UpgradeResult = { changes: [], unpriced: [], written: false, restarted: false, failures: [] };
  if (!(await file.exists())) {
    log(`no ${path}: this space has no codex runtime to update`);
    return result;
  }
  let text = await file.text();
  const codex = parseRuntimesYaml(text).config.runtimes.filter((r): r is CodexCliSpec & { models?: TierModels } => r.kind === "codex-cli");
  if (!codex.length) {
    log(`${RUNTIMES_FILE} has no codex-cli runtime`);
    return result;
  }

  // Agent runs and chat are always local; completions go to the runtime's ssh host.
  const machines = new Map<string, { host?: string; bin: string }>();
  for (const r of codex) {
    const bin = (r.bin.length ? r.bin : ["codex"]).map(quote).join(" ");
    machines.set(`local ${bin}`, { bin });
    if (r.sshHost) machines.set(`${r.sshHost} ${bin}`, { host: r.sshHost, bin });
  }

  const catalogs: CatalogModel[][] = [];
  for (const m of machines.values()) {
    const where = m.host ?? "local";
    const version = async () => (await run(onHost(m.host, `${m.bin} --version`), { timeoutMs: 60_000 })).stdout.trim() || "unknown";
    const before = await version();
    if (!opts.skipUpgrade && !opts.dryRun) {
      const u = await run(onHost(m.host, `${m.bin} update < /dev/null`));
      if (u.code !== 0) {
        result.failures.push(`${where}: codex update failed: ${(u.stderr || u.stdout).trim().slice(-300)}`);
        log(`${where}: codex update failed (exit ${u.code}); reading the installed catalogue`);
      }
      const after = await version();
      log(`${where}: ${before === after ? `${after} (already current)` : `${before} → ${after}`}`);
    } else log(`${where}: ${before}`);
    const c = await run(onHost(m.host, `${m.bin} debug models < /dev/null`), { timeoutMs: 120_000 });
    try {
      catalogs.push((JSON.parse(c.stdout) as { models: CatalogModel[] }).models);
    } catch {
      result.failures.push(`${where}: could not read \`codex debug models\``);
      log(`${where}: could not read the model catalogue; nothing changes`);
      return result;
    }
  }
  const catalog = intersectCatalogs(catalogs);

  for (const r of codex) {
    const current: TierModels = { ...TIER_DEFAULTS["codex-cli"], ...r.models };
    const proposed = proposeTiers(catalog, current);
    const accepted: Partial<Record<ModelTier, string>> = {};
    for (const tier of MODEL_TIERS) {
      const to = proposed[tier];
      if (!to) {
        log(`${r.name}/${tier}: ${current[tier]} (latest)`);
        continue;
      }
      const hosts = [...new Set([undefined, r.sshHost])];
      let ok = true;
      if (!opts.dryRun) {
        for (const host of hosts) {
          const bin = (r.bin.length ? r.bin : ["codex"]).map(quote).join(" ");
          const probe = await run(onHost(host, `${bin} exec --ignore-user-config --ephemeral --skip-git-repo-check --sandbox read-only --model ${quote(to)} ${quote("Reply with just: ok")} < /dev/null`), { timeoutMs: 180_000 });
          if (probe.code !== 0) {
            ok = false;
            const why = (probe.stderr || probe.stdout).trim().split("\n").filter((l) => /error/i.test(l)).at(-1) ?? `exit ${probe.code}`;
            result.failures.push(`${r.name}/${tier}: ${to} did not answer on ${host ?? "local"}: ${why.slice(0, 300)}`);
          }
        }
      }
      log(`${r.name}/${tier}: ${current[tier]} → ${to}${opts.dryRun ? " (not probed)" : ok ? "" : " — refused, kept"}`);
      if (ok) {
        accepted[tier] = to;
        result.changes.push({ runtime: r.name, tier, from: current[tier]!, to });
      }
    }
    if (Object.keys(accepted).length) text = setTierModels(text, r.name, accepted);
  }

  const prices = GPT_PRICING.models as Record<string, unknown>;
  result.unpriced = [...new Set(result.changes.map((c) => c.to))].filter((m) => !prices[m]);
  for (const m of result.unpriced) log(`${m} has no price in src/space/model/gpt-prices.json; its ledger rows show no cost until it is added`);

  if (!result.changes.length || opts.dryRun) return result;
  parseRuntimesYaml(text); // never write a file the next boot cannot read
  await Bun.write(`${path}.bak`, await file.text());
  await Bun.write(path, text);
  result.written = true;
  log(`wrote ${path} (previous version in ${RUNTIMES_FILE}.bak)`);
  if (opts.restart) {
    const r = await run(["systemctl", "--user", "restart", "ai-space"], { timeoutMs: 60_000 });
    result.restarted = r.code === 0;
    log(result.restarted ? "restarted ai-space" : `could not restart ai-space (${r.stderr.trim() || `exit ${r.code}`}); restart it to use the new tiers`);
  } else log("restart ai-space to use the new tiers");
  return result;
}
