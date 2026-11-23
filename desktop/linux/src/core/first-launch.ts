import { parseEnvText } from "./peer.ts";

/**
 * The first launch of the app that carries no service (AI Space Desktop): two entries, the AI Space
 * on this computer or one on another machine. The first connects straight to the one found here;
 * with none it installs the standard one first, with the release's own one-command installer
 * (release/get.sh, published as `install.sh`), behind a single progress bar (`InstallProgress`). The app never bundles, upgrades, stops or
 * removes that service. Everything here is text and injected calls; `app/welcome.ts` draws it and
 * `app/first-launch.ts` does the requests and runs the installer.
 */

/** The port a standard installation listens on (docs/release.md#one-command-install). */
export const STANDARD_PORT = 8700;

/** The installer the latest release carries. */
export const INSTALLER_URL = "https://github.com/ericz-lab/ai-space/releases/latest/download/install.sh";

/** How long the service gets to answer after its installer ended, and how often it is asked. */
export const START_TIMEOUT_MS = 30_000;
export const START_EVERY_MS = 1_000;

/** The workspace's `.env`: under `SPACE_HOME` when that is set, else `~/.ai-space`. */
export function workspaceEnvFile(home: string, spaceHome?: string | null): string {
  const dir = (spaceHome?.trim() || `${home.replace(/\/+$/, "")}/.ai-space`).replace(/\/+$/, "");
  return `${dir}/.env`;
}

/** `SPACE_PORT` of a workspace `.env`, when it names a port. */
export function portFromEnv(text: string): number | undefined {
  const raw = parseEnvText(text).SPACE_PORT?.trim() ?? "";
  if (!/^\d{1,5}$/.test(raw)) return undefined;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : undefined;
}

/** The ports to ask, in order: the workspace's own, then the standard one. */
export function candidatePorts(envText?: string): number[] {
  const own = envText === undefined ? undefined : portFromEnv(envText);
  return own === undefined || own === STANDARD_PORT ? [STANDARD_PORT] : [own, STANDARD_PORT];
}

/** The address a Space on this computer is saved under (`LOCAL_DEFAULT_URL` for the standard port). */
export const localSpaceUrl = (port: number) => `http://127.0.0.1:${port}/`;

/**
 * Whether an answer to `GET /api/space` is an AI Space's: JSON that says `product: "ai-space"`.
 * Nothing more is asked here: a Space this client is too old for is still the Space on this
 * computer, and the window then says so (`classifyIdentity`) instead of offering to install one.
 */
export function answersAsSpace(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    const id = JSON.parse(body) as { product?: unknown } | null;
    return typeof id === "object" && id !== null && id.product === "ai-space";
  } catch {
    return false;
  }
}

/** `GET <url>` with a short timeout; throws when nothing answered. */
export type Probe = (url: string) => Promise<{ status: number; body: string }>;

/** The first candidate port an AI Space answers on, as its address. */
export async function findLocalSpace(ports: readonly number[], probe: Probe): Promise<string | undefined> {
  for (const port of ports) {
    const url = localSpaceUrl(port);
    try {
      const r = await probe(`${url}api/space`);
      if (answersAsSpace(r.status, r.body)) return url;
    } catch {
      // Nothing listens there, or it did not answer in time.
    }
  }
  return undefined;
}

export type Clock = { now: () => number; sleep: (ms: number) => Promise<void> };

/** Looks again until a Space answers or the time is up (a service just installed takes a moment to start). */
export async function waitForLocalSpace(find: () => Promise<string | undefined>, clock: Clock, timeoutMs = START_TIMEOUT_MS, everyMs = START_EVERY_MS): Promise<string | undefined> {
  const until = clock.now() + timeoutMs;
  for (;;) {
    const url = await find();
    if (url) return url;
    if (clock.now() + everyMs > until) return undefined;
    await clock.sleep(everyMs);
  }
}

/** Where the installer comes from: `AI_SPACE_DOWNLOAD` (a mirror, or `file://` in tests), which the installer reads too, else the latest release. */
export function installerUrl(downloadBase?: string | null): string {
  const base = downloadBase?.trim().replace(/\/+$/, "");
  return base ? `${base}/install.sh` : INSTALLER_URL;
}

export const installerCommand = (file: string): string[] => ["bash", file];

/** What the installer's environment gets on top of the app's own: the app shows the Space itself, so no browser. */
export const INSTALLER_ENV: Record<string, string> = { AI_SPACE_NO_OPEN: "1" };

/** The app's environment (`KEY=value` entries) with the installer's additions. */
export function installerEnviron(environ: readonly string[], extra: Record<string, string> = INSTALLER_ENV): string[] {
  return [...environ.filter((e) => !(e.slice(0, Math.max(0, e.indexOf("="))) in extra)), ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
}

/** Why a download is not the installer, if it is not: an error page must never reach `bash`. */
export function installerProblem(status: number, text: string): string | undefined {
  if (status < 200 || status >= 300) return `HTTP ${status}`;
  if (!text.startsWith("#!")) return "not a shell script";
  return undefined;
}

/** The last lines of the installer's output, without the empty ones at its end. */
export function outputTail(lines: readonly string[], count = 12): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]!.trim()) end--;
  return lines.slice(Math.max(0, end - count), end);
}

/**
 * How an installation ended. `download`: the installer could not be fetched; `failed`: it ended
 * with a code other than 0 (-1 when a signal ended it); `silent`: it ended well but no Space
 * answered in time.
 */
export type InstallOutcome = { ok: true; url: string } | { ok: false; reason: "download" | "failed" | "silent"; code?: number; tail: string[] };

export type InstallDeps = {
  /** `AI_SPACE_DOWNLOAD`, when set. */
  downloadBase?: string | null;
  /** Saves the installer at `url` to a temporary file and returns its path; throws with the reason. */
  download: (url: string) => Promise<string>;
  /** Runs the command with `env` added to the app's environment, calls `onLine` for each line of output, and returns its exit code. */
  run: (argv: string[], env: Record<string, string>, onLine: (line: string) => void) => Promise<number>;
  /** Removes the temporary file. */
  cleanup?: (file: string) => void;
  /** One look for a Space on this computer (the workspace's port is read again each time: the installer may just have written it). */
  find: () => Promise<string | undefined>;
  clock: Clock;
  /** Each line as it comes, for the screen. */
  onLine?: (line: string) => void;
  /** The installer ended well and the app waits for the service to answer. */
  onStarting?: () => void;
};

/** Downloads the release's installer, runs it, and waits for the Space it started. */
export async function installLocalSpace(deps: InstallDeps): Promise<InstallOutcome> {
  const lines: string[] = [];
  const onLine = (line: string) => {
    lines.push(line);
    deps.onLine?.(line);
  };
  let file: string;
  try {
    file = await deps.download(installerUrl(deps.downloadBase));
  } catch (e) {
    onLine(e instanceof Error ? e.message : String(e));
    return { ok: false, reason: "download", tail: outputTail(lines) };
  }
  let code: number;
  try {
    code = await deps.run(installerCommand(file), INSTALLER_ENV, onLine);
  } catch (e) {
    onLine(e instanceof Error ? e.message : String(e));
    code = -1;
  } finally {
    deps.cleanup?.(file);
  }
  if (code !== 0) return { ok: false, reason: "failed", code, tail: outputTail(lines) };
  deps.onStarting?.();
  const url = await waitForLocalSpace(deps.find, deps.clock);
  return url ? { ok: true, url } : { ok: false, reason: "silent", tail: outputTail(lines) };
}

/**
 * The one progress bar shown while AI Space is installed (docs/editions.md#ai-space-client). The
 * installer prints no percentages, so the bar moves by the lines it prints at each step (the same
 * in release/get.sh and release/install.ps1) and creeps on within a step, slowing as it nears the
 * step's ceiling, so a long download never looks stuck. Each step starts above the ceiling of the
 * one before: the bar only goes forward. The Mac's `InstallProgress` (SpaceInstaller.swift) is the same.
 */
export type InstallStage = "fetching" | "looking" | "downloading" | "placing" | "apps" | "starting";

/** In order; each step's start, the ceiling it creeps toward, and its usual length in seconds. */
export const INSTALL_STAGES: readonly { stage: InstallStage; from: number; to: number; seconds: number }[] = [
  { stage: "fetching", from: 0, to: 0.05, seconds: 4 },
  { stage: "looking", from: 0.05, to: 0.1, seconds: 4 },
  { stage: "downloading", from: 0.1, to: 0.55, seconds: 45 },
  { stage: "placing", from: 0.6, to: 0.8, seconds: 20 },
  { stage: "apps", from: 0.85, to: 0.95, seconds: 40 },
  { stage: "starting", from: 0.95, to: 0.99, seconds: 8 },
];

/** The step a line of the installer's output begins, if it begins one. */
export function installStageOf(line: string): InstallStage | undefined {
  const l = line.trim();
  if (l.startsWith("ai-space: looking for")) return "looking";
  if (l.startsWith("ai-space: downloading ")) return "downloading";
  if (l.startsWith("ai-space core: installed")) return "apps";
  if (l.startsWith("ai-space is running")) return "starting";
  if (/^ai-space \S+ \(\S+\) in /.test(l)) return "placing";
  return undefined;
}

export class InstallProgress {
  private index = 0;
  private since: number;

  constructor(now: number, stage: InstallStage = "fetching") {
    this.since = now;
    this.enter(stage, now);
  }

  get stage(): InstallStage {
    return INSTALL_STAGES[this.index]!.stage;
  }

  /** Moves to `stage` when it is a later step; an earlier or the same one changes nothing. */
  enter(stage: InstallStage, now: number): void {
    const i = INSTALL_STAGES.findIndex((s) => s.stage === stage);
    if (i <= this.index) return;
    this.index = i;
    this.since = now;
  }

  read(line: string, now: number): void {
    const stage = installStageOf(line);
    if (stage) this.enter(stage, now);
  }

  /** The bar's value, 0 to 1 (1 only once the Space answers, which is not a step here). */
  value(now: number): number {
    const s = INSTALL_STAGES[this.index]!;
    const elapsed = Math.max(0, now - this.since) / 1000;
    return s.from + (s.to - s.from) * (1 - Math.exp(-elapsed / s.seconds));
  }
}
