import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { chatArgs } from "../runtimes/claude-code.ts";
import { type RuntimeRegistry, claudeOnly } from "../runtimes/registry.ts";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { createAgentRoutes } from "./api.ts";
import { chatResponse } from "./runtime.ts";
import { SessionStore } from "./sessions.ts";
import { parseTranscript, transcriptPath } from "./transcript.ts";

// A stand-in for the claude CLI: prints its arguments back as stream-json events.
const FAKE_CLI = `
const args = process.argv.slice(2);
const msg = args[args.indexOf("-p") + 1] ?? "";
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "";
const sid = resume ? "cafe0002-0000-4000-8000-000000000000" : "cafe0001-0000-4000-8000-000000000000";
const out = (o) => console.log(JSON.stringify(o));
if (msg === "crash") { console.error("boom"); process.exit(3); }
if (msg === "slow") await new Promise((r) => setTimeout(r, 250));
out({ type: "system", subtype: "init", session_id: sid, model: "fake", cwd: process.cwd() });
out({ type: "assistant", message: { content: [{ type: "text", text: "echo " + msg + " | " + args.slice(2).filter((a) => a.startsWith("--")).join(" ") + " | prompt=" + (args[args.indexOf("--append-system-prompt") + 1] ?? "").slice(0, 40) + " | cwd=" + process.cwd() }] } });
out({ type: "result", session_id: sid, is_error: false });
`;

let server: ReturnType<typeof Bun.serve>;
let base = "";
let home = "";
let appDir = "";
let runtimes: RuntimeRegistry;
const sessions = new SessionStore(new Database(":memory:"));

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "space-agents-")));
  const ws = workspacePaths(home);
  appDir = join(ws.apps, "notes");
  await mkdir(join(appDir, "agents"), { recursive: true });
  await writeFile(join(appDir, "space.yaml"), "name: notes\ntitle: Notes\ndescription: Personal notes.\nagents:\n  - { name: librarian, prompt: agents/librarian.md, tools: [Read, Grep], model: haiku }\n  - { name: coder, runtime: codex }\n");
  await writeFile(join(appDir, "agents", "librarian.md"), "You are the librarian.");
  await writeFile(join(appDir, "AGENTS.md"), "# Notes\nRead this first.");
  await writeFile(join(home, "fake-claude.js"), FAKE_CLI);
  runtimes = claudeOnly(["bun", join(home, "fake-claude.js")], { chatArgs: ["--extra"] });
  const registry = new AppRegistry();
  await registry.set(await loadManifest(appDir));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    routes: createAgentRoutes({ ws, registry, layout: new LayoutStore(new Database(":memory:")), sessions, runtimes, defaultModel: "sonnet", home }),
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const events = async (r: Response) =>
  (await r.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

describe("chat runtime", () => {
  test("chatArgs builds the claude command line", () => {
    expect(chatArgs({ message: "hi", cwd: "/x" })).toEqual(["-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
    expect(chatArgs({ message: "hi", cwd: "/x", model: "opus", sessionId: "abc12345", permissionMode: "acceptEdits", systemPrompt: "S", allowedTools: ["Read", "Bash(ls *)"] }, ["--z"])).toEqual([
      "-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", "opus", "--resume", "abc12345", "--permission-mode", "acceptEdits", "--append-system-prompt", "S", "--allowedTools", "Read,Bash(ls *)", "--z",
    ]);
    expect(chatArgs({ message: "hi", cwd: "/x", permissionMode: "root" })).not.toContain("--permission-mode");
  });
});

describe("agents api", () => {
  test("lists the space agent and the apps' agents", async () => {
    const r = (await (await fetch(`${base}/api/agents`)).json()) as { agents: { id: string }[] };
    expect(r.agents.map((a) => a.id)).toEqual(["notes/coder", "notes/librarian", "space/assistant"]);
  });

  test("streams a turn with the manifest identity and records the session", async () => {
    const r = await post("/api/agents/notes/librarian/chat", { message: "hello", permissionMode: "acceptEdits" });
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    const ev = await events(r);
    expect(ev[0]).toMatchObject({ type: "system", session_id: "cafe0001-0000-4000-8000-000000000000" });
    const text = String((ev[1] as { message: { content: { text: string }[] } }).message.content[0]!.text);
    expect(text).toContain("--model --permission-mode --append-system-prompt --allowedTools --extra");
    expect(text).toContain("prompt=You are the librarian.");
    expect(text).toContain(`cwd=${appDir}`);
    expect(ev.at(-1)).toEqual({ type: "done" });
    expect(sessions.list("notes/librarian")).toMatchObject([{ sid: "cafe0001-0000-4000-8000-000000000000", title: "hello" }]);

    // Resuming keeps one row and its title.
    await events(await post("/api/agents/notes/librarian/chat", { message: "again", sessionId: "cafe0001-0000-4000-8000-000000000000" }));
    expect(sessions.list("notes/librarian")).toMatchObject([{ sid: "cafe0002-0000-4000-8000-000000000000", title: "hello" }]);
  });

  test("space agent runs in the workspace root without an allow-list", async () => {
    const ev = await events(await post("/api/agents/space/assistant/chat", { message: "hi" }));
    const text = String((ev[1] as { message: { content: { text: string }[] } }).message.content[0]!.text);
    expect(text).toContain(`cwd=${home}`);
    expect(text).not.toContain("--allowedTools");
    expect(text).toContain("--model");
  });

  test("keeps the stream alive with comment lines during a long tool call", async () => {
    const r = chatResponse(runtimes.default, { message: "slow", cwd: home }, {}, { heartbeatMs: 40 });
    const text = await r.text();
    expect(text.split(": keepalive\n\n").length).toBeGreaterThan(2);
    expect(text.trim().endsWith('data: {"type":"done"}')).toBe(true);
    // The browser's parser only reads `data:` lines; a comment never reaches it as an event.
    expect(text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)).type)).toEqual(["system", "assistant", "result", "done"]);
  });

  test("reports a runtime failure as an error event", async () => {
    const ev = await events(await post("/api/agents/notes/librarian/chat", { message: "crash" }));
    expect(ev.find((e) => e.type === "error")).toMatchObject({ error: expect.stringContaining("boom") });
    expect(ev.at(-1)).toEqual({ type: "done" });
  });

  test("validates input and refuses runtimes the space lacks", async () => {
    expect((await post("/api/agents/notes/librarian/chat", { message: " " })).status).toBe(400);
    expect((await post("/api/agents/notes/nobody/chat", { message: "x" })).status).toBe(404);
    expect((await post("/api/agents/notes/coder/chat", { message: "x" })).status).toBe(501);
  });

  test("session list and transcript routes", async () => {
    const list = (await (await fetch(`${base}/api/agents/notes/librarian/sessions`)).json()) as { sessions: unknown[] };
    expect(list.sessions).toHaveLength(1);
    expect((await fetch(`${base}/api/agents/notes/librarian/sessions/not-a-sid!`)).status).toBe(400);
    expect((await fetch(`${base}/api/agents/notes/librarian/sessions/cafe0009-0000-4000-8000-000000000000`)).status).toBe(404);
    const sid = "cafe0002-0000-4000-8000-000000000000";
    const file = transcriptPath(appDir, sid, home);
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, [JSON.stringify({ type: "user", message: { content: "hello" } }), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })].join("\n"));
    const t = (await (await fetch(`${base}/api/agents/notes/librarian/sessions/${sid}`)).json()) as { messages: unknown[] };
    expect(t.messages).toEqual([
      { role: "user", text: "hello" },
      { role: "ai", text: "hi", tools: [] },
    ]);
  });
});

describe("transcript", () => {
  test("parseTranscript merges assistant blocks and skips framework messages", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "<command-name>x</command-name>" } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "read it" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a/b.md" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "..." }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } }),
      "not json",
    ];
    expect(parseTranscript(lines.join("\n"))).toEqual([
      { role: "user", text: "read it" },
      { role: "ai", text: "done", tools: [{ name: "Read", hint: "/a/b.md" }] },
    ]);
  });
});

describe("Base runtime selection", () => {
  test("advertises tiers, resolves both runtimes, and resumes using the recorded runtime", async () => {
    const { RuntimeRegistry } = await import("../runtimes/registry.ts");
    const { fakeCodexBin } = await import("../runtimes/testing-codex.ts");
    const configured = new RuntimeRegistry({ default: "claude", runtimes: [
      { name: "claude", kind: "claude-code", bin: ["bun", join(home, "fake-claude.js")], chatArgs: [] },
      { name: "codex", kind: "codex-cli", bin: fakeCodexBin() },
    ] });
    const store = new SessionStore(new Database(":memory:"));
    const registry = new AppRegistry();
    await registry.set(await loadManifest(appDir));
    const local = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createAgentRoutes({ ws: workspacePaths(home), registry, layout: new LayoutStore(new Database(":memory:")), sessions: store, runtimes: configured }) });
    const url = `http://127.0.0.1:${local.port}`;
    const chat = (body: unknown, app = "space/assistant") => fetch(`${url}/api/agents/${app}/chat`, { method: "POST", body: JSON.stringify(body) });
    try {
      const list = await (await fetch(`${url}/api/agents`)).json() as { agents: { id: string; modelOptions?: { value: string }[] }[] };
      expect(list.agents.find((a) => a.id === "space/assistant")!.modelOptions).toHaveLength(8);
      for (const runtime of ["claude", "codex"]) {
        for (const tier of ["basic", "junior", "intermediate", "advanced"]) {
          const result = await events(await chat({ message: "hello", model: `${runtime}/${tier}` }));
          expect(result.some((e) => e.type === "error")).toBe(false);
          const session = store.list("space/assistant").find((s) => s.runtime === runtime)!;
          expect(session.model).toBe(configured.resolve(`${runtime}/${tier}`).model);
        }
      }
      const session = store.list("space/assistant").find((s) => s.runtime === "codex")!;
      const resumed = await events(await chat({ message: "again", sessionId: session.sid }));
      const answer = JSON.parse((resumed.filter((e) => e.type === "assistant").at(-1)!.message as { content: { text: string }[] }).content[0]!.text);
      expect(answer.args).toContain("resume");
      expect(answer.args).toContain("gpt-6-astra");
      expect((await chat({ message: "x", sessionId: session.sid, model: "claude/basic" })).status).toBe(400);
      expect((await chat({ message: "x", model: "missing/basic" })).status).toBe(501);
      expect((await chat({ message: "x", model: "codex/invalid/model" })).status).toBe(400);
      expect((await chat({ message: "x", model: "codex/basic" }, "notes/librarian")).status).toBe(400);
      configured.get("codex")!.transcript = async () => [{ role: "user", text: "Codex transcript" }];
      const transcript = await (await fetch(`${url}/api/agents/space/assistant/sessions/${session.sid}`)).json();
      expect(transcript).toMatchObject({ messages: [{ text: "Codex transcript" }] });
    } finally { local.stop(true); }
  });

  test("migrates existing session rows without losing history", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE chat_sessions (agent TEXT, sid TEXT, title TEXT, ts INTEGER, PRIMARY KEY(agent, sid)); INSERT INTO chat_sessions VALUES ('space/assistant', 'old-session', 'Existing chat', 1)");
    const store = new SessionStore(db);
    expect(store.get("space/assistant", "old-session")).toMatchObject({ title: "Existing chat", runtime: null, model: null });
    store.record("space/assistant", "new-session", "old-session", "new title", "claude", "sonnet");
    expect(store.list("space/assistant")).toMatchObject([{ sid: "new-session", title: "Existing chat", runtime: "claude", model: "sonnet" }]);
    expect(store.list("space/assistant")).toHaveLength(1);
    db.close();
  });
});

test("Codex-only Base ignores legacy Claude defaults and honors qualified defaults", async () => {
  const { RuntimeRegistry } = await import("../runtimes/registry.ts");
  const { fakeCodexBin } = await import("../runtimes/testing-codex.ts");
  for (const defaultModel of ["sonnet", "codex/basic"]) {
    const configured = new RuntimeRegistry({ default: "codex", runtimes: [{ name: "codex", kind: "codex-cli", bin: fakeCodexBin() }] });
    const store = new SessionStore(new Database(":memory:"));
    const local = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createAgentRoutes({ ws: workspacePaths(home), registry: new AppRegistry(), layout: new LayoutStore(new Database(":memory:")), sessions: store, runtimes: configured, defaultModel }) });
    try {
      const result = await events(await fetch(`http://127.0.0.1:${local.port}/api/agents/space/assistant/chat`, { method: "POST", body: JSON.stringify({ message: "hello" }) }));
      expect(result.some((e) => e.type === "error")).toBe(false);
      expect(store.list("space/assistant")[0]).toMatchObject({ runtime: "codex", model: defaultModel === "sonnet" ? "gpt-6-sol" : "gpt-6-luna" });
    } finally { local.stop(true); }
  }
});

test("Base reads the live default for new chats but retains a resumed session's model", async () => {
  const { RuntimeRegistry } = await import("../runtimes/registry.ts");
  const { fakeCodexBin } = await import("../runtimes/testing-codex.ts");
  const configured = new RuntimeRegistry({ default: "claude", runtimes: [
    { name: "claude", kind: "claude-code", bin: ["bun", join(home, "fake-claude.js")], chatArgs: [] },
    { name: "codex", kind: "codex-cli", bin: fakeCodexBin() },
  ] });
  const db = new Database(":memory:");
  const store = new SessionStore(db);
  let preference = "claude/basic";
  const local = Bun.serve({ port: 0, routes: createAgentRoutes({ ws: workspacePaths(home), registry: new AppRegistry(), layout: new LayoutStore(db), sessions: store, runtimes: configured, baseDefaultModel: () => preference }) });
  const url = `http://localhost:${local.port}`;
  const chat = async (body: unknown) => {
    const response = await fetch(`${url}/api/agents/space/assistant/chat`, { method: "POST", body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    await response.text();
  };
  try {
    await chat({ message: "first" });
    const first = store.list("space/assistant")[0]!;
    expect(first).toMatchObject({ runtime: "claude", model: "haiku" });
    preference = "codex/advanced";
    const list = await (await fetch(`${url}/api/agents`)).json();
    expect(list.agents[0].runtime).toBe("codex");
    await chat({ message: "continue", sessionId: first.sid });
    expect(store.list("space/assistant").find((s) => s.model === "haiku")).toBeDefined();
    await chat({ message: "new" });
    expect(store.list("space/assistant")[0]).toMatchObject({ runtime: "codex", model: "gpt-6-astra" });
  } finally { local.stop(true); db.close(); }
});
