import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPACE_ROOT } from "./config.ts";
import { MANAGED_BY, OWNERSHIP_FILE } from "./local.ts";
import {
  SERVER_LABEL,
  SERVER_PLIST_HEAD,
  SERVER_UNIT,
  type ServiceDeps,
  ServiceError,
  planUninstall,
  renderServerPlist,
  renderServerUnit,
  runUninstall,
  serviceInstall,
  serviceRemove,
  serviceRestart,
  serviceStatus,
  serviceWorkspace,
  workspaceOfUnit,
} from "./service.ts";
import { PLIST_HEAD, plistString } from "./services/plist.ts";
import type { RunResult } from "./services/manager.ts";
import { CAN_SYMLINK } from "./testing.ts";

/**
 * ai-space's own background service: what is written for systemd and for launchd, and the
 * commands each manager gets. The runner is a fake and every path is under a temporary
 * directory: no unit is loaded and nothing of this machine is touched.
 */

let root = "";
const template = await Bun.file(join(SPACE_ROOT, "deploy", "ai-space.service")).text();

beforeAll(async () => {
  // The real path: on a Mac the temporary directory is behind a link.
  root = await realpath(await mkdtemp(join(tmpdir(), "space-service-")));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });

async function deps(platform: "linux" | "darwin", answer: (cmd: string[]) => RunResult | undefined = () => undefined, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(root, "home-"));
  const code = join(home, "code");
  await mkdir(join(code, "deploy"), { recursive: true });
  await Bun.write(join(code, "deploy", "ai-space.service"), template);
  const ran: string[] = [];
  const log: string[] = [];
  const d: ServiceDeps = {
    env: { USER: "tester", SPACE_HOME: join(home, "ws"), SPACE_SERVICE_UNITS: join(home, "units"), ...env },
    home,
    root: code,
    bun: join(home, ".bun", "bin", "bun"),
    uid: 501,
    platform,
    log: (l) => log.push(l),
    run: async (cmd) => {
      ran.push(cmd.join(" "));
      const given = answer(cmd);
      if (given) return given;
      if (cmd[0] === "systemctl" && cmd.includes("is-system-running")) return ok("running\n");
      if (cmd[0] === "systemctl" && cmd.includes("show")) return ok("LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\n");
      // No label is loaded: `launchctl print <domain>/<label>` exits 113, the domain itself answers.
      if (cmd[0] === "launchctl" && cmd[1] === "print" && cmd[2]?.includes("/")) return cmd[2].split("/").length > 2 ? { code: 113, stdout: "", stderr: "Could not find service" } : ok();
      return ok();
    },
  };
  return { d, ran, log, home, code, units: join(home, "units"), ws: join(home, "ws") };
}

describe("the systemd unit", () => {
  test("is deploy/ai-space.service with this machine's checkout, workspace and Bun", () => {
    const text = renderServerUnit(template, { root: "/home/u/.ai-space/core", bun: "/home/u/.bun/bin/bun", workspace: "/home/u/.ai-space", home: "/home/u" });
    expect(text).toContain("WorkingDirectory=/home/u/.ai-space/core\n");
    expect(text).toContain("Environment=SPACE_HOME=/home/u/.ai-space\n");
    expect(text).toContain("ExecStart=/home/u/.bun/bin/bun src/index.ts\n");
    // The usual Bun: the PATH line is the template's.
    expect(text).toContain("Environment=PATH=%h/.bun/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin\n");
    expect(text.split("\n").length).toBe(template.split("\n").length);
  });

  test("a release's own Bun goes first on the unit's PATH", () => {
    const text = renderServerUnit(template, { root: "/p/current", bun: "/p/current/runtime/bun", workspace: "/data/ws", home: "/home/u" });
    expect(text).toContain("WorkingDirectory=/p/current\n");
    expect(text).toContain("ExecStart=/p/current/runtime/bun src/index.ts\n");
    expect(text).toContain("Environment=PATH=/p/current/runtime:%h/.bun/bin:");
  });

  test("gives its workspace back", () => {
    const text = renderServerUnit(template, { root: "/c", bun: "/b/bun", workspace: "/data/ws", home: "/home/u" });
    expect(workspaceOfUnit(text, "linux", "/home/u")).toBe("/data/ws");
    expect(workspaceOfUnit(template, "linux", "/home/u")).toBe("/home/u/.ai-space");
    expect(workspaceOfUnit("", "linux", "/home/u")).toBeUndefined();
  });
});

describe("the LaunchAgent", () => {
  const u = { root: "/Users/u/.local/share/ai-space/current", bun: "/Users/u/.local/share/ai-space/current/runtime/bun", workspace: "/Users/u/My Space & co", home: "/Users/u" };

  test("runs the code's entry point with the workspace, a PATH and a log file", () => {
    const text = renderServerPlist(u);
    expect(text.startsWith(SERVER_PLIST_HEAD)).toBe(true);
    expect(text).toContain(`<key>Label</key>${plistString(SERVER_LABEL)}`);
    expect(text).toContain(`    ${plistString(u.bun)}\n    ${plistString(join(u.root, "src", "index.ts"))}\n  </array>`);
    expect(text).toContain("<key>SPACE_HOME</key><string>/Users/u/My Space &amp; co</string>");
    expect(text).toContain(`<key>PATH</key><string>${u.root}/runtime:${join("/Users/u", ".bun", "bin")}:${join("/Users/u", ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>`);
    expect(text).toContain(`<key>StandardOutPath</key><string>${join("/Users/u/My Space &amp; co", "logs", "space.log")}</string>`);
    expect(text).toContain("<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>");
    // Not one of the apps' LaunchAgents: the supervisor's sweep never takes it for its own.
    expect(text.startsWith(PLIST_HEAD)).toBe(false);
  });

  test("gives its workspace back", () => {
    expect(workspaceOfUnit(renderServerPlist(u), "darwin", u.home)).toBe("/Users/u/My Space & co");
  });
});

describe("the workspace of the service", () => {
  test("SPACE_HOME, else the installed unit's, else ~/.ai-space", async () => {
    const { d, home, units } = await deps("linux");
    expect(await serviceWorkspace(d)).toBe(join(home, "ws"));
    const bare = { ...d, env: { SPACE_SERVICE_UNITS: units } };
    expect(await serviceWorkspace(bare)).toBe(join(home, ".ai-space"));
    await mkdir(units, { recursive: true });
    await Bun.write(join(units, SERVER_UNIT), renderServerUnit(template, { root: "/c", bun: "/b/bun", workspace: "/data/ws", home }));
    expect(await serviceWorkspace(bare)).toBe("/data/ws");
    expect(await serviceWorkspace({ ...bare, env: { ...bare.env, SPACE_HOME: "~/elsewhere" } })).toBe(join(home, "elsewhere"));
  });
});

describe("install", () => {
  test("on Linux: writes the unit, asks for lingering, reloads, enables and restarts", async () => {
    const { d, ran, units, ws, code, home } = await deps("linux");
    const s = await serviceInstall(d);
    const text = await Bun.file(join(units, SERVER_UNIT)).text();
    expect(text).toContain(`WorkingDirectory=${code}\n`);
    expect(text).toContain(`Environment=SPACE_HOME=${ws}\n`);
    expect(text).toContain(`ExecStart=${join(home, ".bun", "bin", "bun")} src/index.ts\n`);
    expect(ran.filter((c) => !c.includes(" show "))).toEqual([
      "systemctl --user is-system-running",
      "loginctl enable-linger tester",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now -- ai-space.service",
      "systemctl --user restart -- ai-space.service",
    ]);
    expect(s).toMatchObject({ kind: "server", manager: "systemd", name: SERVER_UNIT, installed: true, running: true, enabled: true, pid: 42, workspace: ws, logs: "journalctl --user -u ai-space" });
  });

  test("on Linux without the right to linger: still installed, and says what that means", async () => {
    const { d, log } = await deps("linux", (cmd) => (cmd[0] === "loginctl" ? { code: 1, stdout: "", stderr: "denied" } : undefined));
    expect((await serviceInstall(d)).installed).toBe(true);
    expect(log.join("\n")).toContain("lingering is off");
  });

  test("on a Mac: writes the LaunchAgent and its log directory, enables and loads it", async () => {
    const { d, ran, units, ws } = await deps("darwin");
    const s = await serviceInstall(d);
    const file = join(units, `${SERVER_LABEL}.plist`);
    expect(await Bun.file(file).text()).toBe(renderServerPlist({ root: d.root, bun: d.bun, workspace: ws, home: d.home }));
    expect((await Bun.file(join(ws, "logs")).stat()).isDirectory()).toBe(true);
    expect(ran).toContain("launchctl enable gui/501/ai.space.server");
    expect(ran).toContain(`launchctl bootstrap gui/501 ${file}`);
    expect(ran.indexOf("launchctl enable gui/501/ai.space.server")).toBeLessThan(ran.indexOf(`launchctl bootstrap gui/501 ${file}`));
    expect(s).toMatchObject({ kind: "server", manager: "launchd", name: SERVER_LABEL, installed: true, logs: join(ws, "logs", "space.log") });
  });

  test("refuses when no service manager answers", async () => {
    const linux = await deps("linux", (cmd) => (cmd.includes("is-system-running") ? { code: 1, stdout: "offline\n", stderr: "" } : undefined));
    expect(serviceInstall(linux.d)).rejects.toMatchObject({ code: "no-manager" });
    const mac = await deps("darwin", (cmd) => (cmd.join(" ") === "launchctl print gui/501" ? { code: 1, stdout: "", stderr: "" } : undefined));
    expect(serviceInstall(mac.d)).rejects.toBeInstanceOf(ServiceError);
    expect(await Bun.file(join(mac.units, `${SERVER_LABEL}.plist`)).exists()).toBe(false);
  });

  test("leaves a workspace of the AI Space app alone; restart drives the app's service", async () => {
    const { d, ran, ws, units } = await deps("linux", undefined, { SPACE_LOCAL_AGENTS: "" });
    await mkdir(ws, { recursive: true });
    await Bun.write(join(ws, OWNERSHIP_FILE), JSON.stringify({ managedBy: MANAGED_BY, installedAt: "2026-01-01T00:00:00Z", version: "1.0.0", release: "1.0.0-abc" }));
    expect(serviceInstall(d)).rejects.toMatchObject({ code: "local-edition" });
    expect(serviceRemove(d)).rejects.toMatchObject({ code: "local-edition" });
    expect(planUninstall(d)).rejects.toMatchObject({ code: "local-edition" });
    expect(await Bun.file(join(units, SERVER_UNIT)).exists()).toBe(false);
    // The app's unit lives where the app wrote it; here that is the test's directory.
    const local = { ...d, env: { ...d.env, SPACE_LOCAL_AGENTS: units } };
    await mkdir(units, { recursive: true });
    await Bun.write(join(units, "ai-space-local.service"), "[Unit]\n");
    const s = await serviceRestart(local);
    expect(ran).toContain("systemctl --user restart -- ai-space-local.service");
    expect(s).toMatchObject({ kind: "local", name: "ai-space-local.service", logs: "journalctl --user -u ai-space-local" });
  });
});

describe("restart, status, remove", () => {
  test("restart needs an installed unit", async () => {
    const { d } = await deps("linux");
    expect(serviceRestart(d)).rejects.toMatchObject({ code: "not-installed" });
    expect(await serviceStatus(d)).toMatchObject({ installed: false });
  });

  test("on a Mac a restart unloads and loads the label", async () => {
    const { d, ran, units } = await deps("darwin");
    await serviceInstall(d);
    ran.length = 0;
    await serviceRestart(d);
    expect(ran).toContain(`launchctl bootstrap gui/501 ${join(units, `${SERVER_LABEL}.plist`)}`);
  });

  test("remove stops it, switches it off and deletes the unit", async () => {
    const { d, ran, units } = await deps("linux");
    await serviceInstall(d);
    ran.length = 0;
    const s = await serviceRemove(d);
    expect(ran).toContain("systemctl --user disable --now -- ai-space.service");
    expect(ran).toContain("systemctl --user daemon-reload");
    expect(await Bun.file(join(units, SERVER_UNIT)).exists()).toBe(false);
    expect(s.installed).toBe(false);
  });
});

describe("uninstall", () => {
  /** A release installation: `<prefix>/releases/1.0.0` with `current`, and the links the installer makes. */
  async function installed(platform: "linux" | "darwin") {
    const t = await deps(platform);
    const prefix = join(t.home, ".local", "share", "ai-space");
    const release = join(prefix, "releases", "1.0.0");
    await mkdir(join(release, "deploy"), { recursive: true });
    await mkdir(join(release, "bin"), { recursive: true });
    await mkdir(join(release, "runtime"), { recursive: true });
    await Bun.write(join(release, "deploy", "ai-space.service"), template);
    await Bun.write(join(release, "RELEASE.json"), JSON.stringify({ product: "ai-space", edition: "server", version: "1.0.0", commit: "abc" }));
    await Bun.write(join(release, "bin", "space"), "#!/bin/sh\n");
    await Bun.write(join(release, "runtime", "bun"), "");
    await symlink(join("releases", "1.0.0"), join(prefix, "current"));
    const bin = join(t.home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await symlink(join(prefix, "current", "bin", "space"), join(bin, "space"));
    await symlink(join(prefix, "current", "runtime", "bun"), join(bin, "bun"));
    await symlink("/usr/bin/true", join(bin, "other"));
    const d: ServiceDeps = { ...t.d, root: join(prefix, "current"), bun: join(prefix, "current", "runtime", "bun") };
    await mkdir(join(t.ws, "run", "env"), { recursive: true });
    await Bun.write(join(t.ws, ".env"), "SPACE_PORT=8700\n");
    return { ...t, d, prefix, bin };
  }

  test.skipIf(!CAN_SYMLINK)("plans the apps' units of this workspace, the service, the links and the program; keeps the workspace", async () => {
    const t = await installed("linux");
    await serviceInstall(t.d);
    // One app unit this workspace's supervisor wrote, one of another workspace, one of an operator.
    const mine = `# Written by ai-space. Do not edit: it is regenerated on every app sync.\n[Service]\nEnvironmentFile=${join(t.ws, "run", "env", "notes.env")}\n`;
    await Bun.write(join(t.units, "space-notes.service"), mine);
    await Bun.write(join(t.units, "space-other.service"), mine.replace(t.ws, "/elsewhere"));
    await Bun.write(join(t.units, "caddy.service"), "[Service]\n");
    const plan = await planUninstall(t.d);
    expect(plan.steps.map((s) => [s.what, s.target])).toEqual([
      ["app-service", join(t.units, "space-notes.service")],
      ["service", join(t.units, SERVER_UNIT)],
      ["link", join(t.bin, "space")],
      ["link", join(t.bin, "bun")],
      ["program", t.prefix],
    ]);
    expect(plan.kept.join("\n")).toContain(t.ws);

    t.ran.length = 0;
    await runUninstall(t.d, plan);
    expect(t.ran).toContain("systemctl --user disable --now -- space-notes.service");
    expect(t.ran).toContain("systemctl --user disable --now -- ai-space.service");
    for (const gone of [join(t.units, "space-notes.service"), join(t.units, SERVER_UNIT), join(t.bin, "space"), join(t.bin, "bun"), t.prefix]) expect(await Bun.file(gone).exists()).toBe(false);
    for (const stays of [join(t.units, "space-other.service"), join(t.units, "caddy.service"), join(t.ws, ".env")]) expect(await Bun.file(stays).exists()).toBe(true);
    expect((await Bun.file(join(t.bin, "other")).exists())).toBe(true);
  });

  test("--workspace deletes the data too; a checkout's code is never deleted", async () => {
    const t = await deps("darwin");
    await mkdir(t.ws, { recursive: true });
    await Bun.write(join(t.ws, ".env"), "");
    await serviceInstall(t.d);
    const plan = await planUninstall(t.d, { workspace: true });
    expect(plan.steps.map((s) => s.what)).toEqual(["service", "workspace"]);
    expect(plan.kept.join("\n")).toContain("a checkout, not a release");
    await runUninstall(t.d, plan);
    expect(await Bun.file(join(t.ws, ".env")).exists()).toBe(false);
    expect(await Bun.file(join(t.code, "deploy", "ai-space.service")).exists()).toBe(true);
    expect(t.ran).toContain("launchctl disable gui/501/ai.space.server");
  });
});
