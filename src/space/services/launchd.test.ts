import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderLogsCommand } from "../logs/logs.ts";
import type { Manifest } from "../scheduler/manifest.ts";
import { Launchctl, parseLstart, parsePrint } from "./launchd.ts";
import type { RunResult } from "./manager.ts";
import { LAUNCH_SCRIPT, PLIST_HEAD, renderPlist, renderShellEnv } from "./plist.ts";
import { Supervisor } from "./supervisor.ts";

const UID = 501;

const mf = (app: string, extra: Partial<Manifest> = {}): Manifest => ({
  app,
  dir: `/ws/apps/${app}`,
  spec: 1,
  status: "active",
  title: "Demo",
  service: { command: "bun src/index.ts", port: 8710 },
  agents: [],
  widgets: [],
  tasks: [],
  ...extra,
});

describe("plist", () => {
  test("the LaunchAgent: marker, label, the wrapper with env file and command, restart on failure, the log", () => {
    const text = renderPlist({ app: "demo", dir: "/ws/apps/demo", command: "bun a.ts && echo <done> 'x'", envFile: "/ws/run/env/demo.env", logFile: "/ws/logs/demo/service.log" });
    expect(text.startsWith(PLIST_HEAD)).toBe(true);
    expect(text).toContain("<key>Label</key><string>space.demo</string>");
    expect(text).toContain("<string>space-demo</string>\n    <string>/ws/run/env/demo.env</string>\n    <string>bun a.ts &amp;&amp; echo &lt;done&gt; 'x'</string>");
    expect(text).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    expect(text).toContain("<key>RunAtLoad</key><true/>");
    expect(text).toContain("<key>StandardErrorPath</key><string>/ws/logs/demo/service.log</string>");
    expect(text).not.toContain("SPACE_APP_TOKEN");
    expect(() => renderPlist({ app: "demo", dir: "/d", command: "a\u0007b", envFile: "/e", logFile: "/l" })).toThrow(/control character/);
  });

  test.skipIf(process.platform !== "darwin")("plutil accepts it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-plist-"));
    const file = join(dir, "space.demo.plist");
    await Bun.write(file, renderPlist({ app: "demo", dir: "/ws/apps/demo", command: `bun "a b.ts" & echo $HOME`, envFile: "/e", logFile: "/l" }));
    const p = Bun.spawnSync(["plutil", "-lint", file]);
    expect(p.exitCode).toBe(0);
  });

  test("the environment file is sourced by sh exactly as written, nothing expanded", async () => {
    const vars = { A: `it's $HOME "q" \\ \`x\``, MULTI: "a\nb", EMPTY: "", "BAD-NAME": "x" };
    const env = renderShellEnv(vars);
    expect(env.skipped).toEqual(["BAD-NAME"]);
    const dir = await mkdtemp(join(tmpdir(), "space-env-"));
    await Bun.write(join(dir, "e.env"), env.text);
    const p = Bun.spawnSync(["/bin/sh", "-c", `. "$1"; printf '%s|%s|%s' "$A" "$MULTI" "$EMPTY"`, "sh", join(dir, "e.env")]);
    expect(p.stdout.toString()).toBe(`${vars.A}|a\nb|`);
  });

  test("the wrapper: the environment reaches the command, its exit status is the job's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-wrap-"));
    await Bun.write(join(dir, "e.env"), renderShellEnv({ GREETING: "hello there" }).text);
    const p = Bun.spawnSync(["/bin/sh", "-c", LAUNCH_SCRIPT, "space-demo", join(dir, "e.env"), `echo "$GREETING" && exit 3`]);
    expect(p.stdout.toString()).toBe("hello there\n");
    expect(p.exitCode).toBe(3);
    expect(Bun.spawnSync(["/bin/sh", "-c", LAUNCH_SCRIPT, "space-demo", join(dir, "missing.env"), "true"]).exitCode).toBe(78);
  });

  test("the wrapper passes SIGTERM to the whole process group, as launchd signals only the shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-term-"));
    await Bun.write(join(dir, "e.env"), "");
    await Bun.write(join(dir, "app.sh"), `trap 'echo app got TERM; exit 0' TERM\necho ready\nwhile :; do sleep 0.1; done\n`);
    // A compound command: the app is a grandchild of the shell launchd started.
    const proc = Bun.spawn(["/bin/sh", "-c", LAUNCH_SCRIPT, "space-demo", join(dir, "e.env"), `cd '${dir}' && sh app.sh`], { stdout: "pipe", detached: true });
    const reader = proc.stdout.getReader();
    let out = "";
    while (!out.includes("ready")) out += new TextDecoder().decode((await reader.read()).value);
    process.kill(proc.pid, "SIGTERM");
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    expect(out).toContain("app got TERM");
    expect(await proc.exited).toBe(143);
  });
});

describe("launchctl output", () => {
  test("print: the top level only, nested blocks skipped", () => {
    const kv = parsePrint("gui/501/space.demo = {\n\tactive count = 1\n\tpath = /Users/u/Library/LaunchAgents/space.demo.plist\n\tstate = running\n\tenvironment = {\n\t\tstate = nested\n\t}\n\truns = 3\n\tpid = 42\n\tlast exit code = (never exited)\n}\n");
    expect(kv).toMatchObject({ state: "running", runs: "3", pid: "42", path: "/Users/u/Library/LaunchAgents/space.demo.plist", "last exit code": "(never exited)" });
  });

  test("ps lstart is local wall-clock time", () => {
    expect(parseLstart("Wed Oct  7 00:53:12 2026\n")).toEqual(new Date(2026, 9, 7, 0, 53, 12));
    expect(parseLstart("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------- fake launchd

type Job = { loaded: boolean; state: "running" | "not running" | "spawn scheduled"; pid: number; runs: number; exit: string };

/** launchd in memory: jobs by domain and label, bootstrapped from plists on disk as launchd does. */
function fakeLaunchd() {
  const jobs = new Map<string, Job>();
  const disabled = new Set<string>();
  /** Labels whose command exits at once: loaded, they wait in "spawn scheduled" as launchd does. */
  const crashing = new Set<string>();
  const calls: string[] = [];
  let nextPid = 100;
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  const run = async (cmd: string[]): Promise<RunResult> => {
    const sudo = cmd[0] === "sudo";
    if (sudo) cmd = cmd.slice(2);
    if (cmd[0] === "ps") return ok("Wed Oct  7 00:53:12 2026\n");
    const [, verb, target, path] = cmd as [string, string, string, string?];
    if (verb === "print" && target === `gui/${UID}`) return ok("gui/501 = {\n}\n");
    if (verb === "print") {
      const j = jobs.get(target);
      if (!j?.loaded) return { code: 113, stdout: "", stderr: `Could not find service "${target}"` };
      return ok(`${target} = {\n\tstate = ${j.state}\n\truns = ${j.runs}\n${j.pid ? `\tpid = ${j.pid}\n` : ""}\tlast exit code = ${j.exit}\n}\n`);
    }
    if (verb === "print-disabled") return ok(`disabled services = {\n${[...disabled].filter((t) => t.startsWith(`${target}/`)).map((t) => `\t\t"${t.slice(target.length + 1)}" => disabled\n`).join("")}\t}\n`);
    calls.push(`${sudo ? "sudo " : ""}${verb} ${target}${path ? ` ${path.split("/").at(-1)}` : ""}`);
    if (verb === "enable") disabled.delete(target);
    if (verb === "disable") disabled.add(target);
    if (verb === "bootstrap") {
      const label = path!.split("/").at(-1)!.replace(/\.plist$/, "");
      const key = `${target}/${label}`;
      if (disabled.has(key) || jobs.get(key)?.loaded || !(await Bun.file(path!).exists())) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      jobs.set(key, crashing.has(label) ? { loaded: true, state: "spawn scheduled", pid: 0, runs: 2, exit: "1" } : { loaded: true, state: "running", pid: nextPid++, runs: 1, exit: "(never exited)" });
    }
    if (verb === "bootout") {
      const j = jobs.get(target);
      if (!j?.loaded) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
      j.loaded = false;
    }
    return ok();
  };
  return { run, calls, jobs, disabled, crashing };
}

async function setup(extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-ld-"));
  const ld = fakeLaunchd();
  const logs: string[] = [];
  const manager = new Launchctl({ run: ld.run, uid: UID, unitDir: join(root, "LaunchAgents"), systemDir: join(root, "LaunchDaemons"), logDir: join(root, "logs"), groupAlive: () => false });
  const sup = new Supervisor({
    mode: "space",
    envDir: join(root, "run", "env"),
    manager,
    envFor: async () => ({ SPACE_APP: "demo", SPACE_APP_TOKEN: "sat_x" }),
    appEnv: async () => ({}),
    path: "/usr/bin:/bin",
    log: (l) => logs.push(l),
    ...extra,
  });
  return { root, ld, sup, manager, logs, plist: join(root, "LaunchAgents", "space.demo.plist"), envPath: join(root, "run", "env", "demo.env") };
}

const own = `gui/${UID}/space.demo`;

describe("supervisor on launchd", () => {
  test("should run, no LaunchAgent: write plist, env file and log directory, enable and bootstrap", async () => {
    const t = await setup();
    const r = await t.sup.apply(mf("demo", { service: { command: "bun run start", port: 8710, env: { NODE_ENV: "production" } } }));
    expect(r.action).toBe("installed");
    expect(t.ld.calls).toEqual([`enable ${own}`, `bootstrap gui/${UID} space.demo.plist`]);
    expect((await Bun.file(t.plist).text()).startsWith(PLIST_HEAD)).toBe(true);
    const env = await Bun.file(t.envPath).text();
    expect(env).toContain("export SPACE_APP_TOKEN='sat_x'");
    expect(env).toContain("export NODE_ENV='production'");
    expect((await stat(t.envPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(t.root, "logs", "demo"))).isDirectory()).toBe(true);
    expect((await t.sup.status("demo")).state).toMatchObject({ activeState: "active", restarts: 0, since: new Date(2026, 9, 7, 0, 53, 12).toISOString() });
  });

  test("regression: a sync that changes nothing never restarts the app", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    const pid = t.ld.jobs.get(own)!.pid;
    t.ld.calls.length = 0;
    for (let i = 0; i < 3; i++) expect((await t.sup.apply(mf("demo"))).action).toBe("unchanged");
    expect(t.ld.calls).toEqual([]);
    expect(t.ld.jobs.get(own)!.pid).toBe(pid);
  });

  test("changed: bootout and bootstrap, so launchd reads the new plist", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    t.ld.calls.length = 0;
    expect((await t.sup.apply(mf("demo", { service: { command: "bun src/other.ts", port: 8710 } }))).action).toBe("restarted");
    expect(t.ld.calls).toEqual([`bootout ${own}`, `bootstrap gui/${UID} space.demo.plist`]);
  });

  test("unchanged but not running (stopped, or exited cleanly): loaded again", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    await t.sup.control("demo", "stop");
    t.ld.calls.length = 0;
    expect((await t.sup.apply(mf("demo"))).action).toBe("started");
    expect(t.ld.calls).toEqual([`bootstrap gui/${UID} space.demo.plist`]);
    Object.assign(t.ld.jobs.get(own)!, { state: "not running", pid: 0, exit: "0" });
    t.ld.calls.length = 0;
    expect((await t.sup.apply(mf("demo"))).action).toBe("started");
    expect(t.ld.calls).toEqual([`bootout ${own}`, `bootstrap gui/${UID} space.demo.plist`]);
  });

  test("paused: bootout, disable, delete plist and env file; then absent", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    t.ld.calls.length = 0;
    expect((await t.sup.apply(mf("demo", { status: "paused" }))).action).toBe("removed");
    expect(t.ld.calls).toEqual([`bootout ${own}`, `disable ${own}`]);
    expect(await Bun.file(t.plist).exists()).toBe(false);
    expect(await Bun.file(t.envPath).exists()).toBe(false);
    expect((await t.sup.apply(mf("demo", { status: "paused" }))).action).toBe("absent");
    // Active again: the label is switched back on before it is loaded.
    t.ld.calls.length = 0;
    expect((await t.sup.apply(mf("demo"))).action).toBe("installed");
    expect(t.ld.calls).toEqual([`enable ${own}`, `bootstrap gui/${UID} space.demo.plist`]);
  });

  test("a crash loop shows as auto-restart with the restarts counted", async () => {
    const t = await setup();
    t.ld.crashing.add("space.demo");
    await t.sup.apply(mf("demo"));
    expect((await t.sup.status("demo")).state).toMatchObject({ activeState: "activating", subState: "auto-restart", restarts: 1 });
    Object.assign(t.ld.jobs.get(own)!, { state: "not running", exit: "1" });
    expect((await t.sup.status("demo")).state).toMatchObject({ activeState: "failed" });
  });

  test("the operator's LaunchAgent named after the app, loaded or set to load at login, is a conflict", async () => {
    const t = await setup();
    await mkdir(join(t.root, "LaunchAgents"), { recursive: true });
    await Bun.write(join(t.root, "LaunchAgents", "demo.plist"), "<plist/>");
    const r = await t.sup.apply(mf("demo"));
    expect(r.action).toBe("conflict");
    expect(r.error).toContain(`the operator's user unit demo is enabled; disable it (launchctl bootout gui/${UID}/demo && launchctl disable gui/${UID}/demo)`);
    expect(t.ld.calls).toEqual([]);
    expect(await Bun.file(t.plist).exists()).toBe(false);
    // Disabled, it no longer loads at login: the space takes over.
    t.ld.disabled.add(`gui/${UID}/demo`);
    expect((await t.sup.apply(mf("demo"))).action).toBe("installed");
  });

  test("a plist of that name not written by ai-space is left alone", async () => {
    const t = await setup();
    await mkdir(join(t.root, "LaunchAgents"), { recursive: true });
    await Bun.write(t.plist, "<plist/>");
    expect((await t.sup.apply(mf("demo"))).action).toBe("conflict");
    expect((await t.sup.remove("demo")).removed).toBe(false);
    expect(await Bun.file(t.plist).text()).toBe("<plist/>");
  });

  test("hand-over from the operator's LaunchAgent: unloaded and disabled, then the space's loaded", async () => {
    const t = await setup({ probe: async () => "ok", healthWaitMs: 50 });
    await mkdir(join(t.root, "LaunchAgents"), { recursive: true });
    await Bun.write(join(t.root, "LaunchAgents", "demo.plist"), "<plist/>");
    t.ld.jobs.set(`gui/${UID}/demo`, { loaded: true, state: "running", pid: 7, runs: 1, exit: "(never exited)" });
    const r = await t.sup.handover(mf("demo", { service: { command: "x", port: 8710, health: "/healthz" } }), "space");
    expect(r).toMatchObject({ ok: true, steps: ["disabled the user unit demo", "installed space.demo", "healthy"] });
    expect(t.ld.calls).toEqual([`bootout gui/${UID}/demo`, `disable gui/${UID}/demo`, `enable ${own}`, `bootstrap gui/${UID} space.demo.plist`]);
    expect(t.ld.jobs.get(`gui/${UID}/demo`)!.loaded).toBe(false);
  });

  test("a failed hand-over brings the operator's LaunchAgent back", async () => {
    const t = await setup({ probe: async () => "down", healthWaitMs: 60_000 });
    await mkdir(join(t.root, "LaunchAgents"), { recursive: true });
    await Bun.write(join(t.root, "LaunchAgents", "demo.plist"), "<plist/>");
    t.ld.jobs.set(`gui/${UID}/demo`, { loaded: true, state: "running", pid: 7, runs: 1, exit: "(never exited)" });
    t.ld.crashing.add("space.demo");
    const r = await t.sup.handover(mf("demo", { service: { command: "x", port: 8710, health: "/healthz" } }), "space");
    expect(r).toMatchObject({ ok: false, rolledBack: true, error: expect.stringMatching(/space.demo keeps exiting; see .*logs\/demo\/service.log/) });
    expect(await Bun.file(t.plist).exists()).toBe(false);
    expect(t.ld.jobs.get(`gui/${UID}/demo`)).toMatchObject({ loaded: true, state: "running" });
    expect(t.ld.disabled.has(`gui/${UID}/demo`)).toBe(false);
  });

  test("sweep removes the LaunchAgents of gone apps only", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    await t.sup.apply(mf("kept", { service: { command: "x", port: 8711 } }));
    await Bun.write(join(t.root, "LaunchAgents", "com.example.other.plist"), "<plist/>");
    expect(await t.sup.sweep(new Set(["kept"]))).toEqual(["demo"]);
    expect(await Bun.file(join(t.root, "LaunchAgents", "space.kept.plist")).exists()).toBe(true);
  });

  test("without a GUI session nothing is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-ld-"));
    const manager = new Launchctl({ run: async () => ({ code: 125, stdout: "", stderr: "Domain does not support specified action" }), uid: UID, unitDir: join(root, "LaunchAgents"), logDir: join(root, "logs") });
    const sup = new Supervisor({ mode: "space", envDir: join(root, "env"), manager, envFor: async () => ({}), appEnv: async () => ({}) });
    const r = await sup.apply(mf("demo"));
    expect(r).toMatchObject({ action: "failed", error: expect.stringMatching(/no launchd GUI session/) });
    expect(await Bun.file(join(root, "LaunchAgents", "space.demo.plist")).exists()).toBe(false);
  });
});

describe("Launchctl", () => {
  test("a stop waits for the job's process group, and kills what outlives the wait", async () => {
    const ld = fakeLaunchd();
    const root = await mkdtemp(join(tmpdir(), "space-ld-"));
    let alive = 3;
    const killed: number[] = [];
    const m = new Launchctl({ run: ld.run, uid: UID, unitDir: root, logDir: root, stopWaitMs: 300, groupAlive: () => alive-- > 0 || killed.length === 0, killGroup: (g) => killed.push(g) });
    await Bun.write(join(root, "space.demo.plist"), "<plist/>");
    await m.start("space.demo");
    const pid = ld.jobs.get(own)!.pid;
    await m.stop("space.demo");
    expect(killed).toEqual([pid]);
    expect(ld.jobs.get(own)!.loaded).toBe(false);
  });

  test("operator commands in messages", () => {
    const m = new Launchctl({ uid: UID, unitDir: "/U/LaunchAgents", logDir: "/ws/logs" });
    expect(m.command("disable", "demo", "system")).toBe("sudo launchctl bootout system/demo && sudo launchctl disable system/demo");
    expect(m.command("restart", "demo")).toBe(`launchctl kickstart -k gui/${UID}/demo`);
    expect(m.command("start", "demo", "user")).toBe(`launchctl bootstrap gui/${UID} /U/LaunchAgents/demo.plist`);
  });

  test("logs: the app's file through tail; rotation copies and truncates", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-ld-logs-"));
    const m = new Launchctl({ uid: UID, logDir: join(root, "it's logs"), maxLogBytes: 10 });
    expect(renderLogsCommand(m.logsTemplate(), { app: "demo", lines: 5, follow: true })).toBe(`tail -n 5 -f '${join(root, "it'\\''s logs")}'/demo/service.log`);
    await m.prepare("demo");
    await m.prepare("quiet");
    await Bun.write(m.logFile("demo"), "0123456789abcdef\n");
    await Bun.write(m.logFile("quiet"), "short\n");
    expect(await m.rotateLogs()).toEqual(["demo"]);
    expect(await Bun.file(m.logFile("demo")).text()).toBe("");
    expect(await Bun.file(`${m.logFile("demo")}.1`).text()).toBe("0123456789abcdef\n");
    expect(await Bun.file(m.logFile("quiet")).text()).toBe("short\n");
  });
});
