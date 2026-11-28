import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrdersService } from "../orders/service.ts";
import { OrdersStore } from "../orders/store.ts";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { fakeLiveBin } from "../runtimes/testing-live.ts";
import type { ChatTurn } from "../runtimes/types.ts";
import { TeamStore } from "../team/store.ts";
import { removeTemp } from "../testing.ts";
import { workspacePaths } from "../workspace.ts";
import { createAgentRoutes } from "./api.ts";
import { parseResultHeader, type DelegationView } from "./delegation-view.ts";
import { DelegationService, DelegationStore, MAX_RESULT_TURNS, RunTokens } from "./delegations.ts";
import { createDelegationRoutes } from "./delegations-api.ts";
import { RunRegistry } from "./runs.ts";
import { SessionStore } from "./sessions.ts";

/**
 * Delegation on the real routes (docs/orders.md#delegation): a Director turn and its delegates run
 * by the stand-ins of Claude Code's and Codex's live protocols (runtimes/testing-live.ts), and a
 * third runtime whose live handle takes no message while it runs. The Director's turn is started
 * through the chat route as the orders service and the panel start it; its run token comes from the
 * environment the turn was given.
 */

let home = "";
let db: Database;
let runs: RunRegistry;
let team: TeamStore;
let dstore: DelegationStore;
let service: DelegationService;
let orders: OrdersService;
let ordersStore: OrdersStore;
let tokens: RunTokens;
let sessions: SessionStore;
let server: ReturnType<typeof Bun.serve>;
let base = "";
const events: { name: string; data: Record<string, unknown> }[] = [];
const envs: { agent: string; runtime: string; session?: string; message: string; env: Record<string, string | undefined> }[] = [];
let ownerRefused = false;

const runtimes = new RuntimeRegistry({
  default: "claude",
  runtimes: [
    { name: "claude", kind: "claude-code", bin: fakeLiveBin("claude"), chatArgs: [] },
    { name: "codex", kind: "codex-cli", bin: fakeLiveBin("codex") },
    { name: "plain", kind: "claude-code", bin: fakeLiveBin("claude"), chatArgs: [] },
  ],
});
// Every turn's environment, to see who got a run token.
for (const name of ["claude", "codex", "plain"]) {
  const rt = runtimes.get(name)!;
  const chat = rt.chat.bind(rt);
  rt.chat = (turn: ChatTurn, cb) => {
    envs.push({ agent: String(turn.env?.SPACE_AGENT_ID), runtime: name, ...(turn.sessionId ? { session: turn.sessionId } : {}), message: turn.message, env: { ...turn.env } });
    const h = chat(turn, cb);
    // `plain`: a live turn that cannot take a message while it runs.
    return name === "plain" ? { kill: () => h.kill(), ...(h.respond ? { respond: h.respond.bind(h) } : {}) } : h;
  };
}

setDefaultTimeout(20_000);

beforeAll(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), "space-delegations-")));
  await mkdir(workspacePaths(home).apps, { recursive: true });
  db = new Database(":memory:");
  runs = new RunRegistry(db, { killGraceMs: 200 });
  sessions = new SessionStore(db);
  team = new TeamStore(db);
  tokens = new RunTokens(runs);
  ordersStore = new OrdersStore(db, { dataDir: join(home, "data") });
  const agentRoutes = createAgentRoutes({ ws: workspacePaths(home), registry: new AppRegistry(), layout: new LayoutStore(db), sessions, runtimes, runs, runTokens: tokens, apiUrl: "http://127.0.0.1:1", teamRoster: () => team.list(), teamModel: (a) => team.byAgent(a)?.model });
  const chat = (agentRoutes["/api/agents/:app/:agent/chat"] as { POST: (r: Request & { params: Record<string, string> }) => Promise<Response> }).POST;
  dstore = new DelegationStore(db);
  service = new DelegationService({
    store: dstore,
    team,
    runs,
    chat,
    agentExists: (id) => ["space/director", "space/engineer", "space/assistant"].includes(id),
    orders: {
      of: (session) => {
        const t = ordersStore.topicOfSession(session);
        return { topicId: t?.id ?? null, orderId: t ? (ordersStore.ofTopic(t.id).pop()?.id ?? null) : null };
      },
      image: async (orderId, session) => {
        const o = ordersStore.get(orderId);
        const t = o?.topicId != null ? ordersStore.topic(o.topicId) : undefined;
        if (!o?.imagePath || t?.sessionId !== session) return undefined;
        return { name: `order-${o.id}.png`, mediaType: o.imageMime!, data: Buffer.from(await Bun.file(o.imagePath).arrayBuffer()).toString("base64") };
      },
    },
    publish: (name, data) => events.push({ name, data }),
    log: () => {},
  });
  orders = new OrdersService({ store: ordersStore, team, runs, chat, delegations: service, decide: async () => JSON.stringify({ new: "A topic" }), log: () => {} });
  service.start();
  orders.start();
  const routes = { ...agentRoutes, ...createDelegationRoutes({ service, tokens, owner: async (req) => (ownerRefused || req.headers.get("x-app") ? Response.json({ ok: false, error: "not the owner" }, { status: 403 }) : undefined) }) };
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: routes as never });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  orders.stop();
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
const linesOf = (id: string) => {
  const lines: string[] = [];
  runs.subscribe(id, 0, { onEvent: (e) => lines.push(e.line), onEnd: () => {} })?.();
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
};
const said = (id: string) => linesOf(id).flatMap((l) => (l.type === "assistant" ? ((l.message as { content: { type: string; text?: string }[] }).content ?? []).filter((c) => c.type === "text").map((c) => c.text!) : []));
const sid = () => `dir-${crypto.randomUUID()}`;

/**
 * A Director turn on a session of its own, as the orders service or the panel starts one; its run and
 * its token. `plain` runs it on the runtime that takes no message while it runs: its turn goes on
 * when a result comes back (the stand-in ends a waiting turn on any message), so its token lives on.
 */
async function director(message: string, opts: { session?: string; plain?: boolean } = {}): Promise<{ runId: string; token: string; session: string }> {
  const session = opts.session ?? sid();
  // A conversation on another runtime than the default is one that already ran there.
  if (opts.plain) sessions.record("space/director", session, undefined, "t", "plain");
  const r = await fetch(`${base}/api/agents/space/director/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, sessionId: session, interactive: true, ...(opts.plain ? { model: "plain/intermediate" } : {}) }) });
  const runId = r.headers.get("x-run-id")!;
  void r.body?.cancel();
  await until(() => runs.get(runId)?.sid === session && envs.some((e) => e.session === session));
  return { runId, token: envs.find((e) => e.session === session)!.env.SPACE_RUN_TOKEN!, session };
}
const call = (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const start = async (token: string, body: Record<string, unknown>) => {
  const r = await call(token, "POST", "/api/delegations", body);
  return { status: r.status, body: (await r.json()) as { ok: boolean; delegation: DelegationView; error?: string; reason?: string } };
};
const view = (id: number) => service.view(id)!;

describe("the run token", () => {
  test("only a turn of the Director gets one, with the API's address; any other turn has none, whatever the process had", async () => {
    process.env.SPACE_RUN_TOKEN = "leaked";
    try {
      const d = await director("hello");
      expect(d.token).toMatch(/^srt_[0-9a-f]{48}$/);
      expect(envs.at(-1)!.env.SPACE_API_URL).toBe("http://127.0.0.1:1");
      const r = await call(null, "POST", "/api/agents/space/engineer/chat", { message: "hi", interactive: true });
      void r.body?.cancel();
      await until(() => envs.at(-1)!.agent === "space/engineer");
      expect(envs.at(-1)!.env.SPACE_RUN_TOKEN).toBeUndefined();
      // The token dies with its turn.
      await until(() => runs.get(d.runId)?.status === "done");
      const dead = await start(d.token, { to: "engineer", brief: "x" });
      expect(dead.status).toBe(401);
    } finally {
      delete process.env.SPACE_RUN_TOKEN;
    }
  });

  test("the routes take a delegation only from a run token; the owner reads and stops, an app is refused", async () => {
    expect((await call(null, "POST", "/api/delegations", { to: "engineer", brief: "x" })).status).toBe(403);
    expect((await call(null, "GET", "/api/delegations")).status).toBe(200);
    expect((await call(null, "GET", "/api/delegations", undefined, { "x-app": "notes" })).status).toBe(403);
    expect((await call("some-app-token", "GET", "/api/delegations", undefined, { "x-app": "notes" })).status).toBe(403);
  });
});

describe("start", () => {
  test("refuses what is not a member (another machine's agent that is not one too), a disabled member, itself and an empty brief", async () => {
    const d = await director("wait");
    for (const [body, status, reason] of [
      [{ to: "designer", brief: "x" }, 403, "not-member"],
      [{ to: "ai-design/designer", brief: "x" }, 403, "not-member"],
      [{ to: "david/space/engineer", brief: "x" }, 403, "not-member"],
      [{ to: "director", brief: "x" }, 400, "self"],
      [{ to: "engineer", brief: "  " }, 400, undefined],
    ] as const) {
      const r = await start(d.token, body);
      expect([r.status, r.body.reason]).toEqual([status, reason]);
    }
    team.update("engineer", { enabled: false });
    expect((await start(d.token, { to: "engineer", brief: "x" })).body.reason).toBe("disabled");
    team.update("engineer", { enabled: true });
    // A member whose agent left the Space.
    team.add({ role: "ghost", title: "Ghost", i18n: {}, agent: "gone/ghost", summary: "", model: null, permission: "ask", enabled: true });
    expect((await start(d.token, { to: "ghost", brief: "x" })).body.reason).toBe("removed");
    team.remove("ghost");
    runs.stop(d.runId);
  });

  test("runs the member with the brief and its permission; a message is taken and read; the result goes into the delegator's running turn", async () => {
    const d = await director("wait");
    const r = await start(d.token, { to: "engineer", brief: "Goal: fix the button.\nwait" });
    expect(r.status).toBe(201);
    const del = r.body.delegation;
    expect(del).toMatchObject({ label: `Delegation #${del.id}`, state: "running", permission: "edit", from: { agent: "space/director", session: d.session }, to: { agent: "space/engineer", role: "engineer", machine: "" } });
    const runId = del.to.runId!;
    await until(() => linesOf(runId).some((l) => l.type === "assistant"));
    // The member's permission mode, the brief under its header.
    expect(linesOf(runId).find((l) => l.type === "system")).toMatchObject({ permissionMode: "acceptEdits" });
    expect(runs.get(runId)!.message).toBe(`〔Delegation #${del.id} · from the Director〕\nGoal: fix the button.\nwait`);
    expect(events.find((e) => e.name === "delegation.started" && e.data.id === del.id)!.data).toEqual({ id: del.id, from: "space/director", to: "space/engineer", role: "engineer" });
    // The delegator's turn shows the delegation as a step.
    expect(linesOf(d.runId).some((l) => l.type === "delegation" && (l.delegation as DelegationView).id === del.id)).toBe(true);
    // Another conversation's token cannot touch it.
    const other = await director("wait");
    expect((await call(other.token, "POST", `/api/delegations/${del.id}/steer`, { message: "x" })).status).toBe(403);
    expect((await call(other.token, "GET", `/api/delegations/${del.id}`)).status).toBe(403);
    expect(((await (await call(other.token, "GET", "/api/delegations")).json()) as { delegations: unknown[] }).delegations).toEqual([]);
    runs.stop(other.runId);
    // show: the record and the delegate's last steps.
    const shown = (await (await call(d.token, "GET", `/api/delegations/${del.id}`)).json()) as { delegation: DelegationView; tail: string[] };
    expect(shown.tail).toContain("Bash: sleep");
    // say: taken; the delegate reads it (its steer event) and answers.
    const s = await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "also the label" });
    expect(await s.json()).toEqual({ ok: true });
    await until(() => view(del.id).state === "done");
    const notes = view(del.id).notes;
    expect(notes.map((n) => [n.kind, n.taken])).toEqual([["brief", undefined], ["say", true], ["result", undefined]]);
    expect(notes[1]!.readAt).toBeString();
    expect(notes[2]!.text).toBe("heard: also the label");
    expect(events.filter((e) => e.data.id === del.id).map((e) => e.name)).toEqual(["delegation.started", "delegation.noted", "delegation.ended"]);
    expect(events.find((e) => e.name === "delegation.ended" && e.data.id === del.id)!.data).toEqual({ id: del.id, state: "done", summary: "heard: also the label" });
    // Delivered into the Director's running turn, which heard it.
    await service.idle();
    expect(view(del.id).delivered).toBe("steered");
    await until(() => runs.get(d.runId)?.status === "done");
    const heard = said(d.runId).find((t) => t.startsWith("heard: "))!;
    expect(parseResultHeader(heard.slice("heard: ".length))).toEqual({ id: del.id, role: "engineer", state: "done" });
    expect(heard).toContain("heard: also the label");
  });

  test("a running delegate takes two messages, each read, and is still running after the first", async () => {
    const d = await director("wait", { plain: true });
    const del = (await start(d.token, { to: "engineer", brief: "wait" })).body.delegation;
    await until(() => linesOf(del.to.runId!).some((l) => l.type === "assistant"));
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "keep: the label too" })).json()).toEqual({ ok: true });
    await until(() => !!view(del.id).notes[1]?.readAt);
    expect(view(del.id).state).toBe("running");
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "and the icon" })).json()).toEqual({ ok: true });
    await until(() => view(del.id).state === "done");
    expect(view(del.id).notes.map((n) => [n.kind, n.taken, !!n.readAt])).toEqual([["brief", undefined, false], ["say", true, true], ["say", true, true], ["result", undefined, false]]);
    runs.stop(d.runId);
  });

  test("a message added just as the delegate ends is refused as ended, recorded, never sent twice", async () => {
    const d = await director("wait", { plain: true });
    const del = (await start(d.token, { to: "engineer", brief: "quick" })).body.delegation;
    await until(() => view(del.id).state === "done");
    const r = (await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "too late" })).json()) as { ok: boolean; reason: string };
    expect(r).toMatchObject({ ok: false, reason: "ended" });
    expect(view(del.id).notes.find((n) => n.kind === "say")).toMatchObject({ text: "too late", taken: false, reason: "ended" });
    expect(events.filter((e) => e.name === "delegation.noted" && e.data.id === del.id).map((e) => e.data)).toEqual([{ id: del.id, kind: "say", taken: false }]);
    runs.stop(d.runId);
  });

  test("a runtime that cannot take a message while it runs: unsupported", async () => {
    team.update("engineer", { model: "plain/intermediate" });
    try {
      const d = await director("wait", { plain: true });
      const del = (await start(d.token, { to: "engineer", brief: "wait" })).body.delegation;
      await until(() => linesOf(del.to.runId!).some((l) => l.type === "assistant"));
      const r = (await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "more" })).json()) as { ok: boolean; reason: string };
      expect(r).toMatchObject({ ok: false, reason: "unsupported" });
      expect(runs.get(del.to.runId!)?.status).toBe("running");
      const stopped = (await (await call(d.token, "POST", `/api/delegations/${del.id}/stop`)).json()) as { ok: boolean; stopped: boolean };
      expect(stopped).toMatchObject({ ok: true, stopped: true });
      runs.stop(d.runId);
    } finally {
      team.update("engineer", { model: null });
    }
  });

  test("Codex: a message steered into its running turn, and its result", async () => {
    team.update("engineer", { model: "codex/intermediate" });
    try {
      const d = await director("wait", { plain: true });
      const del = (await start(d.token, { to: "engineer", brief: "wait" })).body.delegation;
      await until(() => linesOf(del.to.runId!).some((l) => (l.params as { item?: { type?: string } } | undefined)?.item?.type === "commandExecution" || l.type === "assistant" || l.type === "item"));
      await Bun.sleep(50);
      expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "go on" })).json()).toEqual({ ok: true });
      await until(() => view(del.id).state === "done");
      expect(view(del.id).notes.at(-1)!.text).toContain("heard: go on");
      expect(view(del.id).notes[1]!.readAt).toBeString();
      runs.stop(d.runId);
    } finally {
      team.update("engineer", { model: null });
    }
  });
});

describe("stop and the result", () => {
  test("stopped by the delegator: answers with what it said; the result is not delivered again", async () => {
    const d = await director("wait", { plain: true });
    const del = (await start(d.token, { to: "engineer", brief: "wait" })).body.delegation;
    await until(() => linesOf(del.to.runId!).some((l) => l.type === "assistant"));
    const r = (await (await call(d.token, "POST", `/api/delegations/${del.id}/stop`)).json()) as { ok: boolean; stopped: boolean; last: string };
    expect(r).toMatchObject({ ok: true, stopped: true });
    await until(() => view(del.id).state === "stopped");
    await service.idle();
    expect(view(del.id).delivered).toBeNull();
    expect(view(del.id).notes.map((n) => [n.kind, n.reason])).toEqual([["brief", undefined], ["stop", "delegator"], ["result", "stopped"]]);
    expect(runs.get(d.runId)?.status).toBe("running");
    // Stopping again answers with the result.
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/stop`)).json()).toMatchObject({ ok: true, stopped: false });
    runs.stop(d.runId);
  });

  test("stopped by the person while the delegator is idle: the result starts a new turn of the delegator, trigger delegation", async () => {
    const d = await director("wait", { plain: true });
    // A turn that started the delegation and ended: the result wakes it.
    const del = (await start(d.token, { to: "engineer", brief: "wait" })).body.delegation;
    runs.stop(d.runId);
    await until(() => runs.get(d.runId)?.status === "stopped" && linesOf(del.to.runId!).some((l) => l.type === "assistant"));
    const r = (await (await call(null, "POST", `/api/delegations/${del.id}/stop`)).json()) as { stopped: boolean };
    expect(r.stopped).toBe(true);
    await until(() => view(del.id).delivered === "turn");
    const woke = runs.list({ agent: "space/director", limit: 5 }).find((x) => x.trigger === "delegation" && x.sessionId === d.session)!;
    expect(parseResultHeader(woke.message)).toEqual({ id: del.id, role: "engineer", state: "stopped" });
    expect(woke.message).toContain(`space/engineer, session live-session`);
    expect(view(del.id).notes.find((n) => n.kind === "stop")).toMatchObject({ reason: "person" });
    // The woken turn shows the delegation as its step, and may delegate again (`continue`) with its own token.
    expect(linesOf(woke.id).some((l) => l.type === "delegation")).toBe(true);
    await until(() => runs.get(woke.id)?.status === "done");
  });

  test("continue: a new delegation on the earlier one's session; a running one cannot be continued", async () => {
    const d = await director("wait", { plain: true });
    const first = (await start(d.token, { to: "engineer", brief: "first" })).body.delegation;
    await until(() => view(first.id).state === "done");
    const again = await start(d.token, { to: "engineer", brief: "wait", continue: first.id });
    expect(again.status).toBe(201);
    expect(again.body.delegation).toMatchObject({ continued: first.id, to: { session: "live-session" } });
    expect(runs.get(again.body.delegation.to.runId!)!.sessionId).toBe("live-session");
    expect((await start(d.token, { to: "engineer", brief: "x", continue: again.body.delegation.id })).status).toBe(409);
    runs.stop(again.body.delegation.to.runId!);
    runs.stop(d.runId);
  });

  test(`at most ${MAX_RESULT_TURNS} result-triggered turns in a row; the next result is held and the person asked`, async () => {
    const session = sid();
    const d = await director("hello", { session });
    await until(() => runs.get(d.runId)?.status === "done");
    // Four turns already woken by results on this session.
    for (let i = 0; i < MAX_RESULT_TURNS; i++) {
      db.query("INSERT INTO agent_runs (id, agent, session_id, sid, message, runtime, status, started_at, finished_at, trigger) VALUES (?, 'space/director', ?, ?, 'r', 'claude', 'done', ?, ?, 'delegation')").run(crypto.randomUUID(), session, session, Date.now() + i + 1, Date.now() + i + 1);
    }
    const held: number[] = [];
    const off = service.onHeld((v) => held.push(v.id));
    const del = dstore.create({ fromAgent: "space/director", fromSession: session, fromRun: d.runId, toAgent: "space/engineer", toRole: "engineer", toTitle: "Engineer", permission: "edit", orderId: null, continued: null }, "loop");
    dstore.patch(del.id, { state: "done", endedAt: Date.now() });
    dstore.note(del.id, "result", "back again");
    service.start(); // the unsettled result is delivered, as after a restart
    await service.idle();
    off();
    expect(view(del.id).delivered).toBe("held");
    expect(held).toEqual([del.id]);
    expect(runs.list({ agent: "space/director", limit: 10 }).filter((r) => r.sessionId === session && r.status === "running")).toEqual([]);
  });
});

describe("a restart", () => {
  test("a delegation whose run did not live to its end is marked interrupted and its result delivered", async () => {
    const session = sid();
    const d = await director("hello", { session });
    await until(() => runs.get(d.runId)?.status === "done");
    // As the registry leaves it after a restart: the delegate's row interrupted.
    const runId = crypto.randomUUID();
    db.query("INSERT INTO agent_runs (id, agent, session_id, message, runtime, status, error, started_at, finished_at) VALUES (?, 'space/engineer', NULL, 'b', 'claude', 'interrupted', 'ai-space restarted during the turn', ?, ?)").run(runId, Date.now(), Date.now());
    const del = dstore.create({ fromAgent: "space/director", fromSession: session, fromRun: d.runId, toAgent: "space/engineer", toRole: "engineer", toTitle: "Engineer", permission: "edit", orderId: null, continued: null }, "brief");
    dstore.patch(del.id, { runId });
    service.start();
    expect(view(del.id).state).toBe("interrupted");
    await until(() => view(del.id).delivered === "turn");
    const woke = runs.list({ agent: "space/director", limit: 5 }).find((r) => r.trigger === "delegation" && r.sessionId === session)!;
    expect(woke.message).toContain("ended: interrupted");
    expect(events.find((e) => e.name === "delegation.ended" && e.data.id === del.id)!.data).toMatchObject({ state: "interrupted" });
    await until(() => runs.get(woke.id)?.status === "done");
  });
});

describe("an order's topic", () => {
  test("needs the person while a delegate waits for an approval, which the person answers on the delegate's run; works while another delegation runs; then done", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    team.add({ role: "helper", title: "Helper", i18n: {}, agent: "space/assistant", summary: "", model: null, permission: "ask", enabled: true });
    // The Director's turn waits, so its token lives while it delegates.
    team.update("director", { model: "plain/intermediate" });
    await orders.submit({ clientId: crypto.randomUUID(), text: "wait", image: { bytes: png } });
    await until(() => !!ordersStore.topics()[0]?.runId);
    const topic = ordersStore.topics()[0]!;
    const dRun = runs.get(topic.runId!)!;
    await until(() => !!runs.get(dRun.id)?.sid);
    const token = envs.find((e) => e.agent === "space/director" && e.message.startsWith("〔Order #"))!.env.SPACE_RUN_TOKEN!;
    ordersStore.patchTopic(topic.id, { sessionId: runs.get(dRun.id)!.sid! });
    const order = ordersStore.ofTopic(topic.id)[0]!;
    // The order's screenshot goes to the delegate; an order that is not of this conversation does not.
    const a = await start(token, { to: "engineer", brief: "approve:deploy it", images: [order.id] });
    expect(a.status).toBe(201);
    expect(a.body.delegation.orderId).toBe(order.id);
    expect(runs.get(a.body.delegation.to.runId!)!.message).toContain("approve:deploy it");
    expect((await start(token, { to: "engineer", brief: "x", images: [999] })).status).toBe(400);
    const b = (await start(token, { to: "helper", brief: "wait" })).body.delegation;
    expect(events.find((e) => e.name === "delegation.started" && e.data.id === b.id)!.data).toMatchObject({ order: order.id, topic: topic.id });
    // The Director's turn ends; a delegate waits for an approval: the topic waits for the person.
    runs.stop(dRun.id);
    await until(() => view(a.body.delegation.id).state === "waiting");
    await until(() => ordersStore.topic(topic.id)!.state === "needs-you");
    expect(orders.asking(ordersStore.topic(topic.id)!)).toEqual(["Engineer: deploy it"]);
    // The person answers it on the delegate's own route.
    const rid = linesOf(a.body.delegation.to.runId!).find((l) => l.type === "approval_request")!.id as string;
    expect((await call(null, "POST", `/api/agents/space/engineer/runs/${a.body.delegation.to.runId}/approvals/${encodeURIComponent(rid)}`, { decision: "allow" })).status).toBe(200);
    await until(() => view(a.body.delegation.id).delivered === "turn");
    // The woken turn ends, the other delegation still runs: the topic works.
    await until(() => !runs.running().some((r) => r.agent === "space/director"));
    await until(() => ordersStore.topic(topic.id)!.state === "working");
    // The person stops it from the page: its result wakes the Director once more, and the topic is done.
    expect(await (await call(null, "POST", `/api/delegations/${b.id}/stop`)).json()).toMatchObject({ ok: true, stopped: true });
    await until(() => view(b.id).delivered === "turn");
    await until(() => ordersStore.topic(topic.id)!.state === "done", 10_000);
    team.update("director", { model: null });
    team.remove("helper");
  });
});
