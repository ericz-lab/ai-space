import { PROVIDERS_FILE, builtinSpeech, parseProvidersYaml } from "../speech/config.ts";
import { VOICE_PATTERN, type ProviderSpec, type SpeechConfig, type SpeechRole } from "../speech/types.ts";
import { GatewayEditError, commentsOf, content, entriesOf, indentOf, padOf, scalar, withComment, type Entry } from "./edit.ts";
import { GATEWAY_MODEL_PATTERN, GATEWAY_NAME_PATTERN } from "./types.ts";

/**
 * Settings → Gateway → Speech: the `speech:` section of `providers.yaml` (docs/speech.md), edited
 * as text the way gateway.yaml is (edit.ts). The page writes one provider per model gateway
 * provider it uses, named `gateway-<provider>`, in the shorthand the speech layer already reads:
 *
 *   gateway-openai:
 *     kind: openai-compatible
 *     gateway: space
 *     provider: openai
 *     asrModel: whisper-1
 *     ttsModel: tts-1
 *     voice: alloy
 *
 * and where it sits for ASR and for TTS: off, a fallback after the current default (the safe
 * choice), or the default (the old default then goes first in the fallback). Nothing else moves:
 * other providers, `voices:` and live stay as they are, and a space without the file gets the
 * built-in `voice-studio` default written out, so writing the file never drops it.
 */

export type SpeechPlace = "off" | "fallback" | "default";
export type SpeechChoice = {
  asr: { place: SpeechPlace; provider?: string; model?: string };
  tts: { place: SpeechPlace; provider?: string; model?: string; voice?: string; voices?: string[] };
};

/** The page's own speech providers: the ones it names and may rewrite or remove. */
export const MANAGED_PREFIX = "gateway-";
export const isManaged = (p: ProviderSpec) => p.name.startsWith(MANAGED_PREFIX) && p.kind === "openai-compatible" && p.gateway?.via === "space";

const HEADER = "# Speech providers (docs/speech.md). Settings → Gateway → Speech edits this file; hand edits are kept.";
const ROLES = ["asr", "tts"] as const;

type Planned = {
  default: SpeechConfig["default"];
  fallback: SpeechConfig["fallback"];
  /** The page's providers after the save, by name; null: remove it. */
  entries: Record<string, { provider: string; asrModel?: string; ttsModel?: string; voice?: string; voices?: string[] } | null>;
};

function parse(text: string | undefined, env: Record<string, string | undefined>): { config: SpeechConfig; source: "file" | "builtin" } {
  if (text === undefined) return { config: builtinSpeech(), source: "builtin" };
  try {
    const r = parseProvidersYaml(text, env);
    return { config: r.config, source: r.source };
  } catch (e) {
    throw new GatewayEditError((e as Error).message);
  }
}

/** The chain a role answers with: its default, then its fallback without it. */
export function chainOf(config: SpeechConfig, role: SpeechRole): string[] {
  const first = config.default[role];
  return first ? [first, ...(config.fallback[role] ?? []).filter((n) => n !== first)] : [];
}

function check(choice: SpeechChoice): void {
  for (const role of ROLES) {
    const c = choice[role];
    if (!c || !["off", "fallback", "default"].includes(c.place)) throw new GatewayEditError(`${role}: place must be off, fallback or default`);
    if (c.place === "off") continue;
    if (!c.provider || !GATEWAY_NAME_PATTERN.test(c.provider)) throw new GatewayEditError(`${role}: pick a provider of the model gateway`);
    if (!c.model || !GATEWAY_MODEL_PATTERN.test(c.model) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(c.model)) throw new GatewayEditError(`${role}: pick a model`);
  }
  const t = choice.tts;
  if (t.place !== "off") {
    if (t.voice !== undefined && !VOICE_PATTERN.test(t.voice)) throw new GatewayEditError("tts: the voice is not a voice name");
    if (t.voices && !t.voices.every((v) => VOICE_PATTERN.test(v))) throw new GatewayEditError("tts: voices must be voice names");
  }
}

/** What the save leads to: each role's default and fallback, and the page's providers. */
export function planSpeech(current: SpeechConfig, choice: SpeechChoice): Planned {
  check(choice);
  const managed = new Set(current.providers.filter(isManaged).map((p) => p.name));
  const def: SpeechConfig["default"] = { ...current.default };
  const fb: SpeechConfig["fallback"] = Object.fromEntries(Object.entries(current.fallback).map(([r, l]) => [r, [...l]]));
  // The page's providers leave both roles first; a default that was one gives way to what it pushed into the fallback.
  for (const role of ROLES) {
    const list = (fb[role] ?? []).filter((n) => !managed.has(n));
    if (def[role] && managed.has(def[role]!)) {
      const back = list.shift();
      if (back) def[role] = back;
      else delete def[role];
    }
    if (list.length) fb[role] = list;
    else delete fb[role];
  }
  const entries: Planned["entries"] = {};
  for (const role of ROLES) {
    const c = choice[role];
    if (c.place === "off") continue;
    const name = `${MANAGED_PREFIX}${c.provider}`;
    const e = (entries[name] ??= { provider: c.provider! });
    if (role === "asr") e.asrModel = c.model;
    else {
      e.ttsModel = c.model;
      const t = choice.tts;
      if (t.voices?.length) e.voices = [...new Set(t.voices)];
      if (t.voice) {
        e.voice = t.voice;
        if (e.voices && !e.voices.includes(t.voice)) e.voices.push(t.voice);
      }
    }
    if (c.place === "default" || !def[role]) {
      const prev = def[role];
      def[role] = name;
      if (prev && prev !== name) fb[role] = [prev, ...(fb[role] ?? []).filter((n) => n !== prev)];
    } else fb[role] = [...(fb[role] ?? []).filter((n) => n !== name), name];
  }
  // A page provider no role uses goes, unless a named voice still maps to it (removing it would break the file).
  const inVoices = new Set(Object.values(current.voices).flatMap((m) => Object.keys(m)));
  for (const name of managed) if (!entries[name] && !inVoices.has(name)) entries[name] = null;
  for (const name of managed) if (!entries[name] && inVoices.has(name)) {
    const p = current.providers.find((x) => x.name === name)!;
    if (p.kind === "openai-compatible" && p.gateway) entries[name] = { provider: p.gateway.provider, asrModel: bare(p.asrModel, p.gateway.provider), ttsModel: bare(p.ttsModel, p.gateway.provider), ...(p.voice ? { voice: p.voice } : {}), ...(p.voices ? { voices: p.voices } : {}) };
  }
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
      return withComment(`${pad}${pad}${r}: ${Array.isArray(v) ? `[${v.map(scalar).join(", ")}]` : scalar(v)}`, comments);
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
    parse(text, env);
    const lines = text.split("\n");
    const s = sections(lines);
    if (s && s.children.length) providersOf(lines, s.children);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** A fresh `speech:` section: the built-in default written out, then the plan. */
function freshSection(plan: Planned, base: SpeechConfig): string[] {
  const pad = "  ";
  const out = ["speech:"];
  out.push(...roleLines("default", plan.default as Record<string, string>, pad, []));
  out.push(`${pad}providers:`);
  for (const p of base.providers) {
    if (p.kind !== "voice-studio") throw new GatewayEditError("the built-in speech default has a provider the page cannot write");
    out.push(`${pad}${pad}${p.name}:`, `${pad}${pad}${pad}kind: voice-studio`, `${pad}${pad}${pad}app: ${p.app}`, ...(p.machine ? [`${pad}${pad}${pad}machine: ${p.machine}`] : []));
  }
  for (const [name, e] of Object.entries(plan.entries)) if (e) out.push(...entryLines(name, e, pad + pad, pad, []));
  out.push(...roleLines("fallback", plan.fallback as Record<string, string[]>, pad, []));
  return out;
}

/**
 * `providers.yaml` with the speech choice applied (a new file when `current` is undefined). The
 * result is parsed back: the other providers, the named voices and live must be unchanged, and
 * ASR and TTS must answer as planned, or nothing is written.
 */
export function setSpeechText(current: string | undefined, choice: SpeechChoice, env: Record<string, string | undefined>): { text: string; before: SpeechConfig; after: SpeechConfig } {
  const before = parse(current, env);
  const plan = planSpeech(before.config, choice);
  let lines = (current ?? "").replace(/\n+$/, "").split("\n");
  if (current === undefined || lines.every((l) => l.trim() === "")) lines = [HEADER];
  const s = sections(lines);
  if (!s || before.source === "builtin") {
    // No speech section (or an empty one): it is written whole, the built-in default spelled out.
    if (s) lines.splice(s.speech.at, s.speech.last - s.speech.at + 1);
    lines.push(...freshSection(plan, before.config));
  } else {
    const pad = " ".repeat(s.children[0]?.indent ?? padOf(lines).length);
    // The page's providers: replaced in place, added at the end of providers:, or removed.
    for (const [name, e] of Object.entries(plan.entries)) {
      const { child, entries } = providersOf(lines, sections(lines)!.children);
      const found = entries.find((x) => x.name === name);
      const ipad = " ".repeat(found?.indent ?? entries[0]?.indent ?? child.indent + pad.length);
      const old = found ? lines.slice(found.start, found.end + 1) : [];
      const next = e ? entryLines(name, e, ipad, pad, old) : [];
      if (found) lines.splice(found.start, found.end - found.start + 1, ...next);
      else if (next.length) lines.splice(child.end + 1, 0, ...next);
    }
    // default: and fallback: are written whole (block style); a comment on a line that stays is kept.
    for (const key of ["default", "fallback"] as const) {
      const children = sections(lines)!.children;
      const found = children.find((c) => c.name === key);
      const map = (key === "default" ? withLive(plan.default, before.config) : withLiveFallback(plan.fallback, before.config)) as Record<string, string | string[]>;
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
  const after = parse(text, env).config;
  verify(before.config, after, plan);
  return { text, before: before.config, after };
}

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
  const liveChain = (c: SpeechConfig) => JSON.stringify(chainOf(c, "live"));
  if (liveChain(before) !== liveChain(after)) fail("live changed");
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
