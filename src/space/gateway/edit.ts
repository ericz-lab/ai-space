import { GATEWAY_FILE, parseGatewayYaml } from "./config.ts";
import { quoteEnvValue } from "../setup.ts";
import type { GatewayAuth, GatewayConfig, GatewayProvider } from "./types.ts";

/**
 * Settings → Gateway's edits of `gateway.yaml` (docs/model-gateway.md#settings). The file stays the
 * source of truth and is edited as text, never re-serialized: what the edit does not touch keeps
 * its comments, order and quoting, and a line the edit writes again with the same key and value
 * keeps its trailing comment. Every edit is checked by parsing the result: it must change exactly
 * what was asked and nothing else, or nothing is written (`GatewayEditError`, which the page shows).
 * A file whose shape the editor does not handle (a top-level block written on one line, YAML that
 * does not parse) is shown read-only with the reason.
 */

export class GatewayEditError extends Error {}

/** A provider as the page writes it. Unset fields are left out of the file. */
export type ProviderEntry = {
  preset?: string;
  messages?: string;
  openai?: string;
  auth?: GatewayAuth;
  apiKeyEnv?: string;
  models: string[];
  disabled?: boolean;
};

const HEADER = "# The built-in model gateway (docs/model-gateway.md). Settings → Gateway edits this file; hand edits are kept.";

const content = (l: string) => l.trim() !== "" && !l.trim().startsWith("#");
const indentOf = (l: string) => /^(\s*)/.exec(l)![1]!.length;

/** A top-level key's block: its line and its last content line; undefined when absent. */
function topBlock(lines: string[], key: string): { at: number; last: number } | undefined {
  const at = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return undefined;
  if (!new RegExp(`^${key}:\\s*(#.*)?$`).test(lines[at]!)) throw new GatewayEditError(`${GATEWAY_FILE} writes ${key}: on one line; the page edits block-style files only, change it by hand`);
  let last = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!content(l)) continue;
    if (indentOf(l) === 0) break;
    last = i;
  }
  return { at, last };
}

type Entry = { name: string; start: number; end: number; indent: number };

/** The entries of a block, each from its key line to its last content line. */
function entriesOf(lines: string[], block: { at: number; last: number }): Entry[] {
  const out: Entry[] = [];
  let indent = -1;
  for (let i = block.at + 1; i <= block.last; i++) {
    const l = lines[i]!;
    if (!content(l)) continue;
    const ind = indentOf(l);
    if (indent < 0) indent = ind;
    if (ind === indent) {
      const m = /^\s+(["']?)([A-Za-z0-9._-]+)\1:/.exec(l);
      if (!m) throw new GatewayEditError(`${GATEWAY_FILE} line ${i + 1} is not a key the page can edit; change it by hand`);
      if (out.length) out[out.length - 1]!.end = lastContentBefore(lines, i);
      out.push({ name: m[2]!, start: i, end: i, indent });
    } else if (ind < indent) throw new GatewayEditError(`${GATEWAY_FILE} line ${i + 1} has an indent the page does not follow; change it by hand`);
  }
  if (out.length) out[out.length - 1]!.end = block.last;
  return out;
}

function lastContentBefore(lines: string[], i: number): number {
  let j = i - 1;
  while (j > 0 && !content(lines[j]!)) j--;
  return j;
}

/** The indent the file uses for nested keys (2 when it has none). */
function padOf(lines: string[]): string {
  const nested = lines.find((l) => content(l) && indentOf(l) > 0);
  return " ".repeat(nested ? indentOf(nested) : 2);
}

/** A scalar as YAML: plain when it is safe so, else JSON-quoted. */
function scalar(v: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(v) && !/:\s/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) ? v : JSON.stringify(v);
}

/** Trailing comments of an old entry's lines, by the line's text without the comment. */
function commentsOf(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = /^(.*?\S)\s+(#.*)$/.exec(l);
    if (m && !/["']/.test(m[1]!)) out.set(m[1]!.trim(), m[2]!);
    else if (m) {
      // Quoted values may hold a #; keep the comment only when the quotes are balanced before it.
      const head = m[1]!;
      if ((head.split('"').length - 1) % 2 === 0 && (head.split("'").length - 1) % 2 === 0) out.set(head.trim(), m[2]!);
    }
  }
  return out;
}

function withComment(line: string, comments: Map<string, string>): string {
  const c = comments.get(line.trim());
  return c ? `${line}   ${c}` : line;
}

function providerLines(name: string, p: ProviderEntry, pad: string, old: string[]): string[] {
  const comments = commentsOf(old);
  const inner = pad + pad;
  const out = [`${pad}${name}:`];
  if (p.preset) out.push(`${inner}preset: ${scalar(p.preset)}`);
  if (p.messages) out.push(`${inner}messages: ${scalar(p.messages)}`);
  if (p.openai) out.push(`${inner}openai: ${scalar(p.openai)}`);
  if (p.auth) out.push(`${inner}auth: ${p.auth}`);
  if (p.apiKeyEnv) out.push(`${inner}apiKeyEnv: ${p.apiKeyEnv}`);
  out.push(`${inner}models: [${p.models.map(scalar).join(", ")}]`);
  if (p.disabled) out.push(`${inner}disabled: true`);
  // The key line keeps its comment whatever changed below it.
  const keyComment = old[0] ? /^\s*(["']?)[A-Za-z0-9._-]+\1:\s*(#.*)$/.exec(old[0])?.[2] : undefined;
  return out.map((l, i) => (i === 0 ? (keyComment ? `${l}   ${keyComment}` : l) : withComment(l, comments)));
}

/** What a parsed provider says, in the fields the page writes, to compare an edit's result with what was asked. */
function shape(p: GatewayProvider | undefined, presetBases: { messages?: string; openai?: string; auth?: string } = {}): string {
  if (!p) return "none";
  return JSON.stringify({ preset: p.preset, messages: p.messages ?? presetBases.messages, openai: p.openai ?? presetBases.openai, auth: p.auth, apiKeyEnv: p.apiKeyEnv, models: p.models, disabled: Boolean(p.disabled) });
}

function parse(text: string, env: Record<string, string | undefined>): GatewayConfig {
  try {
    return parseGatewayYaml(text, env).config;
  } catch (e) {
    throw new GatewayEditError((e as Error).message);
  }
}

const sameExcept = (a: GatewayConfig, b: GatewayConfig, provider?: string, groups = false, tiers = false) =>
  JSON.stringify({ p: a.providers.filter((p) => p.name !== provider), g: groups ? undefined : a.groups, t: tiers ? undefined : a.tiers }) ===
  JSON.stringify({ p: b.providers.filter((p) => p.name !== provider), g: groups ? undefined : b.groups, t: tiers ? undefined : b.tiers });

/** Why the page cannot edit this text, or undefined when it can. */
export function editProblem(text: string, env: Record<string, string | undefined>): string | undefined {
  try {
    parse(text, env);
    const lines = text.split("\n");
    for (const key of ["providers", "groups", "tiers"]) {
      const b = topBlock(lines, key);
      if (b) entriesOf(lines, b);
    }
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * `gateway.yaml` with provider `name` set to `entry` (added at the end of `providers:` when new;
 * a new file when `current` is undefined), or removed when `entry` is null.
 */
export function setProviderText(current: string | undefined, name: string, entry: ProviderEntry | null, env: Record<string, string | undefined>): string {
  const text = current ?? `${HEADER}\nproviders:\n`;
  const lines = text.split("\n");
  const pad = current === undefined ? "  " : padOf(lines);
  let block = topBlock(lines, "providers");
  if (!block) {
    if (!entry) throw new GatewayEditError(`${GATEWAY_FILE} has no provider ${name}`);
    // providers: goes first, before groups and tiers that would name it.
    lines.splice(0, 0, "providers:");
    block = { at: 0, last: 0 };
  }
  const found = entriesOf(lines, block).find((e) => e.name === name);
  if (!found && !entry) throw new GatewayEditError(`${GATEWAY_FILE} has no provider ${name}`);
  const old = found ? lines.slice(found.start, found.end + 1) : [];
  const next = entry ? providerLines(name, entry, found ? " ".repeat(found.indent) : pad, old) : [];
  if (found) lines.splice(found.start, found.end - found.start + 1, ...next);
  else lines.splice(block.last + 1, 0, ...next);
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  const before = current === undefined ? undefined : parse(current, env);
  const after = parse(out, env);
  const got = after.providers.find((p) => p.name === name);
  if (before && !sameExcept(before, after, name)) throw new GatewayEditError(`could not change provider ${name} in ${GATEWAY_FILE} safely; change it by hand`);
  if (entry) {
    const want: GatewayProvider = { name, auth: entry.auth ?? got?.auth ?? "bearer", models: [...new Set(entry.models)], ...(entry.messages ? { messages: entry.messages } : {}), ...(entry.openai ? { openai: entry.openai } : {}), ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}), ...(entry.preset ? { preset: entry.preset } : {}), ...(entry.disabled ? { disabled: true } : {}) };
    const bases = { messages: got?.messages, openai: got?.openai };
    if (shape(got) !== shape(want, entry.preset ? bases : {})) throw new GatewayEditError(`could not write provider ${name} to ${GATEWAY_FILE} as asked; change it by hand`);
  } else if (got) throw new GatewayEditError(`could not remove provider ${name} from ${GATEWAY_FILE}; change it by hand`);
  return out;
}

/** `gateway.yaml` with its `groups:` set to `groups` (none removes the block); a new block goes after `providers:`. */
export function setGroupsText(current: string, groups: Record<string, string[]>, env: Record<string, string | undefined>): string {
  const lines = current.split("\n");
  const pad = padOf(lines);
  const block = topBlock(lines, "groups");
  const old = block ? lines.slice(block.at, block.last + 1) : [];
  if (block) entriesOf(lines, block);
  const comments = commentsOf(old);
  const names = Object.keys(groups);
  const next = names.length ? [block ? lines[block.at]! : "groups:", ...names.map((n) => withComment(`${pad}${n}: [${groups[n]!.map(scalar).join(", ")}]`, comments))] : [];
  if (block) lines.splice(block.at, block.last - block.at + 1, ...next);
  else if (next.length) {
    const providers = topBlock(lines, "providers");
    lines.splice(providers ? providers.last + 1 : lines.length, 0, ...next);
  }
  let out = lines.join("\n");
  if (!out.endsWith("\n")) out += "\n";
  const before = parse(current, env);
  const after = parse(out, env);
  if (!sameExcept(before, after, undefined, true) || JSON.stringify(after.groups) !== JSON.stringify(Object.fromEntries(names.map((n) => [n, groups[n]])))) throw new GatewayEditError(`could not set the groups in ${GATEWAY_FILE} safely; change them by hand`);
  return out;
}

/** The workspace `.env` variable a key typed in Settings → Gateway goes to; this prefix marks a key the page created. */
export const PAGE_KEY_PREFIX = "SPACE_GATEWAY_";
export function pageKeyVar(provider: string): string {
  return `${PAGE_KEY_PREFIX}${provider.toUpperCase().replace(/-/g, "_")}_KEY`;
}

const ENV_HEADER = "# Model gateway keys, written by Settings → Gateway (docs/model-gateway.md#keys)";
const envKeyOf = (l: string) => /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(l.trim())?.[1];

/**
 * The `.env` text with `key` set: its line replaced in place, or added under one header for the
 * page's keys. Every other line stays. (setup.ts `updateEnvText` does the same for `space setup`.)
 */
export function setEnvKeyText(text: string, key: string, value: string): string {
  const line = `${key}=${quoteEnvValue(value)}`;
  const lines = text.length ? text.replace(/\n$/, "").split("\n") : [];
  const at = lines.findIndex((l) => envKeyOf(l) === key);
  if (at >= 0) lines[at] = line;
  else {
    const header = lines.indexOf(ENV_HEADER);
    if (header >= 0) {
      let end = header;
      while (end + 1 < lines.length && envKeyOf(lines[end + 1]!)?.startsWith(PAGE_KEY_PREFIX)) end++;
      lines.splice(end + 1, 0, line);
    } else {
      if (lines.length && lines[lines.length - 1] !== "") lines.push("");
      lines.push(ENV_HEADER, line);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The `.env` text without the lines that set `keys` (and the page's header once no key of it is left); every other line stays. */
export function removeEnvKeysText(text: string, keys: string[]): string {
  const drop = new Set(keys);
  let lines = text.split("\n").filter((l) => !drop.has(envKeyOf(l) ?? ""));
  const header = lines.indexOf(ENV_HEADER);
  if (header >= 0 && !envKeyOf(lines[header + 1] ?? "")?.startsWith(PAGE_KEY_PREFIX)) {
    lines.splice(header, 1);
    if (header > 0 && lines[header - 1] === "" && (lines[header] === undefined || lines[header] === "")) lines.splice(header - 1, 1);
    lines = lines.length === 1 && lines[0] === "" ? [] : lines;
  }
  return lines.join("\n");
}
