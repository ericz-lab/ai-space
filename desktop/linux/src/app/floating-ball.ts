import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { type Agent, pickText } from "../core/catalogue.ts";
import {
  type DialSection, FALLBACK_TITLE, type FromBall, SECTIONS, type Section, type ToBall, decodeFromBall, isOwnDrop, resolveDial,
} from "../core/floating-ball.ts";
import { APP_ROOT, dirs, lang, log, logError, path, prefs, savePrefs, t } from "./env.ts";
import { isImageIcon, loadTexture } from "./icons.ts";
import { unixStreams } from "./unix-streams.ts";
import type { AppModel, Space } from "./model.ts";
import type { QuickChat } from "./quick-chat.ts";

/**
 * The floating ball over every app (core/floating-ball.ts, the Mac's FloatingBall.swift): the
 * app's side. The ball is a process of its own (`ball.js`, GTK 3 on X11, through XWayland on a
 * Wayland desktop), since a Wayland window can neither stay above the others nor place itself;
 * this side starts it, tells it what each section of the dial shows in the current Space, and does
 * what it asks: open Quick Chat on a section's agent, with a dropped picture attached.
 */

/** Pictures the ball wrote for this side to read, under the user's runtime directory. */
const DROPS = path(GLib.get_user_runtime_dir(), "ai-space-drops");
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;

export class FloatingBall {
  private proc: { pid: number; exited: boolean } | undefined;
  private stdin: any;
  private restarts: number[] = [];
  private wanted = false;
  /** Each section's agent in the current Space, and whether it is borrowed from Space Assistant. */
  private agents: Partial<Record<Section, { agent: Agent; borrowed: boolean; title: string }>> = {};
  private iconFiles = new Map<string, string>();

  constructor(
    private readonly app: any,
    private readonly model: AppModel,
    private readonly quick: QuickChat,
    private readonly openSettings: () => void,
  ) {
    model.on((change, space) => {
      if ((change === "catalogue" || change === "selection" || change === "connections") && (!space || space === model.current)) this.pushDial();
    });
    Adw.StyleManager.get_default().connect("notify::dark", () => this.pushDial());
  }

  /** XWayland (or an X11 session) is there to run the ball. */
  static get available(): boolean {
    return Boolean(GLib.getenv("DISPLAY"));
  }

  /** Follows the preference: shown when on, the process ended when off. */
  sync(): void {
    this.wanted = Boolean(prefs.floatingBall) && FloatingBall.available;
    if (this.wanted && !this.proc) this.spawn();
    if (!this.wanted && this.proc) this.stop();
  }

  setVisible(on: boolean): void {
    prefs.floatingBall = on;
    savePrefs();
    this.sync();
  }

  /** Called when the section choices change in Settings. */
  refresh(): void {
    this.pushDial();
  }

  stop(): void {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    this.write({ type: "quit" });
    try {
      this.stdin?.close(null);
    } catch {
      // Already closed.
    }
    this.stdin = undefined;
    // Closing its stdin ends it; a ball that hangs is ended a moment later.
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      if (!proc.exited) GLib.spawn_command_line_async(`kill ${proc.pid}`);
      return GLib.SOURCE_REMOVE;
    });
  }

  private spawn(): void {
    // The same GJS that runs the app (the installed copy, so an AppArmor profile covers both).
    let gjs = "gjs";
    try {
      gjs = GLib.file_read_link("/proc/self/exe");
    } catch {
      // Not Linux's /proc: the gjs on PATH.
    }
    const env = GLib.environ_setenv(GLib.get_environ(), "GDK_BACKEND", "x11", true);
    let pid: number, stdinFd: number, stdoutFd: number, stderrFd: number;
    try {
      // Plain pipes wrapped here, so the streams are GioUnix's where GLib has it (unix-streams.ts).
      [, pid, stdinFd, stdoutFd, stderrFd] = GLib.spawn_async_with_pipes(null, [gjs, "-m", path(APP_ROOT, "ball.js")], env, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null) as [boolean, number, number, number, number];
    } catch (e) {
      logError(e, "could not start the floating ball");
      return;
    }
    const { InputStream, OutputStream } = unixStreams();
    const proc = { pid, exited: false };
    this.proc = proc;
    this.stdin = new OutputStream({ fd: stdinFd, close_fd: true });
    const lines = new Gio.DataInputStream({ base_stream: new InputStream({ fd: stdoutFd, close_fd: true }) });
    const read = () => {
      lines.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: unknown) => {
        let line: string | null = null;
        try {
          [line] = lines.read_line_finish_utf8(res);
        } catch {
          line = null;
        }
        if (line === null) return;
        const m = decodeFromBall(line);
        if (m) this.handle(m);
        read();
      });
    };
    read();
    // The ball's own messages go to the app's: unread, they were lost, and a full pipe would stop the ball.
    const errors = new Gio.DataInputStream({ base_stream: new InputStream({ fd: stderrFd, close_fd: true }) });
    const readErrors = () => {
      errors.read_line_async(GLib.PRIORITY_LOW, null, (_s: unknown, res: unknown) => {
        let line: string | null = null;
        try {
          [line] = errors.read_line_finish_utf8(res);
        } catch {
          line = null;
        }
        if (line === null) return;
        printerr(line);
        readErrors();
      });
    };
    readErrors();
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
      GLib.spawn_close_pid(pid);
      proc.exited = true;
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.stdin = undefined;
      // A ball that ended by itself comes back, unless it keeps ending.
      const now = Date.now();
      this.restarts = [...this.restarts.filter((at) => now - at < 60_000), now];
      if (this.wanted && this.restarts.length <= 3) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => (this.sync(), GLib.SOURCE_REMOVE));
      else if (this.wanted) logError(new Error("it ended three times in a minute"), "floating ball");
    });
    const mark = path(APP_ROOT, "data", "icons", "hicolor", "scalable", "apps", "dev.ai_space.Desktop.svg");
    this.write({ type: "init", ...(prefs.floatingBallOrigin ? { origin: prefs.floatingBallOrigin } : {}), markIcon: mark });
    this.pushDial();
  }

  private write(m: ToBall): void {
    if (!this.stdin) return;
    try {
      this.stdin.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
      this.stdin.flush(null);
    } catch (e) {
      log("floating ball: could not write", String(e));
    }
  }

  /** What each section shows in the current Space, sent to the ball whenever it may have changed. */
  private pushDial(): void {
    if (!this.proc) return;
    const space = this.model.current;
    const catalogue = space?.catalogue;
    const dial = resolveDial(catalogue, space ? prefs.floatingBallSlots?.[space.conn.id] : undefined);
    const sections = {} as Record<Section, DialSection>;
    this.agents = {};
    for (const s of SECTIONS) {
      const d = dial[s];
      const title = d.entry ? pickText(d.entry.title, d.entry.i18n, "title", lang) : FALLBACK_TITLE[s];
      const agent = d.agent && catalogue?.agentInfo.find((a) => a.id === d.agent);
      if (space && agent) this.agents[s] = { agent: this.model.preferredAgent(space, agent), borrowed: d.borrowed, title };
      const icon = d.entry?.icon && space ? this.icon(space, d.entry.icon) : undefined;
      sections[s] = { title, usable: Boolean(agent), hidden: d.hidden, ...(icon ? { icon } : {}), ...(d.entry?.kind === "agent" ? { round: true } : {}) };
    }
    this.write({
      type: "dial",
      sections,
      dark: Adw.StyleManager.get_default().get_dark(),
      labels: {
        addInSettings: t("ballAddInSettings"),
        sendTo: t("ballSendTo", { name: "{name}" }),
        hub: "",
        menu: { quickChat: t("quickChat"), settings: t("settings"), hide: t("ballHide") },
      },
    });
  }

  /** An emoji as it is; an image as a PNG in the cache once it has loaded (the dial is sent again then). */
  private icon(space: Space, icon: string): string | undefined {
    if (!isImageIcon(icon)) return icon;
    const key = `${space.conn.id} ${icon}`;
    const known = this.iconFiles.get(key);
    if (known) return known;
    void loadTexture(icon, space.client, 56).then((texture) => {
      if (!texture) return;
      const file = path(dirs.cache, "ball-icons", `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256, key, -1)}.png`);
      try {
        GLib.mkdir_with_parents(path(dirs.cache, "ball-icons"), 0o700);
        texture.save_to_png(file);
        this.iconFiles.set(key, file);
        this.pushDial();
      } catch (e) {
        logError(e, "floating ball icon");
      }
    });
    return undefined;
  }

  /** Debug (`--action ball=<json>`): a line as if the ball had sent it, for checks without a person. */
  debug(line: string): void {
    const m = decodeFromBall(line);
    log("floating ball: debug", m ?? line);
    if (m) this.handle(m);
    else log("floating ball: not a message", line);
  }

  private handle(m: FromBall): void {
    switch (m.type) {
      case "ready":
        break;
      case "moved":
        prefs.floatingBallOrigin = m.origin;
        savePrefs();
        break;
      case "open":
        this.open(m.section, undefined, m.startupId);
        break;
      case "drop":
        void this.drop(m.file, m.temporary, m.section, m.startupId);
        break;
      case "refuse":
        this.notify(t(m.reason === "several" ? "ballOnePicture" : m.reason === "not-a-picture" ? "ballNotAPicture" : "ballUnreadable"));
        break;
      case "menu":
        if (m.action === "hide") this.setVisible(false);
        else if (m.action === "settings") this.openSettings();
        else this.quick.open({ startupId: m.startupId });
        break;
    }
  }

  /**
   * Quick Chat on the section's agent. When the app has no agent of its own, Space Assistant takes
   * the work and the message starts by saying where it goes. With no section (the hub), Space
   * Assistant takes a dropped picture.
   */
  private open(section: Section | undefined, picture: { name: string; bytes: Uint8Array } | undefined, startupId: string | undefined): void {
    const space = this.model.current;
    const target = section ? this.agents[section] : undefined;
    const agent = target?.agent ?? (space ? this.model.assistant(space) : undefined);
    this.quick.open({
      ...(agent ? { agent } : {}),
      ...(target?.borrowed ? { lead: t("ballSaveTo", { name: target.title }) } : {}),
      ...(picture ? { picture } : {}),
      ...(startupId ? { startupId } : {}),
    });
  }

  private async drop(file: string, temporary: boolean, section: Section | undefined, startupId: string | undefined): Promise<void> {
    // The ball only names files; this side reads them, and removes only its own.
    const own = temporary && isOwnDrop(file, DROPS);
    if (temporary && !own) return;
    const f = Gio.File.new_for_path(file);
    try {
      const info = f.query_info("standard::size", Gio.FileQueryInfoFlags.NONE, null);
      if (info.get_size() > MAX_PICTURE_BYTES) throw new Error("too large");
      const [bytes] = (await f.load_contents_async(null)) as [Uint8Array];
      this.open(section, { name: own ? "Image" : (f.get_basename() ?? "Image"), bytes }, startupId);
    } catch (e) {
      logError(e, "floating ball: could not read the dropped picture");
      this.notify(t("ballUnreadable"));
    } finally {
      if (own) GLib.unlink(file);
    }
  }

  private notify(body: string): void {
    const n = new Gio.Notification();
    n.set_title(t("floatingBall"));
    n.set_body(body);
    this.app.send_notification("floating-ball", n);
  }
}
