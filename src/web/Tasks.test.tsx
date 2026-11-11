import { afterEach, expect, test } from "bun:test";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskInfo } from "./api.ts";
import { TaskAppList, type TaskGroup, counts, loadPeerTasks, modelPath, modelsPath, runsPath } from "./Tasks.tsx";
import { translate } from "./messages.ts";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const task = (app: string, name: string, over: Partial<TaskInfo> = {}, lastStatus?: "ok" | "error"): TaskInfo => ({
  id: `${app}.${name}`, app, name, source: "manifest", orphaned: false, enabled: true, schedule: { kind: "manual" }, target: { kind: "command" }, timeoutMs: 1000, triggers: [], overrides: {},
  state: { consecutiveErrors: 0, ...(lastStatus ? { lastStatus } : {}) },
  ...over,
} as TaskInfo);
const news: TaskGroup = { key: "news", app: "news", title: "News", icon: "📰", list: [task("news", "fetch", {}, "ok"), task("news", "digest", {}, "error"), task("news", "old", { enabled: false }, "error"), task("news", "left", { orphaned: true })] };
const notes: TaskGroup = { key: "david/notes", app: "notes", peer: "david", title: "Notes", icon: "📝", list: [task("notes", "backup", {}, "ok")] };

/** Every element in a rendered tree, walking function components that hold no hooks. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const el = node as ReactElement<Record<string, unknown>>;
  return [el, ...elements(el.props.children as ReactNode)];
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("counts leave tasks that are off or orphaned out of active and failing", () => {
  expect(counts(news.list)).toEqual({ total: 4, active: 2, failing: 1 });
  expect(counts(notes.list)).toEqual({ total: 1, active: 1, failing: 0 });
});

test("the list shows one row per app with its counts, and no task", () => {
  const html = renderToStaticMarkup(<TaskAppList groups={[news, notes]} onOpen={() => {}} t={t} heading="On david" />);
  expect(html.match(/class="task-main app-model-row"/g)?.length).toBe(2);
  expect(html).toContain("On david");
  expect(html).toContain("2 of 4 active");
  expect(html.match(/1 failing/g)?.length).toBe(1);
  expect(html).toContain("1 of 1 active");
  expect(html).not.toContain("digest");
});

test("a click on a row opens that app under its machine's key", () => {
  const opened: string[] = [];
  const rows = elements(TaskAppList({ groups: [news, notes], onOpen: (key) => opened.push(key), t })).filter((el) => el.type === "button");
  for (const row of rows) (row.props.onClick as () => void)();
  expect(opened).toEqual(["news", "david/notes"]);
});

test("a machine without tasks shows its note, and one with neither is left out", () => {
  expect(renderToStaticMarkup(<TaskAppList groups={[]} onOpen={() => {}} t={t} heading="On mac" note="No scheduled tasks." />)).toContain("No scheduled tasks.");
  expect(renderToStaticMarkup(<TaskAppList groups={[]} onOpen={() => {}} t={t} />)).toBe("");
});

test("a peer's task is read and changed through the hub, a local one through the panel route", () => {
  expect(runsPath("news.fetch")).toBe("/api/tasks/news.fetch/runs?limit=20");
  expect(runsPath("news.fetch", "david box")).toBe("/api/peers/david%20box/tasks/news.fetch/runs?limit=20");
  expect(modelsPath()).toBe("/api/tasks/models");
  expect(modelsPath("david")).toBe("/api/peers/david/tasks/models");
  expect(modelPath("news.fetch")).toBe("/api/panel/tasks/news.fetch/model");
  expect(modelPath("news.fetch", "david")).toBe("/api/peers/david/tasks/news.fetch/model");
});

test("a peer's tasks load, an older core is told apart from one that is down", async () => {
  const answers: Record<string, () => Response> = {
    "/api/peers/david/tasks": () => Response.json({ ok: true, tasks: notes.list }),
    "/api/peers/old/tasks": () => Response.json({ ok: false, error: "not found" }, { status: 404 }),
    "/api/peers/page/tasks": () => new Response("<html>", { headers: { "content-type": "text/html" } }),
    "/api/peers/ghost/tasks": () => Response.json({ ok: false, error: "unknown peer: ghost" }, { status: 404 }),
    "/api/peers/down/tasks": () => Response.json({ ok: false, error: "peer down unreachable" }, { status: 502 }),
  };
  globalThis.fetch = (async (input: string | URL | Request) => answers[String(input)]!()) as typeof fetch;
  expect((await loadPeerTasks("david")).tasks?.map((x) => x.id)).toEqual(["notes.backup"]);
  expect(await loadPeerTasks("old")).toEqual({ peer: "old", old: true });
  expect(await loadPeerTasks("page")).toEqual({ peer: "page", old: true });
  expect(await loadPeerTasks("ghost")).toEqual({ peer: "ghost", error: "unknown peer: ghost" });
  expect(await loadPeerTasks("down")).toEqual({ peer: "down", error: "peer down unreachable" });
});
