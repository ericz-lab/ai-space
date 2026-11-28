import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentRoutes } from "../agents/api.ts";
import { RunRegistry } from "../agents/runs.ts";
import { SessionStore } from "../agents/sessions.ts";
import { Bus } from "../bus/bus.ts";
import { createBusRoutes } from "../bus/api.ts";
import { SPACE_BUS_SPEC } from "../bus/builtin.ts";
import { BusStore } from "../bus/store.ts";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { claudeOnly } from "../runtimes/registry.ts";
import { fakeLiveBin } from "../runtimes/testing-live.ts";
import { Store } from "../scheduler/store.ts";
import { TeamStore } from "../team/store.ts";
import { removeTemp } from "../testing.ts";
import { workspacePaths } from "../workspace.ts";
import { captureHandler } from "./api.ts";
import { DIRECTOR_ID, OrdersService } from "./service.ts";
import { OrdersStore } from "./store.ts";

/**
 * The orders service on the real chat route (`/api/agents/space/director/chat`), the Director's
 * turns run by the stand-in of Claude Code's live protocol (runtimes/testing-live.ts): what a turn
 * is started with, and what the service makes of its events. Then the capture target on the real
 * capture routes, and the team route.
 */

let home = "";
let db: Database;
let runs: RunRegistry;
let sessions: SessionStore;
let team: TeamStore;
let store: OrdersStore;
let service: OrdersService;
let server: ReturnType<typeof Bun.serve>;
let base = "";
const runtimes = claudeOnly(fakeLiveBin("claude"));
const events: { name: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "space-orders-")));
  await mkdir(workspacePaths(home).apps, { recursive: true });
  db = new Database(":memory:");
  runs = new RunRegistry(db);
  sessions = new SessionStore(db, 2);
  team = new TeamStore(db);
  store = new OrdersStore(db, { dataDir: join(home, "data") });
  sessions.exempt((agent) => (agent === DIRECTOR_ID ? store.pinnedSessions() : []));
  const routes = createAgentRoutes({ ws: workspacePaths(home), registry: new AppRegistry(), layout: new LayoutStore(db), sessions, runtimes, runs, teamModel: (agent) => team.byAgent(agent)?.model });
  const chat = (routes["/api/agents/:app/:agent/chat"] as { POST: (r: Request & { params: Record<string, string> }) => Promise<Response> }).POST;
  let n = 0;
  service = new OrdersService({
    store,
    team,
    runs,
    chat,
    // The sorting: an order starting with "and " continues the newest offered topic; any other opens one.
    decide: async (prompt) => {
      const order = prompt.split("\n")[1] ?? "";
      const ids = [...prompt.matchAll(/^Topic (\d+):/gm)].map((m) => Number(m[1]));
      return !order.startsWith("and ") || !ids.length ? JSON.stringify({ new: `Topic ${++n}` }) : JSON.stringify({ continue: ids[0] });
    },
    publish: (name, data) => events.push({ name, data }),
    log: () => {},
  });
  service.start();
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  service.stop();
  server.stop(true);
  runtimes.closeLive();
  removeTemp(home);
});

const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  expect(cond()).toBe(true);
};
/** The lines of a run so far (the live copy keeps them all). */
const linesOf = (id: string) => {
  const lines: string[] = [];
  runs.subscribe(id, 0, { onEvent: (e) => lines.push(e.line), onEnd: () => {} })?.();
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
};
const init = (id: string) => linesOf(id).find((l) => l.type === "system" && l.subtype === "init") as { permissionMode?: string } | undefined;
const said = (id: string) => linesOf(id).flatMap((l) => (l.type === "assistant" ? ((l.message as { content: { type: string; text?: string }[] }).content ?? []).filter((c) => c.type === "text").map((c) => c.text!) : []));

describe("the Director on the chat route", () => {
  test("is listed beside the Space Assistant and the Fix Engineer", async () => {
    const r = (await (await fetch(`${base}/api/agents`)).json()) as { agents: { id: string; title: string; i18n?: { zh?: { title?: string } } }[] };
    expect(r.agents.find((a) => a.id === "space/director")).toMatchObject({ title: "Director", i18n: { zh: { title: "总管" } } });
  });

  test("an order starts an interactive turn with its words and screenshot; the team's permission sets the mode", async () => {
    team.update("director", { permission: "full" });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    await service.submit({ clientId: crypto.randomUUID(), text: "look at this", via: "screenshot", image: { bytes: png } });
    await until(() => !!store.get(1)?.runId);
    const runId = store.get(1)!.runId!;
    await until(() => runs.get(runId)?.status !== "running");
    expect(init(runId)?.permissionMode).toBe("bypassPermissions");
    // The stand-in echoes what it was sent: the order's block, then the picture.
    expect(said(runId)[0]).toMatch(/^echo: 〔Order #1 · with a screenshot · .+ · screenshot attached〕\nlook at this \[image\]/);
    await service.idle();
    expect(store.topic(1)).toMatchObject({ sessionId: "live-session", state: "done", runId });
    // The topic's session is kept past the retention of the Director's chat list (2 here).
    for (const sid of ["a", "b", "c"]) sessions.record(DIRECTOR_ID, `${sid}0000000-0000-4000-8000-000000000000`, undefined, sid);
    expect(sessions.list(DIRECTOR_ID).map((s) => s.sid)).toContain("live-session");
    expect(sessions.list(DIRECTOR_ID)).toHaveLength(3);
    team.update("director", { permission: "ask" });
  });

  test("an approval makes the topic need the person; answered, the turn ends done", async () => {
    await service.submit({ clientId: crypto.randomUUID(), text: "approve:rm old.log" });
    await until(() => store.topic(2)?.state === "needs-you");
    const runId = store.topic(2)!.runId!;
    expect(init(runId)?.permissionMode).toBe("default");
    expect(events.filter((e) => e.name === "order.state").map((e) => [(e.data.topic as { id: number }).id, e.data.state])).toContainEqual([2, "needs-you"]);
    const rid = linesOf(runId).find((l) => l.type === "approval_request")!.id as string;
    const r = await fetch(`${base}/api/agents/space/director/runs/${runId}/approvals/${encodeURIComponent(rid)}`, { method: "POST", body: JSON.stringify({ decision: "allow" }) });
    expect(r.status).toBe(200);
    await until(() => store.topic(2)?.state === "done");
  });

  test("an order for a turn that is still running is steered into it", async () => {
    await service.submit({ clientId: crypto.randomUUID(), text: "wait" });
    await until(() => !!store.topic(3)?.runId);
    const runId = store.topic(3)!.runId!;
    await until(() => linesOf(runId).some((l) => l.type === "assistant"));
    await service.submit({ clientId: crypto.randomUUID(), text: "and the second thing" });
    await until(() => runs.get(runId)?.status !== "running");
    expect(said(runId).some((s) => s.startsWith("heard: ") && s.includes("and the second thing"))).toBe(true);
    await service.idle();
    expect(store.ofTopic(3).map((o) => o.runId)).toEqual([runId, runId]);
  });
});

describe("the capture target space/order", () => {
  const busStore = new BusStore(":memory:");
  const bus = new Bus({ store: busStore, events: new Store(":memory:"), servicePort: (a) => (a === "ai-spark" ? spark.port : undefined), log: () => {} });
  const forwarded: { path: string; caller: string | null; body: string }[] = [];
  const peer = {
    name: "david",
    knownDown: () => false,
    snapshot: { asOf: "2026-11-26T00:00:00.000Z" },
    forward: async (req: Request, path: string, o?: { headers?: Record<string, string> }) => {
      forwarded.push({ path, caller: o?.headers?.["x-space-caller"] ?? null, body: await req.text() });
      return Response.json({ ok: true, url: "/#order=7", label: "Order #7" });
    },
  };
  // The hub's view of a peer that runs this version: its own `space` entry, named `david/space`.
  const remote = {
    name: "seoul",
    capabilities: () => [{ app: "david/space", peer: "david", health: "ok" as const, provides: SPACE_BUS_SPEC.provides!, publishes: SPACE_BUS_SPEC.events!.publishes, consumes: [] }],
    providerOf: () => undefined,
    get: (n: string) => (n === "david" ? peer : undefined),
  };
  let spark: ReturnType<typeof Bun.serve>;
  let s: ReturnType<typeof Bun.serve>;
  let url = "";
  beforeAll(() => {
    spark = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ok: true, at: "spark" }) });
    bus.syncApp("ai-spark", { events: { publishes: [], consumes: [] }, provides: [{ name: "capture-image", method: "POST", path: "/spark", timeoutMs: 5000, capture: { kinds: ["image"], title: "Spark" } }] });
    bus.syncBuiltin("space", SPACE_BUS_SPEC, { order: captureHandler(service) });
    s = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createBusRoutes({ bus, store: busStore, events: new Store(":memory:"), token: "op", remote }) });
    url = `http://127.0.0.1:${s.port}`;
  });
  afterAll(() => {
    s.stop(true);
    spark.stop(true);
  });
  const jpeg = () => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2])], "shot.jpg", { type: "image/jpeg" });

  test("listed for words and pictures, here and as the peer's; its events in the catalogue", async () => {
    const list = (await (await fetch(`${url}/api/capture`)).json()) as { targets: Record<string, unknown>[]; textTargets: { id: string }[] };
    expect(list.targets.map((t) => t.id)).toEqual(["ai-spark/capture-image", "space/order", "david/space/order"]);
    expect(list.targets.find((t) => t.id === "space/order")).toEqual({ id: "space/order", app: "space", capability: "order", title: "Orders", i18n: { zh: { title: "口谕" } }, kinds: ["text", "image"] });
    expect(list.textTargets.map((t) => t.id)).toEqual(["space/order", "david/space/order"]);
    const cat = (await (await fetch(`${url}/api/capabilities`)).json()) as { apps: { app: string; publishes: { name: string }[] }[] };
    expect(cat.apps.find((a) => a.app === "space")!.publishes.map((p) => p.name)).toEqual(["peer.renamed", "order.issued", "order.sorted", "order.state", "delegation.started", "delegation.noted", "delegation.ended"]);
  });

  test("words and a picture reach the orders in process, once per id; a peer's goes through the peer", async () => {
    const id = crypto.randomUUID();
    const post = () => fetch(`${url}/api/capture/text?to=space/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "  remind me at five  ", via: "voice", id }) });
    const first = (await (await post()).json()) as { url: string; label: string };
    expect(first).toEqual({ ok: true, url: expect.stringMatching(/^\/#order=\d+$/), label: expect.stringMatching(/^Order #\d+$/) } as never);
    expect(await (await post()).json()).toEqual(first as never);
    expect(store.byClientId(id)).toMatchObject({ text: "remind me at five", via: "voice" });
    const form = new FormData();
    form.append("file", jpeg());
    form.append("text", "what is this");
    form.append("via", "screenshot");
    form.append("id", crypto.randomUUID());
    const img = await fetch(`${url}/api/capture/image?to=space/order`, { method: "POST", body: form });
    expect(img.status).toBe(200);
    const shot = store.byClientId(form.get("id") as string)!;
    expect(shot).toMatchObject({ imageMime: "image/jpeg", via: "screenshot", text: "what is this" });
    // Without words, a picture is refused; the legacy route without `to` still reaches Spark.
    const bare = new FormData();
    bare.append("file", jpeg());
    bare.append("id", crypto.randomUUID());
    expect((await fetch(`${url}/api/capture/image?to=space/order`, { method: "POST", body: bare })).status).toBe(400);
    const legacy = new FormData();
    legacy.append("file", jpeg());
    expect(await (await fetch(`${url}/api/capture/image`, { method: "POST", body: legacy })).json()).toEqual({ ok: true, at: "spark" });
    // The peer's target: forwarded as this space's operator.
    const remoteId = crypto.randomUUID();
    const there = await fetch(`${url}/api/capture/text?to=david/space/order`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "for david", id: remoteId }) });
    expect(await there.json()).toEqual({ ok: true, url: "/#order=7", label: "Order #7" });
    expect(forwarded.pop()).toEqual({ path: "/api/peer/call/space/order", caller: "seoul/space", body: JSON.stringify({ text: "for david", id: remoteId }) });
    expect(busStore.listCalls({}).filter((c) => c.app === "space").map((c) => [c.caller, c.capability, c.status])).toEqual([["space", "order", 400], ["space", "order", 200], ["space", "order", 200], ["space", "order", 200]]);
    await service.idle();
  });

  test("an app calling the capability itself is refused", async () => {
    const r = await bus.call("notes", "space", "order", { contentType: "application/json", body: JSON.stringify({ text: "x", id: crypto.randomUUID() }) });
    expect(r.status).toBe(403);
  });
});
