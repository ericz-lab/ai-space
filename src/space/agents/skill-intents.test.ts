import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRegistry } from "../panel/registry.ts";
import { LayoutStore } from "../panel/layout.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { loadManifest } from "../scheduler/manifest.ts";
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
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createAgentRoutes({ ws, registry, layout: new LayoutStore(db), sessions, runs, runtimes: claudeOnly(["bun", cli]), shortcuts: store }) });
  const post = (path: string, body: unknown) => fetch(new URL(path, server.url), { method: "POST", body: JSON.stringify(body) });
  const config = { id: "financial-news", title: "Financial news", agent: "news/curator", skills: ["curate-news"], patterns: ["查{period}金融新闻"] };
  try {
    expect((await post("/api/shortcuts/agent-intents", config)).status).toBe(200);
    const catalogue = await (await fetch(new URL("/api/shortcuts/agent-intents", server.url))).json();
    expect(catalogue.intents[0]).toMatchObject({ id: config.id, available: true });
    expect(runs.list()).toHaveLength(0);
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
