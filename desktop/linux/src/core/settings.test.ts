import { expect, test } from "bun:test";
import { SECTION_LABEL as WEB_LABEL } from "../../../../src/web/SettingsNav.tsx";
import { fmtCost as webCost, fmtTokens as webTokens } from "../../../../src/web/Usage.tsx";
import { MESSAGES } from "../../../../src/web/messages.ts";
import {
  type BackupInfo,
  type ServiceInfo,
  type TaskInfo,
  SECTION_LABEL,
  WEB_SECTIONS,
  appearanceOf,
  backupState,
  byApp,
  callTokens,
  decodeAuth,
  decodeBackups,
  decodeFeedback,
  decodePreferences,
  decodeServices,
  decodeTasks,
  decodeUsage,
  fmtCost,
  fmtTokens,
  hasAccount,
  history,
  languageOf,
  modelChoices,
  previewData,
  problems,
  rollbacks,
  serviceState,
  settled,
  statusSummary,
  taskBadges,
  taskCounts,
  taskModels,
  taskStatus,
  usageHeader,
  usagePeerNotes,
  webText,
} from "./settings.ts";

test("the panel's sections, in its order, under its names", () => {
  expect([...WEB_SECTIONS]).toEqual(["general", "appearance", "models", "automation", "feedback", "usage", "status", "packages", "account"]);
  expect(SECTION_LABEL).toEqual(WEB_LABEL);
  expect(webText("zh", "settings.section.models")).toBe(MESSAGES.zh["settings.section.models"]);
  expect(webText("en", "settings.countServices", { n: 3 })).toBe("3 services");
  expect([appearanceOf("dark"), appearanceOf("nope"), languageOf("zh"), languageOf("fr")]).toEqual(["dark", "system", "zh", undefined]);
});

test("figures read as the panel writes them", () => {
  for (const n of [undefined, 0, 999, 1234, 12_345, 1_234_567, 12_345_678, 2_689_400_000]) expect(fmtTokens(n)).toBe(webTokens(n));
  for (const c of [undefined, 0.0123, 1.5, 123.4]) expect(fmtCost(c)).toBe(webCost(c));
  expect(callTokens({ id: 1, app: "a", tag: "t", model: "m", backend: "b", status: "ok", startedAt: "", durationMs: 1, usage: { inputTokens: 1, cacheWriteTokens: 2, cacheReadTokens: 3, outputTokens: 4 } })).toBe(10);
});

const service = (over: Partial<ServiceInfo>): ServiceInfo => ({ app: "a", title: "A", icon: "", port: 1, health: "ok", status: "active", hidden: false, ...over });
const backup = (over: Partial<BackupInfo>): BackupInfo => ({ app: "a", count: 1, stale: false, retired: false, ...over });

test("status: the summary, the problems and each row", () => {
  const d = {
    services: [service({ health: "down" }), service({ app: "b", status: "paused", health: "down" }), service({ app: "c", supervisor: "space" })],
    peers: [{ name: "p", url: "", health: "down" as const, stale: true, apps: 0, agents: 0, widgets: 0, services: 0 }],
    backups: [backup({ stale: true }), backup({ app: "b", stale: true, retired: true })],
    backupsOn: true,
  };
  expect(problems(d)).toBe(3);
  expect(statusSummary(d, "en")).toBe("3 services · 2 backups · 1 peers");
  expect(statusSummary({ ...d, backups: [], backupsOn: false, peers: [] }, "en")).toBe("3 services");
  expect(serviceState(d.services[0]!)).toEqual({ tone: "down", key: "status.down", supervised: false });
  expect(serviceState(d.services[1]!)).toEqual({ tone: "paused", key: "status.paused", supervised: false });
  expect(serviceState(d.services[2]!).supervised).toBe(true);
  expect(serviceState(service({ supervisor: "space", peer: "x" })).supervised).toBe(false);
  expect(serviceState(service({ supervision: { action: "failed" } })).key).toBe("services.unitProblem");
  expect(serviceState(service({ health: "unknown" })).key).toBeUndefined();
  expect([backupState(d.backups[0]!).key, backupState(d.backups[1]!).key, backupState(backup({})).key]).toEqual(["backup.stale", "backup.retired", "backup.fresh"]);
  expect(decodeServices({ services: [{ app: "x" }, 3, null], peers: "bad" })).toEqual({ services: [{ app: "x" } as ServiceInfo], peers: [] });
  expect(decodeBackups({ enabled: false, backups: [] })).toEqual({ backups: [], on: false });
  expect(decodeBackups({}).on).toBe(true);
});

test("model pickers list what the panel's selects list", () => {
  const p = decodePreferences({
    defaultModel: "gone",
    appDefault: "x",
    baseDefault: "y",
    options: [
      { value: "c:s", runtime: "claude", tier: "advanced", model: "sonnet", capabilities: { agent: true, complete: true } },
      { value: "o:m", runtime: "openai", tier: "basic", model: "mini", capabilities: { agent: false, complete: true } },
    ],
  });
  expect(modelChoices(p.options, p.defaultModel, "Environment defaults", "en")).toEqual([
    { value: "", label: "Environment defaults" },
    { value: "gone", label: "gone" },
    { value: "c:s", label: "claude · Advanced · sonnet" },
    { value: "o:m", label: "openai · Basic · mini" },
  ]);
  expect(modelChoices(p.options.slice(0, 1), null, "-", "en", false).map((c) => c.label)).toEqual(["-", "Advanced · sonnet"]);
  expect(decodePreferences({}).defaultModel).toBeNull();
  const task = { target: { kind: "agent" } } as TaskInfo;
  expect(taskModels(p.options, task).map((o) => o.value)).toEqual(["c:s"]);
});

const task = (over: Omit<Partial<TaskInfo>, "state"> & { state?: Partial<TaskInfo["state"]> }): TaskInfo =>
  ({ id: "a/t", app: "a", name: "t", source: "manifest", orphaned: false, enabled: true, schedule: { kind: "manual" }, target: { kind: "http" }, timeoutMs: 1, triggers: [], overrides: {}, ...over, state: { consecutiveErrors: 0, ...over.state } }) as TaskInfo;

test("tasks: status, counts, badges and groups", () => {
  expect(taskStatus(task({ orphaned: true })).key).toBe("tasks.orphaned");
  expect(taskStatus(task({ enabled: false })).key).toBe("tasks.off");
  expect(taskStatus(task({ state: { runningAt: "x" } })).tone).toBe("running");
  expect(taskStatus(task({ state: { lastStatus: "error", consecutiveErrors: 3 } }))).toEqual({ tone: "down", key: "tasks.errorN", n: 3 });
  expect(taskStatus(task({ state: { lastStatus: "error", consecutiveErrors: 1 } })).key).toBe("tasks.error");
  expect(taskStatus(task({})).key).toBe("tasks.neverRan");
  const list = [task({ id: "b/z", app: "b", name: "z", state: { lastStatus: "error" } }), task({ id: "b/a", app: "b", name: "a", source: "api", overrides: { model: "m" } }), task({ enabled: false })];
  expect(taskCounts(list)).toEqual({ total: 3, active: 2, failing: 1 });
  expect(taskBadges(list[1]!)).toEqual(["api", "override"]);
  const groups = byApp(list, (app) => ({ a: "Zed", b: "Alpha" })[app] ?? app, "en", (t) => t.name);
  expect(groups.map((g) => [g.title, g.rows.map((r) => r.name)])).toEqual([["Alpha", ["a", "z"]], ["Zed", ["t"]]]);
  expect(decodeTasks({ tasks: [{ id: "x" }, { id: "y", state: {} }] }).map((t) => t.id)).toEqual(["y"]);
});

test("events: one line of data", () => {
  expect(previewData({ a: "x", b: 2, c: { d: 1 }, e: true, f: "hidden" })).toBe('a: x · b: 2 · c: {"d":1} · e: true');
  expect(previewData({ long: "y".repeat(200) })).toHaveLength(120);
});

test("usage history: a year of weeks, shaded by quartile, the last twelve weeks as bars", () => {
  const now = Date.parse("2026-10-21T12:00:00Z"); // a Wednesday
  const t = { calls: 0, errors: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0 };
  const u = decodeUsage({
    totals: { calls: 4 },
    history: {
      firstAt: "2026-10-01T00:00:00Z",
      totals: { calls: 4 },
      days: [
        { ...t, day: "2026-10-19", tokens: 10, calls: 1 },
        { ...t, day: "2026-10-20", tokens: 40, calls: 1 },
        { ...t, day: "2026-10-12", tokens: 20, calls: 1 },
        { ...t, day: "2026-10-13", tokens: 30, calls: 1 },
      ],
    },
  });
  expect(u.totals.tokens).toBe(0);
  const h = history(u.history, "tokens", now);
  expect(h.weeks).toHaveLength(52);
  expect(new Date(h.weeks.at(-1)!).toISOString()).toBe("2026-10-19T00:00:00.000Z");
  const last = h.grid.at(-1)!;
  expect(last.map((c) => c.day)).toEqual(["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"]);
  expect(last.map((c) => c.level)).toEqual([1, 3, 0, -1, -1, -1, -1]);
  expect(h.grid.at(-2)!.slice(0, 2).map((c) => c.level)).toEqual([1, 2]);
  expect(h.bars.map((b) => [b.value, b.partial])).toEqual([[50, false], [50, true]]);
  expect(h.max).toBe(50);
  expect(h.daysRecorded).toBe(21);
  expect(h.months.at(-1)!.month).toBe(9);
});

test("packages and account", () => {
  const ops = [{ id: "1", app: "a", version: "1", state: "retired" }, { id: "2", app: "a", version: "2", state: "installed" }, { id: "3", app: "b", version: "1", state: "retired" }];
  expect(rollbacks(ops, "a").map((o) => o.id)).toEqual(["1"]);
  expect([settled(undefined), settled("installing"), settled("failed")]).toEqual([false, false, true]);
  expect(hasAccount(decodeAuth({ mode: "builtin", signedIn: true }))).toBe(true);
  expect(hasAccount(decodeAuth({ mode: "builtin" }))).toBe(false);
  expect(hasAccount(decodeAuth(null))).toBe(false);
});

test("feedback settings read as the panel writes them, with safe defaults", () => {
  const v = decodeFeedback({
    settings: { enabled: true, appsDefault: false, apps: { "ai-todo": "on", bad: "maybe" }, mode: "later", machine: "hub", model: "claude/intermediate", effort: "max", errors: false },
    apps: [{ app: "ai-todo", title: "AI Todo", zh: "AI 待办", enabled: true }, { title: "no id" }],
    machines: [{ value: "", label: "here" }],
    models: [{ value: "claude/intermediate", runtime: "claude", tier: "intermediate", model: "opus" }],
    counts: { later: 3 },
    shortcut: "Alt+Shift+F",
  });
  expect(v.settings).toEqual({ enabled: true, appsDefault: false, apps: { "ai-todo": "on" }, mode: "later", machine: "hub", model: "claude/intermediate", effort: "max", errors: false });
  expect(v.apps).toEqual([{ app: "ai-todo", title: "AI Todo", zh: "AI 待办", enabled: true }]);
  expect(v.later).toBe(3);
  const empty = decodeFeedback(null);
  expect(empty.settings).toEqual({ enabled: false, appsDefault: true, apps: {}, mode: "auto", machine: "", model: "", effort: "xhigh", errors: true });
  expect(empty.shortcut).toBe("Alt+Shift+F");
});

test("model usage names the Space and the peers whose rows are missing or old", () => {
  const u = decodeUsage({ backend: "ai-space", space: "home", peers: [{ name: "david", ok: true }, { name: "eric", ok: false, error: "timeout", asOf: "2026-10-27T10:00:00Z" }, { name: "box", ok: false, error: "no route" }, { ok: false }] });
  expect(usageHeader(u, "en")).toBe("Space home · " + webText("en", "usage.backend", { backend: "ai-space" }));
  expect(usageHeader(decodeUsage({ backend: "x" }), "en")).toBe(webText("en", "usage.backend", { backend: "x" }));
  const notes = usagePeerNotes(u, "en");
  expect(notes).toHaveLength(2);
  expect(notes[0]).toStartWith("eric did not answer (timeout); its figures are from ");
  expect(notes[1]).toBe("box is not included: no route");
  expect(usagePeerNotes(u, "zh")[1]).toBe("未包含 box：no route");
});
