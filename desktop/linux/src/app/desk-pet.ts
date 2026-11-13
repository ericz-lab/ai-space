import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { CLAUDE, type FromPet, type PetOpen, type ToPet, decodeFromPet, sayText, shownMood } from "../core/pet.ts";
import { APP_ROOT, lang, log, logError, path, prefs, savePrefs, t } from "./env.ts";
import type { AppModel } from "./model.ts";
import { animationsOn, petOnDesktop, petWidth } from "./pet.ts";
import { unixStreams } from "./unix-streams.ts";

/**
 * The desk pet on the desktop (docs/linux-desktop.md#desk-pet), the app's side. The pet is a
 * process of its own (`pet.js`, GTK 3 on X11, through XWayland on a Wayland desktop), as the
 * floating ball is (floating-ball.ts): this side starts it while the pet belongs on the desktop,
 * tells it the current Space's mood, and does what it asks: open the chat or the inbox, remember
 * where it was left, put it back in the window or hide it.
 */
export class DeskPet {
  private proc: { pid: number; exited: boolean } | undefined;
  private stdin: any;
  private restarts: number[] = [];
  private wanted = false;

  constructor(
    private readonly model: AppModel,
    private readonly open: (open: PetOpen, startupId?: string) => void,
    /** The preferences changed here (put back in the window, hidden): both pets follow them. */
    private readonly changed: () => void,
  ) {
    model.on((change, space) => {
      if ((change === "mood" && space === model.current) || change === "selection") this.pushMood();
    });
    Adw.StyleManager.get_default().connect("notify::dark", () => this.write({ type: "look", dark: Adw.StyleManager.get_default().get_dark() }));
    Gtk.Settings.get_default()?.connect("notify::gtk-enable-animations", () => this.sync());
  }

  /** Follows the preferences: running while the pet belongs on the desktop and the desktop wants animations. */
  sync(): void {
    this.wanted = petOnDesktop() && animationsOn();
    if (this.wanted && !this.proc) this.spawn();
    else if (this.wanted) this.write({ type: "size", size: petWidth() });
    if (!this.wanted && this.proc) this.stop();
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
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
      if (!proc.exited) GLib.spawn_command_line_async(`kill ${proc.pid}`);
      return GLib.SOURCE_REMOVE;
    });
  }

  private spawn(): void {
    let gjs = "gjs";
    try {
      gjs = GLib.file_read_link("/proc/self/exe");
    } catch {
      // Not Linux's /proc: the gjs on PATH.
    }
    const env = GLib.environ_setenv(GLib.get_environ(), "GDK_BACKEND", "x11", true);
    let pid: number, stdinFd: number, stdoutFd: number, stderrFd: number;
    try {
      [, pid, stdinFd, stdoutFd, stderrFd] = GLib.spawn_async_with_pipes(null, [gjs, "-m", path(APP_ROOT, "pet.js")], env, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null) as [boolean, number, number, number, number];
    } catch (e) {
      logError(e, "could not start the desk pet");
      return;
    }
    const { InputStream, OutputStream } = unixStreams();
    const proc = { pid, exited: false };
    this.proc = proc;
    this.stdin = new OutputStream({ fd: stdinFd, close_fd: true });
    const lines = (fd: number, priority: number, each: (line: string) => void) => {
      const stream = new Gio.DataInputStream({ base_stream: new InputStream({ fd, close_fd: true }) });
      const next = () =>
        stream.read_line_async(priority, null, (_s: unknown, res: unknown) => {
          let line: string | null = null;
          try {
            [line] = stream.read_line_finish_utf8(res);
          } catch {
            line = null;
          }
          if (line === null) return;
          each(line);
          next();
        });
      next();
    };
    lines(stdoutFd, GLib.PRIORITY_DEFAULT, (line) => {
      const m = decodeFromPet(line);
      if (m) this.handle(m);
    });
    // The pet's own messages go to the app's: a full pipe would stop it.
    lines(stderrFd, GLib.PRIORITY_LOW, (line) => printerr(line));
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => {
      GLib.spawn_close_pid(pid);
      proc.exited = true;
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.stdin = undefined;
      // A pet that ended by itself comes back, unless it keeps ending.
      const at = Date.now();
      this.restarts = [...this.restarts.filter((r) => at - r < 60_000), at];
      if (this.wanted && this.restarts.length <= 3) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => (this.sync(), GLib.SOURCE_REMOVE));
      else if (this.wanted) logError(new Error("it ended three times in a minute"), "desk pet");
    });
    this.write({
      type: "init",
      sheet: path(APP_ROOT, CLAUDE.file),
      size: petWidth(),
      ...(prefs.deskPetSpot !== undefined ? { spot: prefs.deskPetSpot } : {}),
      dark: Adw.StyleManager.get_default().get_dark(),
      labels: { toWindow: t("petToWindow"), hide: t("petHide"), name: t("deskPet") },
    });
    this.pushMood();
  }

  private write(m: ToPet): void {
    if (!this.stdin) return;
    try {
      this.stdin.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
      this.stdin.flush(null);
    } catch (e) {
      log("desk pet: could not write", String(e));
    }
  }

  private pushMood(): void {
    const mood = shownMood(this.model.current?.mood);
    const line = sayText(mood?.say, lang);
    this.write({ type: "mood", ...(mood ? { mood } : {}), ...(line ? { line } : {}) });
  }

  private handle(m: FromPet): void {
    switch (m.type) {
      case "ready":
        break;
      case "moved":
        prefs.deskPetSpot = m.spot;
        savePrefs();
        break;
      case "open":
        this.open(m.open, m.startupId);
        break;
      case "menu":
        if (m.action === "hide") prefs.noPet = true;
        else prefs.petPlace = "window";
        savePrefs();
        this.changed();
        break;
    }
  }
}
