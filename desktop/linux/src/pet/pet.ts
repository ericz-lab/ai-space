import Cairo from "cairo";
import Gdk from "gi://Gdk?version=3.0";
import GdkPixbuf from "gi://GdkPixbuf";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=3.0";
import Pango from "gi://Pango";
import PangoCairo from "gi://PangoCairo";
import system from "system";
import { unixStreams } from "../app/unix-streams.ts";
import type { Rect } from "../core/floating-ball.ts";
import {
  CLAUDE, type FromPet, type PetMood, PetMotion, type ToPet, bubbleUntilChange, bubbleVisible, deskSprite, deskWindow, opensRight, spotFraction, spotX,
} from "../core/pet.ts";

/**
 * The desk pet on the desktop, in its own process (`gjs -m pet.js`, started by the app with
 * GDK_BACKEND=x11), built as the floating ball is (src/ball/ball.ts says why): an override-redirect
 * GTK 3 window on X11, through XWayland on a Wayland desktop, above every window and on every
 * workspace, never taking the keyboard. It walks along the bottom of the primary monitor's work
 * area (above the dock), and the window moves with it; clicks land only on the sprite (the input
 * shape), so the desktop under the rest stays usable. It knows no Space: the app sends the mood
 * (`ToPet`, one JSON line on stdin) and hears back what the person did (`FromPet`, on stdout). The
 * motion, the bubble and the window's frame are core/pet.ts, the Mac's.
 */

const { InputStream, OutputStream } = unixStreams();

Gtk.init(null);

const out = new OutputStream({ fd: 1, close_fd: false });
function send(m: FromPet): void {
  try {
    out.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
    out.flush(null);
  } catch {
    // The app is gone; its end of stdin closes too and the pet quits there.
  }
}

// What the app said last.
let sheet: any;
let size = CLAUDE.width;
let dark = false;
let labels = { toWindow: "Put the Pet in the Window", hide: "Hide the Desk Pet", name: "Desk pet" };
let mood: PetMood | undefined;
let line: string | undefined;

let motion: PetMotion | undefined;
let area: Rect = { x: 0, y: 0, width: 0, height: 0 };
let frame: Rect = { x: 0, y: 0, width: 0, height: 0 };
let sprite: Rect = { x: 0, y: 0, width: 0, height: 0 };
let hovering = false;
let bubbleOn = false;
let bubbleSince: number | undefined;
let timer = 0;
let bubbleTimer = 0;

const now = () => GLib.get_monotonic_time() / 1e6;
function stop(id: number): number {
  if (id) GLib.source_remove(id);
  return 0;
}

const win = new Gtk.Window({ type: Gtk.WindowType.POPUP, title: "AI Space Desk Pet" });
win.set_wmclass("ai-space-pet", "AI Space");
win.set_decorated(false);
win.set_resizable(false);
win.set_type_hint(Gdk.WindowTypeHint.UTILITY);
win.set_app_paintable(true);
const visual = win.get_screen().get_rgba_visual();
if (visual) win.set_visual(visual);
win.add_events(Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK);
win.connect("delete-event", () => true);

// Geometry

/** The primary monitor's work area (without the top bar and the dock). */
function workArea(): Rect {
  const display = Gdk.Display.get_default();
  const monitor = display.get_primary_monitor() ?? display.get_monitor(0);
  const r = monitor.get_workarea();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

const pet = () => ({ width: size, height: Math.round(size * cellAspect()) });

function cellAspect(): number {
  if (!sheet) return 1;
  return sheet.get_height() / CLAUDE.rows / (sheet.get_width() / CLAUDE.columns);
}

/** The stage is the work area's width; a new screen or size keeps the pet on it. */
function layout(): void {
  area = workArea();
  const t = now();
  if (motion) motion.resize(area.width, t, size);
  else {
    motion = new PetMotion(CLAUDE, size, area.width, t);
    motion.setMood(mood, t);
  }
  place();
  schedule();
}

/** The window around the pet and its bubble, moved only when it must; the input shape is the sprite. */
function place(): void {
  if (!motion) return;
  const p = pet();
  const f = deskWindow(motion.x, p, area);
  const s = deskSprite(motion.x, p, f, area);
  if (f.width !== frame.width || f.height !== frame.height) {
    win.set_size_request(f.width, f.height);
    win.resize(f.width, f.height);
  }
  if (f.x !== frame.x || f.y !== frame.y) win.move(f.x, f.y);
  const shapeChanged = s.x !== sprite.x || s.y !== sprite.y || s.width !== sprite.width || s.height !== sprite.height || f.width !== frame.width;
  frame = f;
  sprite = s;
  if (shapeChanged) shape();
  win.queue_draw();
}

function shape(): void {
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, Math.max(1, frame.width), Math.max(1, frame.height));
  const cr = new Cairo.Context(surface);
  cr.rectangle(sprite.x, sprite.y, sprite.width, sprite.height);
  cr.fill();
  cr.$dispose();
  win.input_shape_combine_region(Gdk.cairo_region_create_from_surface(surface));
}

/** Runs only when a cell or the place changes: at most 20 times a second while it walks, a few while it rests. */
function schedule(): void {
  timer = stop(timer);
  if (!motion) return;
  const delay = motion.advance(now());
  place();
  timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(Math.max(0.05, delay) * 1000), () => {
    timer = 0;
    schedule();
    return GLib.SOURCE_REMOVE;
  });
}

function restartBubble(): void {
  bubbleTimer = stop(bubbleTimer);
  if (!line) {
    bubbleSince = undefined;
    bubbleOn = false;
    win.queue_draw();
    return;
  }
  bubbleSince ??= now();
  flipBubble();
}

function flipBubble(): void {
  if (bubbleSince === undefined) return;
  const elapsed = now() - bubbleSince;
  bubbleOn = bubbleVisible(elapsed);
  win.queue_draw();
  bubbleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round((bubbleUntilChange(elapsed) + 0.05) * 1000), () => {
    bubbleTimer = 0;
    flipBubble();
    return GLib.SOURCE_REMOVE;
  });
}

// Pointer

let pressed: { rx: number; x: number } | undefined;
let dragging = false;

win.connect("enter-notify-event", () => {
  hovering = true;
  // Resting under the pointer: a window moved under a resting pointer loses its events on XWayland (ball.ts).
  if (motion && !pressed) {
    motion.hold(motion.x, now());
    schedule();
  }
  return false;
});

win.connect("leave-notify-event", (_w: unknown, event: any) => {
  if (event.get_crossing_detail?.() === Gdk.NotifyType.INFERIOR) return false;
  hovering = false;
  if (motion && !pressed) {
    motion.drop(motion.x, now());
    schedule();
  }
  return false;
});

win.connect("button-press-event", (_w: unknown, event: any) => {
  const [, button] = event.get_button();
  if (event.get_event_type() !== Gdk.EventType.BUTTON_PRESS) return true;
  if (button === 3) {
    menu(event);
    return true;
  }
  if (button !== 1 || !motion) return false;
  const [, rx] = event.get_root_coords();
  pressed = { rx, x: motion.x };
  dragging = false;
  return true;
});

win.connect("motion-notify-event", (_w: unknown, event: any) => {
  if (!pressed || !motion) return false;
  const [, rx] = event.get_root_coords();
  if (!dragging && Math.abs(rx - pressed.rx) > 3) dragging = true;
  if (dragging) {
    motion.hold(pressed.x + rx - pressed.rx, now());
    place();
  }
  return true;
});

win.connect("button-release-event", (_w: unknown, event: any) => {
  if (!pressed || !motion) return true;
  pressed = undefined;
  if (dragging) {
    dragging = false;
    send({ type: "moved", spot: spotFraction(motion.x, area.width, size) });
    // Still under the pointer: it stays held until the pointer leaves.
    if (!hovering) motion.drop(motion.x, now());
    schedule();
    return true;
  }
  const open = mood?.open;
  if (open) {
    const id = startupId(event.get_time());
    send({ type: "open", open, ...(id ? { startupId: id } : {}) });
  } else {
    motion.click(now());
    schedule();
  }
  return true;
});

/** An X11 startup id stamped with the event's time, so the app's window may come to the front for this click. */
function startupId(time: number): string | undefined {
  try {
    const ctx = Gdk.Display.get_default().get_app_launch_context();
    ctx.set_timestamp(time);
    const info = Gio.AppInfo.create_from_commandline("ai-space", "AI Space", Gio.AppInfoCreateFlags.SUPPORTS_STARTUP_NOTIFICATION);
    return ctx.get_startup_notify_id(info, []) ?? undefined;
  } catch {
    return undefined;
  }
}

function menu(event: any): void {
  const m = new Gtk.Menu();
  const item = (label: string, action: "window" | "hide") => {
    const i = new Gtk.MenuItem({ label });
    i.connect("activate", () => send({ type: "menu", action }));
    m.append(i);
  };
  item(labels.toWindow, "window");
  item(labels.hide, "hide");
  m.show_all();
  m.popup_at_pointer(event);
}

// Drawing

function roundedRect(cr: any, x: number, y: number, w: number, h: number, r: number): void {
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
}

const cells = new Map<string, any>();
function cell(column: number, row: number): any | undefined {
  if (!sheet) return undefined;
  const key = `${column},${row}`;
  let c = cells.get(key);
  if (!c) {
    const w = Math.floor(sheet.get_width() / CLAUDE.columns), h = Math.floor(sheet.get_height() / CLAUDE.rows);
    c = sheet.new_subpixbuf(column * w, row * h, w, h);
    cells.set(key, c);
  }
  return c;
}

/** The pet at `s` (in the surface's pixels) and, when it shows, its line above it, opening towards the middle of the screen. */
function draw(cr: any, m: PetMotion, s: Rect, stage: number, withBubble: boolean): void {
  if (withBubble && line) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string("Sans 9"));
    layout.set_text(line, -1);
    const [, logical] = layout.get_pixel_extents();
    const bw = logical.width + 18, bh = logical.height + 8;
    const bx = opensRight(m.x, m.width, stage) ? s.x : s.x + s.width - bw;
    const by = s.y - 6 - bh;
    roundedRect(cr, bx + 0.5, by + 0.5, bw - 1, bh - 1, 10);
    dark ? cr.setSourceRGBA(40 / 255, 40 / 255, 44 / 255, 0.95) : cr.setSourceRGBA(1, 1, 1, 0.96);
    cr.fillPreserve();
    dark ? cr.setSourceRGBA(1, 1, 1, 0.14) : cr.setSourceRGBA(0, 0, 0, 0.1);
    cr.setLineWidth(1);
    cr.stroke();
    dark ? cr.setSourceRGBA(1, 1, 1, 0.92) : cr.setSourceRGBA(0.1, 0.1, 0.12, 0.92);
    cr.moveTo(bx + 9, by + 4);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
  }
  const c = cell(m.cell.column, m.cell.row);
  if (!c) return;
  cr.save();
  cr.translate(s.x, s.y);
  if (m.facingLeft) {
    cr.translate(s.width, 0);
    cr.scale(-1, 1);
  }
  cr.scale(s.width / c.get_width(), s.height / c.get_height());
  Gdk.cairo_set_source_pixbuf(cr, c, 0, 0);
  cr.paint();
  cr.restore();
}

win.connect("draw", (_w: unknown, cr: any) => {
  cr.setOperator(Cairo.Operator.SOURCE);
  cr.setSourceRGBA(0, 0, 0, 0);
  cr.paint();
  cr.setOperator(Cairo.Operator.OVER);
  if (motion) draw(cr, motion, sprite, area.width, bubbleOn || hovering);
  cr.$dispose();
  return true;
});

/**
 * Debug (`AISPACE_PET_SHOT=<file.png>`): once the app has sent the sheet and a mood, three poses
 * side by side (resting with the bubble, walking left, the click's spin) drawn into a PNG, and the
 * process quits without showing a window.
 */
const SHOT = GLib.getenv("AISPACE_PET_SHOT");
function snapshot(file: string): void {
  const p = pet();
  const cellW = p.width + 240, h = p.height + 72;
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, cellW * 3, h);
  const cr = new Cairo.Context(surface);
  dark ? cr.setSourceRGBA(0.12, 0.12, 0.14, 1) : cr.setSourceRGBA(0.93, 0.94, 0.96, 1);
  cr.paint();
  // Each pose's random source: 0.9 rests, 0.1 walks (from the right end, so to the left).
  const poses: [number, (m: PetMotion) => void][] = [
    [0.9, () => {}],
    [0.1, (m) => m.drop(cellW * 3, 0)],
    [0.9, (m) => m.click(0)],
  ];
  poses.forEach(([r, pose], i) => {
    const m = new PetMotion(CLAUDE, size, cellW * 3, 0, () => r);
    m.setMood(mood, 0);
    pose(m);
    m.advance(0.2);
    const s = { x: i * cellW + 20, y: h - p.height, width: p.width, height: p.height };
    // An endless stage: the bubble opens to the right, inside the picture.
    draw(cr, m, s, Number.POSITIVE_INFINITY, i === 0);
  });
  cr.$dispose();
  surface.writeToPNG(file);
  printerr(`[ai-space-pet] snapshot ${file}`);
}

// The app's messages

function handle(raw: string): void {
  let m: ToPet;
  try {
    m = JSON.parse(raw) as ToPet;
  } catch {
    return;
  }
  switch (m.type) {
    case "init":
      try {
        sheet = GdkPixbuf.Pixbuf.new_from_file(m.sheet);
      } catch (e) {
        printerr(`[ai-space-pet] could not read the sheet: ${e}`);
      }
      size = m.size;
      dark = m.dark;
      labels = m.labels;
      win.set_title(labels.name);
      if (SHOT) break;
      layout();
      if (m.spot !== undefined && motion) motion.drop(spotX(m.spot, area.width, size), now());
      place();
      win.show_all();
      schedule();
      break;
    case "mood":
      mood = m.mood;
      if (m.line !== line) {
        line = m.line;
        bubbleSince = undefined;
        restartBubble();
      }
      if (SHOT) {
        snapshot(SHOT);
        Gtk.main_quit();
        break;
      }
      if (motion) {
        motion.setMood(mood, now());
        schedule();
      }
      break;
    case "size":
      size = m.size;
      layout();
      break;
    case "look":
      dark = m.dark;
      win.queue_draw();
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
    // The app closed its end: it quit or crashed, and the pet goes with it.
    if (text === null) return Gtk.main_quit();
    handle(text);
    readNext();
  });
}
readNext();

// Monitors added or removed, or the dock moved: back on what is left.
Gdk.Screen.get_default().connect("monitors-changed", () => layout());
Gdk.Screen.get_default().connect("size-changed", () => layout());

send({ type: "ready" });
Gtk.main();
system.exit(0);
