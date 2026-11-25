import Cairo from "cairo";
import Gdk from "gi://Gdk?version=3.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=3.0";
import Pango from "gi://Pango";
import PangoCairo from "gi://PangoCairo";
import system from "system";
import { unixStreams } from "../app/unix-streams.ts";
import { type ToHud, decodeToHud } from "../core/voice.ts";

/**
 * The capsule of `ai-space --dictate` (docs/linux-desktop.md#voice-input), in its own process
 * (`gjs -m hud.js`, started by the app with GDK_BACKEND=x11), built as the floating ball and the
 * desk pet are (src/ball/ball.ts says why): an override-redirect GTK 3 window on X11, through
 * XWayland on a Wayland desktop, above every window and on every workspace. It never takes the
 * keyboard, so the app the person is typing in keeps it, and its input shape is empty, so clicks go
 * through it. It sits at the bottom of the primary monitor's work area and shows one line: what is
 * being heard, the last words while the text is on its way, or a note. The app writes `ToHud`
 * lines on its stdin; the process ends when the app closes that.
 */

const { InputStream } = unixStreams();

Gtk.init(null);

const MAX_WIDTH = 640;
const PAD_X = 18;
const PAD_Y = 11;
const DOT = 8;
const FROM_BOTTOM = 56;

let shown: Extract<ToHud, { type: "show" }> | undefined;
let pulse = 0;
let pulseTimer = 0;

const win = new Gtk.Window({ type: Gtk.WindowType.POPUP, title: "AI Space Voice Input" });
win.set_wmclass("ai-space-voice", "AI Space");
win.set_decorated(false);
win.set_resizable(false);
win.set_accept_focus(false);
win.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION);
win.set_app_paintable(true);
const visual = win.get_screen().get_rgba_visual();
if (visual) win.set_visual(visual);

function layoutFor(cr: any, text: string): any {
  const layout = PangoCairo.create_layout(cr);
  layout.set_font_description(Pango.FontDescription.from_string("Sans 11"));
  layout.set_width((MAX_WIDTH - 2 * PAD_X - DOT - 8) * Pango.SCALE);
  layout.set_ellipsize(Pango.EllipsizeMode.START);
  layout.set_single_paragraph_mode(true);
  layout.set_text(text, -1);
  return layout;
}

/** The capsule's size for the text, measured on a scratch surface. */
function measure(text: string): { width: number; height: number } {
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1);
  const cr = new Cairo.Context(surface);
  const [, logical] = layoutFor(cr, text).get_pixel_extents();
  cr.$dispose();
  const dot = shown?.kind === "note" ? 0 : DOT + 8;
  return { width: Math.min(MAX_WIDTH, Math.max(120, logical.width + 2 * PAD_X + dot)), height: Math.max(36, logical.height + 2 * PAD_Y) };
}

function place(): void {
  if (!shown) return;
  const size = measure(shown.text);
  const display = Gdk.Display.get_default();
  const monitor = display.get_primary_monitor() ?? display.get_monitor(0);
  const area = monitor.get_workarea();
  win.set_size_request(size.width, size.height);
  win.resize(size.width, size.height);
  win.move(Math.round(area.x + (area.width - size.width) / 2), Math.round(area.y + area.height - size.height - FROM_BOTTOM));
  // Clicks go through: the input shape is empty.
  win.input_shape_combine_region(Gdk.cairo_region_create_from_surface(new Cairo.ImageSurface(Cairo.Format.ARGB32, 1, 1)));
  win.queue_draw();
}

win.connect("draw", (_w: unknown, cr: any) => {
  const width = win.get_allocated_width();
  const height = win.get_allocated_height();
  cr.setOperator(Cairo.Operator.SOURCE);
  cr.setSourceRGBA(0, 0, 0, 0);
  cr.paint();
  cr.setOperator(Cairo.Operator.OVER);
  if (!shown) return false;
  const dark = shown.dark !== false;
  const r = height / 2;
  cr.newPath();
  cr.arc(r, r, r, Math.PI / 2, (3 * Math.PI) / 2);
  cr.arc(width - r, r, r, (3 * Math.PI) / 2, Math.PI / 2);
  cr.closePath();
  if (dark) cr.setSourceRGBA(0.12, 0.12, 0.13, 0.92);
  else cr.setSourceRGBA(0.98, 0.98, 0.98, 0.95);
  cr.fillPreserve();
  cr.setSourceRGBA(dark ? 1 : 0, dark ? 1 : 0, dark ? 1 : 0, 0.12);
  cr.setLineWidth(1);
  cr.stroke();
  let x = PAD_X;
  if (shown.kind !== "note") {
    // Red and breathing while it listens, grey while the text is on its way.
    const a = shown.kind === "listening" ? 0.55 + 0.45 * Math.abs(Math.sin(pulse)) : 0.6;
    if (shown.kind === "listening") cr.setSourceRGBA(0.89, 0.2, 0.2, a);
    else cr.setSourceRGBA(0.6, 0.6, 0.6, a);
    cr.arc(x + DOT / 2, height / 2, DOT / 2, 0, 2 * Math.PI);
    cr.fill();
    x += DOT + 8;
  }
  const layout = layoutFor(cr, shown.text);
  const [, logical] = layout.get_pixel_extents();
  cr.moveTo(x, (height - logical.height) / 2);
  if (dark) cr.setSourceRGBA(1, 1, 1, 0.95);
  else cr.setSourceRGBA(0.1, 0.1, 0.1, 0.95);
  PangoCairo.show_layout(cr, layout);
  return false;
});

function handle(line: string): void {
  const m = decodeToHud(line);
  if (!m) return;
  switch (m.type) {
    case "show":
      shown = m;
      place();
      win.show_all();
      if (m.kind === "listening" && !pulseTimer) {
        pulseTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => {
          pulse += 0.25;
          if (shown?.kind !== "listening") {
            pulseTimer = 0;
            return GLib.SOURCE_REMOVE;
          }
          win.queue_draw();
          return GLib.SOURCE_CONTINUE;
        });
      }
      break;
    case "hide":
      shown = undefined;
      win.hide();
      break;
    case "quit":
      Gtk.main_quit();
      break;
  }
}

const input = new Gio.DataInputStream({ base_stream: new InputStream({ fd: 0, close_fd: false }) });
function readNext(): void {
  input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: unknown) => {
    let text: string | null = null;
    try {
      [text] = input.read_line_finish_utf8(res);
    } catch {
      text = null;
    }
    // The app closed its end: it quit or crashed, and the capsule goes with it.
    if (text === null) return Gtk.main_quit();
    handle(text);
    readNext();
  });
}
readNext();

Gdk.Screen.get_default().connect("monitors-changed", () => place());

Gtk.main();
system.exit(0);
