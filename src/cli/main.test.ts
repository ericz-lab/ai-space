import { describe, expect, test } from "bun:test";
import { ALIASES, NOUNS, expandAlias, help, nounHelp } from "./main.ts";
import { runCli } from "./testing.ts";
import { EXIT } from "./types.ts";

const task = (over: Record<string, unknown> = {}) => ({
  id: "11111111-2222-3333-4444-555555555555",
  app: "demo",
  name: "tick",
  source: "manifest",
  orphaned: false,
  enabled: true,
  schedule: { kind: "every", everyMs: 3_600_000 },
  target: { kind: "command", command: "echo hi" },
  timeoutMs: 600_000,
  triggers: [],
  state: { consecutiveErrors: 0, lastRunAt: new Date(Date.now() - 60_000).toISOString(), lastStatus: "ok", nextRunAt: new Date(Date.now() + 3_540_000).toISOString() },
  ...over,
});

describe("help and dispatch", () => {
  test("no arguments, help, and a noun's help", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.join("\n")).toContain("usage: space <command>");
    for (const n of NOUNS) expect(r.out.join("\n")).toContain(`  ${n.name}`);
    const t = await runCli(["task", "help"]);
    expect(t.out[0]).toBe("usage: space task <verb> [args]");
    expect(t.out.join("\n")).toContain("run TASK [--wait]");
    expect((await runCli(["--help"])).out.join("\n")).toContain("usage: space <command>");
    expect((await runCli(["help", "logs"])).out[0]).toBe("usage: space logs APP [-n 100] [-f]");
  });

  test("a noun alone prints its help, unless its default verb takes nothing", async () => {
    expect((await runCli(["logs"])).out[0]).toContain("usage: space logs");
    expect((await runCli(["notify"])).out[0]).toContain("usage: space notify");
    const s = await runCli(["status"], (t) => t.scripted.reply(new Error("down")));
    expect(s.code).toBe(EXIT.unreachable);
  });

  test("unknown command and verb exit 2", async () => {
    const a = await runCli(["frob"]);
    expect(a.code).toBe(EXIT.usage);
    expect(a.err[0]).toContain("unknown command: frob");
    const b = await runCli(["task", "frob"]);
    expect(b.code).toBe(EXIT.usage);
    expect(b.err[0]).toContain("unknown verb: task frob");
  });

  test("a usage error prints the message and the verb's usage", async () => {
    const r = await runCli(["task", "show"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toEqual(["space: TASK is required", "usage: space task show TASK"]);
  });

  test("exit codes: refused is 1, unreachable is 3", async () => {
    const refused = await runCli(["task", "ls"], (t) => t.scripted.reply({ status: 500, body: { ok: false, error: "boom" } }));
    expect(refused.code).toBe(EXIT.failed);
    expect(refused.err[0]).toBe("space: task ls: 500: boom");
    const down = await runCli(["task", "ls"], (t) => t.scripted.reply(new Error("ECONNREFUSED")));
    expect(down.code).toBe(EXIT.unreachable);
    expect(down.err[0]).toContain("not reachable at http://127.0.0.1:8700");
  });

  test("global flags sit anywhere: --url, --token, --json", async () => {
    const r = await runCli(["task", "--url", "http://h:9", "ls", "--token", "tt", "--json"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task()] } }));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ url: "http://h:9/api/tasks", headers: { authorization: "Bearer tt" } });
    expect(JSON.parse(r.out.join("\n"))).toMatchObject({ ok: true, tasks: [{ name: "tick" }] });
  });

  test("the older spellings are aliases", () => {
    expect(expandAlias(["backup", "demo"])).toEqual(["backup", "run", "demo"]);
    expect(expandAlias(["backup", "ls"])).toEqual(["backup", "ls"]);
    expect(expandAlias(["backups"])).toEqual(["backup", "ls"]);
    expect(expandAlias(["backup-verify", "a"])).toEqual(["backup", "verify", "a"]);
    expect(expandAlias(["restore", "a", "--to", "d"])).toEqual(["backup", "restore", "a", "--to", "d"]);
    expect(expandAlias(["model-import", "a", "f"])).toEqual(["model", "import", "a", "f"]);
    expect(expandAlias(["chat-import", "a", "f"])).toEqual(["chat", "import", "a", "f"]);
    expect(expandAlias(["env", "a"])).toEqual(["app", "env", "a"]);
    expect(expandAlias(["task", "ls"])).toEqual(["task", "ls"]);
    for (const [word, [noun, verb]] of Object.entries(ALIASES)) expect(NOUNS.find((n) => n.name === noun)?.verbs[verb!]).toBeDefined();
  });

  test("help lists every noun and a noun's verbs", () => {
    const h = help().join("\n");
    for (const n of NOUNS) expect(h).toContain(n.name);
    const t = nounHelp(NOUNS.find((n) => n.name === "task")!).join("\n");
    for (const v of Object.keys(NOUNS.find((n) => n.name === "task")!.verbs)) expect(t).toContain(`  ${v} `);
  });
});

describe("task", () => {
  test("ls prints one row per task with schedule, state and next run", async () => {
    const r = await runCli(["task", "ls"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task(), task({ name: "old", orphaned: true }), task({ name: "fail", state: { consecutiveErrors: 3, lastStatus: "error", lastRunAt: new Date().toISOString() } })] } }));
    expect(r.code).toBe(0);
    expect(r.out[0]).toMatch(/^TASK +SCHEDULE +ON +LAST RUN +STATUS +NEXT$/);
    expect(r.out[1]).toMatch(/^demo\/tick +every 1h +yes +1m ago +ok +in 59m$/);
    expect(r.out[2]).toMatch(/^demo\/fail +every 1h +yes +just now +error ×3/);
    expect(r.out).toHaveLength(3);
    expect((await runCli(["task", "ls", "--all"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task({ orphaned: true })] } }))).out[1]).toContain("orphaned");
  });

  test("a task is found by app/name, by a unique bare name, or by id", async () => {
    const list = { status: 200, body: { ok: true, tasks: [task(), task({ app: "other", name: "sync" })] } };
    const r = await runCli(["task", "run", "demo/tick"], (t) => t.scripted.reply(list, { status: 202, body: { ok: true, started: true, task: task() } }));
    expect(r.code).toBe(0);
    expect(r.calls[1]).toMatchObject({ method: "POST", url: `http://127.0.0.1:8700/api/tasks/${task().id}/run` });
    expect(r.out).toEqual(["demo/tick: started"]);
    const bare = await runCli(["task", "run", "sync"], (t) => t.scripted.reply(list, { status: 202, body: { ok: true, started: true, task: task() } }));
    expect(bare.code).toBe(0);
    const byId = await runCli(["task", "run", task().id], (t) => t.scripted.reply({ status: 200, body: { ok: true, task: task() } }, { status: 202, body: { ok: true, started: true, task: task() } }));
    expect(byId.calls[0]!.url).toContain(`/api/tasks/${task().id}`);
    const missing = await runCli(["task", "run", "nope"], (t) => t.scripted.reply(list));
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err[0]).toContain("unknown task: nope");
  });

  test("run --wait follows the run and exits with its status", async () => {
    const started = Date.now();
    const r = await runCli(["task", "run", "demo/tick", "--wait"], (t) =>
      t.scripted.reply(
        { status: 200, body: { ok: true, tasks: [task()] } },
        { status: 202, body: { ok: true, started: true, task: task() } },
        { status: 200, body: { ok: true, runs: [] } },
        { status: 200, body: { ok: true, runs: [{ id: 1, taskId: task().id, startedAt: started + 10, endedAt: started + 300, status: "error", error: "exit code 1", output: "boom", trigger: "manual" }] } },
      ),
    );
    expect(r.code).toBe(EXIT.failed);
    expect(r.out).toEqual(["demo/tick: error in 290ms · exit code 1", "boom"]);
  });

  test("a run that does not start is reported", async () => {
    const r = await runCli(["task", "run", "demo/tick"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task()] } }, { status: 409, body: { ok: true, started: false, task: task() } }));
    expect(r.code).toBe(EXIT.failed);
    expect(r.err[0]).toContain("not started");
  });

  test("enable, disable and --reset patch the override", async () => {
    const r = await runCli(["task", "disable", "demo/tick"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task()] } }, { status: 200, body: { ok: true, task: task({ enabled: false }) } }));
    expect(r.calls[1]).toMatchObject({ method: "PATCH", body: { enabled: false } });
    expect(r.out).toEqual(["demo/tick: disabled"]);
    const reset = await runCli(["task", "enable", "demo/tick", "--reset"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task()] } }, { status: 200, body: { ok: true, task: task() } }));
    expect(reset.calls[1]).toMatchObject({ body: { enabled: null } });
  });

  test("create builds the body from flags and rm refuses a manifest task", async () => {
    const r = await runCli(["task", "create", "--app", "demo", "--name", "hourly", "--every", "1h", "--command", "echo hi", "--timeout", "5m"], (t) => t.scripted.reply({ status: 201, body: { ok: true, task: task({ name: "hourly", source: "api" }) } }));
    expect(r.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8700/api/tasks", body: { app: "demo", name: "hourly", schedule: { kind: "every", everyMs: 3_600_000 }, target: { kind: "command", command: "echo hi" }, timeoutMs: 300_000 } });
    expect(r.out[0]).toContain("demo/hourly: created");
    const rm = await runCli(["task", "rm", "demo/tick", "--yes"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task()] } }));
    expect(rm.code).toBe(EXIT.usage);
    expect(rm.err[0]).toContain("space.yaml");
    const ok = await runCli(["task", "rm", "demo/tick", "--yes"], (t) => t.scripted.reply({ status: 200, body: { ok: true, tasks: [task({ source: "api" })] } }, { status: 200, body: { ok: true } }));
    expect(ok.calls[1]).toMatchObject({ method: "DELETE" });
  });
});

describe("other nouns", () => {
  test("logs prints the text as is, and follows a stream", async () => {
    const r = await runCli(["logs", "demo", "-n", "5"], (t) => t.scripted.reply(new Response("a\nb\n", { headers: { "content-type": "text/plain" } })));
    expect(r.calls[0]!.url).toBe("http://127.0.0.1:8700/api/apps/demo/logs?lines=5");
    expect(r.out).toEqual(["a", "b"]);
    const sse = 'event: line\ndata: "x"\n\nevent: line\ndata: "y"\n\nevent: end\ndata: {"code":0}\n\n';
    const f = await runCli(["logs", "space", "-f"], (t) => t.scripted.reply(new Response(sse, { headers: { "content-type": "text/event-stream" } })));
    expect(f.calls[0]!.url).toContain("/api/apps/space/logs?lines=100&follow=1");
    expect(f.out).toEqual(["x", "y"]);
    expect(f.code).toBe(0);
  });

  test("notify send presents the app token inside a task and keeps the older flags", async () => {
    const r = await runCli(["notify", "send", "--level", "warn", "--title", "T", "hello", "there"], (t) => t.scripted.reply({ status: 202, body: { ok: true, notification: { id: "n1", deliveries: [{ channel: "default", status: "queued" }] } } }), { env: { SPACE_HOME: "/nonexistent/x", SPACE_APP: "demo", SPACE_APP_TOKEN: "sat_1", SPACE_API_TOKEN: "op" } });
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8700/api/notify", headers: { authorization: "Bearer sat_1" }, body: { app: "demo", level: "warn", title: "T", text: "hello there" } });
    expect(r.err[0]).toBe("notify: n1 default=queued");
    const alias = await runCli(["notify", "--app", "demo", "hi"], (t) => t.scripted.reply({ status: 202, body: { ok: true, notification: { id: "n2", deliveries: [] } } }));
    expect(alias.calls[0]).toMatchObject({ body: { app: "demo", text: "hi" } });
    const noApp = await runCli(["notify", "send", "hi"]);
    expect(noApp.code).toBe(EXIT.usage);
    expect(noApp.err[0]).toContain("--app is required");
  });

  test("notify send keeps the undelivered text on stderr when nothing answers", async () => {
    const r = await runCli(["notify", "send", "--app", "demo", "lost"], (t) => t.scripted.reply(new Error("ECONNREFUSED")));
    expect(r.code).toBe(EXIT.unreachable);
    expect(r.err[0]).toContain("undelivered message from demo: lost");
  });

  test("app ls, hide, and uninstall asks first", async () => {
    const apps = [{ id: "a", name: "a", title: "A", status: "active", manifestOnly: false, hidden: false, service: { port: 8710, health: "ok" }, url: "https://a.example", agents: [], widgets: [] }];
    const r = await runCli(["app", "ls"], (t) => t.scripted.reply({ status: 200, body: { ok: true, apps } }));
    expect(r.calls[0]!.url).toBe("http://127.0.0.1:8700/api/apps?all=1");
    expect(r.out[1]).toMatch(/^a +A +active +:8710 ok +https:\/\/a\.example$/);
    const hide = await runCli(["app", "hide", "a"], (t) => t.scripted.reply({ status: 200, body: { ok: true, app: { ...apps[0], hidden: true } } }));
    expect(hide.calls[0]).toMatchObject({ method: "PATCH", body: { hidden: true } });
    const ask = await runCli(["app", "uninstall", "a"]);
    expect(ask.code).toBe(EXIT.usage);
    expect(ask.err[0]).toContain("--yes");
    expect(ask.calls).toHaveLength(0);
    const declined = await runCli(["app", "uninstall", "a"], () => {}, { isTTY: true, prompt: async () => "n" });
    expect(declined.code).toBe(EXIT.failed);
    expect(declined.calls).toHaveLength(0);
    const done = await runCli(["app", "uninstall", "a", "--yes"], (t) => t.scripted.reply({ status: 200, body: { ok: true, app: "a", stopped: "ok", dir: { kind: "moved", to: "/trash/a" }, data: "/d/a" } }));
    expect(done.calls[0]).toMatchObject({ method: "DELETE", url: "http://127.0.0.1:8700/api/apps/a" });
    expect(done.out[0]).toBe("a: service ok; directory moved to /trash/a; data kept at /d/a");
  });

  test("model usage prints the totals line and the by-app table", async () => {
    const totals = { calls: 3, errors: 1, inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 500, outputTokens: 200, tokens: 1700, costUsd: 0.05, durationMs: 3000 };
    const r = await runCli(["model", "usage", "--window", "7d"], (t) => t.scripted.reply({ status: 200, body: { ok: true, window: "7d", since: "x", backend: "b", totals, byApp: [{ app: "demo", ...totals }], byTag: [], byModel: [], byRuntime: [], history: { totals } } }));
    expect(r.calls[0]!.url).toBe("http://127.0.0.1:8700/api/model/usage?window=7d");
    expect(r.out[0]).toBe("last 7d: 3 calls, 1 errors, 1.7k tokens, $0.05");
    expect(r.out[3]).toMatch(/^demo +3 +1 +1\.0k +500\/0 +200 +\$0\.05 +1\.0s\/call$/);
  });

  test("event emit and api pass bodies through", async () => {
    const r = await runCli(["event", "emit", "ping", "--app", "demo", "--data", '{"x":1}'], (t) => t.scripted.reply({ status: 202, body: { ok: true, event: { id: 1, name: "demo/ping", app: "demo", at: "x" }, matched: ["demo/tick"] } }));
    expect(r.calls[0]).toMatchObject({ method: "POST", body: { name: "ping", app: "demo", data: { x: 1 } } });
    expect(r.out[0]).toBe("demo/ping #1: matched demo/tick");
    const api = await runCli(["api", "post", "/api/x", "-"], (t) => t.scripted.reply({ status: 200, body: { ok: true } }), { stdin: async () => '{"a":1}' });
    expect(api.calls[0]).toMatchObject({ method: "POST", url: "http://127.0.0.1:8700/api/x", body: { a: 1 } });
    expect(api.out.join("\n")).toBe('{\n  "ok": true\n}');
    const bad = await runCli(["api", "GET", "/api/x"], (t) => t.scripted.reply({ status: 404, body: { ok: false, error: "not found" } }));
    expect(bad.code).toBe(EXIT.failed);
  });

  test("status composes the routes and names what is wrong", async () => {
    const r = await runCli(["status"], (t) =>
      t.scripted.reply(
        { status: 200, body: { ok: true } },
        { status: 200, body: { ok: true, services: [{ app: "a", port: 1, health: "ok" }, { app: "b", port: 2, health: "down" }], peers: [] } },
        { status: 200, body: { ok: true, tasks: [task(), task({ name: "fail", state: { consecutiveErrors: 2, lastStatus: "error", lastError: "exit code 1" } })] } },
        { status: 200, body: { ok: true, target: "s3://b/", backups: [{ app: "a", stale: true }] } },
        { status: 200, body: { ok: true, runtimes: [{ name: "claude", default: true }], maxConcurrency: 4, running: 1, waiting: 0 } },
        { status: 200, body: { ok: true, peers: [] } },
      ),
    );
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe("ai-space at http://127.0.0.1:8700: ok");
    expect(r.out[2]).toBe("services  2 · 1 up · 1 DOWN: b");
    expect(r.out[3]).toBe("tasks     2 · 2 enabled · 1 FAILING: demo/fail");
    expect(r.out[4]).toBe("backups   1 apps → s3://b/ · 1 STALE: a");
    expect(r.out[5]).toBe("model     claude* · 1 running, 0 waiting (cap 4)");
    expect(r.out.at(-1)).toMatch(/^demo\/fail .*exit code 1$/);
  });
});
