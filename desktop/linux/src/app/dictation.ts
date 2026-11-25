import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { NOTE_SECONDS, type ToHud, tail, voiceSpace } from "../core/voice.ts";
import { APP_ROOT, log, logError, path, prefs, t, tw } from "./env.ts";
import type { AppModel, Space } from "./model.ts";
import { QuickChat } from "./quick-chat.ts";
import { unixStreams } from "./unix-streams.ts";
import { VoiceRun, loadGst, spaceTranscribes } from "./voice.ts";

/**
 * Voice input into any app (docs/linux-desktop.md#voice-input): `ai-space --dictate`, which the
 * person binds to a key as they bind `--quick-chat` (GNOME and KDE let no app register a global
 * shortcut, and a Wayland client never sees another app's keys). The first run starts recording,
 * the next one stops it. The words show live in a capsule at the bottom of the screen (`hud.js`,
 * an X11 window through XWayland that never takes the keyboard). Then the text goes:
 *
 * - into the field of this app that has the keyboard, when one does (the main window, Quick Chat);
 * - else onto the clipboard, and the capsule says to press Ctrl+V.
 *
 * It is never typed into another app: Wayland lets no client type into another, and the one
 * sanctioned way (the RemoteDesktop portal) asks the person in a dialog that takes the keyboard
 * from the very field the text is for (the doc says more). The clipboard is set through
 * XWayland's display, which, unlike a Wayland client without the keyboard, may own the selection.
 *
 * One Space only: the one named under Settings › General › Transcribe with, else the selected one;
 * when it cannot transcribe the capsule says so and nothing is sent anywhere.
 */
export class Dictation {
  private run: VoiceRun | undefined;
  /** Between the press and the recording: the Space is being asked whether it transcribes. */
  private checking = false;
  private held = false;
  private hud: Hud | undefined;
  private noteTimer = 0;

  constructor(
    private readonly app: any,
    private readonly model: AppModel,
  ) {}

  /** The display that can own the clipboard while another app has the keyboard: X11's, or XWayland's. */
  static display(): any {
    const display = Gdk.Display.get_default();
    if (display?.constructor?.$gtype?.name === "GdkX11Display") return display;
    return QuickChat.x11Display();
  }

  /** Whether `--dictate` can run on this desktop: GStreamer is there, and X11 or XWayland. */
  static available(): boolean {
    return loadGst() !== null && Boolean(Dictation.display());
  }

  /** Starts, or stops what is recording; a run while the text is on its way does nothing. */
  toggle(): void {
    if (this.checking) {
      // Pressed again before the Space answered: too short to have said anything.
      this.checking = false;
      this.done();
      return;
    }
    if (this.run && !this.run.done) {
      this.run.stop();
      return;
    }
    void this.begin();
  }

  private async begin(): Promise<void> {
    if (!loadGst()) return this.notify(t("voiceNoGst"));
    if (!Dictation.display()) return this.notify(t("voiceNeedsX11"));
    const ids = this.model.list.connections.map((c) => c.id);
    const id = voiceSpace(ids, prefs.voiceSpace, this.model.current?.conn.id ?? this.model.list.default?.id);
    const space = id ? this.model.space(id) : undefined;
    this.hold();
    if (!space) return this.note(t("voiceNoSpace"));
    this.checking = true;
    this.show({ type: "show", kind: "listening", text: t("voiceListening") });
    const can = await spaceTranscribes(space);
    if (!this.checking) return;
    this.checking = false;
    const name = space.conn.name;
    if (can === undefined) return this.note(t("voiceUnreachable", { name }));
    if (!can) return this.note(ids.length > 1 ? t("voiceCannotChoose", { name }) : t("voiceCannot", { name }));
    this.record(space);
  }

  private record(space: Space): void {
    const run = new VoiceRun(space, {
      changed: (r) => {
        if (r !== this.run) return;
        if (r.done) {
          // Ended: the text or a note follows at once; with neither (nothing was heard) the capsule goes.
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (r === this.run && !this.noteTimer) this.done();
            return GLib.SOURCE_REMOVE;
          });
          return;
        }
        if (r.state === "finishing") this.show({ type: "show", kind: "working", text: r.text ? tail(r.text, 90) : tw("omni.transcribing") });
        else this.show({ type: "show", kind: "listening", text: r.text ? tail(r.text, 90) : t("voiceListening") });
      },
      deliver: (text) => {
        if (run === this.run) this.deliver(text);
      },
      failed: (message) => {
        if (run === this.run) this.note(message);
      },
    });
    this.run = run;
    run.start();
  }

  /** Into this app's focused field, else onto the clipboard with a note. */
  private deliver(text: string): void {
    if (this.typeIntoOwnField(text)) return this.done();
    const display = Dictation.display();
    try {
      display.get_clipboard().set(text);
    } catch (e) {
      logError(e, "voice: the clipboard");
    }
    this.note(t("voiceCopied"));
  }

  /** The text at the cursor of the field that has the keyboard in one of this app's windows, when one does. */
  private typeIntoOwnField(text: string): boolean {
    for (const w of this.app.get_windows() as any[]) {
      if (!w.is_active) continue;
      const focus = w.get_focus();
      if (!focus) return false;
      if (focus instanceof Gtk.TextView) {
        if (!focus.get_editable()) return false;
        focus.get_buffer().insert_interactive_at_cursor(text, -1, true);
        return true;
      }
      // Gtk.Text: what a Gtk.Entry or a Gtk.SearchEntry hands the keyboard to.
      if (focus instanceof Gtk.Text) {
        if (!focus.get_editable()) return false;
        focus.delete_selection();
        const end = focus.insert_text(text, -1, focus.get_position());
        if (typeof end === "number") focus.set_position(end);
        return true;
      }
      return false;
    }
    return false;
  }

  private show(m: ToHud): void {
    this.hud ??= new Hud();
    this.hud.write(m.type === "show" ? { ...m, dark: Adw.StyleManager.get_default().get_dark() } : m);
  }

  /** A note in the capsule for a few seconds, then the end. */
  private note(text: string): void {
    this.show({ type: "show", kind: "note", text });
    if (this.noteTimer) GLib.source_remove(this.noteTimer);
    this.noteTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, NOTE_SECONDS, () => {
      this.noteTimer = 0;
      this.done();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** The capsule goes, and the app may quit again if nothing else keeps it. */
  private done(): void {
    if (this.noteTimer) GLib.source_remove(this.noteTimer);
    this.noteTimer = 0;
    this.hud?.stop();
    this.hud = undefined;
    if (this.held) {
      this.held = false;
      this.app.release();
    }
  }

  /** Started by `--dictate` alone, the app has no window: it stays while a recording runs. */
  private hold(): void {
    if (this.held) return;
    this.held = true;
    this.app.hold();
  }

  /** Without a capsule (no X11 display, no GStreamer): a desktop notification. */
  private notify(body: string): void {
    const n = new Gio.Notification();
    n.set_title(t("voiceInput"));
    n.set_body(body);
    this.app.send_notification("voice-input", n);
  }

  stop(): void {
    this.run?.dispose();
    this.done();
  }
}

/** The capsule's process (src/hud/hud.ts), started for one recording and ended after it. */
class Hud {
  private stdin: any;

  constructor() {
    let gjs = "gjs";
    try {
      gjs = GLib.file_read_link("/proc/self/exe");
    } catch {
      // Not Linux's /proc: the gjs on PATH.
    }
    const env = GLib.environ_setenv(GLib.get_environ(), "GDK_BACKEND", "x11", true);
    try {
      const [, pid, stdinFd] = GLib.spawn_async_with_pipes(null, [gjs, "-m", path(APP_ROOT, "hud.js")], env, GLib.SpawnFlags.DO_NOT_REAP_CHILD, null) as [boolean, number, number];
      const { OutputStream } = unixStreams();
      this.stdin = new OutputStream({ fd: stdinFd, close_fd: true });
      GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, () => GLib.spawn_close_pid(pid));
    } catch (e) {
      logError(e, "could not start the voice input capsule");
    }
  }

  write(m: ToHud): void {
    if (!this.stdin) return;
    try {
      this.stdin.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
      this.stdin.flush(null);
    } catch (e) {
      log("voice capsule: could not write", String(e));
    }
  }

  /** Closing its stdin ends it. */
  stop(): void {
    this.write({ type: "quit" });
    try {
      this.stdin?.close(null);
    } catch {
      // Already closed.
    }
    this.stdin = undefined;
  }
}
