import { PROVIDERS_FILE, builtinSpeech, parseProvidersYaml } from "../speech/config.ts";
import { KIND_CAPABILITIES, ROLE_CAPABILITY, VOICE_PATTERN, type ProviderSpec, type SpeechConfig, type SpeechRole } from "../speech/types.ts";
import { GatewayEditError, commentsOf, content, entriesOf, indentOf, padOf, scalar, withComment, type Entry } from "./edit.ts";
import { GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN } from "./types.ts";

/**
 * Settings → Gateway → Speech: the `speech:` section of `providers.yaml` (docs/speech.md), edited
 * as text the way gateway.yaml is (edit.ts). The page shows every speech provider in one list and,
 * for ASR and for TTS, an order: the first answers, the rest are its fallback. A model gateway
 * provider in an order is written as one provider named `gateway-<provider>` in the shorthand the
 * speech layer already reads:
 *
 *   gateway-openai:
 *     kind: openai-compatible
 *     gateway: space
 *     provider: openai
 *     asrModel: whisper-1
 *     ttsModel: tts-1
 *     voice: alloy
 *
 * Every other provider (voice-studio, a hand-written openai-compatible, …) is custom: it can be
 * moved within an order or taken out of one, never rewritten. Live, `voices:` and the other
 * providers stay as they are. A space without the file gets the built-in default written out only
 * when its provider is really there (`builtin: "present"`); otherwise the file names none of it.
 */

/** One place in an order: a provider already in the speech configuration, or a model gateway provider with its model. */
export type ChainItem = { provider: string } | { gateway: string; model: string; voice?: string; voices?: string[] };
export type SpeechOrder = { asr: ChainItem[]; tts: ChainItem[] };
/** Whether the built-in default's provider exists here (with no file): written out when present, left out when absent. */
export type BuiltinPresence = "present" | "absent";

/** The page's own speech providers: the ones it names and may rewrite or remove. */
export const MANAGED_PREFIX = "gateway-";
export const isManaged = (p: ProviderSpec) => p.name.startsWith(MANAGED_PREFIX) && p.kind === "openai-compatible" && p.gateway?.via === "space";
export const managedName = (gatewayProvider: string) => `${MANAGED_PREFIX}${gatewayProvider}`;

const HEADER = "# Speech providers (docs/speech.md). Settings → Gateway → Speech edits this file; hand edits are kept.";
const ROLES = ["asr", "tts"] as const;

type ManagedEntry = { provider: string; asrModel?: string; ttsModel?: string; voice?: string; voices?: string[] };
type Planned = {
  default: SpeechConfig["default"];
  fallback: SpeechConfig["fallback"];
  /** The page's providers after the save, by name; null: remove it. */
  entries: Record<string, ManagedEntry | null>;
};

/** A configuration with no provider: a space without the file whose built-in provider is not there. */
export const emptySpeech = (): SpeechConfig => ({ providers: [], default: {}, fallback: {}, voices: {}, off: {} });

function parse(text: string | undefined, env: Record<string, string | undefined>, builtin: BuiltinPresence): { config: SpeechConfig; source: "file" | "builtin" } {
  const none = () => ({ config: builtin === "present" ? builtinSpeech() : emptySpeech(), source: "builtin" as const });
  if (text === undefined) return none();
  try {
    const r = parseProvidersYaml(text, env);
    return r.source === "builtin" ? none() : { config: r.config, source: r.source };
  } catch (e) {
    throw new GatewayEditError((e as Error).message);
  }
}

/** The configuration the page shows and edits: the file's, else the built-in one when its provider is there, else none. */
export function visibleSpeech(text: string | undefined, env: Record<string, string | undefined>, builtin: BuiltinPresence): { config: SpeechConfig; source: "file" | "builtin" } {
  return parse(text, env, builtin);
}

/** The chain a role answers with: its default, then its fallback without it. */
export function chainOf(config: SpeechConfig, role: SpeechRole): string[] {
  const first = config.default[role];
  return first ? [first, ...(config.fallback[role] ?? []).filter((n) => n !== first)] : [];
}

/** Whether a provider of this configuration can take a role (a reserved kind may be named, as the parser allows). */
export function canServe(spec: ProviderSpec, role: SpeechRole): boolean {
  return spec.kind === "dashscope" || KIND_CAPABILITIES[spec.kind].includes(ROLE_CAPABILITY[role]);
}

const bareOf = (p: Extract<ProviderSpec, { kind: "openai-compatible" }>): ManagedEntry => {
  const g = p.gateway!.provider;
  return { provider: g, asrModel: bare(p.asrModel, g), ttsModel: bare(p.ttsModel, g), ...(p.voice ? { voice: p.voice } : {}), ...(p.voices ? { voices: [...p.voices] } : {}) };
};

/** What the save leads to: each role's default and fallback, and the page's providers. */
export function planSpeech(current: SpeechConfig, order: SpeechOrder): Planned {
  const byName = new Map(current.providers.map((p) => [p.name, p]));
  const managed = new Set(current.providers.filter(isManaged).map((p) => p.name));
  const entries: Planned["entries"] = {};
  const def: SpeechConfig["default"] = {};
  const fb: SpeechConfig["fallback"] = {};
  const start = (name: string): ManagedEntry | undefined => {
    if (entries[name]) return entries[name]!;
    const was = byName.get(name);
    return was && isManaged(was) ? bareOf(was as Extract<ProviderSpec, { kind: "openai-compatible" }>) : undefined;
  };
  for (const role of ROLES) {
    const names: string[] = [];
    for (const item of order[role] ?? []) {
      let name: string;
      if ("gateway" in item) {
        if (!item.gateway || !GATEWAY_NAME_PATTERN.test(item.gateway)) throw new GatewayEditError(`${role}: pick a provider of the model gateway`);
        if (!item.model || !GATEWAY_MODEL_PATTERN.test(item.model) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(item.model)) throw new GatewayEditError(`${role}: pick a model for ${item.gateway}`);
        name = managedName(item.gateway);
        const e = start(name) ?? { provider: item.gateway };
        if (e.provider !== item.gateway) throw new GatewayEditError(`${name} names another gateway provider; change it by hand`);
        if (role === "asr") e.asrModel = item.model;
        else {
          if (item.voice !== undefined && !VOICE_PATTERN.test(item.voice)) throw new GatewayEditError("tts: the voice is not a voice name");
          if (item.voices && !item.voices.every((v) => VOICE_PATTERN.test(v))) throw new GatewayEditError("tts: voices must be voice names");
          e.ttsModel = item.model;
          if (item.voices?.length) e.voices = [...new Set(item.voices)];
          if (item.voice) e.voice = item.voice;
          else delete e.voice;
          if (e.voice && e.voices && !e.voices.includes(e.voice)) e.voices.push(e.voice);
        }
        entries[name] = e;
      } else {
        name = item.provider;
        const spec = byName.get(name);
        if (!spec) throw new GatewayEditError(`${role}: ${name} is not a speech provider here`);
        if (!canServe(spec, role)) throw new GatewayEditError(`${role}: ${name} (${spec.kind}) cannot ${ROLE_CAPABILITY[role]}`);
        if (managed.has(name)) entries[name] = start(name)!;
      }
      if (names.includes(name)) throw new GatewayEditError(`${role}: ${name} is listed twice`);
      names.push(name);
    }
    if (names.length) def[role] = names[0];
    if (names.length > 1) fb[role] = names.slice(1);
  }
  // A page provider no order uses goes, unless a named voice still maps to it (removing it would break the file).
  const inVoices = new Set(Object.values(current.voices).flatMap((m) => Object.keys(m)));
  for (const name of managed) if (!entries[name]) entries[name] = inVoices.has(name) ? start(name)! : null;
  return { default: def, fallback: fb, entries };
}

const bare = (m: string, provider: string) => (m.startsWith(`${provider}/`) ? m.slice(provider.length + 1) : m);

function entryLines(name: string, e: NonNullable<Planned["entries"][string]>, pad: string, unit: string, old: string[]): string[] {
  const comments = commentsOf(old);
  const inner = pad + unit;
  const keyComment = old[0] ? /^\s*[A-Za-z0-9._-]+:\s*(#.*)$/.exec(old[0])?.[1] : undefined;
  const out = [`${pad}${name}:${keyComment ? `   ${keyComment}` : ""}`, `${inner}kind: openai-compatible`, `${inner}gateway: space`, `${inner}provider: ${e.provider}`];
  if (e.asrModel) out.push(`${inner}asrModel: ${scalar(e.asrModel)}`);
  if (e.ttsModel) out.push(`${inner}ttsModel: ${scalar(e.ttsModel)}`);
  if (e.voice) out.push(`${inner}voice: ${scalar(e.voice)}`);
  if (e.voices?.length) out.push(`${inner}voices: [${e.voices.map(scalar).join(", ")}]`);
  return out.map((l, i) => (i === 0 ? l : withComment(l, comments)));
}

/** `default:` or `fallback:` as block lines; none when the mapping is empty. */
function roleLines(key: "default" | "fallback", map: Record<string, string | string[]>, pad: string, old: string[]): string[] {
  const roles = (["asr", "tts", "live"] as const).filter((r) => map[r] !== undefined);
  if (!roles.length) return [];
  const comments = commentsOf(old);
  // The key line's comment stays, also from a flow line (`default: { asr: gpu }   # …`) without quotes before it.
  const keyComment = old[0] && !/["']/.test(old[0]) ? /\s(#.*)$/.exec(old[0])?.[1] : undefined;
  return [
    `${pad}${key}:${keyComment ? `   ${keyComment}` : ""}`,
    ...roles.map((r) => {
      const v = map[r]!;
      const line = withComment(`${pad}${pad}${r}: ${Array.isArray(v) ? `[${v.map(scalar).join(", ")}]` : scalar(v)}`, comments);
      if (line.includes("#")) return line;
      // A role whose value changed keeps the comment its old line had.
      const was = old.slice(1).find((l) => new RegExp(`^\\s*${r}:`).test(l));
      const note = was && !/["']/.test(was) ? /\s(#.*)$/.exec(was)?.[1] : undefined;
      return note ? `${line}   ${note}` : line;
    }),
  ];
}

/** The `speech:` block and its children; throws when the page cannot edit its shape. */
function sections(lines: string[]): { speech: { at: number; last: number }; children: Entry[] } | undefined {
  const at = lines.findIndex((l) => /^speech:/.test(l));
  if (at < 0) return undefined;
  if (!/^speech:\s*(#.*)?$/.test(lines[at]!)) throw new GatewayEditError(`${PROVIDERS_FILE} writes speech: on one line; the page edits block-style files only, change it by hand`);
  let last = at;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (!content(l)) continue;
    if (indentOf(l) === 0) break;
    last = i;
  }
  const speech = { at, last };
  return { speech, children: last > at ? entriesOf(lines, speech, PROVIDERS_FILE) : [] };
}

function providersOf(lines: string[], children: Entry[]): { child: Entry; entries: Entry[] } {
  const child = children.find((c) => c.name === "providers");
  if (!child) throw new GatewayEditError(`${PROVIDERS_FILE} has no speech.providers block`);
  if (!/^\s*providers:\s*(#.*)?$/.test(lines[child.start]!)) throw new GatewayEditError(`${PROVIDERS_FILE} writes speech.providers on one line; change it by hand`);
  return { child, entries: entriesOf(lines, { at: child.start, last: child.end }, PROVIDERS_FILE) };
}

/** Why the page cannot edit this `providers.yaml`, or undefined when it can. */
export function speechEditProblem(text: string, env: Record<string, string | undefined>): string | undefined {
  try {
    parse(text, env, "present");
    const lines = text.split("\n");
    const s = sections(lines);
    if (s && s.children.length) providersOf(lines, s.children);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A fresh `speech:` section: the built-in provider written out when it is there, then the plan. */
function freshSection(plan: Planned, base: SpeechConfig): string[] {
  const pad = "  ";
  const kept = base.providers;
  if (!kept.length && !Object.values(plan.entries).some(Boolean)) throw new GatewayEditError("add a provider to an order first: a speech file needs one");
  const out = ["speech:"];
  out.push(...roleLines("default", withLive(plan.default, base) as Record<string, string>, pad, []));
  out.push(`${pad}providers:`);
  for (const p of kept) {
    if (p.kind !== "voice-studio") throw new GatewayEditError("the built-in speech default has a provider the page cannot write");
    out.push(`${pad}${pad}${p.name}:`, `${pad}${pad}${pad}kind: voice-studio`, `${pad}${pad}${pad}app: ${p.app}`, ...(p.machine ? [`${pad}${pad}${pad}machine: ${p.machine}`] : []));
  }
  for (const [name, e] of Object.entries(plan.entries)) if (e) out.push(...entryLines(name, e, pad + pad, pad, []));
  out.push(...roleLines("fallback", withLiveFallback(plan.fallback, base) as Record<string, string[]>, pad, []));
  return out;
}

/**
 * `providers.yaml` with the orders applied (a new file when `current` is undefined). Only what
 * changed is rewritten: an unchanged page provider, `default:` or `fallback:` keeps its lines. The
 * result is parsed back: the other providers, the named voices and live must be unchanged, and
 * ASR and TTS must answer in the order asked, or nothing is written.
 */
export function setSpeechText(current: string | undefined, order: SpeechOrder, env: Record<string, string | undefined>, builtin: BuiltinPresence): { text: string; before: SpeechConfig; after: SpeechConfig; changed: boolean } {
  const before = parse(current, env, builtin);
  const plan = planSpeech(before.config, order);
  let lines = (current ?? "").replace(/\n+$/, "").split("\n");
  if (current === undefined || lines.every((l) => l.trim() === "")) lines = [HEADER];
  const s = sections(lines);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const oldEntry = (name: string) => {
    const p = before.config.providers.find((x) => x.name === name);
    return p && isManaged(p) ? bareOf(p as Extract<ProviderSpec, { kind: "openai-compatible" }>) : undefined;
  };
  const sameEntries = Object.entries(plan.entries).every(([n, e]) => (e === null ? !oldEntry(n) : same(oldEntry(n), e)));
  const sameRoles = ROLES.every((r) => same(chainOf(before.config, r), plan.default[r] ? [plan.default[r], ...(plan.fallback[r] ?? [])] : []));
  if (before.source === "file" && sameEntries && sameRoles) return { text: current!, before: before.config, after: before.config, changed: false };
  if (!s || before.source === "builtin") {
    // No speech section (or an empty one): it is written whole, the built-in provider spelled out when it is there.
    if (s) lines.splice(s.speech.at, s.speech.last - s.speech.at + 1);
    lines.push(...freshSection(plan, before.config));
  } else {
    const pad = " ".repeat(s.children[0]?.indent ?? padOf(lines).length);
    // The page's providers that changed: replaced in place, added at the end of providers:, or removed.
    for (const [name, e] of Object.entries(plan.entries)) {
      if (e === null ? !oldEntry(name) : same(oldEntry(name), e)) continue;
      const { child, entries } = providersOf(lines, sections(lines)!.children);
      const found = entries.find((x) => x.name === name);
      const ipad = " ".repeat(found?.indent ?? entries[0]?.indent ?? child.indent + pad.length);
      const old = found ? lines.slice(found.start, found.end + 1) : [];
      const next = e ? entryLines(name, e, ipad, pad, old) : [];
      if (found) lines.splice(found.start, found.end - found.start + 1, ...next);
      else if (next.length) lines.splice(child.end + 1, 0, ...next);
    }
    // default: and fallback: are written whole (block style) when they change; a comment on a line that stays is kept.
    for (const key of ["default", "fallback"] as const) {
      const map = (key === "default" ? withLive(plan.default, before.config) : withLiveFallback(plan.fallback, before.config)) as Record<string, string | string[]>;
      const was = key === "default" ? before.config.default : before.config.fallback;
      if (same(sorted(map), sorted(was as Record<string, unknown>))) continue;
      const children = sections(lines)!.children;
      const found = children.find((c) => c.name === key);
      const next = roleLines(key, map, pad, found ? lines.slice(found.start, found.end + 1) : []);
      if (found) lines.splice(found.start, found.end - found.start + 1, ...next);
      else if (next.length) {
        const sp = sections(lines)!;
        const after = key === "default" ? sp.speech.at : (sp.children.find((c) => c.name === "providers")?.end ?? sp.speech.last);
        lines.splice(after + 1, 0, ...next);
      }
    }
  }
  let text = lines.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  const after = parse(text, env, builtin).config;
  verify(before.config, after, plan);
  return { text, before: before.config, after, changed: true };
}

const sorted = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)).sort(([a], [b]) => a.localeCompare(b)));

/** live keeps the provider it had: written out, so a new ASR default cannot carry it along. */
function withLive(def: SpeechConfig["default"], base: SpeechConfig): SpeechConfig["default"] {
  return { ...def, ...(base.default.live ? { live: base.default.live } : {}) };
}
function withLiveFallback(fb: SpeechConfig["fallback"], base: SpeechConfig): SpeechConfig["fallback"] {
  const { live: _, ...rest } = fb;
  return { ...rest, ...(base.fallback.live?.length ? { live: base.fallback.live } : {}) };
}

function verify(before: SpeechConfig, after: SpeechConfig, plan: Planned): void {
  const fail = (what: string) => {
    throw new GatewayEditError(`could not write the speech choice to ${PROVIDERS_FILE} safely (${what}); change it by hand`);
  };
  const others = (c: SpeechConfig) => JSON.stringify(c.providers.filter((p) => !p.name.startsWith(MANAGED_PREFIX) || !isManaged(p)));
  if (others(before) !== others(after)) fail("other providers changed");
  if (JSON.stringify(before.voices) !== JSON.stringify(after.voices)) fail("named voices changed");
  // Live stays where it was; with none before, the file may give it to a new ASR default that can stream, as it always has.
  const liveChain = (c: SpeechConfig) => JSON.stringify(chainOf(c, "live"));
  if (chainOf(before, "live").length && liveChain(before) !== liveChain(after)) fail("live changed");
  for (const role of ROLES) {
    const want = plan.default[role] ? [plan.default[role]!, ...(plan.fallback[role] ?? []).filter((n) => n !== plan.default[role])] : [];
    if (JSON.stringify(chainOf(after, role)) !== JSON.stringify(want)) fail(`${role} would not answer as chosen`);
  }
  for (const [name, e] of Object.entries(plan.entries)) {
    const got = after.providers.find((p) => p.name === name);
    if (!e) {
      if (got) fail(`${name} is still there`);
      continue;
    }
    if (!got || got.kind !== "openai-compatible" || got.gateway?.provider !== e.provider) fail(`${name} was not written`);
    const g = got as Extract<ProviderSpec, { kind: "openai-compatible" }>;
    if ((e.asrModel && g.asrModel !== `${e.provider}/${e.asrModel}`) || (e.ttsModel && g.ttsModel !== `${e.provider}/${e.ttsModel}`) || (e.voice ?? undefined) !== g.voice) fail(`${name} differs from the choice`);
  }
}
