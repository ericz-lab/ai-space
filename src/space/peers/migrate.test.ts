import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../cli/testing.ts";
import { RemoteCatalogue } from "../packages/catalogue.ts";
import { Connections, peerLabel } from "../packages/connections.ts";
import { PackageLinks, createConnectionRoutes } from "../packages/links.ts";
import { LayoutStore } from "../panel/layout.ts";
import { AppRegistry } from "../panel/registry.ts";
import { terminalWebSocket } from "../terminal/api.ts";
import { removeTemp } from "../testing.ts";
import { adoptHeadersEnv, adoptTokenEnv, createAdoptHandler } from "./adopt.ts";
import { createPeerRoutes } from "./api.ts";
import { loadPeers } from "./config.ts";
import { ConnectionPeers } from "./connection-peers.ts";
import { createConnectionPeerServe } from "./connection-serve.ts";
import { PeerHub } from "./hub.ts";
import { type MigrateResult, createMigrateRoutes } from "./migrate.ts";
import { createPeerServeHandlers, createPeerServeRoutes, type PeerServeOptions } from "./serve.ts";
import { PeerStore } from "./store.ts";

// Whole Spaces in one process, each with the pieces `space peer migrate` touches on either side: its connections
// and links, its peers (legacy ones from its `.env`, connection ones from its catalogue), its `/api/peer/*` over
// HTTPS behind its hub token with the adopt route, the channel route, `/api/peers/*` and the migrate route.

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

type Handler = (req: Request & { params: Record<string, string> }) => Response | Promise<Response>;
const ok: Handler = () => Response.json({ ok: true });
/** A route table where every path answers; the lists the snapshot reads are small and fixed. */
function stub(fixed: Record<string, Record<string, Handler>>) {
  return new Proxy({}, { get: (_t, path) => (typeof path === "string" ? fixed[path] ?? { GET: ok, POST: ok, PATCH: ok, PUT: ok, DELETE: ok } : undefined) });
}
/** What the peer's own routes need: one app `media` with an icon route that says who answered. */
function serveOptions(name: string, id: string, seen: string[]): Omit<PeerServeOptions, "token"> {
  const app = { id: "media", name: "media", title: "Media", icon: "/api/apps/media/icon", status: "active", manifestOnly: false, hidden: false, agents: [], widgets: [] };
  return {
    name, id,
    panel: stub({
      "/api/apps": { GET: () => Response.json({ ok: true, apps: [app] }) },
      "/api/services": { GET: () => Response.json({ ok: true, services: [] }) },
      "/api/widgets": { GET: () => Response.json({ ok: true, widgets: [] }) },
      "/api/apps/:app/icon": { GET: (req) => (seen.push(`${name} icon ${req.params.app}`), Response.json({ ok: true, from: name })) },
    }) as never,
    agents: stub({ "/api/agents": { GET: () => Response.json({ ok: true, agents: [] }) } }) as never,
    // No terminal and no SPACE_PEER_MODEL here: full trust must not open either.
  };
}

type SpaceOpts = { hubToken?: string; adopt?: boolean | ((h: Handler) => Handler); legacy?: Record<string, { url: string; token: string; headers?: string; refresh?: string }> };

/** A server first, so two Spaces can name each other's address before either is built. */
function server() {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket: terminalWebSocket, fetch: () => new Response("not yet", { status: 503 }) });
  cleanups.push(() => { s.stop(true); });
  return s;
}

function space(name: string, srv: ReturnType<typeof server>, opts: SpaceOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), `space-migrate-${name}-`));
  cleanups.push(() => removeTemp(dir));
  const envFile = join(dir, ".env");
  const lines = [`SPACE_NAME=${name}`, ...(opts.hubToken ? [`SPACE_HUB_TOKEN=${opts.hubToken}`] : [])];
  for (const [peer, l] of Object.entries(opts.legacy ?? {})) {
    const key = `SPACE_PEER_${peer.toUpperCase()}`;
    lines.push(`# the peer ${peer}`, `${key}=${l.url}`, `${key}_TOKEN=${l.token}`, ...(l.headers ? [`${key}_HEADERS="${l.headers}"`] : []), ...(l.refresh ? [`${key}_REFRESH=${l.refresh}`] : []));
  }
  lines.push("SPACE_OTHER=kept");
  writeFileSync(envFile, `${lines.join("\n")}\n`);
  const env: Record<string, string | undefined> = {};
  for (const l of lines) if (!l.startsWith("#")) env[l.slice(0, l.indexOf("="))] = l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "");

  const db = new Database(":memory:"); cleanups.push(() => db.close());
  const connections = new Connections(db, crypto.randomUUID());
  const links = new PackageLinks(connections, { env, name, apps: () => [] });
  cleanups.push(() => links.close());
  const seen: string[] = [];
  const peerServe = serveOptions(name, connections.spaceId, seen);
  links.peer = createConnectionPeerServe({ routes: createPeerServeHandlers(peerServe), allows: (id, scope) => connections.allowsScope(id, scope) });
  const store = new PeerStore(db);
  const layout = new LayoutStore(db);
  const hub = new PeerHub(loadPeers(env).peers, { store, channel: (id, meta, body, signal, o) => links.request(id, meta, body, signal, o) }, connections.list().map(peerLabel));
  cleanups.push(() => hub.stop());
  const catalogue = new RemoteCatalogue(links, { refreshMs: 3_600_000 }); cleanups.push(() => catalogue.close());
  const connectionPeers = new ConnectionPeers({ hub, catalogue, connections, refreshMs: 3_600_000 });
  cleanups.push(() => connectionPeers.close());
  links.peerState = (id) => connectionPeers.status().find((s) => s.connection === id);
  let adopt: Handler | undefined;
  if (opts.adopt !== false) {
    const base = createAdoptHandler({ connections, links, env, envFile, isPeer: (id) => hub.names().some((n) => hub.get(n)?.config.spaceId === id || hub.get(n)?.snapshot?.id === id) }) as Handler;
    adopt = typeof opts.adopt === "function" ? opts.adopt(base) : base;
  }
  const deps = { hub, connections, links, connectionPeers, catalogue, envFile, env, hubUrl: srv.url.origin, pollMs: 20 };
  srv.reload({
    routes: {
      ...createConnectionRoutes({ links, token: "op" }),
      ...createPeerRoutes({ hub, layout, registry: new AppRegistry() }),
      ...createMigrateRoutes({ deps, token: "op" }),
      ...createPeerServeRoutes({ token: opts.hubToken ?? "", ...peerServe, ...(adopt ? { adopt: adopt as unknown as (req: Request) => Response | Promise<Response> } : {}) }),
    } as never,
    fetch: () => Response.json({ ok: false, error: "not found" }, { status: 404 }),
  });
  hub.start();
  const migrate = async (peer: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`${srv.url.origin}/api/peers/${peer}/migrate`, { method: "POST", headers: { authorization: "Bearer op", "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as MigrateResult };
  };
  return { name, srv, origin: srv.url.origin, connections, links, hub, store, layout, catalogue, connectionPeers, env, envFile, seen, deps, migrate, envText: () => readFileSync(envFile, "utf8") };
}


/** A hub `hub` listing the peer `box` as `SPACE_PEER_BOX`, both up, the hub holding box's snapshot. */
async function pair(peerOpts: SpaceOpts = {}, legacyExtra: { headers?: string; refresh?: string } = {}) {
  const hubSrv = server(), peerSrv = server();
  const peer = space("box", peerSrv, { hubToken: "box-hub-token-0123456789", ...peerOpts });
  const hub = space("hub", hubSrv, { legacy: { box: { url: peer.origin, token: "box-hub-token-0123456789", ...legacyExtra } } });
  await hub.hub.get("box")!.refresh();
  expect(hub.hub.get("box")!.error).toBeUndefined();
  return { hub, peer };
}
const active = (text: string, key: string) => text.split("\n").some((l) => l.startsWith(`${key}=`));

test("a legacy peer moves onto a connection under its name, keeping its stored rows, without a restart", async () => {
  const { hub, peer } = await pair({}, { headers: "CF-Access-Client-Id: a; CF-Access-Client-Secret: b", refresh: "45s" });
  hub.layout.hide("box/media", true);
  expect(hub.hub.get("box")!.via).toBe("http");
  const { status, body } = await hub.migrate("box");
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, state: "migrated", peer: "box", peerSpaceId: peer.connections.spaceId });
  expect(body.steps.map((s) => [s.step, s.status])).toEqual([["connection", "done"], ["peer", "done"], ["verify", "done"], ["legacy", "done"]]);
  // What changed for the owner is said: the peer's access-layer headers, the refresh, the hub's own address.
  expect(body.warnings.join("\n")).toContain("SPACE_PEER_BOX_HEADERS");
  expect(body.warnings.join("\n")).toContain("SPACE_PEER_BOX_REFRESH=45s");
  expect(body.warnings.join("\n")).toContain("/api/connections/channel");
  // The lines are commented out (the token masked in the answer), the rest of the file is as it was.
  const text = hub.envText();
  for (const k of ["SPACE_PEER_BOX", "SPACE_PEER_BOX_TOKEN", "SPACE_PEER_BOX_HEADERS", "SPACE_PEER_BOX_REFRESH"]) {
    expect(active(text, k)).toBe(false);
    expect(text).toContain(`# ${k}=`);
    expect(hub.env[k]).toBeUndefined();
  }
  expect(text).toContain("SPACE_OTHER=kept\n");
  expect(body.removed?.find((r) => r.key === "SPACE_PEER_BOX_TOKEN")?.value).toBe("box-…6789");
  expect(body.removed?.find((r) => r.key === "SPACE_PEER_BOX")?.value).toBe(peer.origin);
  // The running hub reaches box over the connection now, under the same name, with what it stored.
  const client = hub.hub.get("box")!;
  expect(client.via).toBe("connection");
  expect(client.error).toBeUndefined();
  expect(hub.store.get("box")?.apps.map((a) => a.name)).toEqual(["media"]);
  expect(hub.layout.read().hidden).toContain("box/media");
  const icon = await fetch(`${hub.origin}/api/peers/box/apps/media/icon`);
  expect(await icon.json()).toMatchObject({ from: "box" });
  expect(peer.seen).toContain("box icon media");
  // The peer: one outgoing connection with full trust, its token in a variable named after the hub, in its .env and its environment.
  const tokenEnv = adoptTokenEnv(hub.connections.spaceId);
  expect(peer.connections.list()).toEqual([expect.objectContaining({ direction: "outgoing", remoteSpaceId: hub.connections.spaceId, url: hub.origin, tokenEnv, fullTrust: true })]);
  expect(peer.envText()).toContain(`${tokenEnv}=`);
  expect(peer.env[tokenEnv]).toBeTruthy();
  // Full trust keeps what the peer does not serve closed: its terminal is off, it offers no model answers.
  const conn = hub.connections.list()[0]!.id;
  for (const path of ["/api/peer/terminal", "/api/peer/model/run"]) {
    const r = await hub.links.request(conn, { operation: "peer", method: path.endsWith("run") ? "POST" : "GET", path, headers: [] });
    expect(r.status).toBe(404);
    await r.body?.cancel();
  }
  // Again: nothing left to do.
  const again = await hub.migrate("box");
  expect(again.body).toMatchObject({ ok: true, state: "already" });
  expect(hub.connections.list()).toHaveLength(1);
  expect(peer.connections.list()).toHaveLength(1);
});

test("a dry run reports every step and changes nothing on either side", async () => {
  const { hub, peer } = await pair();
  const before = { hubEnv: hub.envText(), peerEnv: peer.envText() };
  const { status, body } = await hub.migrate("box", { dryRun: true });
  expect(status).toBe(200);
  expect(body).toMatchObject({ ok: true, state: "dry-run" });
  expect(body.steps.map((s) => s.status)).toEqual(["would", "would", "would", "would"]);
  expect(body.removed?.map((r) => r.key)).toEqual(["SPACE_PEER_BOX", "SPACE_PEER_BOX_TOKEN"]);
  expect(hub.connections.list()).toEqual([]);
  expect(peer.connections.list()).toEqual([]);
  expect(hub.envText()).toBe(before.hubEnv);
  expect(peer.envText()).toBe(before.peerEnv);
  expect(hub.hub.get("box")!.via).toBe("http");
});

test("a failure at the peer, then at the verification, is continued by the next run with one connection and one token", async () => {
  let refuse = true;
  const { hub, peer } = await pair({ adopt: (h) => (req) => (refuse ? Response.json({ ok: false, error: "not now" }, { status: 500 }) : h(req)) });
  const first = await hub.migrate("box");
  expect(first).toMatchObject({ status: 409, body: { ok: false, state: "refused", error: expect.stringContaining("not now") } });
  expect(hub.connections.list()).toHaveLength(1);
  expect(hub.hub.get("box")!.via).toBe("http");
  // The peer makes its connection, but to an address where nothing answers: the verification fails, the legacy peer stays.
  refuse = false;
  const tokenEnv = adoptTokenEnv(hub.connections.spaceId);
  const second = await hub.migrate("box", { waitMs: 1000, hubUrl: "http://127.0.0.1:1" });
  expect(second).toMatchObject({ status: 409, body: { ok: false, state: "unverified" } });
  expect(second.body.error).toContain("did not connect");
  expect(hub.hub.get("box")!.via).toBe("http");
  expect(active(hub.envText(), "SPACE_PEER_BOX")).toBe(true);
  expect(peer.connections.list()).toEqual([expect.objectContaining({ url: "http://127.0.0.1:1" })]);
  // With the right address: a new token, the peer's connection made again there; still one connection each side, one variable.
  const third = await hub.migrate("box");
  expect(third.body).toMatchObject({ ok: true, state: "migrated" });
  expect(hub.connections.list()).toHaveLength(1);
  expect(peer.connections.list()).toHaveLength(1);
  expect(peer.envText().split("\n").filter((l) => l.startsWith(`${tokenEnv}=`))).toHaveLength(1);
});

test("--keep-legacy stops after the verification, and the run after it finishes the move", async () => {
  const { hub, peer } = await pair();
  // An access layer's service token in front of the hub travels to the peer, which sends it when it dials.
  const kept = await hub.migrate("box", { keepLegacy: true, hubHeaders: "X-Layer: one" });
  expect(kept.body).toMatchObject({ ok: true, state: "kept" });
  expect(hub.hub.get("box")!.via).toBe("http");
  const headersEnv = adoptHeadersEnv(hub.connections.spaceId);
  expect(peer.connections.list()[0]).toMatchObject({ headersEnv });
  expect(peer.env[headersEnv]).toBe("X-Layer: one");
  expect(peer.envText()).toContain(`${headersEnv}="X-Layer: one"`);
  // The legacy peer wins over the connection of the same name while both exist.
  expect(hub.connectionPeers.status()[0]).toMatchObject({ name: "box", state: "shadowed" });
  const done = await hub.migrate("box");
  expect(done.body).toMatchObject({ ok: true, state: "migrated" });
  // The connection was up: no new token, the peer's kept.
  expect(done.body.steps.find((s) => s.step === "connection")).toMatchObject({ status: "skipped" });
  expect(peer.connections.list()).toHaveLength(1);
});

test("a peer without the adopt route is pointed at --manual; manual mode and --finish move it", async () => {
  const { hub, peer } = await pair({ adopt: false });
  const auto = await hub.migrate("box");
  expect(auto).toMatchObject({ status: 409, body: { ok: false, state: "needs-manual", error: expect.stringContaining("--manual") } });
  expect(hub.hub.get("box")!.via).toBe("http");
  const manual = await hub.migrate("box", { mode: "manual" });
  expect(manual.body).toMatchObject({ ok: true, state: "manual" });
  const lines = manual.body.manual!;
  const tokenEnv = adoptTokenEnv(hub.connections.spaceId);
  const tokenLine = lines.find((l) => l.startsWith(`${tokenEnv}=`))!;
  const create = lines.find((l) => l.startsWith("space connection create outgoing"))!;
  expect(create).toBe(`space connection create outgoing ${hub.connections.spaceId} --endpoint ${hub.origin} --token-env ${tokenEnv} --full-trust --yes`);
  expect(lines.at(-1)).toBe("space peer migrate box --finish");
  // --finish before the peer did anything: the verification fails and nothing changes.
  const early = await hub.migrate("box", { mode: "finish", waitMs: 1000 });
  expect(early.body).toMatchObject({ ok: false, state: "unverified" });
  expect(active(hub.envText(), "SPACE_PEER_BOX")).toBe(true);
  // The owner on the peer: the token in its environment (the restart), then the connection, as printed.
  peer.env[tokenEnv] = tokenLine.slice(tokenEnv.length + 1);
  peer.connections.create({ remoteSpaceId: hub.connections.spaceId, direction: "outgoing", url: hub.origin, tokenEnv, fullTrust: true });
  const finished = await hub.migrate("box", { mode: "finish" });
  expect(finished.body).toMatchObject({ ok: true, state: "migrated" });
  expect(hub.hub.get("box")!.via).toBe("connection");
});

test("a peer that does not grant the panel scope fails the verification and the legacy peer stays", async () => {
  const { hub, peer } = await pair();
  expect((await hub.migrate("box", { keepLegacy: true })).body.state).toBe("kept");
  peer.connections.update(peer.connections.list()[0]!.id, { fullTrust: false, scopes: [] });
  // --finish does not ask the peer again, so what the peer grants now is what is checked.
  const r = await hub.migrate("box", { mode: "finish", waitMs: 1000 });
  expect(r.body).toMatchObject({ ok: false, state: "unverified", error: expect.stringContaining("panel scope") });
  expect(hub.hub.get("box")!.via).toBe("http");
});

test("the hub's address is never guessed", async () => {
  const hubSrv = server(), peerSrv = server();
  const peer = space("box", peerSrv, { hubToken: "box-hub-token-0123456789" });
  const hub = space("hub", hubSrv, { legacy: { box: { url: peer.origin, token: "box-hub-token-0123456789" } } });
  await hub.hub.get("box")!.refresh();
  delete (hub.deps as { hubUrl?: string }).hubUrl;
  const r = await hub.migrate("box");
  expect(r.status).toBe(400);
  expect(r.body.error).toContain("--hub-url");
  expect(hub.connections.list()).toEqual([]);
  // A public address must be HTTPS.
  const plain = await hub.migrate("box", { hubUrl: "http://hub.example" });
  expect(plain).toMatchObject({ status: 400, body: { error: expect.stringContaining("HTTPS") } });
  expect(hub.connections.list()).toEqual([]);
  const withUrl = await hub.migrate("box", { hubUrl: hub.origin });
  expect(withUrl.body).toMatchObject({ ok: true, state: "migrated" });
});

test("the adopt route: the hub token, HTTPS, legacy only, and no other connection touched", async () => {
  const { hub, peer } = await pair();
  const adopt = (body: unknown, token = "box-hub-token-0123456789") => fetch(`${peer.origin}/api/peer/connections/adopt`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const hubId = hub.connections.spaceId;
  // A connection the owner made for something else, to another Space.
  const other = peer.connections.create({ remoteSpaceId: crypto.randomUUID(), direction: "incoming", scopes: ["panel"] }).connection;
  const snapshot = () => JSON.stringify(peer.connections.get(other.id));
  const before = snapshot();
  expect((await adopt({ spaceId: hubId, url: hub.origin, token: "t".repeat(43) }, "wrong")).status).toBe(401);
  const plain = await adopt({ spaceId: hubId, url: "http://hub.example", token: "t".repeat(43) });
  expect(plain.status).toBe(400);
  expect(await plain.json()).toMatchObject({ error: expect.stringContaining("HTTPS") });
  for (const bad of [{ spaceId: "not-an-id", url: hub.origin }, { spaceId: hubId, url: `${hub.origin}/path` }, { spaceId: hubId, url: hub.origin, token: "short" }, { spaceId: hubId, url: hub.origin, extra: 1 }, { spaceId: hubId, url: hub.origin }]) {
    const r = await adopt(bad);
    expect(r.status).toBe(400);
    await r.body?.cancel();
  }
  // Naming the other connection's Space: it was not made by a migration, and that Space is no peer here.
  const claimed = await adopt({ spaceId: other.remoteSpaceId, url: hub.origin, token: "t".repeat(43) });
  expect(claimed.status).toBe(409);
  expect(snapshot()).toBe(before);
  expect(peer.connections.list()).toHaveLength(1);
  // The real migration leaves it as it was too.
  expect((await hub.migrate("box")).body.state).toBe("migrated");
  expect(snapshot()).toBe(before);
  // Over the connection the route does not exist, full trust or not.
  const conn = hub.connections.list()[0]!.id;
  const over = await hub.links.request(conn, { operation: "peer", method: "POST", path: "/api/peer/connections/adopt", headers: [["content-type", "application/json"]] }, new Response(JSON.stringify({ spaceId: hubId, url: hub.origin })).body);
  expect(over.status).toBe(403);
  expect(await over.json()).toMatchObject({ error: expect.stringContaining("not available over a connection") });
});

test("two hubs that list each other: one direction moved leaves the other working, and one connection serves both", async () => {
  const aSrv = server(), bSrv = server();
  const a = space("a", aSrv, { hubToken: "a-hub-token-0123456789", legacy: { b: { url: bSrv.url.origin, token: "b-hub-token-0123456789" } } });
  const b = space("b", bSrv, { hubToken: "b-hub-token-0123456789", legacy: { a: { url: aSrv.url.origin, token: "a-hub-token-0123456789" } } });
  await a.hub.refreshAll();
  await b.hub.refreshAll();
  expect((await a.migrate("b")).body).toMatchObject({ ok: true, state: "migrated" });
  expect(a.hub.get("b")!.via).toBe("connection");
  // B still reaches A over the legacy channel, and does not see A twice: A grants B nothing on the new connection yet.
  await b.hub.get("a")!.refresh();
  expect(b.hub.get("a")!.via).toBe("http");
  expect(b.hub.get("a")!.error).toBeUndefined();
  await b.catalogue.refresh();
  b.connectionPeers.sync();
  expect(b.hub.names()).toEqual(["a"]);
  expect(b.connectionPeers.status()[0]).toMatchObject({ state: "no-panel" });
  // The other direction reuses that connection: B dials A on it already.
  const back = await b.migrate("a");
  expect(back.body).toMatchObject({ ok: true, state: "migrated" });
  expect(back.body.steps[0]!.detail).toContain("one connection serves both directions");
  expect(a.connections.list()).toEqual([expect.objectContaining({ direction: "incoming", alias: "b", fullTrust: true })]);
  expect(b.connections.list()).toEqual([expect.objectContaining({ direction: "outgoing", alias: "a", fullTrust: true })]);
  expect(b.hub.get("a")!.via).toBe("connection");
  expect(b.hub.get("a")!.error).toBeUndefined();
  await a.hub.get("b")!.refresh();
  expect(a.hub.get("b")!.error).toBeUndefined();
  expect(await (await fetch(`${a.origin}/api/peers/b/apps/media/icon`)).json()).toMatchObject({ from: "b" });
  expect(await (await fetch(`${b.origin}/api/peers/a/apps/media/icon`)).json()).toMatchObject({ from: "a" });
});

test("space peer migrate --all moves every legacy peer through the running hub", async () => {
  const hubSrv = server(), oneSrv = server(), twoSrv = server();
  const one = space("one", oneSrv, { hubToken: "one-hub-token-0123456789" });
  const two = space("two", twoSrv, { hubToken: "two-hub-token-0123456789" });
  const hub = space("hub", hubSrv, { legacy: { one: { url: one.origin, token: "one-hub-token-0123456789" }, two: { url: two.origin, token: "two-hub-token-0123456789" } } });
  await hub.hub.refreshAll();
  const listed = await runCli(["--url", hub.origin, "--token", "op", "peer", "ls"], () => {}, { fetch });
  expect(listed.out.join("\n")).toContain("legacy");
  expect(listed.err.join("\n")).toContain("space peer migrate --all");
  const r = await runCli(["--url", hub.origin, "--token", "op", "peer", "migrate", "--all"], () => {}, { fetch });
  expect(r.code).toBe(0);
  expect(r.out.filter((l) => l.endsWith("migrated") || l.includes(": migrated"))).toHaveLength(2);
  expect(hub.hub.names().map((n) => hub.hub.get(n)!.via)).toEqual(["connection", "connection"]);
  const again = await runCli(["--url", hub.origin, "--token", "op", "peer", "migrate", "--all"], () => {}, { fetch });
  expect(again).toMatchObject({ code: 0 });
  expect(again.out).toContain("no peer on the legacy channel: nothing to migrate");
});


