import { win32 } from "node:path";
import type { Runner } from "./manager.ts";
import { lastLine } from "./manager.ts";

/**
 * ai-space's background service on Windows: a task of the Task Scheduler that starts when its
 * user logs on (docs/release.md#the-background-service). Not a Windows service: a service runs in
 * session 0 under another logon, where the user's agent CLIs are neither on the search path nor
 * signed in. A task in the user's own session has both, as a LaunchAgent does on a Mac.
 *
 *   <unit dir>\ai-space.xml    the task as registered (`schtasks /Create /XML`)
 *   <unit dir>\ai-space.cmd    what it runs: the environment, the code's directory, the log file
 *
 * The task runs the launcher under `conhost.exe --headless`, so no console window opens at
 * logon. The Task Scheduler knows less than systemd or launchd do: its "end" stops the launcher
 * and leaves what the launcher started, and its state comes back in the system's language. So
 * this file only registers, enables, starts and deletes; `service.ts` reads "running" from the
 * workspace's lock and stops the process the lock names.
 */

export const TASK_NAME = "ai-space";

/** The first lines of the launcher; `remove` deletes no file without them. */
export const LAUNCHER_HEAD = "@echo off\r\nrem Written by ai-space (space service install). Removed by: space service remove.";

export type TaskInput = {
  /** The code the service runs. */
  root: string;
  bun: string;
  workspace: string;
  /** `DOMAIN\user`: who logs on, and whose session the task runs in. */
  user: string;
  /** The launcher's own path, which the task names. */
  launcher: string;
  /** `C:\Windows\System32`. */
  system32: string;
};

/** A path inside a batch file's quotes: a percent sign would start a variable. */
const batch = (s: string) => s.replace(/%/g, "%%");

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The launcher. The session's own environment stays (that is where the agent CLIs are); the Bun's
 * directory goes first on the search path so the apps find the same one. UTF-8, so a workspace
 * under a user name outside the console's code page still resolves.
 */
export function renderLauncher(u: Pick<TaskInput, "root" | "bun" | "workspace">): string {
  const log = win32.join(u.workspace, "logs", "space.log");
  return [
    LAUNCHER_HEAD,
    "chcp 65001 >nul",
    `set "SPACE_HOME=${batch(u.workspace)}"`,
    `set "PATH=${batch(win32.dirname(u.bun))};%PATH%"`,
    `cd /d "${batch(u.root)}"`,
    `"${batch(u.bun)}" "${batch(win32.join(u.root, "src", "index.ts"))}" >> "${batch(log)}" 2>&1`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

/** The workspace a launcher runs on, read back from its text. */
export function workspaceOfLauncher(text: string): string | undefined {
  const m = /^set "SPACE_HOME=(.*)"\r?$/m.exec(text);
  return m ? m[1]!.replace(/%%/g, "%") : undefined;
}

/**
 * The task: started at this user's logon, in their session with their own rights, never stopped
 * for running long or on battery, started again after a crash (the Task Scheduler waits at least
 * a minute), and never twice at once.
 */
export function renderTask(u: TaskInput): string {
  const args = `--headless ${win32.join(u.system32, "cmd.exe")} /d /s /c ""${u.launcher}""`;
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>ai-space: the Space service of this user. Written by: space service install. Removed by: space service remove.</Description>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(u.user)}</UserId></LogonTrigger>`,
    "  </Triggers>",
    "  <Principals>",
    `    <Principal id="Author"><UserId>${xml(u.user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Enabled>true</Enabled>",
    "    <RestartOnFailure><Interval>PT1M</Interval><Count>5</Count></RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    `    <Exec><Command>${xml(win32.join(u.system32, "conhost.exe"))}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(u.root)}</WorkingDirectory></Exec>`,
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** The file `schtasks /Create /XML` reads: UTF-16 with its byte order mark, as the declaration says. */
export function taskFileBytes(text: string): Uint8Array {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

export type TaskState = { registered: boolean; enabled: boolean };

/** `schtasks.exe` with an injectable runner, so tests assert the exact commands with a fake. */
export class TaskScheduler {
  readonly kind = "task-scheduler" as const;
  readonly unavailable = "the Task Scheduler does not answer (schtasks /Query): its service (Schedule) must be running";
  private readonly run: Runner;
  private readonly exe: string;
  private readonly taskkill: string;

  constructor(opts: { run: Runner; system32: string }) {
    this.run = opts.run;
    this.exe = win32.join(opts.system32, "schtasks.exe");
    this.taskkill = win32.join(opts.system32, "taskkill.exe");
  }

  private async must(args: string[]): Promise<void> {
    const r = await this.run([this.exe, ...args]);
    if (r.code !== 0) throw new Error(`schtasks ${args.join(" ")}: ${lastLine(r.stderr) || lastLine(r.stdout) || `exit ${r.code}`}`);
  }

  async available(): Promise<boolean> {
    return (await this.run([this.exe, "/Query", "/TN", "\\"])).code === 0;
  }

  /** Registered or not, and whether it starts at logon. The XML is the same in every language. */
  async query(name: string): Promise<TaskState> {
    const r = await this.run([this.exe, "/Query", "/TN", name, "/XML"]);
    if (r.code !== 0) return { registered: false, enabled: false };
    // `<Enabled>` under Settings is left out when true.
    const settings = /<Settings>[\s\S]*?<\/Settings>/.exec(r.stdout)?.[0] ?? "";
    return { registered: true, enabled: !/<Enabled>\s*false\s*<\/Enabled>/i.test(settings) };
  }

  /** Registers the task from its file, over one of the same name. */
  create(name: string, file: string): Promise<void> {
    return this.must(["/Create", "/TN", name, "/XML", file, "/F"]);
  }

  enable(name: string): Promise<void> {
    return this.must(["/Change", "/TN", name, "/ENABLE"]);
  }

  disable(name: string): Promise<void> {
    return this.must(["/Change", "/TN", name, "/DISABLE"]);
  }

  start(name: string): Promise<void> {
    return this.must(["/Run", "/TN", name]);
  }

  /** Ends the launcher. What it started is ended by `kill`: the Task Scheduler leaves it running. */
  async end(name: string): Promise<void> {
    await this.run([this.exe, "/End", "/TN", name]);
  }

  async delete(name: string): Promise<void> {
    if ((await this.query(name)).registered) await this.must(["/Delete", "/TN", name, "/F"]);
  }

  /** Ends a process and everything it started. Windows has no signal a console program could drain on. */
  async kill(pid: number): Promise<void> {
    await this.run([this.taskkill, "/PID", String(pid), "/T", "/F"]);
  }
}
