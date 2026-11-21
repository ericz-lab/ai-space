import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { type ServiceDeps, serviceInstall, serviceRemove, serviceRestart, serviceStatus, serviceStop, serviceWorkspace } from "../service.ts";
import type { RunResult } from "./manager.ts";
import { LAUNCHER_HEAD, TASK_NAME, TaskScheduler, renderLauncher, renderTask, taskFileBytes, workspaceOfLauncher } from "./schtasks.ts";

const root = await mkdtemp(join(tmpdir(), "space-schtasks-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const SYSTEM32 = String.raw`C:\Windows\System32`;
const schtasks = win32.join(SYSTEM32, "schtasks.exe");

describe("the launcher", () => {
  const u = { root: String.raw`C:\Program Files\ai-space\current`, bun: String.raw`C:\Program Files\ai-space\current\runtime\bun.exe`, workspace: String.raw`C:\Users\me\.ai-space` };

  test("sets the workspace, puts the Bun first on the search path, and appends the output to the workspace's log", () => {
    const lines = renderLauncher(u).split("\r\n");
    expect(lines.slice(0, 2).join("\r\n")).toBe(LAUNCHER_HEAD);
    expect(lines).toContain(String.raw`set "SPACE_HOME=C:\Users\me\.ai-space"`);
    expect(lines).toContain(String.raw`set "PATH=C:\Program Files\ai-space\current\runtime;%PATH%"`);
    expect(lines).toContain(String.raw`cd /d "C:\Program Files\ai-space\current"`);
    expect(lines).toContain(String.raw`"C:\Program Files\ai-space\current\runtime\bun.exe" "C:\Program Files\ai-space\current\src\index.ts" >> "C:\Users\me\.ai-space\logs\space.log" 2>&1`);
  });

  test("gives its workspace back, percent signs included", () => {
    expect(workspaceOfLauncher(renderLauncher(u))).toBe(u.workspace);
    const odd = String.raw`D:\100%\ws`;
    expect(renderLauncher({ ...u, workspace: odd })).toContain(String.raw`set "SPACE_HOME=D:\100%%\ws"`);
    expect(workspaceOfLauncher(renderLauncher({ ...u, workspace: odd }))).toBe(odd);
    expect(workspaceOfLauncher("")).toBeUndefined();
  });
});

describe("the task", () => {
  const text = renderTask({ root: String.raw`C:\code`, bun: String.raw`C:\bun\bun.exe`, workspace: String.raw`C:\ws`, user: String.raw`BOX\me & co`, launcher: String.raw`C:\Users\me\AppData\Local\ai-space\service\ai-space.cmd`, system32: SYSTEM32 });

  test("starts at this user's logon, in their session, without a console window", () => {
    expect(text).toContain(String.raw`<LogonTrigger><Enabled>true</Enabled><UserId>BOX\me &amp; co</UserId></LogonTrigger>`);
    expect(text).toContain("<LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel>");
    expect(text).toContain(String.raw`<Command>C:\Windows\System32\conhost.exe</Command>`);
    expect(text).toContain(String.raw`<Arguments>--headless C:\Windows\System32\cmd.exe /d /s /c &quot;&quot;C:\Users\me\AppData\Local\ai-space\service\ai-space.cmd&quot;&quot;</Arguments>`);
  });

  test("is never ended for running long or on battery, and is started again after a crash", () => {
    expect(text).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(text).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(text).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(text).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(text).toContain("<RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>");
  });

  test("is written as the UTF-16 file its declaration names", () => {
    const bytes = taskFileBytes(text);
    expect([...bytes.slice(0, 2)]).toEqual([0xff, 0xfe]);
    expect(new TextDecoder("utf-16le").decode(bytes.slice(2))).toBe(text);
  });
});

describe("schtasks", () => {
  test("reads registered and enabled from the task's XML, whatever the system's language", async () => {
    const answers: Record<string, RunResult> = {
      on: ok("<Task><Settings><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings><Triggers><LogonTrigger><Enabled>false</Enabled></LogonTrigger></Triggers></Task>"),
      off: ok("<Task><Settings>\r\n  <Enabled>false</Enabled>\r\n</Settings></Task>"),
      none: { code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified." },
    };
    const ts = new TaskScheduler({ run: async (cmd) => answers[cmd[3]!]!, system32: SYSTEM32 });
    expect(await ts.query("on")).toEqual({ registered: true, enabled: true }); // left out under Settings when true; a trigger's own flag is not it
    expect(await ts.query("off")).toEqual({ registered: true, enabled: false });
    expect(await ts.query("none")).toEqual({ registered: false, enabled: false });
  });

  test("a refused command says which and why", async () => {
    const ts = new TaskScheduler({ run: async () => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied.\r\n" }), system32: SYSTEM32 });
    await expect(ts.create(TASK_NAME, "x.xml")).rejects.toThrow("schtasks /Create /TN ai-space /XML x.xml /F: ERROR: Access is denied.");
  });
});

describe("the service on Windows", () => {
  async function deps() {
    const home = await mkdtemp(join(root, "home-"));
    const ran: string[] = [];
    let registered = false;
    let enabled = true;
    const d: ServiceDeps = {
      env: { USERNAME: "me", USERDOMAIN: "BOX", SystemRoot: String.raw`C:\Windows`, SPACE_HOME: join(home, "ws"), SPACE_SERVICE_UNITS: join(home, "units") },
      home,
      root: join(home, "code"),
      bun: join(home, "bun", "bun.exe"),
      uid: 0,
      platform: "win32",
      settleMs: 0,
      log: () => {},
      run: async (cmd) => {
        ran.push(cmd.map((a) => (a === schtasks ? "schtasks" : a)).join(" "));
        if (cmd[0] !== schtasks) return ok();
        if (cmd[1] === "/Create") registered = enabled = true;
        if (cmd[1] === "/Delete") registered = false;
        if (cmd[1] === "/Change") enabled = cmd[4] === "/ENABLE";
        if (cmd[1] === "/Query" && cmd[3] === TASK_NAME) return registered ? ok(`<Task><Settings>${enabled ? "" : "<Enabled>false</Enabled>"}</Settings></Task>`) : { code: 1, stdout: "", stderr: "ERROR: not found" };
        return ok();
      },
    };
    return { d, ran, home, units: join(home, "units"), ws: join(home, "ws") };
  }

  test("install writes the launcher and the task, registers it and starts it", async () => {
    const t = await deps();
    expect(await serviceStatus(t.d)).toMatchObject({ kind: "server", manager: "task-scheduler", name: "ai-space", installed: false, running: false, workspace: t.ws, logs: join(t.ws, "logs", "space.log") });
    const s = await serviceInstall(t.d);
    expect(s).toMatchObject({ installed: true, enabled: true, file: join(t.units, "ai-space.xml") });
    expect(await Bun.file(join(t.units, "ai-space.cmd")).text()).toStartWith(LAUNCHER_HEAD);
    expect(new TextDecoder("utf-16le").decode((await Bun.file(join(t.units, "ai-space.xml")).bytes()).slice(2))).toContain(String.raw`<UserId>BOX\me</UserId>`);
    const xml = join(t.units, "ai-space.xml");
    expect(t.ran.filter((c) => !c.includes("/Query"))).toEqual(["schtasks /End /TN ai-space", `schtasks /Create /TN ai-space /XML ${xml} /F`, "schtasks /Change /TN ai-space /ENABLE", "schtasks /Run /TN ai-space"]);
    // A deploy without the operator's environment finds the workspace in the launcher.
    expect(await serviceWorkspace({ ...t.d, env: { SPACE_SERVICE_UNITS: t.units } })).toBe(t.ws);
  });

  test("stop keeps it off at logon; restart ends and starts it; remove unregisters and deletes both files", async () => {
    const t = await deps();
    await serviceInstall(t.d);
    t.ran.length = 0;
    expect(await serviceStop(t.d)).toMatchObject({ installed: true, enabled: false, running: false });
    expect(t.ran.filter((c) => !c.includes("/Query"))).toEqual(["schtasks /Change /TN ai-space /DISABLE", "schtasks /End /TN ai-space"]);
    t.ran.length = 0;
    await serviceRestart(t.d);
    expect(t.ran.filter((c) => !c.includes("/Query"))).toEqual(["schtasks /End /TN ai-space", "schtasks /Run /TN ai-space"]);
    t.ran.length = 0;
    expect(await serviceRemove(t.d)).toMatchObject({ installed: false, enabled: false });
    expect(t.ran).toContain("schtasks /Delete /TN ai-space /F");
    expect(await Bun.file(join(t.units, "ai-space.xml")).exists()).toBe(false);
    expect(await Bun.file(join(t.units, "ai-space.cmd")).exists()).toBe(false);
  });

  test("a launcher someone else wrote is not deleted with the task", async () => {
    const t = await deps();
    await serviceInstall(t.d);
    await Bun.write(join(t.units, "ai-space.cmd"), "@echo off\r\nrem mine\r\n");
    await serviceRemove(t.d);
    expect(await Bun.file(join(t.units, "ai-space.cmd")).exists()).toBe(true);
  });

  test("without an account name there is nothing to start at logon", async () => {
    const t = await deps();
    await expect(serviceInstall({ ...t.d, env: { ...t.d.env, USERNAME: "" } })).rejects.toThrow("USERNAME is not set");
  });
});
