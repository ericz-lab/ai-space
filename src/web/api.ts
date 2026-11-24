import { recordDeviceAppOpen } from "./device-usage.ts";
import type { I18n } from "./i18n.ts";
import { LOCALE, type Lang, translate } from "./messages.ts";

/** Types of the panel API as the browser sees them, plus tiny fetch helpers. */

export type AgentInfo = {
  id: string;
  /** Set when the agent lives on a peer machine; chat goes through /api/peers/<peer>/. */
  peer?: string;
  app: string;
  name: string;
  title: string;
  description?: string;
  /** Translations of title and description by language tag; see i18n.ts. */
  i18n?: I18n;
  avatar: string;
  /** The owning app's icon, shown in the corner of the tile. */
  appIcon: string;
  /** The runtime a new chat starts on. */
  runtime: string;
  /** Runtime/tier values the chat may pick; absent on an older peer's app agents. `unavailable`: shown greyed. */
  modelOptions?: ModelChoice[];
  /** Set on a peer's agent while that machine does not answer. */
  stale?: boolean;
};

/** A runtime/tier choice as every picker gets it; `unavailable` says why it is shown but cannot be picked (docs/model-machines.md#inventory). */
export type ModelChoice = { value: string; runtime: string; tier: "basic" | "junior" | "intermediate" | "advanced"; model: string; unavailable?: "signed-out" | "offline" };

/** One agent CLI on one machine (`GET /api/model/inventory`). */
export type CliInfo = { cli: string; kind: string; installed?: boolean; signedIn?: boolean; version?: string; path?: string; detail?: string; checkedAt?: string; configured: boolean; runtimes: string[] };
export type MachineInventory = { machine: string; via: "local" | "ssh" | "peer"; reachable?: boolean; stale?: boolean; old?: boolean; clis: CliInfo[] };
/** magpie on this machine (docs/model-gateway.md#magpie): where it listens, its models, which runtimes use it, what adding it makes. */
export type MagpieTiers = Partial<Record<"basic" | "junior" | "intermediate" | "advanced", string>>;
/** A runtime through magpie and its tier pins as runtimes.yaml has them; `loaded` false until a restart. */
export type MagpiePins = { runtime: string; kind: "claude-code" | "anthropic-api"; models: MagpieTiers; loaded: boolean };
export type MagpieInfo = { bin?: string; url: string; running: boolean; version?: string; models: string[]; groups: string[]; error?: string; configured: boolean; runtimes: string[]; pins: MagpiePins[]; suggested: MagpieTiers; adds: "claude-code" | "anthropic-api" };
/** The built-in model gateway's tiers: the four text tiers and `image` for pictures (docs/model-gateway.md#tiers). */
export type GatewayTiers = MagpieTiers & { image?: string };
/** A provider's key as the page sees it: where it is set and its last four characters, never the key. */
export type GatewayKey = { state: "workspace" | "environment" | "none"; last4?: string; page: boolean; variable?: string };
/** One provider of gateway.yaml as Settings → Gateway shows it (`GET /api/model/gateway`). */
export type GatewayProviderInfo = {
  name: string;
  /** Picture models the vendor documents that this provider does not list yet (only when it can draw). */
  imageOffer?: string[];
  preset?: string;
  label?: string;
  messages?: string;
  openai?: string;
  auth: "x-api-key" | "bearer";
  key: GatewayKey;
  disabled: boolean;
  off?: string;
  resting?: { until: string; kind: string };
  models: string[];
  /** Each model's price in USD per million tokens and where it came from; null: unpriced (docs/model-gateway.md#prices). */
  prices?: Record<string, GatewayPrice | null>;
  /** What each listed model is for, and the ones whose kind the file states (the rest: a vendor's rule, or text). */
  kinds: Record<string, GatewayKind>;
  kindSet: string[];
  /** Per kind, true or why it cannot (no openai base, an endpoint shape the gateway does not forward). */
  serves: Record<GatewayKind, true | string>;
  /** What names it: groups with its members (`emptied`: those left with none), tiers on it. */
  usedBy: { groups: string[]; tiers: string[]; emptied: string[] };
};
export type GatewayPrice = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: { over: number }[]; perImage?: number; perMinute?: number; perMillionChars?: number; source: string };
export type GatewaySite = "intl" | "cn";
/** `sites`: a vendor with a China and an international site, the bases of each (one account works on one only). */
export type GatewayPreset = { name: string; label: string; messages?: string; openai?: string; auth: "x-api-key" | "bearer"; hasList: boolean; defaults: string[]; sites?: Record<GatewaySite, { messages?: string; openai?: string }>; openaiOffer?: { intl?: string; cn?: string; note: string; source: string } };
/** The built-in model gateway's section (docs/model-gateway.md#settings). */
export type GatewayInfo = {
  file: string;
  exists: boolean;
  /** Why the built-in gateway cannot exist on this space. */
  unavailable?: string;
  /** Why the page cannot edit the file; it is then shown as `text`. */
  readOnly?: string;
  text?: string;
  problem?: string;
  answers: boolean;
  providers: GatewayProviderInfo[];
  groups: Record<string, string[]>;
  tiers: GatewayTiers;
  models: string[];
  imageModels: string[];
  textModels: string[];
  asrModels: string[];
  ttsModels: string[];
  presets: GatewayPreset[];
  /** Where prices come from: the owner's file, and when models.dev's catalogue was last fetched. */
  pricing?: { file: string; catalogFetchedAt?: string; fileError?: string };
  runtimes: MagpiePins[];
  offer: { claude: boolean };
};
export type GatewayTest = { base: "messages" | "openai"; ok: boolean; ms: number; status?: number; error?: string; detail?: string };
export type GatewayModelList = { source: "vendor" | "defaults"; models: string[]; defaults: string[]; kinds?: Record<string, GatewayKind>; error?: string; note?: string };
/** What a gateway model is for (docs/model-gateway.md#kinds). */
export type GatewayKind = "text" | "asr" | "tts" | "image";
export type SpeechChains = { asr: string[]; tts: string[]; live: string[] };
/** One place in an ASR or TTS order: a provider of the speech configuration by name, or a gateway provider with its model. */
export type SpeechChainItem = { provider: string } | { gateway: string; model: string; voice?: string };
export type SpeechOrder = { asr: SpeechChainItem[]; tts: SpeechChainItem[] };
/** One gateway provider as the Speech and Image groups offer it (`GET /api/model/gateway/speech`). */
export type GatewayMediaProvider = { name: string; label: string; off?: string; serves: { asr: true | string; tts: true | string; image: true | string }; asrModels: string[]; ttsModels: string[]; imageModels: string[]; voices: Record<string, string[]> };
/** A speech provider that is not the gateway's: written in providers.yaml by hand, or the built-in one when it is here. */
export type SpeechCustomProvider = { name: string; kind: string; serves: { asr: boolean; tts: boolean; live: boolean }; machine?: string; located?: boolean; off?: string; testable: boolean };
export type GatewaySpeechInfo = {
  file: string;
  exists: boolean;
  readOnly?: string;
  problem?: string;
  source: string;
  custom: SpeechCustomProvider[];
  order: SpeechOrder;
  /** Live's order, read-only; absent when no provider can do live. */
  live?: string[];
  providers: GatewayMediaProvider[];
  restart?: boolean;
};

/** Icons of the panel's own tiles; `/api/apps` returns the active icon pack's over these. */
export const BUILTIN_ICONS = { store: "/store.svg", inbox: "/inbox.svg", shortcuts: "/shortcuts.svg", terminal: "/terminal.svg", settings: "/settings.svg" };
export type BuiltinIcons = typeof BUILTIN_ICONS;

export type AppInfo = {
  /** The layout key: the name, or `<peer>/<name>` for an app on a peer. */
  id: string;
  name: string;
  /** Set for a package another Space shares over a connection: opened here, managed only on that Space. */
  connection?: string;
  peer?: string;
  /** The peer this entry comes from is not answering; the entry is its last known state. */
  stale?: boolean;
  title: string;
  description?: string;
  i18n?: I18n;
  icon: string;
  url?: string;
  repo?: string;
  status: "active" | "paused" | "archived";
  manifestOnly: boolean;
  hidden: boolean;
  service?: { port: number; health: "ok" | "down" | "unknown" };
  agents: AgentInfo[];
  widgets: { id: string; name: string; title: string; i18n?: I18n; kind: string; size: string; link: string }[];
};

export type ServiceInfo = {
  app: string;
  peer?: string;
  title: string;
  i18n?: I18n;
  icon: string;
  port: number;
  health: "ok" | "down" | "unknown";
  status: "active" | "paused" | "archived";
  hidden: boolean;
  /** Who runs the process (docs/supervision.md). */
  supervisor?: "space" | "operator";
  /** Under the space: the last sync's outcome for the unit. */
  supervision?: { action: string; error?: string; health?: string };
};

export type { WidgetBlock } from "../space/panel/blocks.ts";
import type { WidgetBlock } from "../space/panel/blocks.ts";
export type WidgetItem = { text: string; url: string; time: string };
export type WidgetInfo = {
  id: string;
  peer?: string;
  stale?: boolean;
  app: string;
  name: string;
  title: string;
  i18n?: I18n;
  icon: string;
  link: string;
  kind: "items" | "embed";
  size: string;
} & ({ ok: true; items: WidgetItem[]; blocks?: WidgetBlock[]; asOf?: string; staleAfterMs?: number } | { ok: false; error: string });

/** One peer machine as `GET /api/services` and `GET /api/peers` report it. */
/** One cell of the model status table (docs/model-machines.md#status): a runtime on a machine ("" = this one). */
export type MachineCell = {
  machine: string;
  runtime: string;
  kind: string;
  reachable?: boolean;
  installed?: boolean;
  signedIn?: boolean;
  detail?: string;
  /** The last status probe ran out of time; the other fields are the earlier answers. */
  probeTimedOut?: boolean;
  checkedAt?: string;
  limitedUntil?: string;
  /** Why it rests (docs/model-machines.md#status); absent on an older Space's cell. */
  restKind?: "credit" | "quota" | "rate" | "transport";
  /** The rest's end came from the runtime's own words. */
  restSaid?: boolean;
  lastError?: string;
  lastErrorKind?: "credit" | "quota" | "rate" | "auth" | "transport" | "other";
  lastOkAt?: string;
  used: boolean;
  problem?: "unreachable" | "not installed" | "not signed in" | "limited";
};

/** One speech provider as `GET /api/speech` reports it (docs/speech.md#status). */
export type SpeechCell = {
  provider: string;
  kind: string;
  capabilities: string[];
  selfHosted: boolean;
  /** "" = this machine, a peer's name, or an API's host. */
  where: string;
  /** Why the configuration keeps it off (a key variable not set, a kind not built yet). */
  off?: string;
  located: boolean;
  reachable?: boolean;
  signedIn?: boolean;
  detail?: string;
  limitedUntil?: string;
  restKind?: MachineCell["restKind"];
  restSaid?: boolean;
  lastError?: string;
  lastErrorKind?: MachineCell["lastErrorKind"];
  lastOkAt?: string;
  /** Where the configuration uses it: `asr`, `tts fallback`, … */
  roles: string[];
  used: boolean;
  problem?: "off" | "unreachable" | "not signed in" | "limited";
};

/** `GET /api/speech`: the providers, the choices, and the last 24 hours. */
export type SpeechStatus = {
  configured: boolean;
  source: string;
  configError?: string;
  warnings: string[];
  default: Partial<Record<"asr" | "tts" | "live", string>>;
  fallback: Partial<Record<"asr" | "tts" | "live", string[]>>;
  providers: SpeechCell[];
  usage24h: { calls: number; errors: number; audioSeconds: number; chars: number; costUsd: number };
};

export type PeerInfo = {
  name: string;
  url: string;
  /** `http`: a SPACE_PEER_* peer on the legacy channel, which `space peer migrate` moves onto a `connection`. */
  via?: "http" | "connection";
  health: "ok" | "down";
  asOf?: string;
  error?: string;
  stale: boolean;
  apps: number;
  agents: number;
  widgets: number;
  services: number;
};

export type ChatSession = { sid: string; title: string; ts: number; runtime?: string | null; model?: string | null };
/** A chat turn running, or run, in the background on the server (src/space/agents/runs.ts). */
export type ChatRun = {
  id: string;
  agent: string;
  sessionId: string | null;
  sid: string | null;
  message: string;
  runtime: string;
  model: string | null;
  status: "running" | "done" | "error" | "stopped" | "timeout" | "interrupted";
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  lastSeq: number;
  /** `background`: the agent started the turn by itself to answer a background job (absent from older Spaces). */
  trigger?: "user" | "background";
};

export async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const j = (await r.json()) as T & { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as T & { ok: boolean; error?: string };
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ---------------------------------------------------------------- usage (docs/usage.md)

export type UsageKind = "app" | "agent" | "builtin";
/** One entry's use over a window, as `GET /api/usage` returns it; `activeMs` null = not measured. */
export type UsageRow = { kind: UsageKind; key: string; opens: number; activeMs: number | null; sessions: number; lastAt: string | null; daily: { day: string; opens: number; activeMs: number }[] };

/**
 * Records that a tile or a library card was opened. A beacon: it never holds up or delays the
 * open, survives the page going to a new tab, and a failure is ignored.
 */
export const recordOpen = (kind: UsageKind, key: string, source: "panel" | "library") => {
  try {
    if (kind === "app") recordDeviceAppOpen(key);
    const body = JSON.stringify({ kind, key, source });
    if (!navigator.sendBeacon?.("/api/panel/usage/open", new Blob([body], { type: "text/plain" }))) void fetch("/api/panel/usage/open", { method: "POST", body, keepalive: true }).catch(() => {});
  } catch {
    /* usage is best effort */
  }
};

/** An icon is either an emoji or something an <img> can load. */
export const isImgIcon = (s: string | undefined) => /^(https?:)?\/\//.test(s || "") || (s || "").startsWith("/");

export const repoUrl = (r: string) => {
  const m = r.match(/^git@([^:]+):(.+?)(\.git)?$/);
  return m ? `https://${m[1]}/${m[2]}` : r;
};

/** The route base of an agent's chat: local, or forwarded to the peer that owns it. */
export const agentBase = (a: { peer?: string; app: string; name: string }) =>
  `${a.peer ? `/api/peers/${encodeURIComponent(a.peer)}` : "/api"}/agents/${encodeURIComponent(a.app)}/${encodeURIComponent(a.name)}`;

// The time helpers take the panel language (i18n.ts); English is the default so scripts and tests
// need not pass one.

export const relTime = (iso: string | number, lang: Lang = "en") => {
  const ms = typeof iso === "number" ? iso : new Date(iso).getTime();
  const m = Math.round((Date.now() - ms) / 60000);
  if (Number.isNaN(m)) return "";
  if (m < 1) return translate(lang, "time.justNow");
  if (m < 60) return translate(lang, "time.minAgo", { n: m });
  const h = Math.round(m / 60);
  return h < 24 ? translate(lang, "time.hAgo", { n: h }) : translate(lang, "time.dAgo", { n: Math.round(h / 24) });
};

/** A date and time in the language's locale. */
export const dateTime = (iso: string | number, lang: Lang = "en") => new Date(iso).toLocaleString(LOCALE[lang]);

// ---------------------------------------------------------------- scheduler

export type Schedule = { kind: "manual" } | { kind: "at"; at: string } | { kind: "every"; everyMs: number } | { kind: "cron"; expr: string; tz?: string };
export type RunStatus = "ok" | "error" | "skipped";
export type RunTrigger = "schedule" | "manual" | "event";
/** An event trigger as the manifest declares it: `<app>/<event>` or `<app>/*`, optional data filter and quiet period. */
export type TriggerInfo = { event: string; filter?: Record<string, string | string[]>; debounceMs?: number };

/** One task as `GET /api/tasks` shows it: effective values plus state, timestamps as ISO strings. */
export type TaskInfo = {
  id: string;
  app: string;
  name: string;
  description?: string;
  source: "manifest" | "api";
  orphaned: boolean;
  enabled: boolean;
  schedule: Schedule;
  target: { kind: "http" | "command" | "agent" };
  timeoutMs: number;
  triggers: TriggerInfo[];
  overrides: { enabled?: boolean; schedule?: Schedule; model?: string };
  model?: string;
  modelSelectable?: boolean;
  base?: { model?: string };
  state: {
    nextRunAt?: string;
    runningAt?: string;
    lastRunAt?: string;
    lastStatus?: RunStatus;
    lastError?: string;
    lastDurationMs?: number;
    consecutiveErrors: number;
    /** Events waiting for the next run, and when it is due. */
    pending?: { events: number; dueAt?: string };
  };
};

/** One run as `GET /api/tasks/:id/runs` shows it (epoch milliseconds). */
export type RunInfo = { id: number; taskId: string; startedAt: number; endedAt: number; status: RunStatus; error?: string; output?: string; trigger: RunTrigger; eventIds?: number[] };

export const fmtDuration = (ms: number, lang: Lang = "en") => {
  const t = (key: Parameters<typeof translate>[1], vars: Record<string, number>) => translate(lang, key, vars);
  if (ms < 1000) return t("time.ms", { n: Math.max(0, Math.round(ms)) });
  const s = Math.round(ms / 1000);
  if (s < 60) return t("time.s", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? t("time.ms_", { m, s: s % 60 }) : t("time.m", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? t("time.hm", { h, m: m % 60 }) : t("time.h", { h });
  const d = Math.floor(h / 24);
  return h % 24 ? t("time.dh", { d, h: h % 24 }) : t("time.d", { d });
};

export const scheduleText = (s: Schedule, lang: Lang = "en") => {
  if (s.kind === "manual") return translate(lang, "time.manual");
  if (s.kind === "every") return translate(lang, "time.every", { duration: fmtDuration(s.everyMs, lang) });
  if (s.kind === "cron") return s.tz ? `${s.expr} (${s.tz})` : s.expr;
  return translate(lang, "time.onceAt", { date: dateTime(s.at, lang) });
};

/** Forward-looking counterpart of relTime. */
export const untilTime = (iso: string, lang: Lang = "en") => {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms < 30_000) return translate(lang, "time.now");
  const m = Math.round(ms / 60000);
  if (m < 1) return translate(lang, "time.inLessMin");
  if (m < 60) return translate(lang, "time.inMin", { n: m });
  const h = Math.round(m / 60);
  return h < 24 ? translate(lang, "time.inH", { n: h }) : translate(lang, "time.inD", { n: Math.round(h / 24) });
};

export type DeliveryInfo = {
  id: number;
  eventId: number;
  event: string;
  app: string;
  kind: "http" | "stream";
  method?: string;
  path?: string;
  status: "pending" | "sent" | "ok" | "dead" | "skipped";
  attempts: number;
  nextAt?: string;
  lastError?: string;
  lastStatus?: number;
  createdAt: string;
};
export type InboxItem = {
  thread: string;
  app: string;
  level: "info" | "success" | "warn" | "alert" | "report";
  title?: string;
  text: string;
  url?: string;
  key?: string;
  notificationId: string;
  count: number;
  firstAt: string;
  lastAt: string;
  action: boolean;
  unread: boolean;
  done: boolean;
};
export type InboxSummary = { unread: number; open: number };
export type EventInfo = { id: number; name: string; app: string; at: string; data: Record<string, unknown>; peer?: string };
export type CapabilityApp = {
  app: string;
  peer?: string;
  provides: { name: string; description?: string; method: string; path: string; timeoutMs: number; callers?: string[] }[];
  publishes: { name: string; description?: string }[];
  consumes: { event: string; kind: "task" | "http" | "stream"; task?: string; method?: string; path?: string }[];
  stats?: { capability: string; calls: number; failures: number; meanMs: number }[];
};

export type BackupInfo = {
  app: string;
  count: number;
  lastAt?: number;
  lastStatus?: "ok" | "error";
  lastError?: string;
  lastOkAt?: number;
  lastOkKey?: string;
  lastOkBytes?: number;
  lastVerifiedAt?: number;
  lastVerifyOk?: boolean;
  lastVerifyError?: string;
  stale: boolean;
  /** No backup task will run again (the app left, or opted out); the snapshots are history. */
  retired: boolean;
  taskId?: string;
  nextRunAt?: number;
  enabled?: boolean;
};
