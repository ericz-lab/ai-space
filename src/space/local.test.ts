import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readlink, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { RunResult } from "./services/manager.ts";
import { packApplication } from "./packages/pack.ts";
import { LOCAL_LABEL, LocalError, type LocalDeps, findRuntimes, localInstall, localPaths, localRemoveService, localStatus, localStop, localStart, renderLocalPlist, renderLocalRuntimes, readActivity } from "./local.ts";
import { parseRuntimesYaml } from "./runtimes/config.ts";
import { Database } from "bun:sqlite";

// The Local edition's install, upgrade, rollback and removal, with a stand-in for launchctl that
// runs the plist's program the way launchd would: real service processes on a temporary workspace.

const REPO = resolve(import.meta.dir, "..", "..");
const roots: string[] = [];
const procs = new Set<ReturnType<typeof Bun.spawn>>();

afterEach(async () => {
  for (const p of procs) {
    p.kill("SIGKILL");
    await p.exited;
  }
  procs.clear();
});
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A release tree like the app's Resources/space, linking to this checkout's files. */
async function fakeRelease(dir: string, version: string, commit: string, opts: { broken?: boolean; brokenInit?: boolean; migrates?: boolean; app?: string } = {}): Promise<string> {
  if (opts.app) {
    // One bundled app, as release/local.ts puts them in: bundled-apps/<name>.spaceapp.
    const src = `${dir}-hello`;
    await Bun.write(join(src, "space.yaml"), `spec: 2\nname: hello\nversion: ${opts.app}\nrequires: { spaceApi: 1 }\noffline: { features: [], online: [] }\n`);
    await mkdir(join(dir, "bundled-apps"), { recursive: true });
    await packApplication({ dir: src, include: ["space.yaml"], output: join(dir, "bundled-apps", "hello.spaceapp"), target: { os: "any", arch: "any" }, sourceIncluded: true });
  }
  await mkdir(join(dir, "runtime"), { recursive: true });
  await symlink(process.execPath, join(dir, "runtime", "bun"));
  for (const f of ["node_modules", "skills", "tsconfig.json", "bin"]) await symlink(join(REPO, f), join(dir, f));
  // The service reports package.json's version, read beside its own src/: both are real copies here.
  await Bun.write(join(dir, "package.json"), JSON.stringify({ ...(await Bun.file(join(REPO, "package.json")).json()), version }));
  await cp(join(REPO, "src"), join(dir, "src"), { recursive: true, filter: (f) => !f.endsWith(".test.ts") });
  // `migrates`: a broken start that first changes space.db's schema, as a failed migration would.
  const migrate = opts.migrates ? `{ const { Database } = await import("bun:sqlite"); const db = new Database(process.env.SPACE_HOME + "/data/space.db"); db.exec("CREATE TABLE from_broken (x)"); db.close(); }\n` : "";
  if (opts.brokenInit) await Bun.write(join(dir, "src", "index.ts"), `${migrate} throw new Error("broken init");`);
  if (opts.broken) await Bun.write(join(dir, "src", "index.ts"), `if (process.argv[2] !== "init") { ${migrate} process.exit(3); }\nawait import("./cli/main.ts").then((m) => m.run(process.argv.slice(2), {})).then((c) => process.exit(c));\n`);
  await Bun.write(join(dir, "RELEASE.json"), JSON.stringify({ product: "ai-space", edition: "local", version, commit, os: "macos", arch: process.arch, bun: Bun.version }));
  return dir;
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

/** launchctl as far as Launchctl and local.ts use it, over real processes. */
function fakeLaunchd(log: string[]) {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let disabled = false;
  const alive = () => proc !== undefined && proc.exitCode === null && proc.signalCode === null;
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
  return async (cmd: string[]): Promise<RunResult> => {
    if (cmd[0] !== "launchctl") return { code: 1, stdout: "", stderr: "" };
    const verb = cmd[1]!;
    if (verb !== "print" && verb !== "print-disabled") log.push(verb);
    switch (verb) {
      case "print":
        if (cmd[2]!.endsWith(`/${LOCAL_LABEL}`)) return alive() ? ok(`\tstate = running\n\tpid = ${proc!.pid}\n`) : { code: 113, stdout: "", stderr: "Could not find service" };
        return ok();
      case "print-disabled":
        return ok(disabled ? `\t"${LOCAL_LABEL}" => disabled\n` : "");
      case "enable":
        disabled = false;
        return ok();
      case "disable":
        disabled = true;
        return ok();
      case "bootstrap": {
        const plist = await Bun.file(cmd[3]!).text();
        const args = [...plist.matchAll(/<array>([\s\S]*?)<\/array>/g)][0]![1]!.match(/<string>(.*?)<\/string>/g)!.map((s) => s.slice(8, -9));
        const envBlock = /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)![1]!;
        const env: Record<string, string> = {};
        for (const m of envBlock.matchAll(/<key>(.*?)<\/key><string>(.*?)<\/string>/g)) env[m[1]!] = m[2]!;
        proc = Bun.spawn(args, { env: { ...env, HOME: process.env.HOME! }, stdout: "ignore", stderr: "ignore" });
        procs.add(proc);
        return ok();
      }
      case "bootout":
        if (!alive()) return { code: 3, stdout: "", stderr: "No such process" };
        proc!.kill("SIGTERM");
        await proc!.exited;
        return ok();
      default:
        return ok();
    }
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "space-local-"));
  roots.push(root);
  const home = join(root, "home");
  await mkdir(home);
  const port = await freePort();
  const workspace = join(home, ".ai-space");
  const log: string[] = [];
  const run = fakeLaunchd(log);
  // The agent CLI the user would have: a stand-in, chosen by path so the host's own never counts.
  const claude = join(root, "bin", "claude");
  await Bun.write(claude, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
  await chmod(claude, 0o755);
  const deps = (bundle: string): LocalDeps => ({
    env: { SPACE_HOME: workspace, SPACE_LOCAL_PREFIX: join(root, "prefix"), SPACE_LOCAL_AGENTS: join(root, "agents"), PATH: "/usr/bin:/bin" },
    home,
    root: bundle,
    run,
    // Before the fixture writes .env, status probes the default port. Never inspect a real Space.
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.port !== String(port)) return Promise.reject(new Error("outside the fixture's port"));
      return fetch(input, init);
    }) as typeof fetch,
    uid: 501,
    log: () => {},
    sleep: Bun.sleep,
    runtimes: { claude, codex: null },
  });
  // The port is the workspace's: written before the first install, as the app would pick a free one.
  await mkdir(workspace);
  await Bun.write(join(workspace, ".env"), `SPACE_PORT=${port}\n`);
  await Bun.write(join(workspace, "installation.json"), "{}"); // not ours: replaced below
  await rm(join(workspace, "installation.json"));
  return { root, home, workspace, port, log, deps, claude };
}

describe("agent CLIs", () => {
  test("a chosen path must identify the expected agent; null leaves that one out", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-local-rt-"));
    roots.push(root);
    const exe = join(root, "my claude");
    await Bun.write(exe, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    await chmod(exe, 0o755);
    const plain = join(root, "codex.txt");
    await Bun.write(plain, "");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: exe, codex: null })).toEqual({ claude: exe, codex: null });
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: "claude", codex: plain })).toEqual({ claude: null, codex: null });
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: null, codex: exe })).toEqual({ claude: null, codex: null });
    await Bun.write(exe, "#!/bin/sh\necho 'codex-cli 0.100.0'\n");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: exe, codex: exe })).toEqual({ claude: null, codex: exe });
    await Bun.write(exe, "#!/bin/sh\necho 'codex-cli 0.100.0'\nexit 1\n");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: null, codex: exe })).toEqual({ claude: null, codex: null });
  });

  test("an unresponsive selected program times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "space-local-rt-"));
    roots.push(root);
    const exe = join(root, "hung-agent");
    await Bun.write(exe, "#!/bin/sh\nexec /bin/sleep 10\n");
    await chmod(exe, 0o755);
    expect(await findRuntimes({ PATH: "/usr/bin:/bin" }, root, { claude: exe, codex: null })).toEqual({ claude: null, codex: null });
  });

  test("runtimes.yaml names both CLIs by path, with no default runtime", () => {
    const text = renderLocalRuntimes({ claude: "/Users/me/.local/bin/claude", codex: "/Applications/Codex Tools/codex" })!;
    const { config } = parseRuntimesYaml(text, {});
    expect(config.default).toBeUndefined();
    expect(config.runtimes.map((r) => [r.name, r.kind, (r as { bin: string[] }).bin])).toEqual([
      ["claude", "claude-code", ["/Users/me/.local/bin/claude"]],
      ["codex", "codex-cli", ["/Applications/Codex Tools/codex"]],
    ]);
    expect(renderLocalRuntimes({ claude: null, codex: null })).toBeUndefined();
  });
});

describe("space local", () => {
  test("a new workspace with no agent CLI is refused before anything is installed", async () => {
    const { root, workspace, deps } = await setup();
    await rm(workspace, { recursive: true });
    const v1 = await fakeRelease(join(root, "app1"), "0.1.0", "a".repeat(40));
    const none = { ...deps(v1), runtimes: { claude: null, codex: null } };
    const refused = localInstall(none, { device: "This Mac" });
    await expect(refused).rejects.toMatchObject({ code: "no-runtime" });
    expect(await Bun.file(join(workspace, "installation.json")).exists()).toBe(false);
    expect((await localStatus(none)).state).toBe("absent");
  });

  test("a runtimes.yaml the workspace already has is left as it is", async () => {
    const { root, workspace, port, deps } = await setup();
    await Bun.write(join(workspace, "installation.json"), JSON.stringify({ managedBy: "ai-space-local", installedAt: "2026-10-18T00:00:00.000Z", version: "0.0.0", release: "none" }));
    const mine = "default: api\nruntimes:\n  api:\n    kind: anthropic-api\n";
    await Bun.write(join(workspace, "runtimes.yaml"), mine);
    await Bun.write(join(workspace, ".env"), `SPACE_PORT=${port}\nANTHROPIC_API_KEY=sk-test\n`);
    const v1 = await fakeRelease(join(root, "app1"), "0.1.0", "a".repeat(40));
    await localInstall({ ...deps(v1), runtimes: { claude: null, codex: null } });
    expect(await Bun.file(join(workspace, "runtimes.yaml")).text()).toBe(mine);
  }, 60_000);

  test("activity failures do not silently become idle", async () => {
    const { deps, workspace } = await setup();
    for (const code of [401, 500]) {
      await expect(readActivity({ ...deps("/unused"), fetch: (async (_input: string | URL | Request) => new Response("", { status: code })) as typeof fetch }, workspace, 1)).rejects.toThrow(`HTTP ${code}`);
    }
    await expect(readActivity({ ...deps("/unused"), fetch: (async (_input: string | URL | Request) => Response.json({ ok: true })) as typeof fetch }, workspace, 1)).rejects.toThrow("invalid running-work response");
    expect(await readActivity({ ...deps("/unused"), fetch: (async (_input: string | URL | Request) => new Response("", { status: 404 })) as typeof fetch }, workspace, 1)).toBeUndefined();
  });

  test("the LaunchAgent runs the current release's Bun on the workspace, edition local", () => {
    const p = localPaths({ SPACE_HOME: "/Users/u/.ai-space" }, "/Users/u");
    const text = renderLocalPlist(p);
    expect(text).toContain(`<string>${LOCAL_LABEL}</string>`);
    expect(text).toContain("<string>/Users/u/Library/Application Support/ai-space/local/current/runtime/bun</string>");
    expect(text).toContain("<string>start</string>");
    expect(text).toContain("<key>SPACE_EDITION</key><string>local</string>");
    expect(text).toContain("<key>SuccessfulExit</key><false/>");
  });

  test("installs, starts as managed, upgrades, rolls a broken release back, stops, removes the service", async () => {
    const { root, workspace, port, log, deps, claude } = await setup();
    // A workspace holding only the port is still "absent"-like? No: it has a file, so it would be foreign.
    // The app writes the port into a fresh workspace after this check; here we clear it for the first install.
    await rm(workspace, { recursive: true });
    const v1 = await fakeRelease(join(root, "app1"), "0.1.0", "a".repeat(40), { app: "1.0.0" });
    const before = await localStatus(deps(v1));
    expect(before.state).toBe("absent");
    expect(before.bundle?.version).toBe("0.1.0");

    // Port: give the workspace its port before install writes .env values around it.
    await mkdir(workspace, { recursive: true });
    await Bun.write(join(workspace, ".env"), `SPACE_PORT=${port}\n`);
    await Bun.write(join(workspace, "installation.json"), JSON.stringify({ managedBy: "ai-space-local", installedAt: "2026-10-18T00:00:00.000Z", version: "0.0.0", release: "none" }));

    const r1 = await localInstall(deps(v1), { device: "This Mac" });
    expect(r1).toMatchObject({ version: "0.1.0", url: `http://127.0.0.1:${port}/`, upgraded: false, migrated: false });
    expect(r1.device?.token.startsWith("spd_")).toBe(true);
    expect(r1.apps).toEqual([{ file: "hello.spaceapp", app: "hello", version: "1.0.0", status: "installed" }]);
    const s1 = await localStatus(deps(v1));
    expect(s1).toMatchObject({ state: "managed", running: { version: "0.1.0", edition: "local", installation: "managed" }, service: { running: true, plist: true } });
    expect(s1.installed?.version).toBe("0.1.0");
    const env = await Bun.file(join(workspace, ".env")).text();
    expect(env).toContain("SPACE_EDITION=local");
    expect(env).toContain("SPACE_AUTH=builtin");
    expect(env).toContain(`SPACE_PORT=${port}`);
    expect(env).toContain("SPACE_TERMINAL_ENABLED=1");
    // The agent CLI found becomes the workspace's runtime, by its absolute path.
    const runtimes = parseRuntimesYaml(await Bun.file(join(workspace, "runtimes.yaml")).text(), {}).config;
    expect(runtimes).toEqual({ runtimes: [{ name: "claude", kind: "claude-code", bin: [claude], chatArgs: [] }] });

    // The device token reaches an owner route; nothing else does.
    const layout = (h: Record<string, string>) => fetch(`http://127.0.0.1:${port}/api/panel/layout`, { headers: h });
    expect((await layout({ authorization: `Bearer ${r1.device!.token}` })).status).toBe(200);
    expect((await layout({})).status).toBe(401);

    // A second service on the same workspace refuses to start.
    const second = Bun.spawn([process.execPath, join(REPO, "src", "index.ts"), "start"], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, SPACE_HOME: workspace, SPACE_PORT: String(port + 1) }, stdout: "ignore", stderr: "pipe" });
    expect(await second.exited).toBe(1);
    expect(await new Response(second.stderr).text()).toContain("another ai-space service already runs");

    const v2 = await fakeRelease(join(root, "app2"), "0.2.0", "b".repeat(40), { app: "1.0.0" });
    const r2 = await localInstall(deps(v2));
    expect(r2).toMatchObject({ version: "0.2.0", upgraded: true });
    expect(r2.apps).toMatchObject([{ app: "hello", status: "present" }]);
    expect(r2.device).toBeUndefined();
    const p = localPaths(deps(v2).env, deps(v2).home);
    expect(await readlink(p.current)).toBe(join("releases", `0.2.0-${"b".repeat(12)}`));

    const broken = await fakeRelease(join(root, "app3"), "0.3.0", "c".repeat(40), { broken: true });
    const fast = { ...deps(broken), healthTimeoutMs: 4000 };
    const failing = localInstall(fast);
    await expect(failing).rejects.toBeInstanceOf(LocalError);
    await expect(failing).rejects.toThrow(/did not answer as 0.3.0/);
    expect(await readlink(p.current)).toBe(join("releases", `0.2.0-${"b".repeat(12)}`));
    for (let i = 0; i < 100 && (await localStatus(deps(v2))).running?.version !== "0.2.0"; i++) await Bun.sleep(100);
    expect((await localStatus(deps(v2))).running?.version).toBe("0.2.0");

    const stopped = await localStop(deps(v2));
    expect(stopped.service).toMatchObject({ running: false, disabled: true });
    expect(stopped.running).toBeUndefined();
    expect((await localStart(deps(v2))).service.running).toBe(true);

    const removed = await localRemoveService(deps(v2));
    expect(removed.service).toMatchObject({ running: false, plist: false });
    expect(removed.installed).toBeUndefined();
    expect(removed.state).toBe("managed"); // the workspace stays the app's
    expect(await Bun.file(join(workspace, "data", "space.db")).exists()).toBe(true);
    expect(log.filter((v) => v === "bootstrap").length).toBeGreaterThanOrEqual(4);
  }, 120_000);

  test("an upgrade waits for the work in progress, and a failed one gets space.db back", async () => {
    const { root, workspace, port, deps } = await setup();
    await rm(workspace, { recursive: true });
    await mkdir(workspace);
    await Bun.write(join(workspace, ".env"), `SPACE_PORT=${port}\n`);
    await Bun.write(join(workspace, "installation.json"), JSON.stringify({ managedBy: "ai-space-local", installedAt: "2026-10-18T00:00:00.000Z", version: "0.0.0", release: "none" }));
    const v1 = await fakeRelease(join(root, "app1"), "0.1.0", "f".repeat(40));
    const r1 = await localInstall(deps(v1), { device: "This Mac" });
    expect(await Bun.file(join(workspace, ".env")).text()).toContain("SPACE_DRAIN_SECONDS=30");

    // The real service says it is idle.
    const idle = await fetch(`http://127.0.0.1:${port}/api/space/activity`, { headers: { authorization: `Bearer ${r1.device!.token}` } });
    expect(await idle.json()).toEqual({ ok: true, busy: false, items: [] });
    expect((await fetch(`http://127.0.0.1:${port}/api/space/activity`)).status).toBe(401);

    // A Space that reports work: the activity answer is replaced, everything else is real.
    let busyFor = Infinity;
    const busyFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/space/activity") && busyFor-- > 0) return Response.json({ ok: true, busy: true, items: [{ kind: "task", label: "notes/digest" }] });
      return fetch(url, init);
    }) as typeof fetch;
    const v2 = await fakeRelease(join(root, "app2"), "0.2.0", "1".repeat(40));
    const busyDeps = { ...deps(v2), fetch: busyFetch, sleep: async () => {} };
    const refused = await localInstall(busyDeps).catch((e) => e);
    expect(refused).toMatchObject({ code: "busy", activity: { busy: true, items: [{ label: "notes/digest" }] } });
    expect((await localStatus(deps(v2))).running?.version).toBe("0.1.0"); // untouched
    await expect(localInstall(busyDeps, { whenBusy: "wait", waitMs: 0 })).rejects.toMatchObject({ code: "busy" });
    busyFor = 2;
    expect(await localInstall(busyDeps, { whenBusy: "wait" })).toMatchObject({ version: "0.2.0", upgraded: true });
    expect(busyFor).toBe(-1); // asked three times: busy, busy, idle

    // A release that migrates space.db and then fails: the previous release gets the database it knew.
    busyFor = Infinity;
    const broken = await fakeRelease(join(root, "app3"), "0.3.0", "2".repeat(40), { broken: true, migrates: true });
    await expect(localInstall({ ...deps(broken), fetch: busyFetch, healthTimeoutMs: 4000 }, { whenBusy: "now" })).rejects.toThrow(/0.2.0-1{12} runs again with space.db as it was before/);
    for (let i = 0; i < 100 && (await localStatus(deps(v2))).running?.version !== "0.2.0"; i++) await Bun.sleep(100);
    expect((await localStatus(deps(v2))).running?.version).toBe("0.2.0");
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(workspace, "data", "space.db"), { readonly: true });
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'from_broken'").all()).toEqual([]);
    db.close();
    const p = localPaths(deps(v2).env, deps(v2).home);
    expect((await readdir(join(p.prefix, "db-snapshots"))).length).toBe(2);

    // Initialization can change the schema and then throw before the health check even starts.
    const badInit = await fakeRelease(join(root, "app4"), "0.4.0", "3".repeat(40), { brokenInit: true, migrates: true });
    await expect(localInstall(deps(badInit))).rejects.toThrow(/init failed:/);
    const restored = await localStatus(deps(v2));
    expect(restored.running?.version).toBe("0.2.0");
    expect(restored.ownership?.version).toBe("0.2.0");
    const restoredDb = new Database(join(workspace, "data", "space.db"), { readonly: true });
    expect(restoredDb.query("SELECT name FROM sqlite_master WHERE name = 'from_broken'").all()).toEqual([]);
    restoredDb.close();

    // A failed launchctl bootstrap must also restore the previous release.
    let failOnce = true;
    const bootstrapDeps = { ...deps(badInit), root: await fakeRelease(join(root, "app5"), "0.5.0", "4".repeat(40)),
      run: async (cmd: string[]) => {
        if (cmd[1] === "bootstrap" && failOnce) {
          failOnce = false;
          return { code: 1, stdout: "", stderr: "bootstrap failed" };
        }
        return deps(v2).run(cmd);
      },
    };
    await expect(localInstall(bootstrapDeps)).rejects.toThrow(/bootstrap failed/);
    expect((await localStatus(deps(v2))).running?.version).toBe("0.2.0");

  }, 120_000);

  test("a workspace this app did not make is foreign: install refuses, migrate takes it once it is stopped", async () => {
    const { root, workspace, port, deps } = await setup();
    await Bun.write(join(workspace, "AGENTS.local.md"), "mine\n");
    const v1 = await fakeRelease(join(root, "app"), "0.1.0", "d".repeat(40));
    const s = await localStatus(deps(v1));
    expect(s.state).toBe("foreign");
    expect(s.reason).toContain("was not made by this app");
    await expect(localInstall(deps(v1))).rejects.toMatchObject({ code: "foreign" });

    // Someone else's service running on it: even --migrate waits for it to stop.
    const theirs = Bun.spawn([process.execPath, join(REPO, "src", "index.ts"), "start"], { env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME!, SPACE_HOME: workspace, SPACE_PORT: String(port), SPACE_DEFAULT_APPS: "none" }, stdout: "ignore", stderr: "ignore" });
    procs.add(theirs);
    for (let i = 0; i < 100 && !(await localStatus(deps(v1))).running; i++) await Bun.sleep(100);
    const running = await localStatus(deps(v1));
    expect(running).toMatchObject({ state: "foreign", running: { installation: "external" } });
    await expect(localInstall(deps(v1), { migrate: true })).rejects.toMatchObject({ code: "foreign-running" });
    theirs.kill("SIGTERM");
    await theirs.exited;

    // A Space this app takes on starts with a default model the user chose, from what this Mac offers.
    const before = await localStatus(deps(v1));
    expect(before.models?.map((m) => m.value)).toEqual(["claude/basic", "claude/junior", "claude/intermediate", "claude/advanced"]);
    await expect(localInstall(deps(v1), { migrate: true })).rejects.toMatchObject({ code: "no-default-model" });
    await expect(localInstall(deps(v1), { migrate: true, defaultModel: "codex/intermediate" })).rejects.toMatchObject({ code: "no-default-model" });
    const r = await localInstall(deps(v1), { migrate: true, defaultModel: "claude/intermediate" });
    expect(r.migrated).toBe(true);
    const db = new Database(join(workspace, "data", "space.db"), { readonly: true });
    expect(db.query("SELECT value FROM model_preferences WHERE key = 'default'").get()).toEqual({ value: "claude/intermediate" });
    db.close();
    expect((await localStatus(deps(v1))).models).toBeUndefined();
    expect(await Bun.file(join(workspace, "AGENTS.local.md")).text()).toBe("mine\n");
    expect((await localStatus(deps(v1))).state).toBe("managed");
  }, 120_000);

  test("stop, start and remove refuse an installation this app does not own", async () => {
    const { root, deps } = await setup();
    const v1 = await fakeRelease(join(root, "app"), "0.1.0", "e".repeat(40));
    await expect(localStop(deps(v1))).rejects.toMatchObject({ code: "not-installed" });
    await expect(localRemoveService(deps(v1))).rejects.toMatchObject({ code: "not-installed" });
    expect(await readdir(join(root))).not.toContain("prefix");
  });
});
