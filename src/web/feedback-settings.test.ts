import { expect, test } from "bun:test";
import { withPatch, type View } from "./FeedbackSettings.tsx";

const view = (): View => ({
  settings: { enabled: true, appsDefault: true, apps: { notes: "off" }, mode: "auto", machine: "", model: "", effort: "high", errors: true },
  apps: [
    { app: "notes", title: "Notes", status: "running", enabled: false },
    { app: "todo", title: "Todo", status: "running", enabled: true },
  ],
  machines: [],
  models: [],
  counts: { later: 0, queued: 0, fixing: 0, review: 0, failed: 0, skipped: 0, recorded: 0 },
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
