/**
 * ai-space's price catalogue (docs/prices.md#publishing).
 *
 *   bun run prices build [out.json]
 *       The catalogue of this checkout's data files (src/space/prices/tables), checked as a Space
 *       checks a fetched one; written to out.json (default dist/prices/v1.json).
 *   bun run prices check [--against <url|file>] [--max-move 0.5] [--strict] [--report out.md]
 *       What this checkout's catalogue changes against the published one (default: the URL every
 *       Space fetches), as a Markdown report. --strict exits 1 when a change is past the bound
 *       (a figure moved more than --max-move, a figure removed, a new zero): the gate for a change
 *       no person has reviewed, such as the daily Model Watch sync.
 *
 * Publishing itself is .github/workflows/prices.yml: on a merge to main that touches the data, it
 * builds the catalogue and uploads it to the bucket behind CATALOGUE_URL.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundledCatalogue, CATALOGUE_URL, type Catalogue, parseCatalogue } from "../src/space/prices/catalogue.ts";
import { formatReport, guardChanges } from "../src/space/prices/guard.ts";

const ROOT = join(import.meta.dir, "..");

export function build(): Catalogue {
  const c = bundledCatalogue();
  // The same check a Space makes before it uses a fetched copy: a catalogue it would refuse is never published.
  return parseCatalogue(JSON.parse(JSON.stringify(c)));
}

async function published(from: string): Promise<Catalogue | undefined> {
  if (!/^https?:\/\//.test(from)) return parseCatalogue(await Bun.file(from).json());
  const res = await fetch(from, { headers: { accept: "application/json", "user-agent": "ai-space" } });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${from}: HTTP ${res.status}`);
  return parseCatalogue(await res.json());
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "build") {
    const out = args[0] ?? join(ROOT, "dist", "prices", "v1.json");
    const c = build();
    await mkdir(dirname(out), { recursive: true });
    await Bun.write(out, `${JSON.stringify(c)}\n`);
    const models = Object.values(c.vendors).reduce((n, v) => n + Object.keys(v.models).length, 0);
    console.log(`${out}: catalogue of ${c.asOf}, ${Object.keys(c.vendors).length} vendors, ${models} models, ${c.modelWatch?.prices.length ?? 0} Model Watch rows`);
  } else if (cmd === "check") {
    const against = flag(args, "--against") ?? process.env.SPACE_PRICES_URL ?? CATALOGUE_URL;
    const maxMove = Number(flag(args, "--max-move") ?? 0.5);
    const before = await published(against);
    const report = guardChanges(before, build(), maxMove);
    const text = `## Price catalogue against ${before ? `${against} (${before.asOf})` : `nothing published at ${against}`}\n\n${formatReport(report)}`;
    const out = flag(args, "--report");
    if (out) await Bun.write(out, text);
    console.log(text);
    if (args.includes("--strict") && report.violations.length) process.exit(1);
  } else {
    console.error("usage: bun run prices build [out.json] | check [--against <url|file>] [--max-move 0.5] [--strict] [--report out.md]");
    process.exit(2);
  }
}
