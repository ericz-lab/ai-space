import { expect, test } from "bun:test";
import { modelsFor, withPatch, type View } from "./FeedbackSettings.tsx";

const view = (): View => ({
  settings: { enabled: true, appsDefault: true, apps: { notes: "off" }, mode: "auto", machine: "", model: "", effort: "high", errors: true },
  apps: [
    { app: "notes", title: "Notes", status: "running", enabled: false },
    { app: "todo", title: "Todo", status: "running", enabled: true },
  ],
  machines: [],
  models: [],
  counts: { later: 0, queued: 0, fixing: 0, review: 0, failed: 0, skipped: 0, recorded: 0, accepted: 0, dropped: 0 },
  shortcut: "Alt+Shift+F",
});

const shown = (v: View) => Object.fromEntries(v.apps.map((a) => [a.app, a.enabled]));

test("a switch shows its new value before the save answers", () => {
  const next = withPatch(view(), { enabled: false });
  expect(next.settings.enabled).toBe(false);
  expect(shown(next)).toEqual({ notes: false, todo: false });
});

test("an app set back to default drops its own value and follows the default", () => {
  const next = withPatch(view(), { apps: { notes: "default" } as unknown as View["settings"]["apps"] });
  expect(next.settings.apps).toEqual({});
  expect(shown(next)).toEqual({ notes: true, todo: true });
});

test("an app's own value wins over the default", () => {
  const next = withPatch(view(), { appsDefault: false, apps: { todo: "on" } });
  expect(next.settings.apps).toEqual({ notes: "off", todo: "on" });
  expect(shown(next)).toEqual({ notes: false, todo: true });
});

test("the model menu offers the models of the machine the engineer runs on", () => {
  const opus = { value: "claude/intermediate", runtime: "claude", tier: "intermediate", model: "opus" };
  const sol = { value: "codex/intermediate", runtime: "codex", tier: "intermediate", model: "gpt-6.1-sol" };
  const v = { ...view(), machines: [{ value: "", label: "home" }, { value: "box", label: "box" }, { value: "old", label: "old" }], models: [sol], machineModels: { "": [sol], box: [opus] } };
  expect(modelsFor(v)).toEqual([sol]);
  // Picking another machine changes the list at once, before the save answers.
  expect(modelsFor(withPatch(v, { machine: "box" }))).toEqual([opus]);
  // A peer that has not said what it runs offers nothing, rather than this machine's list.
  expect(modelsFor(withPatch(v, { machine: "old" }))).toEqual([]);
  // An older space sends only its own.
  expect(modelsFor({ ...view(), models: [sol] })).toEqual([sol]);
});
