/**
 * What a supervised app looks like to launchd on macOS: one LaunchAgent and
 * one environment file, both rendered here, as `unit.ts` does for systemd,
 * so the supervisor can tell "unchanged" from "changed" by comparing text
 * (docs/supervision.md#macos).
 */

/** The first two lines of every LaunchAgent ai-space writes; a plist without them is never touched. */
export const PLIST_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!-- Written by ai-space. Do not edit: it is regenerated on every app sync. -->';

/** The label of an app's LaunchAgent; the file is `<label>.plist`. The operator's own are labelled after the app. */
export function launchLabel(app: string): string {
  return `space.${app}`;
}

/**
 * The script launchd runs, through `/bin/sh -c SCRIPT space-<app> <env file> <command>`:
 * it sources the environment file (without one it exits 78, which launchd
 * retries; a failed `.` would end a POSIX shell before any `||`), runs the
 * command in the background and waits for it. launchd sends SIGTERM to this shell only; the trap passes it to the whole process
 * group, which launchd made for the job, so the app gets the SIGTERM the
 * contract promises however the command spawns it (the counterpart of
 * systemd's `KillMode=control-group`). A command run in the foreground would
 * hold the trap back until it exited. The command's exit status becomes the
 * job's, so `KeepAlive.SuccessfulExit=false` restarts it after a crash only.
 */
export const LAUNCH_SCRIPT = `[ -r "$1" ] || exit 78; . "$1"; trap 'trap "" TERM; kill -TERM 0 2>/dev/null; wait; exit 143' TERM INT HUP; /bin/sh -c "$2" & wait $!`;

export type PlistInput = {
  app: string;
  dir: string;
  command: string;
  envFile: string;
  /** stdout and stderr of the app, appended. */
  logFile: string;
};

/**
 * The LaunchAgent. `RunAtLoad` starts it at login (and when it is loaded),
 * `KeepAlive.SuccessfulExit=false` restarts it when it exits with an error
 * (`Restart=on-failure`), `ThrottleInterval` spaces the restarts, and
 * `ExitTimeOut` leaves the app the 10 seconds of the contract with room to
 * spare before launchd kills it. The credentials stay in the environment
 * file (mode 0600), not in the plist, which other users may read.
 */
export function renderPlist(u: PlistInput): string {
  const str = (s: string) => `<string>${xml(s)}</string>`;
  const command = u.command.trim();
  return [
    PLIST_HEAD,
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key>${str(launchLabel(u.app))}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...["/bin/sh", "-c", LAUNCH_SCRIPT, `space-${u.app}`, u.envFile, command].map((a) => `    ${str(a)}`),
    "  </array>",
    `  <key>WorkingDirectory</key>${str(u.dir)}`,
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
    "  <key>ThrottleInterval</key><integer>5</integer>",
    "  <key>ExitTimeOut</key><integer>30</integer>",
    "  <key>ProcessType</key><string>Standard</string>",
    `  <key>StandardOutPath</key>${str(u.logFile)}`,
    `  <key>StandardErrorPath</key>${str(u.logFile)}`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The environment file the script sources: `export KEY='value'` lines, a
 * `'` closed, escaped and reopened, so the shell expands nothing. A line
 * break inside the quotes is kept as is; only a name the shell would not
 * accept is left out and reported.
 */
export function renderShellEnv(vars: Record<string, string>): { text: string; skipped: string[] } {
  const lines = ["# Written by ai-space for the LaunchAgent of this app; regenerated on every app sync."];
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    if (!ENV_KEY_RE.test(k)) {
      skipped.push(k);
      continue;
    }
    lines.push(`export ${k}='${v.replace(/'/g, `'\\''`)}'`);
  }
  return { text: lines.join("\n") + "\n", skipped };
}

/** Text for a plist `<string>`; a control character XML cannot carry is refused rather than dropped. */
function xml(s: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)) throw new Error("a control character cannot go into a LaunchAgent; move it into a script");
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
