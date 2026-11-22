import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { type InstallOutcome, candidatePorts, findLocalSpace, installLocalSpace, installerEnviron, installerProblem, waitForLocalSpace, workspaceEnvFile } from "../core/first-launch.ts";
import { bytesToText, log, path, readText, sleep, writeText } from "./env.ts";
import { plainRequest } from "./http.ts";

/**
 * The requests and the process behind the first launch (core/first-launch.ts): the look at this
 * computer's ports, and the release's own installer, downloaded and run with bash. The app only
 * ever installs: it never upgrades, stops or removes the service (`space upgrade`, `space uninstall`).
 */

/** One look for an AI Space on this computer: the workspace's port, then 8700. */
export async function lookForLocalSpace(): Promise<string | undefined> {
  const envText = await readText(workspaceEnvFile(GLib.get_home_dir(), GLib.getenv("SPACE_HOME")));
  const url = await findLocalSpace(candidatePorts(envText), async (target) => {
    const r = await plainRequest("GET", target, { Accept: "application/json" }, { quick: true });
    return { status: r.status, body: bytesToText(r.bytes) };
  });
  log("first launch", url ? `found ${url}` : "no Space on this computer");
  return url;
}

/** The installer as a file of its own in a new private directory. */
async function download(url: string): Promise<string> {
  let status = 200;
  let text: string;
  if (url.startsWith("file://")) {
    const [contents] = (await Gio.File.new_for_uri(url).load_contents_async(null)) as [Uint8Array];
    text = bytesToText(contents);
  } else {
    const r = await plainRequest("GET", url, { Accept: "*/*" }, { follow: true });
    status = r.status;
    text = bytesToText(r.bytes);
  }
  const problem = installerProblem(status, text);
  if (problem) throw new Error(`${url}: ${problem}`);
  const file = path(GLib.Dir.make_tmp("ai-space-desktop-XXXXXX"), "install.sh");
  await writeText(file, text, 0o600);
  return file;
}

function cleanup(file: string): void {
  GLib.unlink(file);
  GLib.rmdir(GLib.path_get_dirname(file));
}

/** Runs the command in the app's environment plus `env`, with no input, its output and errors read line by line. */
async function run(argv: string[], env: Record<string, string>, onLine: (line: string) => void): Promise<number> {
  const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE });
  launcher.set_environ(installerEnviron(GLib.get_environ(), env));
  launcher.set_cwd(GLib.get_home_dir());
  log("first launch", argv.join(" "));
  const proc = launcher.spawnv(argv);
  const lines = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe(), newline_type: Gio.DataStreamNewlineType.ANY });
  const decoder = new TextDecoder();
  for (;;) {
    const [line] = (await lines.read_line_async(GLib.PRIORITY_DEFAULT, null)) as [Uint8Array | null, number];
    if (line === null) break;
    onLine(decoder.decode(line));
  }
  await proc.wait_async(null);
  return proc.get_if_exited() ? proc.get_exit_status() : -1;
}

const clock = { now: () => Date.now(), sleep };

/** Installs AI Space on this computer with the release's installer and waits for it to answer. */
export function installOnThisComputer(on: { line: (line: string) => void; starting: () => void }): Promise<InstallOutcome> {
  return installLocalSpace({ downloadBase: GLib.getenv("AI_SPACE_DOWNLOAD"), download, run, cleanup, find: lookForLocalSpace, clock, onLine: on.line, onStarting: on.starting });
}

/** Looks again for a while, after an installer that ended well but whose Space had not answered yet. */
export function waitForThisComputer(): Promise<string | undefined> {
  return waitForLocalSpace(lookForLocalSpace, clock);
}
