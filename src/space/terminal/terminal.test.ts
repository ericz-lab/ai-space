import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PeerHub } from "../peers/hub.ts";
import { createPeerServeRoutes } from "../peers/serve.ts";
import { PASSPHRASE_HEADER, createTerminalRoutes, sameOrigin, terminalWebSocket } from "./api.ts";
import { type TerminalConfig, loadTerminalConfig, parseIdle, parseShell, sessionEnv } from "./config.ts";
import { PASSPHRASE_TRIES, TerminalService } from "./service.ts";
import { TerminalStore } from "./store.ts";

// Real shells in real pseudo-terminals, through the routes a browser uses, then through a hub.

const CONFIG: TerminalConfig = { enabled: true, shell: ["/bin/sh"], passphrase: "", idleMs: 0, maxSessions: 2 };
const quiet = () => {};

type Client = {
  ws: WebSocket;
  out: () => string;
  controls: Record<string, unknown>[];
  send: (text: string) => void;
  waitFor: (re: RegExp, ms?: number) => Promise<string>;
  waitControl: (type: string, ms?: number) => Promise<Record<string, unknown>>;
  closed: Promise<{ code: number; reason: string }>;
};

function connect(url: string): Client {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let out = "";
  const controls: Record<string, unknown>[] = [];
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    if (typeof e.data === "string") controls.push(JSON.parse(e.data) as Record<string, unknown>);
    else out += dec.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true });
  };
  const closed = new Promise<{ code: number; reason: string }>((res) => (ws.onclose = (e) => res({ code: e.code, reason: e.reason })));
  const until = async <T>(probe: () => T | undefined, ms: number, what: string): Promise<T> => {
    const t0 = Date.now();
    for (;;) {
      const v = probe();
      if (v !== undefined) return v;
      if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}; output so far: ${JSON.stringify(out)} controls: ${JSON.stringify(controls)}`);
      await Bun.sleep(20);
    }
  };
  return {
    ws,
    out: () => out,
    controls,
    send: (text) => ws.send(new TextEncoder().encode(text)),
    waitFor: (re, ms = 5000) => until(() => (re.test(out) ? out : undefined), ms, String(re)),
    waitControl: (type, ms = 5000) => until(() => controls.find((c) => c.type === type), ms, `control ${type}`),
    closed,
  };
}

const j = async (r: Response) => (await r.json()) as Record<string, unknown> & { ok: boolean; error?: string; ticket?: string; id?: string };
const post = (base: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) =>
  fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const wsUrl = (base: string, path: string, ticket: string) => `${base.replace(/^http/, "ws")}${path}?ticket=${encodeURIComponent(ticket)}`;

describe("config", () => {
  test("off by default; every value has a safe default", () => {
    const { config, warnings } = loadTerminalConfig({ SHELL: "/bin/zsh" });
    expect(config.enabled).toBe(false);
    expect(config.shell).toEqual(["/bin/zsh", "-l"]);
    expect(config.idleMs).toBe(30 * 60_000);
    expect(config.maxSessions).toBe(4);
    expect(config.passphrase).toBe("");
    expect(warnings).toEqual([]);
  });

  test("reads the variables and warns on the bad ones", () => {
    const { config, warnings } = loadTerminalConfig({ SPACE_TERMINAL_ENABLED: "yes", SPACE_TERMINAL_SHELL: "/usr/bin/fish --login", SPACE_TERMINAL_IDLE: "2h", SPACE_TERMINAL_MAX_SESSIONS: "0", SPACE_TERMINAL_PASSPHRASE: "short" });
    expect(config).toMatchObject({ enabled: true, shell: ["/usr/bin/fish", "--login"], idleMs: 7_200_000, maxSessions: 4, passphrase: "short" });
    expect(warnings.join("\n")).toContain("SPACE_TERMINAL_MAX_SESSIONS");
    expect(warnings.join("\n")).toContain("shorter than 8");
  });

  test("durations", () => {
    expect(parseIdle("0")).toBe(0);
    expect(parseIdle("90s")).toBe(90_000);
    expect(parseIdle("5s")).toBe(10_000); // floor
    expect(parseIdle("45m")).toBe(2_700_000);
    expect(() => parseIdle("soon")).toThrow(/not a duration/);
    expect(parseShell("", {})[0]).toMatch(/\/(bash|sh)$/);
  });

  test("session environment drops credentials and sets the terminal type", () => {
    const env = sessionEnv({ HOME: "/home/x", SPACE_API_TOKEN: "t", SPACE_HUB_TOKEN: "h", SPACE_PEER_DAVID_TOKEN: "p", SPACE_S3_SECRET_ACCESS_KEY: "s", GH_TOKEN: "g", ANTHROPIC_API_KEY: "k", SPACE_TERMINAL_PASSPHRASE: "pp", PATH: "/bin", LANG: "en_US.UTF-8" }, { SPACE_HOME: "/w" });
    expect(Object.keys(env).sort()).toEqual(["COLORTERM", "HOME", "LANG", "PATH", "SPACE_HOME", "TERM"]);
    expect(env.TERM).toBe("xterm-256color");
  });
});

describe("same origin", () => {
  const req = (h: Record<string, string>) => new Request("http://x/api/terminal/sessions", { method: "POST", headers: h });
  test("browser requests must come from the panel's own origin", () => {
    expect(sameOrigin(req({ host: "space.example.com", origin: "https://space.example.com" }))).toBe(true);
    expect(sameOrigin(req({ host: "space.example.com", origin: "https://evil.example.com" }))).toBe(false);
    expect(sameOrigin(req({ host: "space.example.com", origin: "null" }))).toBe(false);
    expect(sameOrigin(req({ host: "127.0.0.1:8700", "x-forwarded-host": "space.example.com", origin: "https://space.example.com" }))).toBe(true);
    expect(sameOrigin(req({ host: "x", "sec-fetch-site": "cross-site" }))).toBe(false);
    expect(sameOrigin(req({ host: "x", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(sameOrigin(req({ host: "x" }))).toBe(true); // no browser headers at all: a script on the machine, a hub
  });
});

describe("local sessions", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let service: TerminalService;
  let store: TerminalStore;
  let clock = 1_000_000;

  beforeAll(() => {
    store = new TerminalStore(new Database(":memory:"));
    service = new TerminalService({ config: { ...CONFIG, idleMs: 60_000 }, cwd: "/", store, now: () => clock, sweepMs: 30, ticketTtlMs: 500, log: quiet, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createTerminalRoutes({ service, name: "box" }), websocket: terminalWebSocket, fetch: () => new Response("404", { status: 404 }) });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    service.stop();
    server.stop(true);
  });

  test("status names the machine and the backend", async () => {
    const s = await j(await fetch(`${base}/api/terminal`));
    expect(s).toMatchObject({ ok: true, enabled: true, shell: "/bin/sh", passphrase: false, idleMs: 60_000, maxSessions: 2, active: 0, machines: [{ name: "box", enabled: true, health: "ok" }], sessions: [], recent: [] });
    expect(["bun", "python"]).toContain(String(s.backend));
  });

  test("a cross-origin page cannot open or end a session", async () => {
    expect((await post(base, "/api/terminal/sessions", {}, { origin: "https://evil.example.com" })).status).toBe(403);
    expect((await fetch(`${base}/api/terminal/sessions/x`, { method: "DELETE", headers: { origin: "https://evil.example.com" } })).status).toBe(403);
    expect((await fetch(`${base}/api/terminal/ws?ticket=x`, { headers: { origin: "https://evil.example.com" } })).status).toBe(403);
  });

  test("a shell runs in a pseudo-terminal: echo, resize, exit code, audit row", async () => {
    const t = await j(await post(base, "/api/terminal/sessions", { cols: 100, rows: 30 }, { origin: base, "user-agent": "test-browser" }));
    expect(t.ok).toBe(true);
    expect(t.expiresIn).toBe(500);
    expect(service.list()).toMatchObject([{ id: t.id, state: "pending", cols: 100, rows: 30, agent: "test-browser" }]);

    const c = connect(wsUrl(base, "/api/terminal/ws", t.ticket!));
    const ready = await c.waitControl("ready");
    expect(ready).toMatchObject({ id: t.id, shell: "/bin/sh", idleMs: 60_000 });
    expect(service.list()).toMatchObject([{ id: t.id, state: "open" }]);

    c.send("stty size; echo marco-$((20+22))\n");
    await c.waitFor(/marco-42/);
    expect(c.out()).toMatch(/30 100/);

    c.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await Bun.sleep(100);
    c.send("stty size\n");
    await c.waitFor(/40 120/);

    // The environment: credentials are gone, the session id is there, TERM is set.
    c.send("echo T=$TERM S=$SPACE_TERMINAL_SESSION\n");
    await c.waitFor(new RegExp(`T=xterm-256color S=${t.id}`));

    c.send("exit 7\n");
    const exit = await c.waitControl("exit");
    expect(exit).toMatchObject({ code: 7 });
    expect(await c.closed).toMatchObject({ code: 1000, reason: "exit" });
    expect(service.list()).toEqual([]);
    // The audit row keeps the size the session opened with; later resizes are not tracked.
    expect(store.recent()).toMatchObject([{ id: t.id, exitCode: 7, reason: "exit", agent: "test-browser", cols: 100, rows: 30 }]);
    expect(store.recent()[0]!.bytesOut).toBeGreaterThan(20);
  });

  test("a ticket works once and expires", async () => {
    const t = await j(await post(base, "/api/terminal/sessions", {}, { origin: base }));
    const a = connect(wsUrl(base, "/api/terminal/ws", t.ticket!));
    await a.waitControl("ready");
    expect((await fetch(`${base}/api/terminal/ws?ticket=${t.ticket}`)).status).toBe(401);
    expect((await fetch(`${base}/api/terminal/ws?ticket=nope`)).status).toBe(401);
    expect((await fetch(`${base}/api/terminal/ws`)).status).toBe(401);
    a.ws.close(1000, "done");
    await a.closed;

    const late = await j(await post(base, "/api/terminal/sessions", {}, { origin: base }));
    clock += 1_000;
    expect((await fetch(`${base}/api/terminal/ws?ticket=${late.ticket}`)).status).toBe(401);
    await Bun.sleep(80); // the sweep forgets it
    expect(service.list()).toEqual([]);
  });

  test("the browser leaving hangs the shell up", async () => {
    const t = await j(await post(base, "/api/terminal/sessions", {}, { origin: base }));
    const c = connect(wsUrl(base, "/api/terminal/ws", t.ticket!));
    await c.waitControl("ready");
    c.send("echo alive\n");
    await c.waitFor(/alive/);
    c.ws.close(1000, "tab closed");
    await c.closed;
    await Bun.sleep(150);
    expect(service.list()).toEqual([]);
    expect(store.recent().find((r) => r.id === t.id)).toMatchObject({ reason: "closed", exitCode: null });
  });

  test("the cap counts open sessions and unredeemed tickets; the operator can end one", async () => {
    const a = await j(await post(base, "/api/terminal/sessions", {}, { origin: base }));
    const b = await j(await post(base, "/api/terminal/sessions", {}, { origin: base }));
    const over = await post(base, "/api/terminal/sessions", {}, { origin: base });
    expect(over.status).toBe(429);
    expect(String((await j(over)).error)).toContain("2 terminal sessions already open");
    const c = connect(wsUrl(base, "/api/terminal/ws", a.ticket!));
    await c.waitControl("ready");
    expect((await fetch(`${base}/api/terminal/sessions/${a.id}`, { method: "DELETE", headers: { origin: base } })).status).toBe(200);
    expect(await c.closed).toMatchObject({ code: 4000, reason: "killed" });
    expect(c.controls.find((x) => x.type === "closed")).toMatchObject({ reason: "killed" });
    expect((await fetch(`${base}/api/terminal/sessions/${b.id}`, { method: "DELETE", headers: { origin: base } })).status).toBe(200);
    expect((await fetch(`${base}/api/terminal/sessions/${b.id}`, { method: "DELETE", headers: { origin: base } })).status).toBe(404);
    expect(service.list()).toEqual([]);
  });

  test("an idle session is closed and says why", async () => {
    const t = await j(await post(base, "/api/terminal/sessions", {}, { origin: base }));
    const c = connect(wsUrl(base, "/api/terminal/ws", t.ticket!));
    await c.waitControl("ready");
    c.send("echo hi\n");
    // The output line, not the echoed input (nor "this shell" in a bash notice): the keystroke must be
    // processed before the clock moves, or it counts as fresh input.
    await c.waitFor(/\nhi\r?\n/);
    clock += 61_000;
    expect(await c.closed).toMatchObject({ code: 4000, reason: "idle" });
    expect(store.recent().find((r) => r.id === t.id)).toMatchObject({ reason: "idle" });
  });
});

describe("passphrase and disabled", () => {
  test("required, wrong, locked after repeated failures, right", async () => {
    let clock = 5_000_000;
    const service = new TerminalService({ config: { ...CONFIG, passphrase: "correct horse" }, cwd: "/", now: () => clock, log: quiet, backend: "python" });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createTerminalRoutes({ service, name: "box" }), websocket: terminalWebSocket, fetch: () => new Response("404", { status: 404 }) });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await j(await fetch(`${base}/api/terminal`))).passphrase).toBe(true);
      let r = await post(base, "/api/terminal/sessions", {}, { origin: base });
      expect([r.status, (await j(r)).error]).toEqual([401, "passphrase required"]);
      for (let i = 0; i < PASSPHRASE_TRIES - 1; i++) {
        r = await post(base, "/api/terminal/sessions", {}, { origin: base, [PASSPHRASE_HEADER]: "wrong" });
        expect([r.status, (await j(r)).error]).toEqual([401, "passphrase wrong"]);
      }
      r = await post(base, "/api/terminal/sessions", {}, { origin: base, [PASSPHRASE_HEADER]: "wrong" });
      expect(r.status).toBe(429);
      // Locked out even with the right one, until the lockout passes.
      expect((await post(base, "/api/terminal/sessions", {}, { origin: base, [PASSPHRASE_HEADER]: "correct horse" })).status).toBe(429);
      clock += 61_000;
      const ok = await j(await post(base, "/api/terminal/sessions", {}, { origin: base, [PASSPHRASE_HEADER]: "correct horse" }));
      expect(ok.ok).toBe(true);
      expect(typeof ok.ticket).toBe("string");
    } finally {
      service.stop();
      server.stop(true);
    }
  });

  test("off: the status says so and nothing opens", async () => {
    const service = new TerminalService({ config: { ...CONFIG, enabled: false }, cwd: "/", log: quiet });
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createTerminalRoutes({ service, name: "box" }), websocket: terminalWebSocket, fetch: () => new Response("404", { status: 404 }) });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect(await j(await fetch(`${base}/api/terminal`))).toMatchObject({ ok: true, enabled: false, machines: [{ name: "box", enabled: false }] });
      const r = await post(base, "/api/terminal/sessions", {}, { origin: base });
      expect(r.status).toBe(404);
      expect((await j(r)).error).toContain("SPACE_TERMINAL_ENABLED");
    } finally {
      server.stop(true);
    }
  });
});

describe("through a hub", () => {
  let peerServer: ReturnType<typeof Bun.serve>;
  let hubServer: ReturnType<typeof Bun.serve>;
  let hub = "";
  let peerService: TerminalService;
  let hubService: TerminalService;
  let peers: PeerHub;

  // A peer with no apps: the lists the snapshot bundles, and stubs for the routes the peer side mirrors.
  const gone = () => Response.json({ ok: false, error: "none" }, { status: 404 });
  const lists = {
    "/api/apps": { GET: () => Response.json({ ok: true, apps: [] }) },
    "/api/services": { GET: () => Response.json({ ok: true, services: [] }) },
    "/api/widgets": { GET: () => Response.json({ ok: true, widgets: [] }) },
    "/api/agents": { GET: () => Response.json({ ok: true, agents: [] }) },
    "/api/apps/:app": { DELETE: gone },
    "/api/apps/:app/icon": { GET: gone },
    "/api/panel/appcolor": { GET: gone },
    "/api/agents/:app/:agent/avatar": { GET: gone },
    "/api/widgets/:app/:name/embed": { GET: gone },
    "/api/agents/:app/:agent/chat": { POST: gone },
    "/api/agents/:app/:agent/sessions": { GET: gone },
    "/api/agents/:app/:agent/sessions/:sid": { GET: gone },
  };

  beforeAll(async () => {
    peerService = new TerminalService({ config: { ...CONFIG, passphrase: "peer-pass-1" }, cwd: "/", log: quiet, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    const peerTerminal = createTerminalRoutes({ service: peerService, name: "david" });
    peerServer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      routes: { ...peerTerminal, ...createPeerServeRoutes({ token: "s3cret", name: "david", panel: lists, agents: lists, terminal: peerTerminal }) },
      websocket: terminalWebSocket,
      fetch: () => new Response("404", { status: 404 }),
    });
    const peerBase = `http://127.0.0.1:${peerServer.port}`;

    hubService = new TerminalService({ config: { ...CONFIG, enabled: false }, cwd: "/", log: quiet });
    peers = new PeerHub([
      { name: "david", url: peerBase, token: "s3cret", headers: {}, refreshMs: 10_000 },
      { name: "wrong", url: peerBase, token: "nope", headers: {}, refreshMs: 10_000 },
    ]);
    await peers.refreshAll();
    hubServer = Bun.serve({ port: 0, hostname: "127.0.0.1", routes: createTerminalRoutes({ service: hubService, name: "hub", hub: peers }), websocket: terminalWebSocket, fetch: () => new Response("404", { status: 404 }) });
    hub = `http://127.0.0.1:${hubServer.port}`;
  });
  afterAll(() => {
    peers.stop();
    peerService.stop();
    peerServer.stop(true);
    hubServer.stop(true);
  });

  test("the machine list shows which peers offer a terminal", async () => {
    const s = await j(await fetch(`${hub}/api/terminal`));
    expect(s.machines).toEqual([
      { name: "hub", enabled: false, health: "ok" },
      { name: "david", peer: "david", enabled: true, health: "ok" },
      { name: "wrong", peer: "wrong", enabled: false, health: "down" },
    ]);
    expect(peers.get("david")?.snapshot?.terminal).toBe(true);
  });

  test("the peer's routes need the hub token", async () => {
    const peerBase = peers.get("david")!.config.url;
    expect((await fetch(`${peerBase}/api/peer/terminal`)).status).toBe(401);
    expect((await post(peerBase, "/api/peer/terminal/sessions")).status).toBe(401);
    expect((await fetch(`${peerBase}/api/peer/terminal/ws?ticket=x`)).status).toBe(401);
    expect((await fetch(`${peerBase}/api/peer/terminal`, { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);
  });

  test("a session on the peer, opened and bridged by the hub, with the passphrase passed through", async () => {
    const status = await j(await fetch(`${hub}/api/peers/david/terminal`));
    expect(status).toMatchObject({ ok: true, enabled: true, passphrase: true, machines: [{ name: "david" }] });

    let r = await post(hub, "/api/peers/david/terminal/sessions", {}, { origin: hub });
    expect([r.status, (await j(r)).error]).toEqual([401, "passphrase required"]);
    expect((await post(hub, "/api/peers/david/terminal/sessions", {}, { origin: "https://evil.example.com", [PASSPHRASE_HEADER]: "peer-pass-1" })).status).toBe(403);

    r = await post(hub, "/api/peers/david/terminal/sessions", { cols: 90, rows: 25 }, { origin: hub, [PASSPHRASE_HEADER]: "peer-pass-1" });
    const t = await j(r);
    expect(t.ok).toBe(true);
    expect(peerService.list()).toMatchObject([{ id: t.id, state: "pending", cols: 90, rows: 25 }]);

    const c = connect(wsUrl(hub, "/api/peers/david/terminal/ws", t.ticket!));
    await c.waitControl("ready");
    c.send("stty size; echo via-hub-$((6*7))\n");
    await c.waitFor(/via-hub-42/);
    expect(c.out()).toMatch(/25 90/);
    c.ws.send(JSON.stringify({ type: "resize", cols: 70, rows: 20 }));
    await Bun.sleep(100);
    c.send("stty size\n");
    await c.waitFor(/20 70/);

    // Ending it from the hub reaches the peer.
    expect((await fetch(`${hub}/api/peers/david/terminal/sessions/${t.id}`, { method: "DELETE", headers: { origin: hub } })).status).toBe(200);
    expect(await c.closed).toMatchObject({ code: 4000, reason: "killed" });
    await Bun.sleep(50);
    expect(peerService.list()).toEqual([]);
  });

  test("a bad ticket, a wrong token or an unknown peer never reach a shell", async () => {
    const bad = connect(wsUrl(hub, "/api/peers/david/terminal/ws", "nope"));
    const closed = await bad.closed;
    expect(closed.code).toBe(4002);
    expect(closed.reason).toContain("refused");

    const t = await j(await post(hub, "/api/peers/david/terminal/sessions", {}, { origin: hub, [PASSPHRASE_HEADER]: "peer-pass-1" }));
    const viaWrong = connect(wsUrl(hub, "/api/peers/wrong/terminal/ws", t.ticket!));
    expect((await viaWrong.closed).code).toBe(4002);
    expect(peerService.list()).toMatchObject([{ state: "pending" }]); // the ticket was never redeemed
    peerService.kill(t.id as string);

    expect((await fetch(`${hub}/api/peers/nobody/terminal`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/nobody/terminal/ws?ticket=x`)).status).toBe(404);
    expect((await fetch(`${hub}/api/peers/david/terminal/ws`)).status).toBe(401);
  });
});
