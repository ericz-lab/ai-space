import { type Catalogue, flatten } from "./catalogue.ts";

/**
 * What changed between the published catalogue and a new one, and whether a machine may publish it
 * without a person (docs/prices.md#publishing). A vendor page misread by Model Watch would reach
 * every Space within a day, so an unattended change is bounded: no figure may move by more than
 * `maxMove` (0.5: half again or a third less), none may disappear, and a new figure may not be zero.
 * Anything past that waits for review.
 */
export type PriceChange = { key: string; before?: number; after?: number };
export type GuardReport = { added: PriceChange[]; removed: PriceChange[]; changed: PriceChange[]; violations: string[] };

export function guardChanges(before: Catalogue | undefined, after: Catalogue, maxMove = 0.5): GuardReport {
  const a = before ? flatten(before) : new Map<string, number>();
  const b = flatten(after);
  const report: GuardReport = { added: [], removed: [], changed: [], violations: [] };
  for (const [key, x] of b) {
    const old = a.get(key);
    if (old === undefined) {
      report.added.push({ key, after: x });
      if (before && x === 0 && !/ cachedInput$| cacheRead$| cacheWrite$/.test(key)) report.violations.push(`${key}: new and zero`);
    } else if (old !== x) {
      report.changed.push({ key, before: old, after: x });
      const ratio = old === 0 ? Infinity : x / old;
      if (ratio > 1 + maxMove || ratio < 1 / (1 + maxMove)) report.violations.push(`${key}: ${old} → ${x}, more than ${Math.round(maxMove * 100)}%`);
    }
  }
  for (const [key, x] of a) if (!b.has(key)) {
    report.removed.push({ key, before: x });
    report.violations.push(`${key}: removed`);
  }
  if (before && after.asOf < before.asOf) report.violations.push(`asOf ${after.asOf} is older than the published ${before.asOf}`);
  // A Space keeps the newer of its release's copy and the fetched one by asOf: a change must move it.
  const moved = report.added.length + report.removed.length + report.changed.length > 0;
  if (before && moved && after.asOf === before.asOf) report.violations.push(`prices changed but asOf is still ${after.asOf}: move the asOf of the data file you edited`);
  return report;
}

/** The report as Markdown, for a pull request or a workflow summary. */
export function formatReport(r: GuardReport): string {
  const row = (c: PriceChange) => `| ${c.key} | ${c.before ?? ""} | ${c.after ?? ""} |`;
  const table = (title: string, xs: PriceChange[]) => xs.length ? [`### ${title} (${xs.length})`, "", "| price | before | after |", "| --- | --- | --- |", ...xs.slice(0, 200).map(row), ...(xs.length > 200 ? [`| … ${xs.length - 200} more | | |`] : []), ""] : [];
  return [
    r.violations.length ? `**Needs review:** ${r.violations.length} change(s) past the bound.\n\n${r.violations.slice(0, 50).map((v) => `- ${v}`).join("\n")}\n` : "Every change is within the bound.\n",
    ...table("Changed", r.changed), ...table("Added", r.added), ...table("Removed", r.removed),
  ].join("\n");
}
