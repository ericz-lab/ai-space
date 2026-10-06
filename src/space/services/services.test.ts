import { describe, expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSupervisor } from "../config.ts";
import { renderLogsCommand } from "../logs/logs.ts";
import type { Manifest } from "../scheduler/manifest.ts";
import { createServiceRoutes } from "./api.ts";
import { Supervisor } from "./supervisor.ts";
import { parseTimestamp, type RunResult, Systemctl } from "./systemd.ts";
import { UNIT_MARKER, execArg, renderEnvFile, renderUnit, serviceEnv, unitName } from "./unit.ts";

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

describe("unit", () => {
  test("golden unit text", () => {
    expect(renderUnit({ app: "demo", title: "Demo 100%", dir: "/ws/apps/demo", command: 'bun src/index.ts --name "x" $HOME', envFile: "/ws/run/env/demo.env" })).toBe(
      [
        UNIT_MARKER,
        "[Unit]",
        "Description=Demo 100%% (ai-space app)",
        "X-Space-App=demo",
        "After=network-online.target",
        "Wants=network-online.target",
        "",
        "[Service]",
        "WorkingDirectory=/ws/apps/demo",
        "EnvironmentFile=/ws/run/env/demo.env",
        'ExecStart=/bin/sh -c "bun src/index.ts --name \\"x\\" $$HOME"',
        "Restart=on-failure",
        "RestartSec=5",
        "KillMode=control-group",
        "TimeoutStopSec=30",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
    expect(unitName("demo")).toBe("space-demo.service");
  });

  test("the command is escaped for systemd, and a multi-line one refused", () => {
    expect(execArg("a\\b 50% ${X}")).toBe('"a\\\\b 50%% $${X}"');
    expect(() => execArg("one\ntwo")).toThrow(/single line/);
  });

  test("environment precedence: PATH, .env, space.env, service.env, then what the space sets", () => {
    const vars = serviceEnv({
      app: "demo",
      dir: "/ws/apps/demo",
      port: 8710,
      path: "/bin",
      appEnv: { A: "app", B: "app", PORT: "1", SPACE_APP_DIR: "x", PATH: "/app/bin:/bin" },
      spaceEnv: { B: "space", C: "space", SPACE_APP: "demo", SPACE_APP_DATA_DIR: "/ws/data/demo", SPACE_API_URL: "http://127.0.0.1:8700", SPACE_NAME: "box" },
      serviceEnv: { C: "service", SPACE_APP_DATA_DIR: "nope", SPACE_NAME: "nope" },
    });
    expect(vars).toMatchObject({ PATH: "/app/bin:/bin", A: "app", B: "space", C: "service", PORT: "8710", SPACE_APP: "demo", SPACE_APP_DIR: "/ws/apps/demo", SPACE_APP_DATA_DIR: "/ws/data/demo", SPACE_NAME: "box" });
  });

  test("env file quotes values and leaves out what it cannot hold", () => {
    const r = renderEnvFile({ A: 'say "hi" \\ bye', "BAD-NAME": "x", MULTI: "a\nb", EMPTY: "" });
    expect(r.text).toBe(`# Written by ai-space for the unit of this app; regenerated on every app sync.\nA="say \\"hi\\" \\\\ bye"\nEMPTY=""\n`);
    expect(r.skipped).toEqual(["BAD-NAME", "MULTI"]);
  });
});

// ---------------------------------------------------------------- fake systemd

/** A user manager in memory: units by name, with the states `systemctl show` reports. */
function fakeSystemd(init: Record<string, { active?: string; enabled?: string; scope?: "user" | "system" }> = {}) {
  const units = new Map<string, { active: string; enabled: string; sub?: string }>(Object.entries(init).map(([k, v]) => [`${v.scope ?? "user"}:${k}`, { active: v.active ?? "inactive", enabled: v.enabled ?? "disabled" }]));
  /** Units whose command exits at once: started, they loop through auto-restart as systemd does. */
  const crashing = new Set<string>();
  const calls: string[] = [];
  const failOn = new Set<string>();
  const run = async (cmd: string[]): Promise<RunResult> => {
    const sudo = cmd[0] === "sudo";
    if (sudo) cmd = cmd.slice(2);
    const args = cmd.slice(1).filter((a) => a !== "--");
    const scope = args[0] === "--user" ? "user" : "system";
    const rest = scope === "user" ? args.slice(1) : args;
    const verb = rest[0]!;
    if (verb === "is-system-running") return { code: 0, stdout: "running\n", stderr: "" };
    if (verb === "show") {
      const name = rest.at(-1)!;
      const u = units.get(`${scope}:${name}`);
      const stdout = u
        ? `LoadState=loaded\nActiveState=${u.active}\nSubState=${u.sub ?? (u.active === "active" ? "running" : "dead")}\nUnitFileState=${u.enabled}\nNRestarts=0\nMainPID=${u.active === "active" ? 42 : 0}\nActiveEnterTimestamp=\n`
        : "LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\nNRestarts=0\nMainPID=0\n";
      return { code: 0, stdout, stderr: "" };
    }
    calls.push((sudo ? "sudo " : "") + rest.join(" "));
    if (failOn.has(verb)) return { code: 1, stdout: "", stderr: `Job for ${rest.at(-1)} failed.` };
    const name = rest.at(-1)!;
    const u = units.get(`${scope}:${name}`) ?? { active: "inactive", enabled: "disabled" };
    if (verb === "enable") Object.assign(u, { enabled: "enabled", ...(rest.includes("--now") ? { active: "active" } : {}) });
    if (verb === "disable") Object.assign(u, { enabled: "disabled", ...(rest.includes("--now") ? { active: "inactive" } : {}) });
    if (verb === "start" || verb === "restart") u.active = "active";
    if (verb === "stop") u.active = "inactive";
    if (crashing.has(name) && u.active === "active") Object.assign(u, { active: "activating", sub: "auto-restart" });
    if (verb !== "daemon-reload" && verb !== "reset-failed") units.set(`${scope}:${name}`, u);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls, units, failOn, crashing };
}

async function setup(init?: Parameters<typeof fakeSystemd>[0], mode: "space" | "operator" = "space", extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "space-sup-"));
  const sd = fakeSystemd(init);
  const logs: string[] = [];
  const spaceEnv: Record<string, string> = { SPACE_APP: "demo", SPACE_APP_DATA_DIR: "/ws/data/demo", SPACE_APP_TOKEN: "sat_x" };
  const sup = new Supervisor({
    mode,
    envDir: join(root, "run", "env"),
    manager: new Systemctl({ run: sd.run, unitDir: join(root, "units") }),
    envFor: async () => ({ ...spaceEnv }),
    appEnv: async () => ({}),
    interpolate: (t) => t.replace("${SECRET}", "s3cret"),
    path: "/usr/bin:/bin",
    log: (l) => logs.push(l),
    ...extra,
  });
  return { root, sd, sup, logs, spaceEnv, unitPath: join(root, "units", "space-demo.service"), envPath: join(root, "run", "env", "demo.env") };
}

describe("supervisor", () => {
  test("should run, no unit: write the unit and env file, reload, enable --now", async () => {
    const t = await setup();
    const r = await t.sup.apply(mf("demo", { service: { command: "bun run start", port: 8710, env: { TOKEN: "${SECRET}" } } }));
    expect(r.action).toBe("installed");
    expect(t.sd.calls).toEqual(["daemon-reload", "enable --now space-demo.service"]);
    const unit = await Bun.file(t.unitPath).text();
    expect(unit.startsWith(UNIT_MARKER)).toBe(true);
    expect(unit).toContain(`EnvironmentFile=${t.envPath}`);
    const env = await Bun.file(t.envPath).text();
    expect(env).toContain('TOKEN="s3cret"');
    expect(env).toContain('PORT="8710"');
    expect(env).toContain('SPACE_APP_TOKEN="sat_x"');
    expect((await stat(t.envPath)).mode & 0o777).toBe(0o600);
  });

  test("regression: a sync that changes nothing never restarts the app", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    t.sd.calls.length = 0;
    for (let i = 0; i < 3; i++) expect((await t.sup.apply(mf("demo"))).action).toBe("unchanged");
    expect(t.sd.calls).toEqual([]);
  });

  test("unit or env changed: rewrite, daemon-reload, restart", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    t.sd.calls.length = 0;
    expect((await t.sup.apply(mf("demo", { service: { command: "bun src/other.ts", port: 8710 } }))).action).toBe("restarted");
    expect(t.sd.calls).toEqual(["daemon-reload", "restart space-demo.service"]);
    // A new variable from storage (a database added) changes the env file only.
    t.sd.calls.length = 0;
    t.spaceEnv.DATABASE_URL = "sqlite:///ws/data/demo/db.sqlite";
    expect((await t.sup.apply(mf("demo", { service: { command: "bun src/other.ts", port: 8710 } }))).action).toBe("restarted");
    expect(t.sd.calls).toEqual(["daemon-reload", "restart space-demo.service"]);
  });

  test("unchanged but not running: start", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    t.sd.units.get("user:space-demo.service")!.active = "failed";
    t.sd.calls.length = 0;
    expect((await t.sup.apply(mf("demo"))).action).toBe("started");
    expect(t.sd.calls).toEqual(["start space-demo.service"]);
  });

  test("paused, archived or no service: disable --now and delete unit and env file", async () => {
    for (const change of [{ status: "paused" as const }, { status: "archived" as const }, { service: undefined }]) {
      const t = await setup();
      await t.sup.apply(mf("demo"));
      t.sd.calls.length = 0;
      expect((await t.sup.apply(mf("demo", change))).action).toBe("removed");
      expect(t.sd.calls).toEqual(["disable --now space-demo.service", "daemon-reload", "reset-failed space-demo.service"]);
      expect(await Bun.file(t.unitPath).exists()).toBe(false);
      expect(await Bun.file(t.envPath).exists()).toBe(false);
      expect((await t.sup.apply(mf("demo", change))).action).toBe("absent");
    }
  });

  test("a unit of that name not written by ai-space is a conflict and left alone", async () => {
    const t = await setup();
    await Bun.write(t.unitPath, "[Service]\nExecStart=/bin/true\n");
    const r = await t.sup.apply(mf("demo"));
    expect(r.action).toBe("conflict");
    expect(r.error).toMatch(/not written by ai-space/);
    expect(t.sd.calls).toEqual([]);
    expect((await t.sup.remove("demo")).removed).toBe(false);
    expect(await Bun.file(t.unitPath).text()).toBe("[Service]\nExecStart=/bin/true\n");
  });

  test("the operator's own unit, enabled or running, in user or system scope, is a conflict", async () => {
    for (const init of [{ "demo.service": { enabled: "enabled" } }, { "demo.service": { active: "active", scope: "system" as const } }]) {
      const t = await setup(init);
      const r = await t.sup.apply(mf("demo"));
      expect(r.action).toBe("conflict");
      expect(r.error).toMatch(/operator's (user|system) unit demo.service/);
      expect(t.sd.calls).toEqual([]);
      expect(await Bun.file(t.unitPath).exists()).toBe(false);
    }
  });

  test("without a user manager nothing is written", async () => {
    const t = await setup();
    const sup = new Supervisor({ ...{ mode: "space", envDir: join(t.root, "env"), envFor: async () => ({}), appEnv: async () => ({}) }, manager: new Systemctl({ unitDir: join(t.root, "units"), run: async () => ({ code: 127, stdout: "", stderr: "Executable not found" }) }) });
    const r = await sup.apply(mf("demo"));
    expect(r.action).toBe("failed");
    expect(r.error).toMatch(/no systemd user manager/);
    expect(await Bun.file(t.unitPath).exists()).toBe(false);
    expect((await sup.status("demo")).state).toBeUndefined();
  });

  test("a failing systemctl is recorded, not thrown", async () => {
    const t = await setup();
    t.sd.failOn.add("enable");
    const r = await t.sup.apply(mf("demo"));
    expect(r.action).toBe("failed");
    expect(r.error).toMatch(/systemctl --user enable --now space-demo.service: Job for/);
    expect(t.sup.lastOf("demo")?.action).toBe("failed");
  });

  test("remove (uninstall) clears unit and env file; sweep removes units of gone apps only", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    await t.sup.apply(mf("kept", { service: { command: "x", port: 8711 } }));
    expect(await t.sup.sweep(new Set(["kept"]))).toEqual(["demo"]);
    expect(await Bun.file(t.unitPath).exists()).toBe(false);
    expect(await Bun.file(t.envPath).exists()).toBe(false);
    expect(await Bun.file(join(t.root, "units", "space-kept.service")).exists()).toBe(true);
    expect((await t.sup.remove("kept")).removed).toBe(true);
    expect((await t.sup.remove("kept")).removed).toBe(false);
  });

  test("operator mode never touches systemd", async () => {
    const t = await setup({}, "operator");
    expect((await t.sup.apply(mf("demo"))).action).toBe("operator");
    expect(await t.sup.sweep(new Set())).toEqual([]);
    expect((await t.sup.remove("demo")).removed).toBe(false);
    expect(t.sd.calls).toEqual([]);
    await expect(t.sup.control("demo", "restart")).rejects.toThrow(/systemctl restart demo.service/);
    expect((await t.sup.status("demo")).unit).toBe("demo.service");
  });

  test("a start waits for health in the background", async () => {
    let answers = 0;
    const { sup } = await setup({}, "space", { probe: async () => (++answers >= 2 ? "ok" : "down"), healthWaitMs: 5_000 });
    const r = await sup.apply(mf("demo", { service: { command: "x", port: 8710, health: "/healthz" } }));
    expect(r.health).toBe("pending");
    await Bun.sleep(1_200);
    expect(sup.lastOf("demo")?.health).toBe("ok");
  });
});

describe("handover", () => {
  const healthy = { probe: async () => "ok" as const, healthWaitMs: 50 };
  const withHealth = (app = "demo") => mf(app, { service: { command: "bun run start", port: 8710, health: "/healthz" } });

  test("to the space: the operator's unit is disabled, the space's installed, health waited for", async () => {
    const t = await setup({ "demo.service": { active: "active", enabled: "enabled" } }, "space", healthy);
    const r = await t.sup.handover(withHealth(), "space");
    expect(r).toMatchObject({ ok: true, steps: ["disabled the user unit demo.service", "installed space-demo.service", "healthy"] });
    expect(t.sd.calls).toEqual(["disable --now demo.service", "daemon-reload", "enable --now space-demo.service"]);
    expect(t.sd.units.get("user:demo.service")).toEqual({ active: "inactive", enabled: "disabled" });
    expect(t.sup.lastOf("demo")?.action).toBe("installed");
  });

  test("an operator's system unit is stopped through sudo -n", async () => {
    const t = await setup({ "demo.service": { active: "active", enabled: "enabled", scope: "system" } }, "space", healthy);
    expect((await t.sup.handover(withHealth(), "space")).ok).toBe(true);
    expect(t.sd.calls[0]).toBe("sudo disable --now demo.service");
  });

  test("not healthy in time: the space's unit is removed and the operator's comes back as it was", async () => {
    const t = await setup({ "demo.service": { active: "active", enabled: "enabled" } }, "space", { probe: async () => "down", healthWaitMs: 50 });
    const r = await t.sup.handover(withHealth(), "space");
    expect(r).toMatchObject({ ok: false, rolledBack: true, error: expect.stringMatching(/not healthy/) });
    expect(r.steps).toEqual(["disabled the user unit demo.service", "installed space-demo.service", "removed space-demo.service", "restored the user unit demo.service"]);
    expect(await Bun.file(t.unitPath).exists()).toBe(false);
    expect(t.sd.units.get("user:demo.service")).toEqual({ active: "active", enabled: "enabled" });
    expect(t.sup.lastOf("demo")).toMatchObject({ action: "conflict", error: expect.stringMatching(/hand-over failed/) });
  });

  test("a unit that fails to start is rolled back without waiting out the health window", async () => {
    const t = await setup({ "demo.service": { active: "active", enabled: "disabled" } }, "space", { probe: async () => "down", healthWaitMs: 60_000 });
    t.sd.failOn.add("enable");
    const r = await t.sup.handover(withHealth(), "space");
    expect(r).toMatchObject({ ok: false, rolledBack: true });
    // Only running before, not enabled: it is started again, not enabled.
    expect(t.sd.calls.at(-1)).toBe("start demo.service");
  });

  test("a command that keeps exiting is caught in auto-restart, not after the whole health window", async () => {
    const t = await setup({ "demo.service": { active: "active", enabled: "enabled" } }, "space", { probe: async () => "down", healthWaitMs: 60_000 });
    t.sd.crashing.add("space-demo.service");
    const started = Date.now();
    const r = await t.sup.handover(withHealth(), "space");
    expect(r).toMatchObject({ ok: false, rolledBack: true, error: expect.stringMatching(/keeps exiting/) });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(t.sd.units.get("user:demo.service")).toMatchObject({ active: "active", enabled: "enabled" });
  });

  test("back to the operator: the space's unit goes, the operator's is enabled, later syncs leave it alone", async () => {
    const t = await setup({ "demo.service": { active: "inactive", enabled: "disabled" } }, "space", healthy);
    await t.sup.apply(withHealth());
    t.sd.calls.length = 0;
    const r = await t.sup.handover(withHealth(), "operator");
    expect(r).toMatchObject({ ok: true, steps: ["removed space-demo.service", "enabled the user unit demo.service", "healthy"] });
    expect(await Bun.file(t.unitPath).exists()).toBe(false);
    expect(t.sd.units.get("user:demo.service")).toEqual({ active: "active", enabled: "enabled" });
    expect((await t.sup.apply(withHealth())).action).toBe("conflict");
  });

  test("refused under operator, without an operator unit to hand back to, and for a paused app", async () => {
    const op = await setup({}, "operator");
    await expect(op.sup.handover(withHealth(), "space")).rejects.toMatchObject({ status: 409 });
    const t = await setup({}, "space", healthy);
    await expect(t.sup.handover(withHealth(), "operator")).rejects.toThrow(/no operator unit/);
    await expect(t.sup.handover(mf("demo", { status: "paused" }), "space")).rejects.toThrow(/paused/);
  });
});

describe("systemctl", () => {
  test("a show timestamp is local wall-clock time, whatever zone abbreviation follows", () => {
    // `CST` is China here; JavaScript alone would read it as US Central, 14 hours off.
    expect(parseTimestamp("Sun 2026-09-27 17:18:09 CST")).toEqual(new Date(2026, 8, 27, 17, 18, 9));
    expect(parseTimestamp("Mon 2026-09-28 10:00:00 KST")).toEqual(new Date(2026, 8, 28, 10, 0, 0));
    expect(parseTimestamp("@1790500689")).toEqual(new Date(1790500689 * 1000));
    expect(parseTimestamp("n/a")).toBeUndefined();
  });
});

describe("routes", () => {
  test("status, control, unknown app and app without a service", async () => {
    const t = await setup();
    await t.sup.apply(mf("demo"));
    const routes = createServiceRoutes({ supervisor: t.sup, hasService: (a) => (a === "demo" ? true : a === "plain" ? false : undefined) });
    const call = (app: string, method: "GET" | "POST", body?: unknown) =>
      routes["/api/apps/:app/service"]![method]!(Object.assign(new Request(`http://h/api/apps/${app}/service`, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), { params: { app } }));
    const got = (await (await call("demo", "GET")).json()) as { service: { managed: boolean; unit: string; state: { activeState: string } } };
    expect(got.service).toMatchObject({ managed: true, unit: "space-demo.service", state: { activeState: "active" } });
    t.sd.calls.length = 0;
    expect((await call("demo", "POST", { action: "restart" })).status).toBe(200);
    expect(t.sd.calls).toEqual(["restart space-demo.service"]);
    expect((await call("demo", "POST", { action: "kill" })).status).toBe(400);
    expect((await call("nope", "GET")).status).toBe(404);
    expect((await call("plain", "GET")).status).toBe(404);
  });
});

describe("configuration and logs", () => {
  test("SPACE_SUPERVISOR: operator by default, space refuses the operator templates", () => {
    expect(loadSupervisor({})).toBe("operator");
    expect(loadSupervisor({ SPACE_SUPERVISOR: "space" })).toBe("space");
    expect(() => loadSupervisor({ SPACE_SUPERVISOR: "systemd" })).toThrow(/space or operator/);
    expect(() => loadSupervisor({ SPACE_SUPERVISOR: "space", SPACE_SERVICE_STOP: "systemctl --user stop {app}" })).toThrow(/remove SPACE_SERVICE_STOP/);
    expect(() => loadSupervisor({ SPACE_SUPERVISOR: "space", SPACE_SERVICE_LOGS: "x", SPACE_SERVICE_STOP: " " })).toThrow(/remove SPACE_SERVICE_LOGS from/);
    expect(loadSupervisor({ SPACE_SUPERVISOR: "operator", SPACE_SERVICE_STOP: "x" })).toBe("operator");
  });

  test("logs of a supervised app read its space unit", () => {
    expect(renderLogsCommand("journalctl --user -u {app} -n {lines} {follow}", { app: "demo", lines: 5, follow: false, unit: "space-demo.service" })).toBe("journalctl --user -u space-demo.service -n 5");
    expect(() => renderLogsCommand("x {app}", { app: "demo", lines: 5, follow: false, unit: "a;b" })).toThrow(/invalid unit/);
  });
});
