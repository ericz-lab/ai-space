import { UsageError } from "./types.ts";

/**
 * A small argument parser: enough for a dozen nouns, no dependency.
 *
 *   --name value | --name=value | -n value      a value flag
 *   --flag | -f                                 a boolean
 *   --                                          the rest is positional
 *
 * Every flag is declared; an unknown `--x` is a usage error, so a typo never
 * silently becomes a positional. A `list` flag may repeat.
 */

export type FlagSpec = Record<string, { kind: "value" | "bool" | "list"; alias?: string }>;

export type Parsed<S extends FlagSpec> = {
  flags: { [K in keyof S]?: S[K]["kind"] extends "bool" ? boolean : S[K]["kind"] extends "list" ? string[] : string };
  positional: string[];
};

export function parseArgs<S extends FlagSpec>(argv: string[], spec: S): Parsed<S> {
  const flags: Record<string, unknown> = {};
  const positional: string[] = [];
  const byAlias = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) if (s.alias) byAlias.set(s.alias, name);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    let name: string;
    let inline: string | undefined;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) inline = a.slice(eq + 1);
    } else {
      const short = a.slice(1);
      const full = byAlias.get(short);
      if (!full) throw new UsageError(`unknown option -${short}`);
      name = full;
    }
    const s = spec[name];
    if (!s) throw new UsageError(`unknown option --${name}`);
    if (s.kind === "bool") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (s.kind === "list") (flags[name] ??= [] as string[]) && (flags[name] as string[]).push(value);
    else flags[name] = value;
  }
  return { flags: flags as Parsed<S>["flags"], positional };
}

/** The one positional argument a verb needs, or a usage error naming it. */
export function need(positional: string[], index: number, what: string): string {
  const v = positional[index];
  if (!v) throw new UsageError(`${what} is required`);
  return v;
}

export function noMore(positional: string[], count: number): void {
  if (positional.length > count) throw new UsageError(`unexpected argument: ${positional[count]}`);
}

/** `30m`, `2h`, `90s`, `1d`, or plain milliseconds. */
export function parseDuration(raw: string, what = "duration"): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(raw.trim());
  if (!m) throw new UsageError(`${what} must look like 30m, 2h, 90s or 1d`);
  const n = Number(m[1]);
  const unit = m[2] ?? "ms";
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86_400_000 }[unit]!);
}

export function parseCount(raw: string | undefined, fallback: number, what = "count"): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${what} must be a positive whole number`);
  return n;
}
