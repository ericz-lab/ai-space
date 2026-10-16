import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
import { RunRegistry } from "./runs.ts";
import { SessionStore } from "./sessions.ts";
import { skillContext } from "./skill-context.ts";

test("skill intent routing injects actual skill contents, preserves the sentence and streams the selected agent", async () => {
  const home = await mkdtemp(join(tmpdir(), "space-skill-intents-"));
  const ws = workspacePaths(home);
  const dir = join(ws.apps, "news");
  await mkdir(join(dir, "skills", "curate-news"), { recursive: true });
  await Bun.write(join(dir, "space.yaml"), "name: news\nagents:\n  - { name: curator, tools: [Read] }\n  - { name: other }\n");
  await Bun.write(join(dir, "skills", "curate-news", "SKILL.md"), "# Curation\nSKILL_CONTENT_SENTINEL: cite actual sources.");
  const cli = join(home, "fake.ts");
  await Bun.write(cli, `const args=process.argv.slice(2); const sid=crypto.randomUUID();
console.log(JSON.stringify({type:"system",subtype:"init",session_id:sid}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:JSON.stringify({message:args[args.indexOf("-p")+1],system:args[args.indexOf("--append-system-prompt")+1],permission:args.includes("--permission-mode")?args[args.indexOf("--permission-mode")+1]:"default"})}]}}));
console.log(JSON.stringify({type:"result",session_id:sid,is_error:false}));`);
  const db = new Database(":memory:");
  const store = new ShortcutStore(join(home, "shortcuts.db"));
  const sessions = new SessionStore(db);
  const runs = new RunRegistry(db);
  const registry = new AppRegistry();
  await registry.set(await loadManifest(dir));
  const actions: Action[] = [{ id: "todo/create", app: "todo", builtin: false, title: "Todo", keywords: ["todo"], effect: "write", result: "receipt", available: true,
    inputs: [{ name: "title", label: "Title", type: "text", query: true, required: true }, { name: "date", label: "Date", type: "date" }, { name: "time", label: "Time", type: "time" }] }];
  actions.push({ id: "finance-news-feed/news", app: "finance-news-feed", builtin: false, title: "Financial news", keywords: ["金融新闻"],
    patterns: ["[查[{period}]]金融新闻"], effect: "read", result: "list", available: true, inputs: [{ name: "period", label: "Period", type: "period", default: "today" }] });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createAgentRoutes({ ws, registry, layout: new LayoutStore(db), sessions, runs, runtimes: claudeOnly(["bun", cli]), shortcuts: store, actionCatalogue: () => actions }) });
  const post = (path: string, body: unknown) => fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body) });
  const config = { id: "financial-news", title: "Financial news", agent: "news/curator", skills: ["curate-news"], patterns: ["[查[{period}]]金融新闻[{suffix2}]"] };
  try {
    expect((await post("/api/shortcuts/agent-intents", config)).status).toBe(200);
    const catalogue = await (await fetch(new URL("/api/shortcuts/agent-intents", server.url))).json();
    expect(catalogue.intents[0]).toMatchObject({ id: config.id, available: true });
    expect(runs.list()).toHaveLength(0);
    const resolve = async (text: string) => (await post("/api/shortcuts/resolve", { text, timezone: "Asia/Seoul" })).json();
    for (const text of ["金融新闻", "查今天金融新闻", "金融新闻。", "金融新闻一下", "查今天金融新闻？！"]) {
      const result = await resolve(text);
      expect(result.intents).toEqual([]);
      expect(result.agentIntents).toHaveLength(1);
      expect(result).toMatchObject({ agentIntents: [{ id: config.id, available: true }], ambiguous: false });
    }
    expect(await resolve("todo 明天 15:00 提交报告")).toMatchObject({ intents: [{ kind: "action", action: { id: "todo/create", effect: "write" }, args: { title: "提交报告", date: "tomorrow", time: "15:00" } }], agentIntents: [] });
    expect(await resolve("2+3*4")).toMatchObject({ intents: [{ kind: "calc", expression: "2+3*4" }], agentIntents: [] });
    expect(await resolve("unmatched request")).toMatchObject({ intents: [], agentIntents: [], ambiguous: false });
    expect(await resolve("  ")).toMatchObject({ intents: [], agentIntents: [] });
    for (const body of [{ text: "todo" }, { text: "todo", timezone: "bad/zone" }, { text: 4, timezone: "UTC" }, { text: "x".repeat(4001), timezone: "UTC" }]) {
      expect((await post("/api/shortcuts/resolve", body)).status).toBe(400);
    }
    store.setAgentIntent({ ...config, id: "second", enabled: true });
    expect(await resolve("查今天金融新闻")).toMatchObject({ intents: [], ambiguous: true });
    store.setAgentIntent({ ...config, id: "second", enabled: false });
    // A configured but now unavailable skill remains a visible, disabled match.
    store.setAgentIntent({ ...config, id: "missing-skill", skills: ["missing"], enabled: true });
    const unavailable = await resolve("查今天金融新闻");
    expect(unavailable.agentIntents.find((i: { id: string }) => i.id === "missing-skill")).toMatchObject({ available: false });
    expect(unavailable.intents).toEqual([]);
    store.setAgentIntent({ ...config, enabled: false });
    const onlyUnavailable = await resolve("金融新闻");
    expect(onlyUnavailable.intents).toEqual([]);
    expect(onlyUnavailable.agentIntents).toHaveLength(1);
    expect(onlyUnavailable.agentIntents[0].available).toBe(false);
    store.setAgentIntent({ ...config, id: "missing-skill", skills: ["missing"], enabled: false });
    expect(await resolve("金融新闻")).toMatchObject({ agentIntents: [], intents: [{ action: { id: "finance-news-feed/news" } }] });
    store.setAgentIntent({ ...config, enabled: true });
    expect(runs.list()).toHaveLength(0);
    expect(store.listRuns()).toHaveLength(0);
    for (const body of [{ ...config, skills: ["missing"] }, { ...config, skills: ["../secret"] }, { ...config, agent: "news/missing" }]) {
      expect((await post("/api/shortcuts/agent-intents", body)).ok).toBe(false);
      expect(store.agentIntents()[0]?.skills).toEqual(["curate-news"]);
    }
    expect((await post("/api/agents/news/other/chat", { message: "查今天金融新闻", intentId: config.id, timezone: "Asia/Seoul" })).status).toBe(400);
    expect((await post("/api/agents/news/curator/chat", { message: "查今天金融新闻", intentId: config.id })).status).toBe(400);
    const res = await post("/api/agents/news/curator/chat", { message: "查今天金融新闻", intentId: config.id, timezone: "Asia/Seoul", permissionMode: "plan" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("查今天金融新闻");
    expect(text).toContain("SKILL_CONTENT_SENTINEL");
    expect(text).toContain("Asia/Seoul");
    expect(text).toContain("plan");
    const sid = sessions.list("news/curator")[0]!.sid;
    expect(sessions.intentContext("news/curator", sid)).toEqual({ id: config.id, timezone: "Asia/Seoul" });
    const followup = await post("/api/agents/news/curator/chat", { message: "展开第二条", sessionId: sid });
    expect(await followup.text()).toContain("SKILL_CONTENT_SENTINEL");
    const nextSid = sessions.list("news/curator")[0]!.sid;
    expect(sessions.intentContext("news/curator", nextSid)?.id).toBe(config.id);
    expect(runs.list().every((r) => r.agent === "news/curator")).toBe(true);
    expect((await post("/api/shortcuts/agent-intents", { ...config, enabled: false })).status).toBe(200);
    expect((await post("/api/agents/news/curator/chat", { message: "again", sessionId: nextSid })).status).toBe(404);
    expect(runs.list()).toHaveLength(2);
  } finally { server.stop(true); store.close(); db.close(); await rm(home, { recursive: true, force: true }); }
});

test("skill loading refuses traversal and symlinks outside the app", async () => {
  const home = await mkdtemp(join(tmpdir(), "skill-boundary-"));
  const dir = join(home, "app");
  await mkdir(join(dir, "skills", "escape"), { recursive: true });
  await Bun.write(join(home, "secret.md"), "not a skill");
  await symlink(join(home, "secret.md"), join(dir, "skills", "escape", "SKILL.md"));
  try {
    await expect(skillContext(dir, ["../secret"])).rejects.toThrow(/Invalid/);
    await expect(skillContext(dir, ["escape"])).rejects.toThrow(/outside/);
    await expect(skillContext(dir, ["missing"])).rejects.toThrow(/Missing/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
