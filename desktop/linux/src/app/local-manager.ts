import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Secret from "gi://Secret";
import { type InstallResult, LocalFailure, type LocalStatus, type Release, decodeLocal, hasSession, needsDeviceCredential, runtimeArgs, updateAvailable } from "../core/local.ts";
import { hostOf, resolveUrl } from "../core/url.ts";
import { APP_ROOT, dirs, exists, log, logError, openExternally, path, prefs, readTextSync, savePrefs, t, writeText } from "./env.ts";
import { plainRequest } from "./http.ts";
import type { AppModel, Space } from "./model.ts";
import { allCookies, storeResponseCookies } from "./web.ts";

/**
 * The Local edition's side of the app (docs/local.md), as the Mac's `LocalManager`: it reads
 * where this computer stands, installs or upgrades the service from the release the app carries
 * in `<app>/space`, starts, stops and removes the systemd user service, and keeps the app signed
 * in to it with its device credential. Every change goes through `space local … --json` with the
 * Bun inside that release; the service process belongs to systemd, so quitting the app leaves it
 * running.
 */

Gio._promisify(Secret, "password_store", "password_store_finish");
Gio._promisify(Secret, "password_lookup", "password_lookup_finish");
Gio._promisify(Secret, "password_clear", "password_clear_finish");

export type Bundle = { root: string; bun: string; entry: string; version: string; commit: string };

/** `<app>/space/RELEASE.json` of the Local edition; absent in the Client edition. `AISPACE_LOCAL_BUNDLE` points elsewhere for development. */
export function findBundle(): Bundle | undefined {
  const root = GLib.getenv("AISPACE_LOCAL_BUNDLE") || path(APP_ROOT, "space");
  try {
    const info = JSON.parse(readTextSync(path(root, "RELEASE.json")) ?? "") as Release;
    if (info.product !== "ai-space" || info.edition !== "local") return undefined;
    const bun = path(root, "runtime", "bun");
    if (!exists(bun)) return undefined;
    return { root, bun, entry: path(root, "src", "index.ts"), version: info.version, commit: info.commit };
  } catch {
    return undefined;
  }
}

// The device credential: in the desktop's keyring (Secret Service) by workspace path, or, where
// no keyring answers, in a file only this user can read.
const SCHEMA = new Secret.Schema("dev.ai_space.local.device", Secret.SchemaFlags.NONE, { workspace: Secret.SchemaAttributeType.STRING });
const tokenFile = (workspace: string) => path(dirs.data, `device-${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, workspace, -1).slice(0, 16)}.token`);

export const DeviceToken = {
  async get(workspace: string): Promise<string | undefined> {
    try {
      const v = (await Secret.password_lookup(SCHEMA, { workspace }, null)) as string | null;
      if (v) return v;
    } catch (e) {
      logError(e, "keyring");
    }
    return readTextSync(tokenFile(workspace))?.trim() || undefined;
  },
  async save(workspace: string, token: string): Promise<void> {
    try {
      await Secret.password_store(SCHEMA, { workspace }, Secret.COLLECTION_DEFAULT, `AI Space device credential (${workspace})`, token, null);
      GLib.unlink(tokenFile(workspace));
      return;
    } catch (e) {
      log(t("keyringMissing"), e instanceof Error ? e.message : String(e));
    }
    await writeText(tokenFile(workspace), token, 0o600);
  },
  async delete(workspace: string): Promise<void> {
    try {
      await Secret.password_clear(SCHEMA, { workspace }, null);
    } catch {}
    GLib.unlink(tokenFile(workspace));
  },
};

export type WhenBusy = "refuse" | "wait" | "now";
export type Busy = "setup" | "update" | "migrate" | "wait" | "start" | "stop" | "restart" | "remove";

export class LocalManager {
  readonly bundle = findBundle();
  status: LocalStatus | undefined;
  busy: Busy | undefined;
  failure: LocalFailure | undefined;
  /** The work an automatic update waits for. */
  waitingFor: { kind: string; label: string }[] | undefined;
  private retry = 0;
  private lastSignIn = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly model: AppModel) {
    model.signIn = (space) => this.signIn(space);
  }

  get available(): boolean {
    return Boolean(this.bundle);
  }

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of [...this.listeners]) fn();
  }

  // Commands

  private async run<T>(args: string[]): Promise<T> {
    const b = this.bundle;
    if (!b) throw new LocalFailure("no-bundle", t("noBundle"));
    const launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE });
    // A desktop session's environment is not a terminal's: give the command a plain, known one,
    // plus what `systemctl --user` needs to reach the user's manager.
    const env: Record<string, string> = { HOME: GLib.get_home_dir(), PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" };
    for (const k of ["USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "SPACE_LOCAL_PREFIX", "SPACE_LOCAL_AGENTS", "SPACE_HOME"]) {
      const v = GLib.getenv(k);
      if (v) env[k] = v;
    }
    launcher.set_environ(Object.entries(env).map(([k, v]) => `${k}=${v}`));
    launcher.set_cwd(GLib.get_home_dir());
    const argv = [b.bun, b.entry, "local", ...args, "--json"];
    log("local", args.join(" "));
    const proc = launcher.spawnv(argv);
    const [stdout] = (await proc.communicate_utf8_async(null, null)) as [string | null, string | null];
    return decodeLocal<T>(stdout ?? "");
  }

  private async perform(what: Busy, work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = what;
    this.failure = undefined;
    this.changed();
    try {
      await work();
    } catch (e) {
      this.failure = e instanceof LocalFailure ? e : new LocalFailure("error", e instanceof Error ? e.message : String(e));
      if (this.failure.status) this.status = this.failure.status;
    } finally {
      this.busy = undefined;
      this.changed();
    }
  }

  private get args(): string[] {
    return runtimeArgs(prefs.chosenRuntimes);
  }

  async refresh(): Promise<void> {
    if (!this.available) return;
    try {
      this.status = await this.run<LocalStatus>(["status", ...this.args]);
    } catch (e) {
      this.failure = e instanceof LocalFailure ? e : new LocalFailure("error", String(e));
    }
    this.changed();
  }

  /** An agent CLI the person pointed the app at, when the search does not find it. */
  async chooseRuntime(name: string, file: string | undefined): Promise<void> {
    if (file) prefs.chosenRuntimes[name] = file;
    else delete prefs.chosenRuntimes[name];
    savePrefs();
    await this.refresh();
  }

  /**
   * Install or upgrade, then save the Space it runs and sign in to it. An upgrade while the Space
   * is busy is refused with its work (`failure.activity`), waits for it, or drains it now.
   */
  async install(opts: { migrate?: boolean; whenBusy?: WhenBusy; defaultModel?: string } = {}): Promise<void> {
    if (this.busy) return;
    this.cancelRetry();
    const whenBusy = opts.whenBusy ?? "refuse";
    const label: Busy = opts.migrate ? "migrate" : whenBusy === "wait" ? "wait" : this.status?.state === "managed" ? "update" : "setup";
    await this.perform(label, async () => {
      const current = await this.run<LocalStatus>(["status", ...this.args]);
      this.status = current;
      const needsDevice = needsDeviceCredential(current, Boolean(await DeviceToken.get(this.workspace)));
      const args = ["install"];
      if (opts.migrate) args.push("--migrate");
      if (whenBusy !== "refuse") args.push(`--${whenBusy}`);
      if (needsDevice) args.push("--device", GLib.get_host_name() || "Linux");
      args.push(...this.args);
      if (opts.defaultModel) args.push("--default-model", opts.defaultModel);
      const result = await this.run<InstallResult>(args);
      if (result.device) {
        await DeviceToken.save(result.workspace, result.device.token);
        this.lastSignIn = 0;
      }
      this.status = await this.run<LocalStatus>(["status", ...this.args]);
      const space = this.model.adoptLocal(result.url);
      await this.signIn(space, true);
      void this.model.refresh(space);
    });
  }

  /**
   * The app carries a newer release than the one installed: update without asking once the Space
   * has no work in progress, trying again every two minutes while it has. A service the person
   * stopped is left alone.
   */
  async autoUpdate(): Promise<void> {
    this.cancelRetry();
    const s = this.status;
    if (!s || !updateAvailable(s) || s.service.disabled || this.busy) {
      this.waitingFor = undefined;
      return;
    }
    await this.install();
    if (this.failure?.code === "busy") {
      this.waitingFor = this.failure.activity?.items ?? [];
      this.failure = undefined;
      this.retry = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 120, () => {
        this.retry = 0;
        void this.refresh().then(() => this.autoUpdate());
        return GLib.SOURCE_REMOVE;
      });
    } else this.waitingFor = undefined;
    this.changed();
  }

  private cancelRetry(): void {
    if (this.retry) GLib.source_remove(this.retry);
    this.retry = 0;
    this.waitingFor = undefined;
  }

  start = () => this.lifecycle("start", "start");
  stop = () => this.lifecycle("stop", "stop");
  restart = () => this.lifecycle("restart", "restart");

  /** Stops and unregisters the background service and deletes its program; the workspace stays. */
  async removeService(): Promise<void> {
    await this.lifecycle("remove", "remove-service");
    if (!this.failure) this.model.releaseLocal();
  }

  private async lifecycle(what: Busy, verb: string): Promise<void> {
    this.cancelRetry();
    await this.perform(what, async () => {
      this.status = await this.run<LocalStatus>([verb, ...this.args]);
    });
  }

  openLog(): void {
    const s = this.status;
    if (!s) return;
    const file = path(s.workspace.path, "logs", "space.log");
    openExternally(Gio.File.new_for_path(file).get_uri());
  }

  // Signing in

  /** The workspace the credential belongs to: the status's, else the default. */
  private get workspace(): string {
    return this.status?.workspace.path ?? path(GLib.get_home_dir(), ".ai-space");
  }

  /**
   * Exchanges the device credential for a session cookie in the connection's web data, so the
   * native views and the pages are signed in. At most once every 20 seconds, so a refusal cannot loop.
   */
  async signIn(space: Space, force = false): Promise<boolean> {
    if (!space.conn.managed) return false;
    const token = await DeviceToken.get(this.workspace);
    if (!token) return false;
    if (!force && Date.now() - this.lastSignIn < 20_000) return false;
    this.lastSignIn = Date.now();
    try {
      const url = resolveUrl("/api/auth/device/session", space.client.base) ?? `${space.client.base}/api/auth/device/session`;
      const r = await plainRequest("POST", url, { Authorization: `Bearer ${token}`, Accept: "application/json", Origin: space.client.base });
      if (r.status === 401) {
        // Revoked, or a workspace that never knew it: Repair (install) makes a new one.
        await DeviceToken.delete(this.workspace);
        this.failure = new LocalFailure("device", t("deviceInvalid"));
        this.changed();
        return false;
      }
      if (r.status !== 200) return false;
      return (await storeResponseCookies(space.conn.id, r.msg)) > 0;
    } catch (e) {
      logError(e, "device sign-in");
      return false;
    }
  }

  /** At launch: the app's own Space has no session cookie yet, or it expired. */
  async ensureSignIn(): Promise<void> {
    const c = this.model.list.managed;
    if (!c) return;
    const space = this.model.space(c.id)!;
    const host = hostOf(c.url) ?? "";
    if (hasSession(await allCookies(c.id), host)) return;
    if (await this.signIn(space, true)) void this.model.refresh(space);
  }
}
