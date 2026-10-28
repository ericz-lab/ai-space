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
import {
  ANGLE, DIAL_DIAMETER, DIAL_WINDOW, DIAMETER, type DialSection, type FromBall, HUB_DIAMETER, type Point, type Rect, SECTIONS, type Section,
  type ToBall, dialCenter, isPictureType, offer, origin, sectionAt,
} from "../core/floating-ball.ts";

/**
 * The floating ball's own process (`gjs -m ball.js`, started by the app with GDK_BACKEND=x11).
 *
 * GNOME on Wayland lets no Wayland window stay above the others or place itself, and has no
 * layer-shell. An X11 window may do both, and XWayland runs X11 windows on the same desktop, with
 * drag and drop between the two. So the ball is a GTK 3 window on X11 (GTK 4 can neither place a
 * window nor keep it above): above every window, on every workspace, never taking the keyboard. It knows
 * no Space: the app sends what each section shows (`ToBall`, one JSON line on stdin) and hears
 * back what the person did (`FromBall`, on stdout). The geometry and the drop rules are
 * `core/floating-ball.ts`, the Mac's.
 */

const { InputStream, OutputStream } = unixStreams();

Gtk.init(null);

const out = new OutputStream({ fd: 1, close_fd: false });
function send(m: FromBall): void {
  try {
    out.write_all(new TextEncoder().encode(`${JSON.stringify(m)}\n`), null);
    out.flush(null);
  } catch {
    // The app is gone; its end of stdin closes too and the ball quits there.
  }
}

// What the app said last.
let sections: Partial<Record<Section, DialSection>> = {};
let dark = false;
let labels = { addInSettings: "", sendTo: "{name}", hub: "", menu: { quickChat: "Quick Chat", settings: "Settings", hide: "Hide" } };
let mark: any;
let saved: Point | undefined;

// The look's state.
let expanded = false;
let scale = 1;
let hover = false;
let dragging = false;
let highlighted: Section | undefined;

// An override-redirect window, which the window manager leaves alone: Mutter stacks those above
// every window it manages (full-screen ones too), on every workspace, and never gives them the
// keyboard. A managed window kept above was also marked as wanting attention ("is ready") when
// it appeared over the focused one. So the ball places and moves itself.
const win = new Gtk.Window({ type: Gtk.WindowType.POPUP, title: "AI Space Floating Ball" });
win.set_wmclass("ai-space-ball", "AI Space");
win.set_decorated(false);
win.set_resizable(false);
win.set_type_hint(Gdk.WindowTypeHint.UTILITY);
win.set_app_paintable(true);
const visual = win.get_screen().get_rgba_visual();
if (visual) win.set_visual(visual);
win.add_events(Gdk.EventMask.POINTER_MOTION_MASK | Gdk.EventMask.BUTTON_PRESS_MASK | Gdk.EventMask.BUTTON_RELEASE_MASK | Gdk.EventMask.ENTER_NOTIFY_MASK | Gdk.EventMask.LEAVE_NOTIFY_MASK);
win.connect("delete-event", () => true);
win.set_size_request(DIAL_WINDOW, DIAL_WINDOW);
win.resize(DIAL_WINDOW, DIAL_WINDOW);

// Geometry

/** The work area (without the top bar and the dock) of the monitor at a point. */
function workArea(p: Point): Rect {
  const display = Gdk.Display.get_default();
  const monitor = display.get_monitor_at_point(Math.round(p.x), Math.round(p.y)) ?? display.get_primary_monitor() ?? display.get_monitor(0);
  const r = monitor.get_workarea();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

/** The person is dragging the ball. */
let moving = false;

/**
 * The window is always the dial's size and only moves when the ball does: the ball is drawn at
 * `offset` inside it, and the dial in its middle. Growing or moving the window under a resting
 * pointer made XWayland send the window a leave and then nothing more (no motion, no clicks), and
 * on a monitor's edge the grown window showed on the next monitor for a moment. Opening and closing
 * the dial now changes only where clicks land (the input shape).
 */
const W = DIAL_WINDOW;
/** The ball's top-left inside the window. */
let offset: Point = { x: (W - DIAMETER) / 2, y: (W - DIAMETER) / 2 };
/** The dial's centre inside the window. */
let hub: Point = { x: W / 2, y: W / 2 };

/** The ball with its top-left at `o` (screen); the window around it, all on the ball's monitor, with the dial fitting it. */
function layout(o: Point): void {
  const center = { x: o.x + DIAMETER / 2, y: o.y + DIAMETER / 2 };
  const area = workArea(center);
  const c = dialCenter(center, area);
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(v, hi)));
  const wx = clamp(c.x - W / 2, area.x, area.x + area.width - W), wy = clamp(c.y - W / 2, area.y, area.y + area.height - W);
  offset = { x: Math.round(o.x) - wx, y: Math.round(o.y) - wy };
  hub = { x: Math.round(c.x) - wx, y: Math.round(c.y) - wy };
  win.move(wx, wy);
  shape();
}

/** Clicks and drops land only on the ball, or on the open dial: the rest of the window lets them through. */
function shape(): void {
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, W, W);
  const cr = new Cairo.Context(surface);
  if (expanded) cr.arc(hub.x, hub.y, DIAL_DIAMETER / 2 + 2, 0, 2 * Math.PI);
  else cr.arc(offset.x + DIAMETER / 2, offset.y + DIAMETER / 2, DIAMETER / 2, 0, 2 * Math.PI);
  cr.fill();
  cr.$dispose();
  win.input_shape_combine_region(Gdk.cairo_region_create_from_surface(surface));
  win.queue_draw();
}

/** The ball at its saved place, on the monitor that still has it. */
function place(): void {
  const at = saved ?? { x: 0, y: 0 };
  layout(origin(saved, { width: DIAMETER, height: DIAMETER }, workArea(saved ? { x: at.x + DIAMETER / 2, y: at.y + DIAMETER / 2 } : at)));
}

let openTimer = 0;
let closeTimer = 0;
let animTimer = 0;

function stop(id: number): number {
  if (id) GLib.source_remove(id);
  return 0;
}

function expand(): void {
  closeTimer = stop(closeTimer);
  if (expanded) return;
  expanded = true;
  highlighted = undefined;
  shape();
  // Only the disc's scale animates; the window stays where it is.
  scale = 0.35;
  animTimer = stop(animTimer);
  animTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
    scale = Math.min(1, scale + 0.13);
    win.queue_draw();
    if (scale < 1) return GLib.SOURCE_CONTINUE;
    animTimer = 0;
    return GLib.SOURCE_REMOVE;
  });
}

/** Back to the ball: at its place, or centred on `center` when the dial is dragged away. */
function collapse(center?: Point): void {
  openTimer = stop(openTimer);
  closeTimer = stop(closeTimer);
  animTimer = stop(animTimer);
  if (!expanded) return;
  expanded = false;
  dragging = false;
  highlighted = undefined;
  scale = 1;
  if (center) layout({ x: center.x - DIAMETER / 2, y: center.y - DIAMETER / 2 });
  else shape();
}

/** The dial closes a moment after the pointer (or a drag) leaves it. */
function closeSoon(ms = 350): void {
  log(`closing in ${ms}ms`);
  closeTimer = stop(closeTimer);
  closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    closeTimer = 0;
    collapse();
    return GLib.SOURCE_REMOVE;
  });
}

/** Debug (`AISPACE_BALL_DEBUG=1`): the pointer events and what the ball made of them, on stderr. */
const DEBUG = Boolean(GLib.getenv("AISPACE_BALL_DEBUG"));
const log = (what: string) => DEBUG && printerr(`[ai-space-ball] ${(GLib.get_monotonic_time() / 1000).toFixed(0)} ${what} expanded=${expanded} pressed=${Boolean(pressed)} moving=${moving}`);

const sectionUnder = (x: number, y: number): Section | undefined => (expanded ? sectionAt({ x, y }, hub) : undefined);
const usable = (s: Section) => sections[s]?.usable === true;

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

// Pointer

let pressed: { x: number; y: number; ox: number; oy: number } | undefined;

win.connect("enter-notify-event", () => {
  log("enter");
  closeTimer = stop(closeTimer);
  return false;
});

win.connect("leave-notify-event", (_w: unknown, event: any) => {
  // A crossing into the window's own parts (an inferior) is not leaving it.
  if (event.get_crossing_detail?.() === Gdk.NotifyType.INFERIOR) return false;
  log("leave");
  openTimer = stop(openTimer);
  if (highlighted) {
    highlighted = undefined;
    win.queue_draw();
  }
  if (expanded && !pressed && !dragging) closeSoon();
  return false;
});

win.connect("motion-notify-event", (_w: unknown, event: any) => {
  const [, x, y] = event.get_coords();
  closeTimer = stop(closeTimer);
  // The dial opens on the pointer moving on the ball, after a short rest so a pointer passing
  // over it does not open it.
  if (!expanded && !pressed && !moving && !openTimer) {
    log("motion on the ball: opening soon");
    openTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
      openTimer = 0;
      if (!pressed && !moving) expand();
      return GLib.SOURCE_REMOVE;
    });
  }
  if (pressed) {
    const [, rx, ry] = event.get_root_coords();
    if (!moving && Math.abs(rx - pressed.x) + Math.abs(ry - pressed.y) > 3) {
      // Moving the open dial moves the ball: it closes under the pointer and follows from there.
      if (expanded) collapse({ x: rx, y: ry });
      moving = true;
      log("drag starts");
      const [ox, oy] = win.get_position();
      pressed = { ...pressed, x: rx, y: ry, ox, oy };
    }
    if (moving) {
      win.move(Math.round(pressed.ox + rx - pressed.x), Math.round(pressed.oy + ry - pressed.y));
    }
    return true;
  }
  const s = sectionUnder(x, y);
  if (s !== highlighted) {
    highlighted = s;
    win.queue_draw();
  }
  return false;
});

win.connect("button-press-event", (_w: unknown, event: any) => {
  const [, button] = event.get_button();
  log(`press ${button}`);
  if (event.get_event_type() !== Gdk.EventType.BUTTON_PRESS) return true;
  if (button === 3) {
    menu(event);
    return true;
  }
  if (button !== 1) return false;
  openTimer = stop(openTimer);
  const [, rx, ry] = event.get_root_coords();
  const [ox, oy] = win.get_position();
  pressed = { x: rx, y: ry, ox, oy };
  moving = false;
  return true;
});

win.connect("button-release-event", (_w: unknown, event: any) => {
  log("release");
  if (!pressed) return true;
  pressed = undefined;
  if (moving) {
    moving = false;
    settle();
    return true;
  }
  const [, x, y] = event.get_coords();
  // The hub and the closed ball do nothing on a click; only a section opens something.
  const s = sectionUnder(x, y);
  if (!s) return true;
  const id = startupId(event.get_time());
  collapse();
  if (usable(s)) send({ type: "open", section: s, ...(id ? { startupId: id } : {}) });
  else if (sections[s]?.hidden) send({ type: "menu", action: "settings", ...(id ? { startupId: id } : {}) });
  return true;
});

/** After the person moved the ball: back inside the monitor it was left on, and remembered. */
function settle(): void {
  const [wx, wy] = win.get_position();
  const now = { x: wx + offset.x, y: wy + offset.y };
  const o = origin(now, { width: DIAMETER, height: DIAMETER }, workArea({ x: now.x + DIAMETER / 2, y: now.y + DIAMETER / 2 }));
  saved = o;
  layout(o);
  send({ type: "moved", origin: o });
}

function menu(event: any): void {
  const m = new Gtk.Menu();
  const item = (label: string, action: "quick-chat" | "settings" | "hide") => {
    const i = new Gtk.MenuItem({ label });
    i.connect("activate", () => {
      const id = startupId(Gtk.get_current_event_time());
      send({ type: "menu", action, ...(id ? { startupId: id } : {}) });
    });
    m.append(i);
  };
  item(labels.menu.quickChat, "quick-chat");
  item(labels.menu.settings, "settings");
  m.append(new Gtk.SeparatorMenuItem());
  item(labels.menu.hide, "hide");
  m.show_all();
  collapse();
  m.popup_at_pointer(event);
}

// Drop: a picture from another app, as one file or as image data. GTK 3 asks for the data only
// at the drop, so while the drag is over the ball only its types are known.

win.drag_dest_set(0, null, Gdk.DragAction.COPY);
win.drag_dest_add_uri_targets();
win.drag_dest_add_image_targets();

const targetNames = (ctx: any): string[] => (ctx.list_targets() ?? []).map((a: any) => a.name());
const imageTarget = (names: string[]) => ["image/png", "image/jpeg", "image/webp", "image/gif"].find((n) => names.includes(n)) ?? names.find(isPictureType);
const mayHold = (names: string[]) => names.includes("text/uri-list") || Boolean(imageTarget(names));

win.connect("drag-motion", (_w: unknown, ctx: any, x: number, y: number, time: number) => {
  closeTimer = stop(closeTimer);
  const names = targetNames(ctx);
  if (!mayHold(names)) {
    Gdk.drag_status(ctx, 0, time);
    return true;
  }
  if (!expanded) expand();
  dragging = true;
  hover = true;
  const s = sectionUnder(x, y);
  if (s !== highlighted) {
    highlighted = s;
    win.queue_draw();
  }
  // A section that cannot take the picture refuses it; the hub takes it.
  Gdk.drag_status(ctx, s && !usable(s) ? 0 : Gdk.DragAction.COPY, time);
  return true;
});

win.connect("drag-leave", () => {
  hover = false;
  highlighted = undefined;
  win.queue_draw();
  // drag-leave comes before a drop too: the drop cancels this.
  closeSoon(400);
});

/** The drop being read: its section, its types, and whether the file list was asked for first. */
let dropping: { section?: Section; names: string[]; triedUris: boolean; time: number } | undefined;

win.connect("drag-drop", (_w: unknown, ctx: any, x: number, y: number, time: number) => {
  closeTimer = stop(closeTimer);
  const names = targetNames(ctx);
  const s = sectionUnder(x, y);
  if (s && !usable(s)) return false;
  dropping = { ...(s ? { section: s } : {}), names, triedUris: names.includes("text/uri-list"), time };
  const first = dropping.triedUris ? "text/uri-list" : imageTarget(names);
  if (!first) return false;
  win.drag_get_data(ctx, Gdk.Atom.intern(first, false), time);
  return true;
});

/** Where pictures dropped as data are written for the app to read: the user's runtime directory, this user only. */
const DROPS = GLib.build_filenamev([GLib.get_user_runtime_dir(), "ai-space-drops"]);

function contentType(file: any): string {
  try {
    const info = file.query_info("standard::content-type", Gio.FileQueryInfoFlags.NONE, null);
    return Gio.content_type_get_mime_type(info.get_content_type()) ?? "";
  } catch {
    return "";
  }
}

function writeDrop(bytes: Uint8Array, ext: string): string {
  GLib.mkdir_with_parents(DROPS, 0o700);
  const file = GLib.build_filenamev([DROPS, `${GLib.uuid_string_random()}.${ext}`]);
  GLib.file_set_contents(file, bytes);
  GLib.chmod(file, 0o600);
  return file;
}

win.connect("drag-data-received", (_w: unknown, ctx: any, _x: number, _y: number, data: any, _info: number, time: number) => {
  const d = dropping;
  if (!d) return Gtk.drag_finish(ctx, false, false, time);
  const finish = (ok: boolean) => {
    dropping = undefined;
    dragging = false;
    hover = false;
    Gtk.drag_finish(ctx, ok, false, time);
    collapse();
  };
  const id = startupId(d.time);
  const name = data.get_data_type().name();
  if (name === "text/uri-list") {
    const files = (data.get_uris() ?? []).map((u: string) => Gio.File.new_for_uri(u)).filter((f: any) => f.is_native());
    if (files.length) {
      const verdict = offer(d.names, files.map(contentType), isPictureType);
      if (verdict !== "file") {
        send({ type: "refuse", reason: files.length > 1 ? "several" : "not-a-picture" });
        return finish(false);
      }
      send({ type: "drop", file: files[0].get_path(), temporary: false, ...(d.section ? { section: d.section } : {}), ...(id ? { startupId: id } : {}) });
      return finish(true);
    }
    // Links only (a browser's picture): the picture's own data, when the drag has it.
    const image = imageTarget(d.names);
    if (!image) {
      send({ type: "refuse", reason: "not-a-picture" });
      return finish(false);
    }
    d.triedUris = false;
    win.drag_get_data(ctx, Gdk.Atom.intern(image, false), time);
    return;
  }
  try {
    const raw: Uint8Array | null = data.get_data();
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[name as string];
    let file: string | undefined;
    if (ext && raw?.length) file = writeDrop(raw, ext);
    else {
      const pixbuf = data.get_pixbuf();
      if (pixbuf) {
        const [ok, png] = pixbuf.save_to_bufferv("png", [], []);
        if (ok) file = writeDrop(png, "png");
      }
    }
    if (!file) {
      send({ type: "refuse", reason: "unreadable" });
      return finish(false);
    }
    send({ type: "drop", file, temporary: true, ...(d.section ? { section: d.section } : {}), ...(id ? { startupId: id } : {}) });
    finish(true);
  } catch {
    send({ type: "refuse", reason: "unreadable" });
    finish(false);
  }
});

// Drawing

const pixbufs = new Map<string, any>();
function pixbuf(file: string, size: number): any {
  const key = `${file}@${size}`;
  if (!pixbufs.has(key)) {
    try {
      pixbufs.set(key, GdkPixbuf.Pixbuf.new_from_file_at_scale(file, size, size, true));
    } catch {
      pixbufs.set(key, null);
    }
  }
  return pixbufs.get(key);
}

const ink = () => (dark ? [235 / 255, 235 / 255, 245 / 255] : [60 / 255, 60 / 255, 67 / 255]);
const line = (cr: any) => (dark ? cr.setSourceRGBA(1, 1, 1, 0.12) : cr.setSourceRGBA(0, 0, 0, 0.08));

function roundedRect(cr: any, x: number, y: number, w: number, h: number, r: number): void {
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
}

function text(cr: any, s: string, cx: number, cy: number, font: string, width: number, lines = 2): void {
  const layout = PangoCairo.create_layout(cr);
  layout.set_font_description(Pango.FontDescription.from_string(font));
  layout.set_width(Math.round(width * Pango.SCALE));
  layout.set_alignment(Pango.Alignment.CENTER);
  layout.set_wrap(Pango.WrapMode.WORD_CHAR);
  layout.set_height(-lines);
  layout.set_ellipsize(Pango.EllipsizeMode.END);
  layout.set_text(s, -1);
  const [, logical] = layout.get_pixel_extents();
  cr.moveTo(cx - width / 2, cy - logical.height / 2);
  PangoCairo.show_layout(cr, layout);
  cr.newPath();
}

/** The section's picture: its PNG icon (round for an agent), an emoji, else its first letter. */
function icon(cr: any, s: Section, cx: number, cy: number, size: number): void {
  const sec = sections[s];
  const [r, g, b] = ink();
  cr.newPath();
  if (!sec || sec.hidden) {
    cr.save();
    cr.setSourceRGBA(r, g, b, 0.3);
    cr.setLineWidth(1);
    cr.setDash([3, 2.6], 0);
    cr.arc(cx, cy, size / 2 - 0.5, 0, 2 * Math.PI);
    cr.stroke();
    cr.setDash([], 0);
    cr.setLineWidth(1.4);
    cr.moveTo(cx - 4, cy);
    cr.lineTo(cx + 4, cy);
    cr.moveTo(cx, cy - 4);
    cr.lineTo(cx, cy + 4);
    cr.stroke();
    cr.restore();
    return;
  }
  cr.save();
  if (!sec.usable) cr.pushGroup();
  const pb = sec.icon?.startsWith("/") ? pixbuf(sec.icon, size * 2) : undefined;
  if (pb) {
    cr.save();
    if (sec.round) cr.arc(cx, cy, size / 2, 0, 2 * Math.PI);
    else roundedRect(cr, cx - size / 2, cy - size / 2, size, size, size * 0.225);
    cr.clip();
    cr.translate(cx - size / 2, cy - size / 2);
    cr.scale(size / pb.get_width(), size / pb.get_height());
    Gdk.cairo_set_source_pixbuf(cr, pb, 0, 0);
    cr.paint();
    cr.restore();
  } else if (sec.icon && !sec.icon.startsWith("/")) {
    cr.setSourceRGBA(r, g, b, 1);
    text(cr, sec.icon, cx, cy, `${Math.round(size * 0.62)}px`, size + 8, 1);
  } else {
    cr.setSourceRGBA(0.47, 0.47, 0.5, dark ? 0.32 : 0.16);
    if (sec.round) cr.arc(cx, cy, size / 2, 0, 2 * Math.PI);
    else roundedRect(cr, cx - size / 2, cy - size / 2, size, size, size * 0.225);
    cr.fill();
    cr.setSourceRGBA(r, g, b, 0.85);
    text(cr, (sec.title.trim()[0] ?? "?").toUpperCase(), cx, cy, "Sans Bold 11", size, 1);
  }
  if (!sec.usable) {
    cr.popGroupToSource();
    cr.paintWithAlpha(0.3);
  }
  cr.restore();
}

function drawBall(cr: any, size: number): void {
  const c = size / 2, r = size / 2 - 3;
  const grow = hover ? 1.08 : 1;
  dark ? cr.setSourceRGBA(40 / 255, 40 / 255, 44 / 255, 0.94) : cr.setSourceRGBA(248 / 255, 248 / 255, 250 / 255, 0.96);
  cr.arc(c, c, r * Math.min(grow, (size / 2 - 0.5) / r), 0, 2 * Math.PI);
  cr.fillPreserve();
  if (hover) {
    cr.setSourceRGBA(0.04, 0.52, 1, 1);
    cr.setLineWidth(2);
  } else {
    dark ? cr.setSourceRGBA(1, 1, 1, 0.16) : cr.setSourceRGBA(0, 0, 0, 0.14);
    cr.setLineWidth(1);
  }
  cr.stroke();
  const pb = mark && pixbuf(mark, 56);
  if (pb) {
    cr.save();
    cr.translate(c - 14, c - 14);
    cr.scale(28 / pb.get_width(), 28 / pb.get_height());
    Gdk.cairo_set_source_pixbuf(cr, pb, 0, 0);
    cr.paint();
    cr.restore();
  }
}

function drawDial(cr: any, size: number): void {
  const c = size / 2, outer = DIAL_DIAMETER / 2, inner = HUB_DIAMETER / 2;
  cr.save();
  cr.translate(c, c);
  cr.scale(scale, scale);
  cr.translate(-c, -c);
  // A soft shadow under the disc (0 12 32 in the spec), drawn as rings fading out.
  for (let i = 12; i > 0; i--) {
    cr.setSourceRGBA(0, 0, 0, 0.005 * (13 - i) * (dark ? 1.6 : 1));
    cr.arc(c, c + 6, outer + i * 1.4, 0, 2 * Math.PI);
    cr.fill();
  }
  dark ? cr.setSourceRGBA(40 / 255, 40 / 255, 44 / 255, 0.95) : cr.setSourceRGBA(1, 1, 1, 0.95);
  cr.arc(c, c, outer, 0, 2 * Math.PI);
  cr.fill();
  // The section under the pointer, tinted blue.
  if (highlighted && (usable(highlighted) || sections[highlighted]?.hidden)) {
    const a = (ANGLE[highlighted] * Math.PI) / 180;
    cr.setSourceRGBA(0.04, 0.52, 1, dark ? 0.22 : 0.14);
    cr.arc(c, c, outer, -a - Math.PI / 4, -a + Math.PI / 4);
    cr.arcNegative(c, c, inner, -a + Math.PI / 4, -a - Math.PI / 4);
    cr.closePath();
    cr.fill();
  }
  line(cr);
  cr.setLineWidth(1);
  cr.arc(c, c, outer - 0.5, 0, 2 * Math.PI);
  cr.stroke();
  for (let d = 45; d < 360; d += 90) {
    const a = (d * Math.PI) / 180;
    cr.moveTo(c + Math.cos(a) * inner, c - Math.sin(a) * inner);
    cr.lineTo(c + Math.cos(a) * outer, c - Math.sin(a) * outer);
  }
  cr.stroke();
  for (const s of SECTIONS) {
    const a = (ANGLE[s] * Math.PI) / 180, r = (inner + outer) / 2;
    icon(cr, s, c + Math.cos(a) * r, c - Math.sin(a) * r, 28);
  }
  // The hub names the section under the pointer.
  dark ? cr.setSourceRGBA(52 / 255, 52 / 255, 57 / 255, 0.98) : cr.setSourceRGBA(1, 1, 1, 0.98);
  cr.arc(c, c, inner, 0, 2 * Math.PI);
  cr.fillPreserve();
  line(cr);
  cr.stroke();
  const label = hubLabel();
  if (label) {
    const [r, g, b] = dark ? [1, 1, 1] : [0.1, 0.1, 0.12];
    cr.setSourceRGBA(r, g, b, 0.92);
    text(cr, label, c, c, "Sans Bold 8", inner * 2 - 8);
  }
  cr.restore();
}

function hubLabel(): string | undefined {
  if (!highlighted) return labels.hub || undefined;
  const sec = sections[highlighted];
  if (!sec || sec.hidden) return labels.addInSettings;
  if (dragging && sec.usable) return labels.sendTo.replace("{name}", sec.title);
  return sec.title;
}

win.connect("draw", (_w: unknown, cr: any) => {
  cr.setOperator(Cairo.Operator.SOURCE);
  cr.setSourceRGBA(0, 0, 0, 0);
  cr.paint();
  cr.setOperator(Cairo.Operator.OVER);
  if (expanded) {
    cr.translate(hub.x - W / 2, hub.y - W / 2);
    drawDial(cr, W);
  } else {
    cr.translate(offset.x, offset.y);
    drawBall(cr, DIAMETER);
  }
  cr.$dispose();
  return true;
});

/**
 * Debug (`AISPACE_BALL_SHOT=<file.png>`): the ball and its open dial, the first section lit, drawn
 * side by side into a PNG once the app has said what the dial shows. A screenshot of the desktop
 * needs the person's leave on GNOME; this needs none.
 */
const SHOT = GLib.getenv("AISPACE_BALL_SHOT");
function snapshot(file: string): void {
  const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, DIAMETER + DIAL_WINDOW + 16, DIAL_WINDOW);
  const cr = new Cairo.Context(surface);
  cr.translate(0, (DIAL_WINDOW - DIAMETER) / 2);
  drawBall(cr, DIAMETER);
  cr.translate(DIAMETER + 16, -(DIAL_WINDOW - DIAMETER) / 2);
  const was = { expanded, highlighted, scale };
  [expanded, highlighted, scale] = [true, SECTIONS.find(usable), 1];
  drawDial(cr, DIAL_WINDOW);
  [expanded, highlighted, scale] = [was.expanded, was.highlighted, was.scale];
  cr.$dispose();
  surface.writeToPNG(file);
  printerr(`[ai-space-ball] snapshot ${file}`);
}

// The app's messages

function handle(raw: string): void {
  let m: ToBall;
  try {
    m = JSON.parse(raw) as ToBall;
  } catch {
    return;
  }
  switch (m.type) {
    case "init":
      saved = m.origin;
      mark = m.markIcon;
      if (!expanded) place();
      win.show_all();
      break;
    case "dial":
      sections = m.sections;
      dark = m.dark;
      labels = m.labels;
      win.queue_draw();
      if (SHOT) snapshot(SHOT);
      break;
    case "quit":
      Gtk.main_quit();
      break;
  }
}

const input = new Gio.DataInputStream({ base_stream: new InputStream({ fd: 0, close_fd: false }) });
function readNext(): void {
  input.read_line_async(GLib.PRIORITY_DEFAULT, null, (_s: unknown, res: unknown) => {
    let line: string | null = null;
    try {
      [line] = input.read_line_finish_utf8(res);
    } catch {
      line = null;
    }
    // The app closed its end: it quit or crashed, and the ball goes with it.
    if (line === null) return Gtk.main_quit();
    handle(line);
    readNext();
  });
}
readNext();

// Monitors added or removed: back inside what is left.
Gdk.Screen.get_default().connect("monitors-changed", () => {
  collapse();
  place();
});

send({ type: "ready", x11: true });
Gtk.main();
system.exit(0);
