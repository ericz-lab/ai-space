import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { createPeerRoutes } from "../peers/api.ts";
import { machineAccess, peerMachines } from "../peers/delegates.ts";
import { PeerHub } from "../peers/hub.ts";
import { createPeerServeRoutes } from "../peers/serve.ts";
import { PeerStore } from "../peers/store.ts";
import { RuntimeRegistry } from "../runtimes/registry.ts";
import { fakeLiveBin } from "../runtimes/testing-live.ts";
import type { ChatTurn } from "../runtimes/types.ts";
import { TeamStore } from "../team/store.ts";
import { removeTemp } from "../testing.ts";
import { workspacePaths } from "../workspace.ts";
import { createAgentRoutes } from "./api.ts";
import { type DelegationView, parseResultHeader } from "./delegation-view.ts";
import { DelegationService, DelegationStore, RunTokens } from "./delegations.ts";
import { createDelegationRoutes } from "./delegations-api.ts";
import { RunRegistry } from "./runs.ts";
import { SessionStore } from "./sessions.ts";

/**
 * Delegation to an agent on another machine (docs/orders.md#on-another-machine), on two Spaces: the
 * hub runs the Director and lists the peer `david`; the peer runs the delegate on its own routes, with
 * the stand-ins of the live CLIs (runtimes/testing-live.ts). Every hub request to the peer goes
 * through `link`, which can take the peer offline (refused at once) and cut the streams open now.
 */

setDefaultTimeout(30_000);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const IDLE_MS = 1_500;
let giveUpMs = 60_000;
/** The hub's peer clock ahead of the real one: its last snapshot looks old. */
let skew = 0;

let home = "";
let peerHome = "";
const cleanup: (() => void)[] = [];

// ---- the peer
let peerRuns: RunRegistry;
let peerServer: ReturnType<typeof Bun.serve>;
const peerTurns: { agent: string; runtime: string; message: string; permissionMode?: string; images: number; session?: string }[] = [];

// ---- the hub
let db: Database;
let runs: RunRegistry;
let team: TeamStore;
let dstore: DelegationStore;
let service: DelegationService;
let tokens: RunTokens;
let peers: PeerHub;
let server: ReturnType<typeof Bun.serve>;
let base = "";
let chat: (r: Request & { params: Record<string, string> }) => Promise<Response>;
const envs: { session?: string; message: string; env: Record<string, string | undefined> }[] = [];
const hubSessions = { current: undefined as SessionStore | undefined };

/** The link to the peer: `down` refuses every request; `cut()` ends every open one (a dropped stream). */
const link = { down: false, open: new Set<AbortController>(), requests: [] as string[] };
const cut = () => {
  for (const c of link.open) c.abort(new Error("link cut"));
  link.open.clear();
};
const linkFetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input instanceof Request ? input.url : input);
  link.requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}${new URL(url).search}`);
  if (link.down) throw new Error("connect ECONNREFUSED");
  const ctl = new AbortController();
  link.open.add(ctl);
  const signal = init.signal ? AbortSignal.any([init.signal, ctl.signal]) : ctl.signal;
  try {
    const r = await fetch(input, { ...init, signal });
    if (!r.body) link.open.delete(ctl);
    return r;
  } catch (e) {
    link.open.delete(ctl);
    throw e;
  }
}) as typeof fetch;

function liveRuntimes(record: (name: string, turn: ChatTurn) => void): RuntimeRegistry {
  const reg = new RuntimeRegistry({
    default: "claude",
    runtimes: [
      { name: "claude", kind: "claude-code", bin: fakeLiveBin("claude"), chatArgs: [] },
      { name: "codex", kind: "codex-cli", bin: fakeLiveBin("codex") },
    ],
  });
  for (const name of ["claude", "codex"]) {
    const rt = reg.get(name)!;
    const chat = rt.chat.bind(rt);
    rt.chat = (turn: ChatTurn, cb) => {
      record(name, turn);
      return chat(turn, cb);
    };
  }
  cleanup.push(() => reg.closeLive());
  return reg;
}

function newService(): DelegationService {
  return new DelegationService({
    store: dstore,
    team,
    runs,
    chat,
    machines: peerMachines(peers),
    remote: { idleMs: IDLE_MS, retryMs: [100, 200, 300], get giveUpMs() { return giveUpMs; } },
    agentExists: (id) => ["space/director", "space/engineer"].includes(id),
    orders: { of: () => ({ topicId: null, orderId: null }), image: async (orderId) => ({ name: `order-${orderId}.png`, mediaType: "image/png", data: PNG }) },
    log: () => {},
  });
}

beforeAll(async () => {
  // ---- the peer: its own agents, its own runs; nothing of the hub's
  peerHome = await realpath(await mkdtemp(join(tmpdir(), "space-dlg-peer-")));
  await mkdir(workspacePaths(peerHome).apps, { recursive: true });
  const peerDb = new Database(":memory:");
  peerRuns = new RunRegistry(peerDb, { killGraceMs: 200 });
  const peerRuntimes = liveRuntimes((name, turn) => peerTurns.push({ agent: String(turn.env?.SPACE_AGENT_ID), runtime: name, message: turn.message, ...(turn.permissionMode ? { permissionMode: turn.permissionMode } : {}), images: turn.images?.length ?? 0, ...(turn.sessionId ? { session: turn.sessionId } : {}) }));
  const peerAgents = createAgentRoutes({ ws: workspacePaths(peerHome), registry: new AppRegistry(), layout: new LayoutStore(peerDb), sessions: new SessionStore(peerDb), runtimes: peerRuntimes, runs: peerRuns, apiUrl: "http://127.0.0.1:1" });
  const empty = (key: string) => ({ GET: () => Response.json({ ok: true, [key]: [] }) });
  // No apps there: the lists are empty, every other panel route answers 404.
  const lists: Record<string, unknown> = { "/api/apps": empty("apps"), "/api/services": empty("services"), "/api/widgets": empty("widgets") };
  const peerPanel = new Proxy(lists, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : () => Response.json({ ok: false }, { status: 404 })) }) as never;
  peerServer = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 255, routes: { ...peerAgents, ...createPeerServeRoutes({ token: "s3cret", name: "david", panel: peerPanel, agents: peerAgents }) } as never });

  // ---- the hub: the Director, the team, and the peer david
  home = await realpath(await mkdtemp(join(tmpdir(), "space-dlg-hub-")));
  await mkdir(workspacePaths(home).apps, { recursive: true });
  db = new Database(":memory:");
  runs = new RunRegistry(db, { killGraceMs: 200 });
  hubSessions.current = new SessionStore(db);
  team = new TeamStore(db);
  tokens = new RunTokens(runs);
  const hubRuntimes = liveRuntimes((_, turn) => envs.push({ ...(turn.sessionId ? { session: turn.sessionId } : {}), message: turn.message, env: { ...turn.env } }));
  const layout = new LayoutStore(db);
  const registry = new AppRegistry();
  peers = new PeerHub([{ name: "david", url: `http://127.0.0.1:${peerServer.port}`, token: "s3cret", headers: {}, refreshMs: 10_000 }], { store: new PeerStore(db), fetch: linkFetch, now: () => Date.now() + skew });
  await peers.refreshAll();
  const agentRoutes = createAgentRoutes({ ws: workspacePaths(home), registry, layout, sessions: hubSessions.current, runtimes: hubRuntimes, runs, runTokens: tokens, apiUrl: "http://127.0.0.1:1", teamRoster: () => team.list(), teamModel: (a) => team.byAgent(a)?.model, peers });
  chat = (agentRoutes["/api/agents/:app/:agent/chat"] as { POST: typeof chat }).POST;
  dstore = new DelegationStore(db);
  service = newService();
  service.start();
  team.add({ role: "far", title: "Far engineer", i18n: {}, agent: "david/space/engineer", summary: "Changes apps on david.", model: null, permission: "edit", enabled: true });
  const routes = { ...agentRoutes, ...createPeerRoutes({ hub: peers, layout, registry }), ...createDelegationRoutes({ service, tokens, owner: async () => undefined }) };
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 255, routes: routes as never });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  service.stop();
  server.stop(true);
  peerServer.stop(true);
  for (const c of cleanup) c();
  removeTemp(home);
  removeTemp(peerHome);
});

const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
  expect(cond()).toBe(true);
};
const peerLines = (id: string) => {
  const lines: Record<string, unknown>[] = [];
  peerRuns.subscribe(id, 0, { onEvent: (e) => lines.push(JSON.parse(e.line) as Record<string, unknown>), onEnd: () => {} })?.();
  return lines;
};
const hubSaid = (id: string) => {
  const out: string[] = [];
  runs.subscribe(id, 0, { onEvent: (e) => {
    const l = JSON.parse(e.line) as { type?: string; message?: { content?: { type: string; text?: string }[] } };
    if (l.type === "assistant") for (const c of l.message?.content ?? []) if (c.type === "text") out.push(c.text!);
  }, onEnd: () => {} })?.();
  return out;
};

async function director(message: string): Promise<{ runId: string; token: string; session: string }> {
  const session = `dir-${crypto.randomUUID()}`;
  const r = await fetch(`${base}/api/agents/space/director/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message, sessionId: session, interactive: true }) });
  const runId = r.headers.get("x-run-id")!;
  void r.body?.cancel();
  await until(() => runs.get(runId)?.sid === session && envs.some((e) => e.session === session));
  return { runId, token: envs.find((e) => e.session === session)!.env.SPACE_RUN_TOKEN!, session };
}
const call = (token: string | null, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const start = async (token: string, body: Record<string, unknown>) => {
  const r = await call(token, "POST", "/api/delegations", body);
  return { status: r.status, body: (await r.json()) as { ok: boolean; delegation: DelegationView; error?: string; reason?: string } };
};
const view = (id: number) => service.view(id)!;
/** The hub has read the delegate's first steps off the peer's stream. */
const seen = async (id: number) => {
  const end = Date.now() + 10_000;
  while (Date.now() < end && !(await service.show(id)).tail.some((l) => l.startsWith("Bash"))) await Bun.sleep(10);
  expect((await service.show(id)).tail.some((l) => l.startsWith("Bash"))).toBe(true);
};

describe("delegation to an agent on another machine", () => {
  test("runs there with the brief, the screenshot and the member's permission; a message is taken and read; the result comes back", async () => {
    const d = await director("wait");
    const r = await start(d.token, { to: "far", brief: "Goal: fix the header on david.\nwait", images: [7] });
    expect(r.status).toBe(201);
    const del = r.body.delegation;
    expect(del).toMatchObject({ state: "running", permission: "edit", to: { agent: "space/engineer", machine: "david", role: "far" }, unreachableSince: null });
    const runId = del.to.runId!;
    // The run is the peer's: in its registry, not the hub's.
    expect(runs.get(runId)).toBeNull();
    await until(() => peerLines(runId).some((l) => l.type === "assistant"));
    const turn = peerTurns.find((t) => t.message.includes(`Delegation #${del.id}`))!;
    // Edit is acceptEdits there; the picture rode in the chat body.
    expect(turn).toMatchObject({ agent: "space/engineer", runtime: "claude", permissionMode: "acceptEdits", images: 1 });
    expect(link.requests).toContain("POST /api/peer/agents/space/engineer/chat");
    // show: the steps are the peer's.
    const shown = (await (await call(d.token, "GET", `/api/delegations/${del.id}`)).json()) as { tail: string[] };
    expect(shown.tail.length).toBeGreaterThan(0);
    // say: through the peer's steer route; its steer event marks it read.
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "also the footer" })).json()).toEqual({ ok: true });
    await until(() => view(del.id).state === "done");
    const notes = view(del.id).notes;
    expect(notes.map((n) => [n.kind, n.taken])).toEqual([["brief", undefined], ["say", true], ["result", undefined]]);
    expect(notes[1]!.readAt).toBeString();
    expect(notes[2]!.text).toBe("heard: also the footer");
    // The delegate's session there is kept; the result names the machine and reached the Director's turn.
    expect(view(del.id).to.session).toBeString();
    await service.idle();
    await until(() => runs.get(d.runId)?.status === "done");
    const heard = hubSaid(d.runId).find((t) => t.startsWith("heard: "))!;
    expect(parseResultHeader(heard.slice("heard: ".length))).toMatchObject({ id: del.id, role: "far", state: "done" });
    expect(heard).toContain("space/engineer on david");
  });

  test("the member's model is one of that machine's, sent without a machine prefix", async () => {
    team.update("far", { model: "codex/intermediate" });
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "quick" })).body.delegation;
    await until(() => view(del.id).state === "done");
    expect(peerTurns.find((t) => t.message.includes(`Delegation #${del.id}`))).toMatchObject({ runtime: "codex" });
    team.update("far", { model: null });
    runs.stop(d.runId);
  });

  test("stop goes to the peer's run and answers with its last words", async () => {
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "wait" })).body.delegation;
    await until(() => peerLines(del.to.runId!).some((l) => l.type === "assistant"));
    const r = (await (await call(null, "POST", `/api/delegations/${del.id}/stop`)).json()) as { ok: boolean; stopped: boolean; last: string };
    expect(r).toMatchObject({ ok: true, stopped: true });
    await until(() => view(del.id).state === "stopped");
    expect(peerRuns.get(del.to.runId!)!.status).toBe("stopped");
    expect(view(del.id).notes.at(-1)).toMatchObject({ kind: "result" });
    runs.stop(d.runId);
  });

  test("an approval of the delegate waits for the person, who answers it through the peer route", async () => {
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "approve:rm -rf build" })).body.delegation;
    await until(() => view(del.id).state === "waiting");
    expect(view(del.id).asking.length).toBe(1);
    const rid = peerLines(del.to.runId!).find((l) => l.type === "approval_request")!.id as string;
    // As the Orders page does: the hub's /api/peers/<machine>/agents/… route.
    const a = await fetch(`${base}/api/peers/david/agents/space/engineer/runs/${del.to.runId}/approvals/${encodeURIComponent(rid)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) });
    expect(a.status).toBe(200);
    await until(() => view(del.id).state === "done");
    expect(view(del.id).asking).toEqual([]);
    runs.stop(d.runId);
  });

  test("a dropped stream is read again after its last event: nothing twice, nothing lost", async () => {
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "wait" })).body.delegation;
    const runId = del.to.runId!;
    await seen(del.id);
    const before = link.requests.filter((p) => p.includes(`/runs/${runId}/events`)).length;
    cut();
    await until(() => link.requests.filter((p) => p.includes(`/runs/${runId}/events`)).length > before);
    expect(link.requests.filter((p) => p.includes(`/runs/${runId}/events?after=`)).at(-1)).not.toEndWith("after=0");
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "after the drop" })).json()).toEqual({ ok: true });
    await until(() => view(del.id).state === "done");
    expect(view(del.id).notes.map((n) => n.kind)).toEqual(["brief", "say", "result"]);
    expect(view(del.id).notes[1]!.readAt).toBeString();
    expect(view(del.id).unreachableSince).toBeNull();
    runs.stop(d.runId);
  });

  test("the peer offline when the run ends: running with unreachable since, settled when it answers again", async () => {
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "wait" })).body.delegation;
    const runId = del.to.runId!;
    await seen(del.id);
    link.down = true;
    cut();
    await until(() => view(del.id).unreachableSince !== null);
    expect(view(del.id).state).toBe("running");
    // Not reachable: a message is not sent, and says so.
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "x" })).json()).toMatchObject({ ok: false, reason: "unreachable" });
    // The run ends on the peer while the hub cannot see it.
    peerRuns.stop(runId);
    await until(() => peerRuns.get(runId)!.status === "stopped");
    await Bun.sleep(300);
    expect(view(del.id).state).toBe("running");
    link.down = false;
    await until(() => view(del.id).state === "stopped");
    expect(view(del.id).unreachableSince).toBeNull();
    runs.stop(d.runId);
  });

  test("a machine that does not answer for the bound: the delegation ends interrupted", async () => {
    giveUpMs = 400;
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "wait" })).body.delegation;
    await seen(del.id);
    link.down = true;
    cut();
    await until(() => view(del.id).state === "interrupted");
    expect(view(del.id).notes.at(-1)!.text).toContain("david did not answer");
    link.down = false;
    giveUpMs = 60_000;
    peerRuns.stop(del.to.runId!);
    runs.stop(d.runId);
  });

  test("after a restart of this Space the delegate is followed again and its messages are not read twice", async () => {
    const d = await director("wait");
    const del = (await start(d.token, { to: "far", brief: "wait" })).body.delegation;
    const runId = del.to.runId!;
    await until(() => peerLines(runId).some((l) => l.type === "assistant"));
    // A message read before the restart (Claude's `keep:` goes on waiting).
    expect(await (await call(d.token, "POST", `/api/delegations/${del.id}/steer`, { message: "keep: the label" })).json()).toEqual({ ok: true });
    await until(() => !!view(del.id).notes[1]?.readAt);
    const readAt = view(del.id).notes[1]!.readAt;
    // The restart: the old service is gone, a new one starts from the same store.
    service.stop();
    cut();
    service = newService();
    service.start();
    await until(() => link.requests.filter((p) => p.endsWith(`/runs/${runId}/events?after=0`)).length >= 2);
    expect(view(del.id).state).toBe("running");
    peerRuns.stop(runId);
    await until(() => view(del.id).state === "stopped");
    expect(view(del.id).notes[1]!.readAt).toBe(readAt);
    runs.stop(d.runId);
  });

  test("refusals say what is missing: an unlisted machine, an offline one, an agent it does not have", async () => {
    const d = await director("wait");
    team.add({ role: "ghost", title: "Ghost", i18n: {}, agent: "eric/space/engineer", summary: "", model: null, permission: "ask", enabled: true });
    const unlisted = await start(d.token, { to: "ghost", brief: "x" });
    expect(unlisted).toMatchObject({ status: 409, body: { reason: "machine-unlisted" } });
    expect(unlisted.body.error).toContain("does not list eric as a peer");
    team.remove("ghost");
    team.add({ role: "nobody", title: "Nobody", i18n: {}, agent: "david/notes/nobody", summary: "", model: null, permission: "ask", enabled: true });
    expect(await start(d.token, { to: "nobody", brief: "x" })).toMatchObject({ status: 409, body: { reason: "removed" } });
    team.remove("nobody");
    // Not answering, not known down yet: the turn does not start, recorded as an error.
    link.down = true;
    const lost = await start(d.token, { to: "far", brief: "x" });
    expect(lost).toMatchObject({ status: 502, body: { reason: "machine-offline" } });
    expect(lost.body.error).toContain("david did not answer");
    // Known down (two snapshots failed and the last good one is old): refused before anything is recorded.
    const count = dstore.recent(500).length;
    await peers.refreshAll();
    await peers.refreshAll();
    skew = 10 * 60_000;
    const off = await start(d.token, { to: "far", brief: "x" });
    expect(off).toMatchObject({ status: 503, body: { reason: "machine-offline" } });
    expect(off.body.error).toContain("david does not answer");
    expect(dstore.recent(500).length).toBe(count);
    skew = 0;
    link.down = false;
    await peers.refreshAll();
    expect((await start(d.token, { to: "far", brief: "quick" })).status).toBe(201);
    runs.stop(d.runId);
  });
});

describe("which machines this Space may run agents on", () => {
  const grant = (scopes: string[], fullTrust = false) => ({ scopes, fullTrust }) as never;
  test("a connection peer needs the agents scope (or full trust) on the other side; a connection without panel is no peer", () => {
    const hub = new PeerHub([{ name: "box", url: "", token: "", headers: {}, refreshMs: 10_000, connection: "c1" }], { store: new PeerStore(new Database(":memory:")) });
    const panelOnly = machineAccess(hub, [{ connection: "c1", name: "box", state: "peer", granted: grant(["panel"]) }], "box");
    expect(panelOnly).toMatchObject({ ok: false, reason: "no-agents" });
    expect((panelOnly as { error: string }).error).toContain("--scopes panel,agents");
    expect(machineAccess(hub, [{ connection: "c1", name: "box", state: "peer", granted: grant(["panel", "agents"]) }], "box")).toEqual({ ok: true });
    expect(machineAccess(hub, [{ connection: "c1", name: "box", state: "peer", granted: grant([], true) }], "box")).toEqual({ ok: true });
    const noPanel = machineAccess(hub, [{ connection: "c2", name: "zed", state: "no-panel", granted: grant([]) }], "zed");
    expect(noPanel).toMatchObject({ ok: false, reason: "unlisted" });
    expect((noPanel as { error: string }).error).toContain("grants this Space no panel scope");
  });
});
