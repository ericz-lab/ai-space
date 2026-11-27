import { isAbsolute, resolve } from "node:path";
import { need, noMore, parseArgs } from "./args.ts";
import { type Ctx, type Noun, UsageError } from "./types.ts";

/**
 * `space orders import decree|hive` (docs/orders.md#importing-the-old-path): the old path's history
 * into the orders store. The Space reads the source (a path on its machine, or decree's URL); it only
 * adds rows it does not have, and deletes or uninstalls nothing.
 */

type Report = {
  kind: string;
  from: string;
  dryRun: boolean;
  added: { topics: number; orders: number; pictures: number; transcripts: number };
  matched: number;
  unchanged: number;
  skipped: { item: string; reason: string }[];
};

const importCmd = async (ctx: Ctx, argv: string[]) => {
  const { flags, positional } = parseArgs(argv, { from: { kind: "value" }, images: { kind: "value" }, machine: { kind: "value" }, "hive-machine": { kind: "value" }, "dry-run": { kind: "bool" } });
  const kind = need(positional, 0, "decree|hive");
  noMore(positional, 1);
  if (kind !== "decree" && kind !== "hive") throw new UsageError(`import decree or hive, not ${kind}`);
  if (kind === "hive" && !flags.from) throw new UsageError("hive runs on another machine: copy its hive.db and decree-images/ here, then --from <path to the copy of hive.db>");
  // A path is the Space's to read: made absolute here, as this shell means it.
  const path = (p: string | undefined) => (p && !/^https?:\/\//.test(p) && !isAbsolute(p) ? resolve(p) : p);
  const c = await ctx.client();
  const r = await c.post<{ report: Report }>("/api/orders/import", {
    kind,
    ...(flags.from ? { from: path(flags.from) } : {}),
    ...(flags.images ? { images: path(flags.images) } : {}),
    ...(flags.machine ? { machine: flags.machine } : {}),
    ...(flags["hive-machine"] ? { hiveMachine: flags["hive-machine"] } : {}),
    dryRun: !!flags["dry-run"],
  }, { timeoutMs: 30 * 60_000 }); // pictures from decree's URL come one by one
  if (ctx.flags.json) return ctx.print.data(r), 0;
  const x = r.report;
  const verb = x.dryRun ? "would add" : "added";
  ctx.print.line(`${x.dryRun ? "Dry run: nothing written. " : ""}${x.kind} from ${x.from}:`);
  ctx.print.line(`  topics ${verb}:      ${x.added.topics}`);
  ctx.print.line(`  orders ${verb}:      ${x.added.orders}`);
  ctx.print.line(`  pictures ${verb}:    ${x.added.pictures}`);
  ctx.print.line(`  transcripts ${verb}: ${x.added.transcripts}`);
  ctx.print.line(`  matched (${kind === "hive" ? "moved into hive's topic" : "given decree's text and picture"}): ${x.matched}`);
  ctx.print.line(`  already imported:   ${x.unchanged}`);
  ctx.print.line(`  skipped:            ${x.skipped.length}`);
  for (const s of x.skipped) ctx.print.line(`    ${s.item}: ${s.reason}`);
  return 0;
};

export const ordersNoun: Noun = {
  name: "orders",
  summary: "the orders store: import the old path's history (docs/orders.md)",
  verbs: {
    import: { usage: "decree|hive [--from PATH|URL] [--images DIR] [--machine NAME] [--hive-machine NAME] [--dry-run]", summary: "add the decree app's orders or hive's topic rooms; reads only, deletes nothing", run: importCmd },
  },
};
