import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Launchctl } from "../services/launchd.ts";
import type { RunResult } from "../services/manager.ts";
import { Systemctl } from "../services/systemd.ts";
import { parsePackageManifest } from "./manifest.ts";
import type { RuntimeApp } from "./runtime.ts";
import { StandaloneServices } from "./standalone.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });

const SPACE = "5a37e82a-15a6-4f30-afbf-54d01b68f029";
const app = (dir: string, version = "1.0.0"): RuntimeApp => ({
  dir, index: { format: 1, target: { os: "any", arch: "any" }, sourceIncluded: true, files: [] },
  manifest: parsePackageManifest(`spec: 2\nname: notes\ntitle: My Notes\nversion: ${version}\nrequires: { spaceApi: 1, bun: 1.3.0 }\noffline: { features: [Read], online: [] }\nlaunch: { kind: process, runtime: bun, entry: dist/app.js, args: [--label, "it's here"], health: /healthz }`),
});
async function scratch() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "standalone-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, units: join(root, "units"), envDir: join(root, "ws", "run", "env"), logDir: join(root, "ws", "logs") };
}
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

test("systemd: the unit is named after the app and the Space, written once, and an unchanged running one is left alone", async () => {
  const d = await scratch();
  const calls: string[] = [];
  let active = false;
  const manager = new Systemctl({ unitDir: d.units, run: async (cmd) => {
    calls.push(cmd.slice(1).filter((a) => a !== "--user" && a !== "--").join(" "));
    if (cmd.includes("show")) return ok(`LoadState=loaded\nActiveState=${active ? "active" : "inactive"}\nSubState=${active ? "running" : "dead"}\nUnitFileState=enabled\nMainPID=${active ? 4242 : 0}\nNRestarts=0\n`);
    if (cmd.includes("enable")) active = true;
    if (cmd.includes("stop") || cmd.includes("disable")) active = false;
    if (cmd.includes("is-system-running")) return ok("running\n");
    return ok();
  } });
  const host = new StandaloneServices({ manager, spaceId: SPACE, envDir: d.envDir, logDir: d.logDir, bun: "/opt/bun", path: "/usr/bin:/bin" });
  expect(host.unit("notes")).toBe("space-notes-5a37e82a.service");
  expect(await host.unavailable()).toBeUndefined();
  calls.length = 0;

  await host.start(app("/apps/notes/v1"), 4100, { SPACE_APP_TOKEN: "secret", SPACE_API_URL: "http://127.0.0.1:8700" });
  expect(calls).toEqual(["daemon-reload", "show -p LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NRestarts,ActiveEnterTimestamp,MainPID space-notes-5a37e82a.service", "enable --now space-notes-5a37e82a.service"]);
  const unit = await Bun.file(join(d.units, "space-notes-5a37e82a.service")).text();
  expect(unit).toContain("Description=My Notes (ai-space app)");
  expect(unit).toContain("WorkingDirectory=/apps/notes/v1");
  expect(unit).toContain(`ExecStart=/bin/sh -c "/opt/bun /apps/notes/v1/dist/app.js --label 'it'\\\\''s here'"`);
  expect(unit).toContain(`EnvironmentFile=${d.envDir}/notes-5a37e82a.env`);
  expect(unit).toContain(`StandardOutput=append:${d.logDir}/notes/package.log`);
  expect(unit).toContain("WantedBy=default.target");
  const envFile = join(d.envDir, "notes-5a37e82a.env");
  const env = await Bun.file(envFile).text();
  expect(env).toContain('PORT="4100"');
  expect(env).toContain('SPACE_APP_TOKEN="secret"');
  expect(env).toContain('SPACE_APP="notes"');
  expect((await stat(envFile)).mode & 0o777).toBe(0o600);
  // What `space uninstall` and the supervisor's sweep go by.
  expect(manager.owns(unit, envFile)).toBe(true);
  expect(manager.appOfFile("space-notes-5a37e82a.service")).toBe(host.key("notes"));
  expect(await host.state("notes")).toEqual({ active: true, pid: 4242 });

  // The Space restarted: nothing changed, the running process is not touched.
  calls.length = 0;
  await host.start(app("/apps/notes/v1"), 4100, { SPACE_APP_TOKEN: "secret", SPACE_API_URL: "http://127.0.0.1:8700" });
  expect(calls).toEqual(["enable --now space-notes-5a37e82a.service"]);

  // A new version: the old process is stopped before the new one starts.
  calls.length = 0;
  await host.start(app("/apps/notes/v2", "2.0.0"), 4100, { SPACE_APP_TOKEN: "secret", SPACE_API_URL: "http://127.0.0.1:8700" });
  expect(calls.map((c) => c.split(" ")[0])).toEqual(["daemon-reload", "show", "stop", "enable"]);

  calls.length = 0;
  await host.stop("notes");
  expect(calls).toEqual(["disable --now space-notes-5a37e82a.service"]);
  await host.remove("notes");
  expect(await readdir(d.units)).toEqual([]);
  expect(await readdir(d.envDir)).toEqual([]);
  // Nothing left to stop: no command at all.
  calls.length = 0;
  await host.stop("notes"); await host.remove("notes");
  expect(calls).toEqual([]);
});

test("launchd: the LaunchAgent carries the Space's identity in its label and logs to the app's package.log", async () => {
  const d = await scratch();
  const calls: string[] = [];
  let loaded = false;
  const manager = new Launchctl({ unitDir: d.units, logDir: d.logDir, uid: 501, stopWaitMs: 10, groupAlive: () => false, run: async (cmd) => {
    calls.push(cmd.slice(1).join(" "));
    if (cmd[1] === "print" && cmd[2] === "gui/501") return ok();
    if (cmd[1] === "print-disabled") return ok("");
    if (cmd[0] === "ps") return ok("");
    if (cmd[1] === "print") return loaded ? ok("\tstate = running\n\tpid = 777\n\truns = 1\n") : { code: 113, stdout: "", stderr: "Could not find service" };
    if (cmd[1] === "bootstrap") loaded = true;
    if (cmd[1] === "bootout") loaded = false;
    return ok();
  } });
  const host = new StandaloneServices({ manager, spaceId: SPACE, envDir: d.envDir, logDir: d.logDir, bun: "/opt/bun", path: "/usr/bin:/bin" });
  expect(host.unit("notes")).toBe("space.notes-5a37e82a");
  await host.start(app("/apps/notes/v1"), 4100, { SPACE_APP_TOKEN: "it's" });
  const plist = await Bun.file(join(d.units, "space.notes-5a37e82a.plist")).text();
  expect(plist).toContain("<key>Label</key><string>space.notes-5a37e82a</string>");
  expect(plist).toContain(`<string>${d.logDir}/notes/package.log</string>`);
  expect(plist).toContain("<key>RunAtLoad</key><true/>");
  expect(await Bun.file(join(d.envDir, "notes-5a37e82a.env")).text()).toContain(`export SPACE_APP_TOKEN='it'\\''s'`);
  expect(manager.owns(plist, join(d.envDir, "notes-5a37e82a.env"))).toBe(true);
  expect(calls).toContain("enable gui/501/space.notes-5a37e82a");
  expect(calls).toContain(`bootstrap gui/501 ${d.units}/space.notes-5a37e82a.plist`);
  expect((await host.state("notes")).active).toBe(true);
  await host.stop("notes");
  expect(calls).toContain("bootout gui/501/space.notes-5a37e82a");
  expect(calls).toContain("disable gui/501/space.notes-5a37e82a");
  await host.remove("notes");
  expect(await readdir(d.units)).toEqual([]);
});
