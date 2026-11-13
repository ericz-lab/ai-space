import Gdk from "gi://Gdk?version=4.0";
import GdkPixbuf from "gi://GdkPixbuf";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { CLAUDE, PET_SIZES, type PetMood, PetMotion, type PetOpen, bubbleUntilChange, bubbleVisible, isPetSize, opensRight, sayText } from "../core/pet.ts";
import { APP_ROOT, lang, logError, path, prefs, t } from "./env.ts";

/**
 * The desk pet in the main window (docs/linux-desktop.md#desk-pet): the web panel's Claude walking
 * along the bottom of Home, showing the Space's mood (core/pet.ts, the Mac's PetRules.swift).
 * Only the sprite takes the pointer; the rest of Home stays as it is. A click opens the chat or
 * the inbox the mood points at, else Claude jumps; right-click to put it on the desktop or hide it.
 * Its timer runs only while Home is on show in a window that can be seen, and only when a cell or
 * the place changes; with the desktop's animations off it is not shown.
 */

/** The sheet beside the app (build.ts copies it), read once and cut into cells as they are first drawn. */
const sheet = { pixbuf: undefined as any, loaded: false, cells: new Map<string, any>() };

export function petCell(column: number, row: number): any | undefined {
  if (!sheet.loaded) {
    sheet.loaded = true;
    try {
      sheet.pixbuf = GdkPixbuf.Pixbuf.new_from_file(path(APP_ROOT, CLAUDE.file));
    } catch (e) {
      logError(e, "the desk pet's sheet");
    }
  }
  if (!sheet.pixbuf) return undefined;
  const key = `${column},${row}`;
  let cell = sheet.cells.get(key);
  if (!cell) {
    const w = Math.floor(sheet.pixbuf.get_width() / CLAUDE.columns), h = Math.floor(sheet.pixbuf.get_height() / CLAUDE.rows);
    cell = sheet.pixbuf.new_subpixbuf(column * w, row * h, w, h);
    sheet.cells.set(key, cell);
  }
  return cell;
}

/** The pet's width in pixels for the size chosen in Settings. */
export const petWidth = () => PET_SIZES[isPetSize(prefs.petSize) ? prefs.petSize : "medium"];

/** Whether the desktop asks for animations (GNOME's Reduce Animations, as the Mac's Reduce Motion). */
export const animationsOn = () => Gtk.Settings.get_default()?.gtk_enable_animations !== false;

/** XWayland (or an X11 session) is there to run the desktop pet, as the floating ball needs. */
export const desktopPetAvailable = () => Boolean(GLib.getenv("DISPLAY"));

/** Settings › General › Desk Pet: on by default, in the window unless put on the desktop (where that can run). */
export const petOnDesktop = () => !prefs.noPet && prefs.petPlace === "desktop" && desktopPetAvailable();
export const petInWindow = () => !prefs.noPet && !petOnDesktop();

export type PetActions = {
  open: (open: PetOpen) => void;
  /** Put the pet on the desktop; absent where the desktop pet cannot run. */
  toDesktop?: () => void;
  hide: () => void;
  /** The pet belongs in the window now (on, and not on the desktop). */
  wanted: () => boolean;
};

export class WindowPet {
  /** Takes no input; tells the stage's width. */
  private readonly probe: any;
  private readonly area: any;
  private readonly bubble: any;
  private readonly bubbleText: any;
  private motion: PetMotion | undefined;
  private mood: PetMood | undefined;
  private stage = 0;
  private active = false;
  private running = false;
  private timer = 0;
  private bubbleTimer = 0;
  private bubbleSince: number | undefined;
  private bubbleOn = false;
  private hovering = false;

  constructor(private readonly actions: PetActions) {
    this.probe = new Gtk.DrawingArea({ can_target: false, hexpand: true, vexpand: true });
    this.probe.connect("resize", (_a: unknown, width: number) => this.layout(width));
    const width = petWidth();
    this.area = new Gtk.DrawingArea({ content_width: width, content_height: width, halign: Gtk.Align.START, valign: Gtk.Align.END, margin_bottom: 6 });
    this.area.set_cursor(Gdk.Cursor.new_from_name("pointer", null));
    this.area.set_draw_func((_a: unknown, cr: any, w: number, h: number) => {
      const m = this.motion;
      const cell = m && petCell(m.cell.column, m.cell.row);
      if (cell) {
        if (m.facingLeft) {
          cr.translate(w, 0);
          cr.scale(-1, 1);
        }
        cr.scale(w / cell.get_width(), h / cell.get_height());
        Gdk.cairo_set_source_pixbuf(cr, cell, 0, 0);
        cr.paint();
      }
      cr.$dispose?.();
    });
    this.bubbleText = new Gtk.Label({ wrap: false, single_line_mode: true });
    this.bubble = new Gtk.Box({ css_classes: ["pet-bubble"], valign: Gtk.Align.END, can_target: false, visible: false });
    this.bubble.append(this.bubbleText);

    const click = new Gtk.GestureClick({ button: 0 });
    click.connect("released", (g: any, n: number, x: number, y: number) => {
      if (n !== 1) return;
      if (g.get_current_button() === Gdk.BUTTON_SECONDARY) this.menu({ x, y });
      else this.click();
    });
    this.area.add_controller(click);
    const motion = new Gtk.EventControllerMotion();
    motion.connect("enter", () => this.hover(true));
    motion.connect("leave", () => this.hover(false));
    this.area.add_controller(motion);

    Gtk.Settings.get_default()?.connect("notify::gtk-enable-animations", () => this.sync());
  }

  /** Puts the pet over `overlay`'s child (Home), along its bottom edge. */
  attach(overlay: any): void {
    overlay.add_overlay(this.probe);
    overlay.add_overlay(this.bubble);
    overlay.add_overlay(this.area);
    this.sync();
  }

  /** The Space's mood as the pet shows it; the same one again changes nothing. */
  setMood(mood: PetMood | undefined): void {
    const lineBefore = this.line();
    this.mood = mood;
    if (this.motion) {
      this.motion.setMood(mood, now());
      this.schedule();
    }
    if (this.line() !== lineBefore) {
      this.bubbleSince = undefined;
      this.restartBubble();
    }
  }

  /** Home is on show in a window that can be seen; otherwise nothing runs. */
  setActive(on: boolean): void {
    this.active = on;
    this.run();
  }

  /** The preferences changed (on, where, size), or the desktop's animations. */
  sync(): void {
    const shown = this.actions.wanted() && animationsOn();
    const width = petWidth();
    this.area.set_content_width(width);
    this.area.set_content_height(width);
    if (this.motion && this.motion.width !== width) this.motion.resize(this.stage, now(), width);
    this.area.set_visible(shown);
    if (!shown) this.bubble.set_visible(false);
    this.run();
    this.place();
  }

  private get shown(): boolean {
    return this.area.get_visible();
  }

  private line(): string | undefined {
    return sayText(this.mood?.say, lang);
  }

  private layout(width: number): void {
    if (width <= 0) return;
    this.stage = width;
    const t = now();
    if (this.motion) this.motion.resize(width, t);
    else {
      this.motion = new PetMotion(CLAUDE, petWidth(), width, t);
      this.motion.setMood(this.mood, t);
    }
    // The first size starts the pet; a later one places it again.
    this.run();
    this.schedule();
  }

  private run(): void {
    const on = this.active && this.shown && this.motion !== undefined;
    if (on === this.running) return;
    this.running = on;
    if (on) {
      this.schedule();
      this.restartBubble();
    } else {
      this.timer = stop(this.timer);
      this.bubbleTimer = stop(this.bubbleTimer);
    }
  }

  private schedule(): void {
    this.timer = stop(this.timer);
    const m = this.motion;
    if (!this.running || !m) return;
    const delay = m.advance(now());
    this.place();
    this.area.queue_draw();
    // At most 20 changes a second: the walk's cells skip rather than the timer racing them.
    this.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(Math.max(0.05, delay) * 1000), () => {
      this.timer = 0;
      this.schedule();
      return GLib.SOURCE_REMOVE;
    });
  }

  /** The sprite at the pet's place, the bubble above it opening towards the middle. */
  private place(): void {
    const m = this.motion;
    if (!m) return;
    const x = Math.round(m.x);
    if (this.area.get_margin_start() !== x) this.area.set_margin_start(x);
    const line = this.line();
    const show = this.shown && line !== undefined && (this.bubbleOn || this.hovering);
    if (show) {
      if (this.bubbleText.get_label() !== line) this.bubbleText.set_label(line);
      const bottom = 6 + m.width + 6;
      if (this.bubble.get_margin_bottom() !== bottom) this.bubble.set_margin_bottom(bottom);
      if (opensRight(m.x, m.width, this.stage)) {
        this.bubble.set_halign(Gtk.Align.START);
        this.bubble.set_margin_end(0);
        this.bubble.set_margin_start(x);
      } else {
        this.bubble.set_halign(Gtk.Align.END);
        this.bubble.set_margin_start(0);
        this.bubble.set_margin_end(Math.max(0, Math.round(this.stage - m.x - m.width)));
      }
    }
    if (this.bubble.get_visible() !== show) this.bubble.set_visible(show);
  }

  private restartBubble(): void {
    this.bubbleTimer = stop(this.bubbleTimer);
    if (this.line() === undefined) {
      this.bubbleSince = undefined;
      this.bubbleOn = false;
      this.place();
      return;
    }
    this.bubbleSince ??= now();
    this.flipBubble();
  }

  private flipBubble(): void {
    if (!this.running || this.bubbleSince === undefined) return;
    const elapsed = now() - this.bubbleSince;
    this.bubbleOn = bubbleVisible(elapsed);
    this.place();
    this.bubbleTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round((bubbleUntilChange(elapsed) + 0.05) * 1000), () => {
      this.bubbleTimer = 0;
      this.flipBubble();
      return GLib.SOURCE_REMOVE;
    });
  }

  private hover(on: boolean): void {
    this.hovering = on;
    this.place();
  }

  private click(): void {
    const open = this.mood?.open;
    if (open) return this.actions.open(open);
    this.motion?.click(now());
    this.schedule();
  }

  private menu(at: { x: number; y: number }): void {
    const pop = new Gtk.Popover({ has_arrow: false });
    pop.set_pointing_to(new Gdk.Rectangle({ x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 }));
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    const item = (label: string, run: () => void) => {
      const b = new Gtk.Button({ child: new Gtk.Label({ label, xalign: 0 }), css_classes: ["flat"] });
      b.connect("clicked", (button: any) => {
        button.get_ancestor(Gtk.Popover.$gtype)?.popdown();
        run();
      });
      box.append(b);
    };
    const toDesktop = this.actions.toDesktop;
    if (toDesktop) item(t("petToDesktop"), toDesktop);
    item(t("petHide"), () => this.actions.hide());
    pop.set_child(box);
    pop.set_parent(this.area);
    pop.connect("closed", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (pop.unparent(), GLib.SOURCE_REMOVE)));
    pop.popup();
  }
}

const now = () => GLib.get_monotonic_time() / 1e6;

function stop(id: number): number {
  if (id) GLib.source_remove(id);
  return 0;
}
