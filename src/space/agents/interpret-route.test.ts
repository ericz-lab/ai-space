import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRegistry } from "../panel/registry.ts";
import { LayoutStore } from "../panel/layout.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { loadManifest } from "../scheduler/manifest.ts";
import type { Action } from "../shortcuts/types.ts";
import { ShortcutStore } from "../shortcuts/store.ts";
import { workspacePaths } from "../workspace.ts";
import { createAgentRoutes } from "./api.ts";
import { SessionStore } from "./sessions.ts";

test("interpret asks the model only for longer text and returns a checked suggestion", async () => {
  const home = await mkdtemp(join(tmpdir(), "space-interpret-"));
  const ws = workspacePaths(home);
  const dir = join(ws.apps, "news");
  await mkdir(join(dir, "skills", "curate-news"), { recursive: true });
  await Bun.write(join(dir, "space.yaml"), "name: news\nagents:\n  - { name: curator }\n");
  await Bun.write(join(dir, "skills", "curate-news", "SKILL.md"), "# Curation");
  const db = new Database(":memory:");
  const store = new ShortcutStore(join(home, "shortcuts.db"));
  const registry = new AppRegistry();
  await registry.set(await loadManifest(dir));
  const actions: Action[] = [{ id: "todo/create", app: "todo", builtin: false, title: "Todo", keywords: ["todo"], effect: "write", result: "receipt", available: true,
    inputs: [{ name: "title", label: "Title", type: "text", query: true, required: true }, { name: "date", label: "Date", type: "date" }, { name: "time", label: "Time", type: "time" }] }];
  const prompts: string[] = [];
  let answer: string | undefined = "";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createAgentRoutes({
    ws, registry, layout: new LayoutStore(db), sessions: new SessionStore(db), runtimes: claudeOnly(["true"]), shortcuts: store, actionCatalogue: () => actions,
    interpret: async (prompt) => { prompts.push(prompt); return answer; },
  }) });
  const ask = async (text: string) => (await fetch(new URL("/api/shortcuts/interpret", server.url), { method: "POST", body: JSON.stringify({ text, timezone: "Asia/Seoul" }) })).json();
  try {
    expect(await ask("8点开会")).toMatchObject({ ok: true, skipped: true, interpretation: null });
    expect(prompts).toHaveLength(0);

    answer = '{"kind":"action","id":"todo/create","args":{"title":"写周报","date":"tomorrow","time":"15:00"}}';
    expect(await ask("帮我记一下明天下午3点写周报")).toMatchObject({ ok: true, skipped: false, interpretation: { kind: "action", action: { id: "todo/create" }, args: { title: "写周报", date: "tomorrow", time: "15:00" } } });
    expect(prompts).toHaveLength(1);

    store.setAgentIntent({ id: "financial-news", title: "Financial news", agent: "news/curator", skills: ["curate-news"], patterns: ["金融新闻"], enabled: true });
    answer = '{"kind":"agent","id":"financial-news"}';
    expect(await ask("最近美联储加息对港股有什么影响")).toMatchObject({ interpretation: { kind: "agent", intent: { id: "financial-news", agent: "news/curator", available: true } } });
    expect(prompts[1]).toContain('"id":"financial-news"');

    answer = undefined;
    expect(await ask("最近美联储加息对港股有什么影响")).toMatchObject({ ok: true, interpretation: null, failed: true });
    expect((await fetch(new URL("/api/shortcuts/interpret", server.url), { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(400);
  } finally {
    server.stop(true);
    store.close?.();
    await rm(home, { recursive: true, force: true });
  }
});
