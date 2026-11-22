import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { clipOutput } from "../runtimes/tool-text.ts";
import { claudeProjectDir } from "../runtimes/transcripts.ts";
import { loadManifest } from "../scheduler/manifest.ts";
import { workspacePaths } from "../workspace.ts";
import { createAgentRoutes } from "./api.ts";
import { CHANGES_NOTE_PREFIX, extractCards, parseCard, transcriptCards, withoutChangesNote } from "./cards.ts";
import { RunRegistry } from "./runs.ts";
import { SessionStore } from "./sessions.ts";

const card = (extra: Record<string, unknown> = {}) => ({ v: 1, kind: "receipt", title: "Added 2 todos", items: [{ id: "128", title: "Write the report", detail: "tomorrow 15:00", url: "/?todo=128", version: 1 }, { id: 129, title: "Call Ann", version: 1 }], state: "card-state", actions: { undo: "card-undo" }, ...extra });
const cardLine = (c: unknown = card()) => `::space-card ${JSON.stringify(c)}`;

describe("card lines", () => {
  test("a card that keeps the rules passes, numbers as ids become strings, unknown actions are left out", () => {
    const c = parseCard(card({ actions: { undo: "card-undo", edit: "card-edit" } }));
    expect(c).toEqual({ v: 1, kind: "receipt", title: "Added 2 todos", items: [{ id: "128", title: "Write the report", detail: "tomorrow 15:00", url: "/?todo=128", version: 1 }, { id: "129", title: "Call Ann", version: 1 }], state: "card-state", actions: { undo: "card-undo" } });
  });

  test("a card that breaks a rule is dropped whole", () => {
    expect(parseCard(card({ v: 2 }))).toBeNull();
    expect(parseCard(card({ kind: "draft" }))).toBeNull();
    expect(parseCard(card({ items: [] }))).toBeNull();
    expect(parseCard(card({ items: Array.from({ length: 21 }, (_, i) => ({ id: String(i), title: "x" })) }))).toBeNull();
    expect(parseCard(card({ items: [{ id: "1", title: "x", url: "javascript:alert(1)" }] }))).toBeNull();
    expect(parseCard(card({ items: [{ id: "1", title: "x", url: "//evil.example" }] }))).toBeNull();
    expect(parseCard(card({ items: [{ id: "1", title: "x" }, { id: "1", title: "y" }] }))).toBeNull();
    expect(parseCard(card({ state: "ai-todo/card-state" }))).toBeNull();
    expect(parseCard(card({ kind: "list" }))).toBeNull(); // a list card has no actions
    expect(parseCard({ v: 1, kind: "list", items: [{ id: "1", title: "x" }] })).not.toBeNull();
    expect(parseCard({ v: 1, kind: "value", text: "42 °C" })).toEqual({ v: 1, kind: "value", items: [], text: "42 °C" });
  });

  test("card lines leave the output, at most four cards, a line too long or not JSON is dropped", () => {
    const out = ["#128\topen\tWrite the report", cardLine(), "::space-card {not json", `::space-card ${"x".repeat(17_000)}`, cardLine(), cardLine(), cardLine(), cardLine(), "done"].join("\n");
    const r = extractCards(out);
    expect(r.text).toBe("#128\topen\tWrite the report\ndone");
    expect(r.cards).toHaveLength(4);
  });

  test("a clipped output keeps its card lines whole", () => {
    const out = `${"a".repeat(20_000)}\n${cardLine()}`;
    const clipped = clipOutput(out, 12_000);
    expect(clipped.length).toBeLessThan(13_000);
    expect(extractCards(clipped).cards).toHaveLength(1);
    expect(clipOutput("short", 12_000)).toBe("short");
  });

  test("a restored transcript: cards on the ai message, links resolved, lines out of the step", () => {
    const messages = transcriptCards([{ role: "user", text: "add" }, { role: "ai", text: "Done.", tools: [], steps: [{ kind: "tool", name: "Bash", input: "bun src/cli.ts add x", output: `#128\n${cardLine()}`, failed: false }] }], (url) => new URL(url, "https://todo.example.com/?lang=zh").toString());
    const ai = messages[1] as { cards?: { items: { url?: string }[] }[]; steps: { output: string }[] };
    expect(ai.steps[0]!.output).toBe("#128");
    expect(ai.cards?.[0]?.items[0]?.url).toBe("https://todo.example.com/?todo=128");
    expect(ai.cards?.[0]?.items[1]?.url).toBeUndefined();
  });

  test("the note before a message comes off again", () => {
    expect(withoutChangesNote(`${CHANGES_NOTE_PREFIX}Since your last reply the person undid these: x (#1).\n\nhello`)).toBe("hello");
    expect(withoutChangesNote("hello")).toBe("hello");
  });
});

// A claude CLI stand-in: `add` runs a tool whose output carries a card line; any other message is echoed back.
const FAKE_CLI = `
const args = process.argv.slice(2);
let msg = await new Response(Bun.stdin.stream()).text();
if (args.includes("--input-format")) msg = JSON.parse(msg).message.content.map((b) => b.text ?? "").join("");
const resume = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "";
const sid = resume || "cafe0001-0000-4000-8000-000000000000";
const out = (o) => console.log(JSON.stringify(o));
out({ type: "system", subtype: "init", session_id: sid, model: "fake" });
if (msg === "add") {
  const output = "#128\\topen\\tWrite the report\\n" + process.env.CARD_LINE;
  out({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun src/cli.ts add x" } }] } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: output }] }, tool_use_result: { stdout: output, stderr: "" } });
  out({ type: "assistant", message: { content: [{ type: "text", text: "Added." }] } });
} else {
  out({ type: "assistant", message: { content: [{ type: "text", text: "echo " + msg }] } });
}
out({ type: "result", session_id: sid, is_error: false });
`;

describe("cards in a chat", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let home = "";
  let appDir = "";
  const calls: { app: string; capability: string; body: unknown }[] = [];
  const removed = new Set<string>();

  beforeAll(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "space-cards-")));
    const ws = workspacePaths(home);
    appDir = join(ws.apps, "todo");
    await mkdir(appDir, { recursive: true });
    await writeFile(join(appDir, "space.yaml"), "name: todo\ntitle: Todo\nurl: https://todo.example.com/?lang={lang}\nagents:\n  - { name: planner, tools: [Bash] }\n");
    await writeFile(join(home, "fake-claude.js"), FAKE_CLI);
    process.env.CARD_LINE = cardLine();
    const registry = new AppRegistry();
    await registry.set(await loadManifest(appDir));
    const runs = new RunRegistry(new Database(":memory:"));
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: createAgentRoutes({
        ws,
        registry,
        layout: new LayoutStore(new Database(":memory:")),
        sessions: new SessionStore(new Database(":memory:")),
        runtimes: claudeOnly([process.execPath, join(home, "fake-claude.js")]),
        defaultModel: "sonnet",
        home,
        runs,
        cardCall: async (app, capability, body) => {
          const b = JSON.parse(body) as { ids?: string[]; items?: { id: string; version?: number }[] };
          calls.push({ app, capability, body: b });
          if (capability === "card-state") return { status: 200, body: JSON.stringify({ ok: true, items: (b.ids ?? []).map((id) => (removed.has(id) ? { id, status: "removed" } : { id, status: "active", title: `todo ${id}`, url: `/?todo=${id}`, version: 1 })) }) };
          for (const i of b.items ?? []) removed.add(i.id);
          return { status: 200, body: JSON.stringify({ ok: true, items: (b.items ?? []).map((i) => ({ id: i.id, status: "removed" })) }) };
        },
      }),
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop(true);
    delete process.env.CARD_LINE;
  });

  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const events = async (r: Response) =>
    (await r.text())
      .split("\n\n")
      .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => !!l)
      .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);

  let token = "";
  const sid = "cafe0001-0000-4000-8000-000000000000";

  test("a tool result's card line becomes a cards event with a token, and leaves every copy of the output", async () => {
    const r = await post("/api/agents/todo/planner/chat", { message: "add" });
    const runId = r.headers.get("x-run-id")!;
    const evs = await events(r);
    const result = evs.find((e) => e.type === "user")!;
    expect(JSON.stringify(result)).not.toContain("::space-card");
    expect(JSON.stringify(result)).toContain("Write the report");
    const at = evs.indexOf(result);
    const cards = evs[at + 1] as { type: string; cards: { items: { url?: string }[] }[]; token: string };
    expect(cards.type).toBe("cards");
    expect(cards.cards[0]!.items[0]!.url).toBe("https://todo.example.com/?todo=128");
    expect(cards.token).toMatch(/^[0-9a-f-]{36}$/);
    token = cards.token;
    // The replay from the finished run's memory copy still has it; a missed event is not a moved-on turn.
    const again = await events(await fetch(`${base}/api/agents/todo/planner/runs/${runId}/events`));
    expect(again.some((e) => e.type === "cards")).toBe(true);
  });

  test("state reads the card's items from its app as the space", async () => {
    const r = await post("/api/agents/cards/state", { agent: "todo/planner", card: card() });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { items: { id: string; status: string; url?: string }[] };
    expect(j.items.map((i) => i.status)).toEqual(["active", "active"]);
    expect(j.items[0]!.url).toBe("https://todo.example.com/?todo=128");
    expect(calls.at(-1)).toEqual({ app: "todo", capability: "card-state", body: { ids: ["128", "129"] } });
    expect((await post("/api/agents/cards/state", { agent: "space/assistant", card: card() })).status).toBe(400);
    expect((await post("/api/agents/cards/state", { agent: "todo/planner", card: card({ state: undefined }) })).status).toBe(400);
  });

  test("undo sends the ids and versions ai-space extracted, for the chosen items only", async () => {
    expect((await post("/api/agents/cards/action", { token: "nope", card: 0, action: "undo" })).status).toBe(409);
    expect((await post("/api/agents/cards/action", { token, card: 0, action: "edit" })).status).toBe(400);
    expect((await post("/api/agents/cards/action", { token, card: 0, action: "undo", items: ["999"] })).status).toBe(400);
    const r = await post("/api/agents/cards/action", { token, card: 0, action: "undo", items: ["128"] });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { items: unknown[] }).items).toEqual([{ id: "128", status: "removed" }]);
    expect(calls.at(-1)).toEqual({ app: "todo", capability: "card-undo", body: { items: [{ id: "128", version: 1 }] } });
  });

  test("the next message tells the agent what was undone, and the cards of the turn before become read-only", async () => {
    const evs = await events(await post("/api/agents/todo/planner/chat", { message: "hello", sessionId: sid }));
    const text = JSON.stringify(evs.find((e) => e.type === "assistant"));
    expect(text).toContain("undid these from the result cards: Write the report (#128).");
    expect(text).toContain("hello");
    const r = await post("/api/agents/cards/action", { token, card: 0, action: "undo", items: ["129"] });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { readOnly?: boolean }).readOnly).toBe(true);
  });

  test("a restored session carries the cards of its tool outputs, without a token, and the person's text without the note", async () => {
    const dir = join(home, ".claude", "projects", claudeProjectDir(appDir));
    await mkdir(dir, { recursive: true });
    const jsonl = [
      { type: "user", message: { content: `${CHANGES_NOTE_PREFIX}Since your last reply the person undid these from the result cards: x (#1).\n\nadd two` } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun src/cli.ts add x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: `#128\n${cardLine()}` }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "Added." }] } },
    ].map((l) => JSON.stringify(l)).join("\n");
    await writeFile(join(dir, `${sid}.jsonl`), jsonl);
    const j = (await (await fetch(`${base}/api/agents/todo/planner/sessions/${sid}`)).json()) as { messages: { role: string; text: string; cards?: unknown[]; steps?: { output: string }[] }[] };
    expect(j.messages[0]!.text).toBe("add two");
    const ai = j.messages[1]!;
    expect(ai.cards).toHaveLength(1);
    expect(JSON.stringify(ai)).not.toContain("token");
    expect(ai.steps![0]!.output).toBe("#128");
  });
});
