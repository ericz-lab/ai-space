import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppRegistry } from "../panel/registry.ts";
import { LayoutStore } from "../panel/layout.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { agentSkillsPrompt, resolveAgentSkills, skillMeta } from "../skills.ts";
import { createAgentRoutes } from "./api.ts";
import { RunRegistry } from "./runs.ts";
import { SessionStore } from "./sessions.ts";

const skill = (dir: string, name: string, description: string) => Bun.write(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${description}"\n---\n# ${name}\n`);

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "space-app-agents-"));
  const ws = workspacePaths(home);
  const shared = join(home, "core", "skills");
  await skill(shared, "notify", "Send a notification");
  const board = join(ws.apps, "board");
  await skill(join(board, "skills"), "board-edit", "Edit the board");
  await skill(join(board, "skills"), "board-read", "Read the board");
  const news = join(ws.apps, "news");
  await skill(join(news, ".claude", "skills"), "news-search", "Search the news");
  await mkdir(join(ws.apps, "other"), { recursive: true });
  await Bun.write(join(board, "space.yaml"), "name: board\nagents:\n  - { name: analyst, skills: [./skills, news:news-search, space:notify, news:gone, ../news/skills] }\n");
  await Bun.write(join(news, "space.yaml"), "name: news\n");
  await Bun.write(join(ws.apps, "other", "space.yaml"), "name: other\nagents:\n  - { name: helper }\n");
  return { home, ws, shared, board, news };
}

test("frontmatter gives a skill's name and description", () => {
  expect(skillMeta(`---\nname: a\ndescription: "Does b: c"\n---\nbody`, "x")).toEqual({ name: "a", description: "Does b: c" });
  expect(skillMeta("# no frontmatter", "dir")).toEqual({ name: "dir", description: "" });
});

test("an agent's skills resolve from its app, shared skills and other apps; the rest is reported missing", async () => {
  const f = await fixture();
  try {
    const registry = new AppRegistry();
    for (const d of [f.board, f.news]) await registry.set(await loadManifest(d));
    const r = await resolveAgentSkills(["./skills", "news:news-search", "space:notify", "news:gone", "../news/skills", "nobody:x", "space:../x"], {
      app: "board", appDir: f.board, shared: f.shared, appDirOf: (a) => registry.get(a)?.manifest.dir,
    });
    expect(r.skills.map((s) => `${s.owner}/${s.name}`)).toEqual(["board/board-edit", "board/board-read", "news/news-search", "space/notify"]);
    expect(r.missing).toEqual(["news:gone", "../news/skills", "nobody:x", "space:../x"]);
    const prompt = agentSkillsPrompt(r);
    expect(prompt).toContain("- news-search (news): Search the news");
    expect(prompt).toContain(join(f.news, ".claude", "skills", "news-search", "SKILL.md"));
    expect(prompt).toContain("Not available on this space: news:gone");
    expect(agentSkillsPrompt({ skills: [], missing: [] })).toBe("");
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test("an app's token runs its own agent with its skills in the prompt, and nobody else's", async () => {
  const f = await fixture();
  const cli = join(f.home, "fake.ts");
  await Bun.write(cli, `const args=process.argv.slice(2); const sid=crypto.randomUUID();
console.log(JSON.stringify({type:"system",subtype:"init",session_id:sid}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:args[args.indexOf("--append-system-prompt")+1]}]}}));
console.log(JSON.stringify({type:"result",session_id:sid,is_error:false}));`);
  const registry = new AppRegistry();
  for (const d of [f.board, f.news, join(f.ws.apps, "other")]) await registry.set(await loadManifest(d));
  const db = new Database(":memory:");
  const tokens: Record<string, string> = { "tok-board": "board", "tok-other": "other" };
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    routes: createAgentRoutes({
      ws: f.ws, registry, layout: new LayoutStore(db), sessions: new SessionStore(db), runs: new RunRegistry(db), runtimes: claudeOnly(["bun", cli]), sharedSkills: f.shared,
      callerApp: async (req) => {
        const t = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        return t ? tokens[t] ?? "" : null;
      },
    }),
  });
  const chat = (agent: string, token?: string) => fetch(new URL(`/api/agents/${agent}/chat`, server.url), { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify({ message: "hi" }) });
  try {
    const own = await chat("board/analyst", "tok-board");
    expect(own.status).toBe(200);
    const text = await own.text();
    expect(text).toContain("--- Skills ---");
    expect(text).toContain("board-edit (board)");
    expect(text).toContain("news-search (news)");
    expect((await chat("other/helper", "tok-board")).status).toBe(403);
    expect((await chat("board/analyst", "tok-other")).status).toBe(403);
    expect((await chat("board/analyst", "not-an-app")).status).toBe(403);
    expect((await chat("other/helper")).status).toBe(200); // the owner
    const runs = await fetch(new URL("/api/agents/runs", server.url), { headers: { authorization: "Bearer tok-board" } });
    expect(runs.status).toBe(403);
  } finally {
    server.stop(true);
    await rm(f.home, { recursive: true, force: true });
  }
});
