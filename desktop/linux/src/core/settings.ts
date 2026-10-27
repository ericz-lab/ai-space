import type { BackupInfo, CapabilityApp, DeliveryInfo, EventInfo, PeerInfo, RunInfo, ServiceInfo, TaskInfo, UsageRow } from "../../../../src/web/api.ts";
import { type Key as WebKey, type Lang, translate } from "../../../../src/web/messages.ts";

/**
 * Settings as the web panel lays them out (src/web/App.tsx, SettingsNav.tsx): the same sections in
 * the same order, the same rows, the same words. The words are the panel's own dictionaries
 * (src/web/messages.ts); the rules below are the panel components' (SettingsStatus, Tasks, Events,
 * Usage, Activity, AppModels, Packages), kept here without GTK so they are tested next to the web's.
 */

export type { BackupInfo, CapabilityApp, DeliveryInfo, EventInfo, PeerInfo, RunInfo, ServiceInfo, TaskInfo, UsageRow, WebKey };
export { dateTime, fmtDuration, relTime, scheduleText, untilTime } from "../../../../src/web/api.ts";
export { activityBars, activityRange, type UsageWindow } from "../../../../src/web/activity-range.ts";

export const webText = (lang: Lang, key: WebKey, vars?: Record<string, string | number>) => translate(lang, key, vars);

/** The panel's sections, then this client's own two (This Computer in the Local edition, Peer). */
export type Section = "general" | "appearance" | "models" | "automation" | "feedback" | "usage" | "status" | "packages" | "account" | "local" | "peer";
export const WEB_SECTIONS = ["general", "appearance", "models", "automation", "feedback", "usage", "status", "packages", "account"] as const;
export const SECTION_LABEL: Record<(typeof WEB_SECTIONS)[number], WebKey> = {
  general: "settings.section.general",
  appearance: "settings.section.appearance",
  models: "settings.section.models",
  automation: "settings.section.automation",
  feedback: "settings.section.feedback",
  usage: "settings.section.usage",
  status: "settings.status",
  packages: "settings.section.packages",
  account: "auth.account",
};
/** The pages a section opens inside the pane, with Back (the panel's `settingsPage`). */
export type Detail = "usage" | "activity" | "appModels" | "tasks" | "events";

/** Accent of a status dot: the panel's `status` classes. */
export type Tone = "ok" | "down" | "paused" | "running" | "off" | "unknown";

const objects = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)) : []);
const field = (raw: unknown, key: string): unknown => (typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : undefined);
/** An answer's list under `key`, skipping anything that is not an object (the panel trusts the shape; this client checks it). */
export const listOf = <T>(raw: unknown, key: string): T[] => objects(field(raw, key)) as T[];

// ------------------------------------------------------------------ appearance and language

export type Appearance = "system" | "light" | "dark";
export const APPEARANCES: { mode: Appearance; key: WebKey }[] = [
  { mode: "system", key: "appearance.system" },
  { mode: "light", key: "appearance.light" },
  { mode: "dark", key: "appearance.dark" },
];
export const appearanceOf = (v: unknown): Appearance => (v === "light" || v === "dark" ? v : "system");
/** The language chosen in Settings, else the desktop's. */
export const languageOf = (v: unknown): Lang | undefined => (v === "en" || v === "zh" ? v : undefined);

// ------------------------------------------------------------------ status

export type StatusData = { services: ServiceInfo[]; peers: PeerInfo[]; backups: BackupInfo[]; backupsOn: boolean };

export const decodeServices = (raw: unknown) => ({ services: listOf<ServiceInfo>(raw, "services"), peers: listOf<PeerInfo>(raw, "peers") });
export const decodeBackups = (raw: unknown) => ({ backups: listOf<BackupInfo>(raw, "backups"), on: field(raw, "enabled") !== false });

/** Down services that should be up, peers not answering, and stale backups still running. */
export const problems = (d: StatusData) =>
  d.services.filter((s) => s.status === "active" && s.health === "down").length + d.peers.filter((p) => p.health !== "ok").length + d.backups.filter((b) => b.stale && !b.retired).length;

/** The status section's one-line summary. */
export const statusSummary = (d: StatusData, lang: Lang) =>
  [
    webText(lang, "settings.countServices", { n: d.services.length }),
    d.backupsOn || d.backups.length ? webText(lang, "settings.countBackups", { n: d.backups.length }) : "",
    d.peers.length ? webText(lang, "settings.countPeers", { n: d.peers.length }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

const HEALTH: Record<string, WebKey | undefined> = { ok: "status.up", down: "status.down", unknown: undefined };
const STATUS: Record<string, WebKey> = { active: "status.active", paused: "status.paused", archived: "status.archived" };

/** A service row: its dot and word (none while its health is unknown: "?"), and whether the Space runs it, so it can be started and stopped. */
export function serviceState(s: ServiceInfo): { tone: Tone; key: WebKey | undefined; supervised: boolean } {
  const unitProblem = s.supervision?.action === "conflict" || s.supervision?.action === "failed";
  const key: WebKey | undefined = unitProblem ? "services.unitProblem" : s.status === "active" ? HEALTH[s.health] : STATUS[s.status];
  const tone: Tone = unitProblem ? "down" : s.status === "active" ? (s.health === "ok" ? "ok" : s.health === "down" ? "down" : "unknown") : s.status === "paused" ? "paused" : "off";
  return { tone, key, supervised: !s.peer && s.supervisor === "space" && s.status === "active" };
}

export function backupState(b: BackupInfo): { tone: Tone; key: WebKey } {
  if (b.retired) return { tone: "off", key: "backup.retired" };
  return b.stale ? { tone: "down", key: "backup.stale" } : { tone: "ok", key: "backup.fresh" };
}

// ------------------------------------------------------------------ models

export type ModelOption = { value: string; runtime: string; tier: "basic" | "junior" | "intermediate" | "advanced"; model: string; capabilities?: { agent: boolean; complete: boolean } };
export type Preferences = { defaultModel: string | null; appDefault: string; baseDefault: string; options: ModelOption[] };
export type Choice = { value: string; label: string };

export function decodePreferences(raw: unknown): Preferences {
  const d = field(raw, "defaultModel");
  return {
    defaultModel: typeof d === "string" && d ? d : null,
    appDefault: String(field(raw, "appDefault") ?? ""),
    baseDefault: String(field(raw, "baseDefault") ?? ""),
    options: listOf<ModelOption>(raw, "options").filter((o) => typeof o.value === "string"),
  };
}

/**
 * The entries of a model picker, as the panel's selects list them: the empty choice first, the
 * current value when no option has it (so it is not lost), then the options, runtime by runtime.
 */
export function modelChoices(options: ModelOption[], current: string | null | undefined, empty: string, lang: Lang, withRuntime = true): Choice[] {
  const out: Choice[] = [{ value: "", label: empty }];
  if (current && !options.some((o) => o.value === current)) out.push({ value: current, label: current });
  const runtimes = [...new Set(options.map((o) => o.runtime))];
  for (const r of runtimes)
    for (const o of options.filter((x) => x.runtime === r)) out.push({ value: o.value, label: `${withRuntime || runtimes.length > 1 ? `${o.runtime} · ` : ""}${webText(lang, `modelTier.${o.tier}` as WebKey)} · ${o.model}` });
  return out;
}

export type AppModelSource = "request" | "choice" | "override-tag" | "override-app" | "manifest-tag" | "manifest-default" | "default";
export type AppModelRow = { tag: string | null; manifest?: string; override?: string; model: string; source: AppModelSource };
export type AppModels = { app: string; rows: AppModelRow[] };

export const decodeAppModels = (raw: unknown) => ({
  apps: listOf<AppModels>(raw, "apps").map((a) => ({ app: String(a.app), rows: objects(a.rows) as AppModelRow[] })),
  options: listOf<ModelOption>(raw, "options"),
});

// ------------------------------------------------------------------ feedback

/** Settings → Feedback, `GET /api/panel/feedback/settings` (FeedbackSettings.tsx). */
export type FeedbackView = {
  settings: { enabled: boolean; appsDefault: boolean; apps: Record<string, string>; mode: "auto" | "later"; machine: string; model: string; effort: "high" | "xhigh" | "max"; errors: boolean };
  apps: { app: string; title: string; zh?: string; enabled: boolean }[];
  /** Each peer's apps, which follow these settings (the hub sends them on). */
  peers: { name: string; ok: boolean; error: string; synced: boolean; apps: { app: string; title: string; zh?: string; enabled: boolean }[] }[];
  machines: Choice[];
  models: ModelOption[];
  later: number;
  shortcut: string;
};
export const FEEDBACK_EFFORTS = ["high", "xhigh", "max"] as const;

function feedbackApps(raw: unknown): FeedbackView["apps"] {
  return listOf<FeedbackView["apps"][number]>(raw, "apps").filter((a) => typeof a.app === "string").map((a) => ({ app: a.app, title: String(a.title ?? a.app), ...(typeof a.zh === "string" ? { zh: a.zh } : {}), enabled: a.enabled === true }));
}

export function decodeFeedback(raw: unknown): FeedbackView {
  const s = field(raw, "settings");
  const apps = field(s, "apps");
  const mode = field(s, "mode");
  const effort = field(s, "effort");
  return {
    settings: {
      enabled: field(s, "enabled") === true,
      appsDefault: field(s, "appsDefault") !== false,
      apps: typeof apps === "object" && apps !== null ? Object.fromEntries(Object.entries(apps).filter(([, v]) => v === "on" || v === "off")) : {},
      mode: mode === "later" ? "later" : "auto",
      machine: String(field(s, "machine") ?? ""),
      model: String(field(s, "model") ?? ""),
      effort: FEEDBACK_EFFORTS.includes(effort as "high") ? (effort as FeedbackView["settings"]["effort"]) : "xhigh",
      errors: field(s, "errors") !== false,
    },
    apps: feedbackApps(raw),
    peers: listOf<Record<string, unknown>>(raw, "peers")
      .filter((p) => typeof p.name === "string")
      .map((p) => ({ name: String(p.name), ok: p.ok === true, error: typeof p.error === "string" ? p.error : "", synced: p.synced === true, apps: feedbackApps(p) })),
    machines: listOf<Choice>(raw, "machines").map((m) => ({ value: String(m.value ?? ""), label: String(m.label ?? "") })),
    models: listOf<ModelOption>(raw, "models").filter((o) => typeof o.value === "string"),
    later: Number(field(field(raw, "counts"), "later") ?? 0) || 0,
    shortcut: String(field(raw, "shortcut") ?? "Alt+Shift+F"),
  };
}

// ------------------------------------------------------------------ tasks

/** A task row's dot and word: the dot follows the last outcome; off and orphaned rows are muted (Tasks.tsx). */
export function taskStatus(t: TaskInfo): { tone: Tone; key: WebKey; n?: number } {
  if (t.orphaned) return { tone: "off", key: "tasks.orphaned" };
  if (!t.enabled) return { tone: "off", key: "tasks.off" };
  if (t.state.runningAt) return { tone: "running", key: "tasks.running" };
  switch (t.state.lastStatus) {
    case "ok":
      return { tone: "ok", key: "status.ok" };
    case "error":
      return t.state.consecutiveErrors > 1 ? { tone: "down", key: "tasks.errorN", n: t.state.consecutiveErrors } : { tone: "down", key: "tasks.error" };
    case "skipped":
      return { tone: "paused", key: "tasks.skipped" };
    default:
      return { tone: "unknown", key: "tasks.neverRan" };
  }
}

export const RUN_STATUS: Record<RunInfo["status"], { tone: Tone; key: WebKey }> = {
  ok: { tone: "ok", key: "status.ok" },
  error: { tone: "down", key: "tasks.error" },
  skipped: { tone: "paused", key: "tasks.skipped" },
};

export const decodeTasks = (raw: unknown) => listOf<TaskInfo>(raw, "tasks").filter((t) => typeof t.id === "string" && typeof t.state === "object" && t.state !== null);

export function taskCounts(tasks: TaskInfo[]): { total: number; active: number; failing: number } {
  const live = tasks.filter((t) => t.enabled && !t.orphaned);
  return { total: tasks.length, active: live.length, failing: live.filter((t) => t.state.lastStatus === "error").length };
}

/** Rows grouped by app, apps by title in the reader's language, rows by name. */
export function byApp<T extends { app: string }>(rows: T[], title: (app: string) => string, lang: Lang, name: (row: T) => string): { app: string; title: string; rows: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.app, [...(groups.get(r.app) ?? []), r]);
  return [...groups.entries()]
    .map(([app, list]) => ({ app, title: title(app), rows: list.sort((a, b) => name(a).localeCompare(name(b))) }))
    .sort((a, b) => a.title.localeCompare(b.title, lang));
}

/** Tags shown on a task: made through the API, and changed from its manifest. */
export const taskBadges = (t: TaskInfo) => [t.source === "api" ? "api" : "", t.overrides.enabled !== undefined || t.overrides.schedule || t.overrides.model ? "override" : ""].filter(Boolean);

/** Models a task may run on: an agent task needs an agent runtime, any other a completion. */
export const taskModels = (options: ModelOption[], t: TaskInfo) => options.filter((o) => (t.target.kind === "agent" ? o.capabilities?.agent : o.capabilities?.complete));

// ------------------------------------------------------------------ events

export const DELIVERY: Record<DeliveryInfo["status"], { tone: Tone; key: WebKey }> = {
  pending: { tone: "paused", key: "events.pending" },
  sent: { tone: "running", key: "events.sent" },
  ok: { tone: "ok", key: "status.ok" },
  dead: { tone: "down", key: "events.dead" },
  skipped: { tone: "off", key: "events.skipped" },
};

/** The first few fields of an event's data on one line (Events.tsx). */
export function previewData(data: Record<string, unknown>): string {
  const parts = Object.entries(data ?? {})
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const s = parts.join(" · ");
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** Apps that take part in the bus: they provide, publish or consume something. */
export const catalogueApps = (apps: CapabilityApp[]) => apps.filter((a) => a.provides?.length || a.publishes?.length || a.consumes?.length);

// ------------------------------------------------------------------ model usage

export type Totals = { calls: number; errors: number; inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number; tokens: number; costUsd: number; durationMs: number };
export type UsageInfo = {
  window: string;
  backend: string;
  totals: Totals;
  byTag: (Totals & { app: string; tag: string; model: string; machine?: string })[];
  byModel: (Totals & { model: string; machine?: string })[];
  byBackend: (Totals & { backend: string; origin: string })[];
  history: { firstAt?: string; totals: Totals; days: (Totals & { day: string })[] };
};
/** The model with the machine that ran it, when that is not the Space's own: `david:gpt-6-luna` (src/web/Usage.tsx). */
export const modelOn = (r: { model: string; machine?: string }): string => (r.machine ? `${r.machine}:${r.model}` : r.model);
export type CallInfo = {
  id: number;
  app: string;
  tag: string;
  model: string;
  machine?: string;
  modelSource?: string;
  backend: string;
  status: "ok" | "error";
  error?: string;
  startedAt: string;
  durationMs: number;
  usage?: { inputTokens: number; cacheWriteTokens: number; cacheReadTokens: number; outputTokens: number };
  costUsd?: number;
};
export const MODEL_WINDOWS = ["5h", "24h", "7d", "30d"] as const;
export type Metric = "tokens" | "costUsd" | "calls";
export const METRICS: Metric[] = ["tokens", "costUsd", "calls"];

const ZERO: Totals = { calls: 0, errors: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, tokens: 0, costUsd: 0, durationMs: 0 };
const totals = (v: unknown): Totals => ({ ...ZERO, ...(typeof v === "object" && v !== null ? (v as Partial<Totals>) : {}) });

export function decodeUsage(raw: unknown): UsageInfo {
  const h = field(raw, "history");
  return {
    window: String(field(raw, "window") ?? ""),
    backend: String(field(raw, "backend") ?? ""),
    totals: totals(field(raw, "totals")),
    byTag: listOf<UsageInfo["byTag"][number]>(raw, "byTag"),
    byModel: listOf<UsageInfo["byModel"][number]>(raw, "byModel"),
    byBackend: listOf<UsageInfo["byBackend"][number]>(raw, "byBackend"),
    history: { ...(typeof field(h, "firstAt") === "string" ? { firstAt: field(h, "firstAt") as string } : {}), totals: totals(field(h, "totals")), days: listOf<UsageInfo["history"]["days"][number]>(h, "days") },
  };
}

/** 1234 → 1.2K, 1234567 → 1.23M, 2689400000 → 2.69B; a missing figure is a dash (Usage.tsx). */
export const fmtTokens = (n: number | undefined): string => {
  if (n === undefined) return "–";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}K`;
  return String(n);
};

export const fmtCost = (usd: number | undefined): string => {
  if (usd === undefined) return "–";
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
};

export const fmtMetric = (m: Metric, v: number) => (m === "costUsd" ? fmtCost(v) : m === "tokens" ? fmtTokens(v) : v.toLocaleString());

/** Every token of a call, or undefined when the runtime reported none. */
export const callTokens = (c: CallInfo) => (c.usage ? c.usage.inputTokens + c.usage.cacheWriteTokens + c.usage.cacheReadTokens + c.usage.outputTokens : undefined);

const DAY = 86_400_000;
export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Monday of the UTC week a day belongs to. */
export const weekStart = (ms: number) => Math.floor(ms / DAY) * DAY - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;

/**
 * The history (Usage.tsx's History): days recorded, a day grid over the last 52 weeks (one column
 * per week, Monday on top, shade 0–4 by quartile of the metric among days with calls, -1 for days
 * still to come) and the last 12 weeks as bars. Weeks are UTC and start on Monday, like the ledger's days.
 */
export function history(h: UsageInfo["history"], metric: Metric, now: number) {
  const byDay = new Map(h.days.map((d) => [d.day, d]));
  const today = weekStart(now);
  const weeks: number[] = [];
  for (let w = today - 51 * 7 * DAY; w <= today; w += 7 * DAY) weeks.push(w);
  const values = h.days
    .map((d) => d[metric])
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  const q = (p: number) => values[Math.min(values.length - 1, Math.floor(values.length * p))] ?? 0;
  const cuts = [q(0.25), q(0.5), q(0.75)] as const;
  const level = (v: number) => (v <= 0 ? 0 : v <= cuts[0] ? 1 : v <= cuts[1] ? 2 : v <= cuts[2] ? 3 : 4);
  const grid = weeks.map((w) =>
    [0, 1, 2, 3, 4, 5, 6].map((row) => {
      const ms = w + row * DAY;
      const d = byDay.get(dayKey(ms));
      return { day: dayKey(ms), value: d ? d[metric] : 0, level: ms > now ? -1 : level(d ? d[metric] : 0), calls: Boolean(d) };
    }),
  );
  const months: { col: number; month: number }[] = [];
  weeks.forEach((w, col) => {
    const m = new Date(w).getUTCMonth();
    if (months.at(-1)?.month !== m) months.push({ col, month: m });
  });
  const weekly = new Map<number, number>();
  for (const d of h.days) {
    const w = weekStart(Date.parse(`${d.day}T00:00:00Z`));
    weekly.set(w, (weekly.get(w) ?? 0) + d[metric]);
  }
  const bars = [...weekly.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-12)
    .map(([week, value]) => ({ week, value, partial: week === today }));
  const daysRecorded = h.firstAt ? Math.max(1, Math.ceil((now - new Date(h.firstAt).getTime()) / DAY)) : 0;
  return { weeks, grid, months, bars, max: Math.max(1, ...bars.map((b) => b.value)), daysRecorded };
}

// ------------------------------------------------------------------ app usage

export const ACTIVITY_WINDOWS = ["7d", "30d", "90d", "all"] as const;
export const KINDS = [
  { value: "all", key: "activity.kindAll" },
  { value: "app", key: "activity.kindApp" },
  { value: "agent", key: "activity.kindAgent" },
  { value: "builtin", key: "activity.kindBuiltin" },
] as const satisfies readonly { value: string; key: WebKey }[];
export type DeviceRow = { client: string; deviceId: string; sessions: number; activeMs: number; lastAt: string; apps?: { key: string; opens: number; activeMs: number | null }[] };
export const CLIENTS: Record<string, string> = { web: "Web", ios: "iOS", macos: "macOS", android: "Android", linux: "Linux" };
export const deviceLabel = (d: DeviceRow) => `${CLIENTS[d.client] ?? d.client} · ${d.deviceId.slice(-8)}`;

export function activityTotals(rows: UsageRow[]): { opens: number; timeMs: number; top?: UsageRow } {
  return { opens: rows.reduce((n, r) => n + r.opens, 0), timeMs: rows.reduce((n, r) => n + (r.activeMs ?? 0), 0), ...(rows[0] ? { top: rows[0] } : {}) };
}

// ------------------------------------------------------------------ packages

export type PackageApp = { app: string; title: string; version: string; url: string; page?: boolean; state?: string; offline?: { features: string[]; online: string[] }; sourceIncluded?: boolean };
export type PackageCatalogue = { spaceId: string; apps: PackageApp[]; remotes: { connectionId: string; spaceId: string; available: boolean; apps: PackageApp[] }[] };
export type PackageConnection = { id: string; remoteSpaceId: string; direction: string; apps: string[]; enabled: boolean; connected: boolean };
export type PackageOperation = { id: string; app: string; version: string; state: string };

export function decodePackageCatalogue(raw: unknown): PackageCatalogue {
  return {
    spaceId: String(field(raw, "spaceId") ?? ""),
    apps: listOf<PackageApp>(raw, "apps"),
    remotes: listOf<PackageCatalogue["remotes"][number]>(raw, "remotes").map((r) => ({ ...r, apps: objects(r.apps) as PackageApp[] })),
  };
}

/** Earlier installs of an app that it can be rolled back to. */
export const rollbacks = (ops: PackageOperation[], app: string) => ops.filter((o) => o.app === app && o.state === "retired");
/** An upload is settled once its operation leaves pending and installing. */
export const settled = (state: string | undefined) => state !== undefined && !["pending", "installing"].includes(state);
export const runtimeKey = (state: string | undefined) => `packages.runtime.${state ?? "unavailable"}` as WebKey;
export const operationKey = (state: string) => `packages.state.${state}` as WebKey;

// ------------------------------------------------------------------ account

export type AuthState = { mode: string; signedIn: boolean };
export type SessionView = { id: number; createdAt: string; lastSeenAt: string; userAgent: string; current: boolean };
export const decodeAuth = (raw: unknown): AuthState => ({ mode: String(field(raw, "mode") ?? "external"), signedIn: field(raw, "signedIn") === true });
/** Account shows only where the Space keeps its own password and this app is signed in (Auth.tsx). */
export const hasAccount = (a: AuthState | undefined) => a?.mode === "builtin" && a.signedIn;
export const MIN_PASSWORD = 8;
