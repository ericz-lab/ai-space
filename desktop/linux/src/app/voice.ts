import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Soup from "gi://Soup?version=3.0";
import { SpaceError } from "../core/check.ts";
import { LiveSession, type VoiceFailure, type VoiceState, appendTranscript, canTranscribe, startMessage, uploadFields, voiceCode } from "../core/voice.ts";
import { lang, log, logError, prefs, t, tw } from "./env.ts";
import type { Space } from "./model.ts";

/**
 * Voice input, the app's side (docs/linux-desktop.md#voice-input): the microphone through
 * GStreamer, the live route through libsoup, and the button beside a field. The rules are
 * core/voice.ts (`LiveSession`), which this file only feeds and obeys.
 *
 * GStreamer's bindings (the `Gst-1.0` typelib) are optional: without them the microphone buttons
 * stay hidden and Settings says what to install. They are looked up through `imports.gi`, which
 * throws at once for a missing library, as `unix-streams.ts` explains.
 */

let gst: any | null | undefined;

/** GStreamer, initialised once; null when its bindings are not installed. */
export function loadGst(): any | null {
  if (gst !== undefined) return gst;
  try {
    const gi = (globalThis as any).imports.gi;
    gi.versions.Gst = "1.0";
    gst = gi.Gst;
    gst.init(null);
  } catch (e) {
    log("voice: no GStreamer bindings", String(e));
    gst = null;
  }
  return gst;
}

/**
 * Whether a microphone is there: a source the desktop's sound server lists that is not the
 * monitor of an output. Undefined when the device monitor itself cannot tell (no provider), so a
 * recording is tried anyway.
 */
function microphonePresent(Gst: any): boolean | undefined {
  try {
    const monitor = new Gst.DeviceMonitor();
    monitor.add_filter("Audio/Source", null);
    if (!monitor.start()) return undefined;
    const devices: any[] = monitor.get_devices() ?? [];
    monitor.stop();
    const providers: string[] = monitor.get_providers?.() ?? [];
    if (!devices.length && !providers.length) return undefined;
    return devices.some((d) => d.get_properties()?.get_string("device.class") !== "monitor");
  } catch {
    return undefined;
  }
}

/**
 * The default microphone as 16 kHz mono PCM16, pulled from the sink on the main loop every 50 ms
 * (GJS may not run a callback on GStreamer's streaming thread).
 */
class Microphone {
  private pipeline: any;
  private timer = 0;

  /** Throws with the reason when it cannot record. */
  constructor(onAudio: (pcm: Uint8Array) => void, onError: (detail: string) => void) {
    const Gst = loadGst();
    if (!Gst) throw new Error(t("voiceNoGst"));
    // AISPACE_VOICE_SOURCE: a GStreamer source in place of the microphone, for a check without one
    // (docs/linux-desktop.md#debugging), such as `audiotestsrc is-live=true` or `filesrc location=… ! decodebin`.
    const source = GLib.getenv("AISPACE_VOICE_SOURCE");
    if (!source && microphonePresent(Gst) === false) throw new MicrophoneMissing();
    this.pipeline = Gst.parse_launch(
      `${source || "autoaudiosrc"} ! queue ! audioconvert ! audioresample ! audio/x-raw,format=S16LE,rate=16000,channels=1,layout=interleaved ! appsink name=sink sync=false max-buffers=0 drop=false`,
    );
    const sink = this.pipeline.get_by_name("sink");
    const bus = this.pipeline.get_bus();
    bus.add_signal_watch();
    bus.connect("message::error", (_b: unknown, m: any) => {
      const [error] = m.parse_error();
      onError(error?.message ?? "error");
    });
    if (this.pipeline.set_state(Gst.State.PLAYING) === Gst.StateChangeReturn.FAILURE) {
      this.stop();
      throw new Error("the audio source did not start");
    }
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
      for (;;) {
        const sample = sink.emit("try-pull-sample", 0);
        if (!sample) break;
        const buffer = sample.get_buffer();
        const bytes = buffer?.extract_dup(0, buffer.get_size());
        if (bytes?.length) onAudio(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      }
      return GLib.SOURCE_CONTINUE;
    });
  }

  stop(): void {
    if (this.timer) GLib.source_remove(this.timer);
    this.timer = 0;
    const p = this.pipeline;
    this.pipeline = undefined;
    if (!p) return;
    try {
      p.get_bus().remove_signal_watch();
      p.set_state(loadGst().State.NULL);
    } catch (e) {
      logError(e, "voice: stopping the microphone");
    }
  }
}

class MicrophoneMissing extends Error {
  constructor() {
    super(t("voiceNoMic"));
  }
}

// Whether a Space transcribes

/** What each Space answered to `GET /api/voice`, by origin, for the life of the app. Only an answer is kept. */
const known = new Map<string, boolean>();
const asked = new Map<string, number>();

/** Whether the Space can transcribe: true or false once it answered, undefined while it cannot be asked. */
export async function spaceTranscribes(space: Space): Promise<boolean | undefined> {
  const base = space.client.base;
  if (known.has(base)) return known.get(base);
  try {
    const can = canTranscribe(await space.client.get("/api/voice"));
    known.set(base, can);
    return can;
  } catch (e) {
    log("voice: /api/voice", String(e));
    return undefined;
  }
}

/** The answer already known, and a look when there is none (at most every 30 s per Space while it fails). */
function knownOrAsk(space: Space, then: () => void): boolean | undefined {
  const base = space.client.base;
  if (known.has(base)) return known.get(base);
  const last = asked.get(base) ?? 0;
  if (Date.now() - last > 30_000) {
    asked.set(base, Date.now());
    void spaceTranscribes(space).then(then);
  }
  return undefined;
}

/** The words for a recording that ended without text. */
export function failureText(why: VoiceFailure): string {
  return why.kind === "timedOut" ? t("voiceTimedOut") : tw("omni.voiceFailed", { error: why.detail });
}

/** The language this recording is transcribed in, read when it starts (Settings › General › Voice language). */
export function recordingLanguage(): string {
  return voiceCode(prefs.voiceLanguage, lang);
}

export type VoiceRunEvents = {
  changed(run: VoiceRun): void;
  deliver(text: string): void;
  failed(message: string): void;
};

/**
 * One recording sent to one Space: the microphone opens at once, the live route
 * (`WS /api/voice/realtime`) is opened beside it, and `LiveSession` decides what goes where; a
 * clip goes to `POST /api/voice/transcribe` when the live route will not answer.
 */
export class VoiceRun {
  private readonly session: LiveSession;
  private mic: Microphone | undefined;
  private socket: any;
  private readonly cancel = new Gio.Cancellable();
  private timer = 0;
  private readonly language = recordingLanguage();

  constructor(
    private readonly space: Space,
    private readonly events: VoiceRunEvents,
  ) {
    this.session = new LiveSession({
      sendText: (text) => this.socket?.send_text(text),
      sendFrame: (frame) => {
        // The socket may have closed under a frame in flight; LiveSession hears it from `closed`.
        if (this.socket?.get_state() === Soup.WebsocketState.OPEN) this.socket.send_message(Soup.WebsocketDataType.BINARY, new GLib.Bytes(frame));
      },
      closeSocket: () => this.closeSocket(),
      releaseMic: () => {
        this.mic?.stop();
        this.mic = undefined;
      },
      upload: (clip) => {
        this.space.client.upload("/api/voice/transcribe", "file", "voice.wav", "audio/wav", clip, uploadFields(this.language)).then(
          (body) => this.session.uploaded(body),
          (e) => this.session.uploadFailed(e instanceof SpaceError || e instanceof Error ? e.message : String(e)),
        );
      },
      arm: (seconds) => {
        if (this.timer) GLib.source_remove(this.timer);
        this.timer = 0;
        if (seconds > 0)
          this.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this.timer = 0;
            this.session.timeout();
            return GLib.SOURCE_REMOVE;
          });
      },
      changed: () => this.events.changed(this),
      deliver: (text) => this.events.deliver(text),
      failed: (why) => this.events.failed(failureText(why)),
    });
  }

  get state(): VoiceState {
    return this.session.state;
  }

  get text(): string {
    return this.session.text;
  }

  get done(): boolean {
    return this.session.done;
  }

  /** Opens the microphone and the live route; a microphone that cannot open ends the run with the reason. */
  start(): void {
    try {
      this.mic = new Microphone(
        (pcm) => this.session.audio(pcm),
        (detail) => {
          if (this.session.done) return;
          this.session.abort();
          this.events.failed(t("voiceMicFailed", { error: detail }));
        },
      );
    } catch (e) {
      const message = e instanceof MicrophoneMissing ? e.message : t("voiceMicFailed", { error: e instanceof Error ? e.message : String(e) });
      this.session.abort();
      this.events.failed(message);
      return;
    }
    this.session.micOpen();
    void this.connect();
  }

  stop(): void {
    this.session.stop();
  }

  /** Ends the run with nothing delivered (the field went away, the app quits). */
  dispose(): void {
    this.cancel.cancel();
    this.session.abort();
  }

  private async connect(): Promise<void> {
    let socket: any;
    try {
      socket = await this.space.client.socket("/api/voice/realtime", this.cancel);
    } catch (e) {
      this.session.socketFailed(e instanceof Error ? e.message : String(e));
      return;
    }
    if (this.session.done) {
      socket.close(1000, null);
      return;
    }
    this.socket = socket;
    socket.connect("message", (_c: unknown, type: number, bytes: any) => {
      if (type !== Soup.WebsocketDataType.TEXT) return;
      const data = bytes?.get_data?.();
      if (data) this.session.message(new TextDecoder().decode(data));
    });
    socket.connect("closed", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.session.socketFailed(`closed (${socket.get_close_code?.() ?? 0})`);
    });
    socket.connect("error", (_c: unknown, error: any) => log("voice socket", error?.message ?? String(error)));
    socket.send_text(startMessage(this.language));
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = undefined;
    this.cancel.cancel();
    try {
      if (socket?.get_state() === Soup.WebsocketState.OPEN) socket.close(1000, null);
    } catch {
      // Already closed.
    }
  }
}

/**
 * The microphone beside a field (Home's command box, the chat's message field, Quick Chat's):
 * hidden until the field's Space says it can transcribe; a click records, a second click stops;
 * the words appear in the field as they are heard, after what it already held, and the final text
 * stays there. Nothing is sent by itself. A failure puts the field back and says why beside the button.
 */
export class VoiceButton {
  readonly widget: any;
  private readonly button: any;
  private readonly spinner: any;
  private readonly note: any;
  private readonly noteLabel: any;
  private run: VoiceRun | undefined;
  private prefix = "";
  private noteTimer = 0;
  private space: Space | undefined;

  constructor(
    private readonly field: { read(): string; write(text: string): void; space(): Space | undefined },
    opts: { flat?: boolean } = {},
  ) {
    this.widget = new Gtk.Box({ valign: Gtk.Align.CENTER, visible: false });
    this.button = new Gtk.Button({ icon_name: "audio-input-microphone-symbolic", tooltip_text: tw("omni.voice"), valign: Gtk.Align.CENTER });
    this.button.add_css_class("circular");
    if (opts.flat !== false) this.button.add_css_class("flat");
    this.button.connect("clicked", () => this.toggle());
    this.spinner = new Gtk.Spinner({ visible: false, valign: Gtk.Align.CENTER, tooltip_text: tw("omni.transcribing") });
    this.widget.append(this.button);
    this.widget.append(this.spinner);
    this.noteLabel = new Gtk.Label({ wrap: true, max_width_chars: 40, margin_top: 6, margin_bottom: 6, margin_start: 8, margin_end: 8 });
    this.note = new Gtk.Popover({ child: this.noteLabel, autohide: true });
    this.note.set_parent(this.widget);
    this.widget.connect("destroy", () => {
      this.run?.dispose();
      this.note.unparent();
    });
    this.widget.connect("unrealize", () => {
      // Leaving the screen ends a recording; the text heard so far stays in the field.
      if (this.run && !this.run.done) this.run.dispose();
    });
  }

  /** Shows the button when the field's Space can transcribe (asked once per Space). */
  refresh(): void {
    const space = this.field.space();
    if (space !== this.space && this.run && !this.run.done) this.run.dispose();
    this.space = space;
    const can = loadGst() !== null && space ? knownOrAsk(space, () => this.refresh()) : false;
    this.widget.set_visible(Boolean(can) || Boolean(this.run && !this.run.done));
  }

  /** Whether a recording is on (the field's own Return should not send while it is). */
  get busy(): boolean {
    return Boolean(this.run && !this.run.done);
  }

  toggle(): void {
    if (this.run && !this.run.done) {
      this.run.stop();
      return;
    }
    const space = this.field.space();
    if (!space) return;
    this.hideNote();
    this.prefix = this.field.read();
    const run = new VoiceRun(space, {
      changed: (r) => {
        if (r !== this.run) return;
        if (r.state === "recording" && r.text) this.field.write(appendTranscript(this.prefix, r.text));
        this.render();
      },
      deliver: (text) => {
        if (run === this.run) this.field.write(appendTranscript(this.prefix, text));
      },
      failed: (message) => {
        if (run !== this.run) return;
        this.field.write(this.prefix);
        this.showNote(message);
      },
    });
    this.run = run;
    run.start();
    this.render();
  }

  private render(): void {
    const state = this.run && !this.run.done ? this.run.state : "idle";
    const recording = state === "recording" || state === "starting";
    this.button.set_visible(state !== "finishing");
    this.spinner.set_visible(state === "finishing");
    this.spinner.set_spinning(state === "finishing");
    this.button.set_icon_name(recording ? "media-playback-stop-symbolic" : "audio-input-microphone-symbolic");
    this.button.set_tooltip_text(recording ? tw("omni.stop") : tw("omni.voice"));
    if (recording) this.button.add_css_class("voice-recording");
    else this.button.remove_css_class("voice-recording");
    if (state === "idle") this.refresh();
  }

  private showNote(message: string): void {
    this.noteLabel.set_text(message);
    this.widget.set_visible(true);
    this.note.popup();
    if (this.noteTimer) GLib.source_remove(this.noteTimer);
    this.noteTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 6, () => {
      this.noteTimer = 0;
      this.hideNote();
      return GLib.SOURCE_REMOVE;
    });
  }

  private hideNote(): void {
    this.note.popdown();
  }
}
