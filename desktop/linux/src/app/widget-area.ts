import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk?version=4.0";
import type { Widget } from "../core/catalogue.ts";
import {
  type Align,
  type AreaCard,
  type Box,
  type Edge,
  type Frame,
  type Guides,
  type LayoutWrite,
  ERROR_MS,
  KEYS_REST_MS,
  TWEEN_MS,
  UNDO_MS,
  type ToolbarOp,
  arrange,
  canReset,
  framesWrite,
  handleAt,
  handleRects,
  keyStep,
  nudge,
  readoutOf,
  resizeTo,
  resolveFrames,
  startResize,
  toolbarWrite,
  tween,
} from "../core/widget-area.ts";
import { tw } from "./env.ts";
import type { Space } from "./model.ts";
import { animationsOn } from "./pet.ts";
import { Bag, type CardHost, LiveCard, colors } from "./widget-card.ts";

/**
 * A screen's widget area, laid out as the web panel's (src/web/WidgetArea.tsx,
 * docs/panel.md#resize-a-widget; the maths in core/widget-area.ts, which is the panel's own
 * module): the cards flow in stepless rows at the boxes `place` computes, each card keeps its
 * widget and its state while it moves, and in Edit Layout every card has three handles (right edge,
 * bottom edge, corner) and a toolbar aligns, centres, splits, resets and undoes. Below the panel's
 * breakpoint it is one column of cards sized by their content.
 *
 * The cards are children of one widget whose layout manager (AreaLayout) allocates them; it only
 * places, and anything that changes a widget (a card's size class, its rows per page, the size
 * readouts) waits for an idle after the allocation, so an allocation never asks for another.
 */

/** What the area needs from Home. */
export type AreaHost = Omit<CardHost, "embed" | "releaseEmbed" | "decorate" | "writes"> & {
  embed: (w: Widget) => any;
  releaseEmbed: (view: any) => void;
  decorate: (root: any, widgetId: string) => void;
  /** Puts a layout write on the screen at once (the catalogue's widgets and alignment). */
  apply: (write: LayoutWrite) => void;
  /** Stores it; false when it was not saved (the area then puts the previous layout back). */
  save: (write: LayoutWrite) => Promise<boolean>;
  /** Edit Layout is done (the toolbar's Done, or Escape). */
  leave: () => void;
};

type Entry = { id: string; card: LiveCard; handles: Record<Edge, any>; bag: Bag };

const KEYS: Record<number, "left" | "right" | "up" | "down"> = { 0xff51: "left", 0xff53: "right", 0xff52: "up", 0xff54: "down" };
const KEY_ESCAPE = 0xff1b;
const CURSORS: Record<Edge, string> = { x: "col-resize", y: "row-resize", xy: "nwse-resize" };
const LABELS: Record<Edge, "widget.resizeWidth" | "widget.resizeHeight" | "widget.resizeBoth"> = { x: "widget.resizeWidth", y: "widget.resizeHeight", xy: "widget.resizeBoth" };

/** The area's layout manager: it asks the WidgetArea that owns its widget where everything goes. */
const AreaLayout = GObject.registerClass(
  { GTypeName: "AiSpaceWidgetAreaLayout" },
  class AreaLayout extends Gtk.LayoutManager {
    vfunc_get_request_mode(): number {
      return Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH;
    }

    vfunc_measure(widget: any, orientation: number, forSize: number): [number, number, number, number] {
      const area: WidgetArea | null = widget._area ?? null;
      if (!area || orientation === Gtk.Orientation.HORIZONTAL) return [0, 0, -1, -1];
      const h = area.heightFor(forSize);
      return [h, h, -1, -1];
    }

    vfunc_allocate(widget: any, width: number, height: number): void {
      (widget._area as WidgetArea | null)?.allocate(width, height);
    }
  },
);

/**
 * The widget the cards are children of (GtkWidget itself cannot be made). It has no dispose of its
 * own: GJS may finalize it while the collector runs, when it refuses to call into JavaScript, so
 * WidgetArea.dispose() unparents every child itself.
 */
const AreaWidget = GObject.registerClass({ GTypeName: "AiSpaceWidgetArea" }, class AreaWidget extends Gtk.Widget {});

/** A row of controls that wraps when the window is narrow: Adw.WrapBox where there is one (libadwaita 1.7), else a flow box (chat-cards.ts). */
function wrapRow(classes: string[]): { box: any; append: (w: any) => void; clear: () => void } {
  const WrapBox = (Adw as any).WrapBox;
  const box = WrapBox
    ? new WrapBox({ child_spacing: 6, line_spacing: 6, css_classes: classes })
    : new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous: false, column_spacing: 6, row_spacing: 6, min_children_per_line: 1, max_children_per_line: 30, css_classes: classes });
  return {
    box,
    append: (w: any) => {
      box.append(w);
      // A flow box wraps each child in one that takes the focus itself; the button inside should.
      if (!WrapBox) box.get_last_child()?.set_focusable(false);
    },
    clear: () => {
      let child = box.get_first_child();
      while (child) {
        const next = child.get_next_sibling();
        box.remove(child);
        child = next;
      }
    },
  };
}

export class WidgetArea {
  /** The toolbar (Edit Layout only) above the cards. */
  readonly widget: any;
  private readonly area: any;
  private readonly toolbar: ReturnType<typeof wrapRow>;
  private readonly guide: any;
  /** What the guide draws; plain data, read by its drawing function. */
  private readonly guides: Guides = { x: [], y: [] };
  private readonly bag = new Bag();
  private toolbarBag = new Bag();
  private entries: Entry[] = [];
  private align: Align = "start";
  private editing = false;
  private disposed = false;
  /** The width the area was last given, and the boxes it placed there. */
  private W = 0;
  private boxes: Box[] = [];
  private free = false;
  /** While an edge is dragged (or moved with the keys), the frames drawn instead of the stored ones. */
  private live: Frame[] | null = null;
  private drag: { start: ReturnType<typeof startResize>; id: string } | null = null;
  private keys: { base: Frame[]; f: Frame[]; i: number; timer: number } | null = null;
  /** A move being tweened: where each card was. */
  private tweenFrom: Map<string, Box> | null = null;
  private tweenK = 1;
  /** What the cards were last told, so the idle after an allocation tells only what changed. */
  private told = new Map<string, string>();
  private settlePending = 0;
  private undoable: { undo: LayoutWrite; redo: LayoutWrite; timer: number } | null = null;
  private error: { text: string; timer: number } | null = null;
  private confirmReset = false;

  constructor(
    readonly space: Space,
    private host: AreaHost,
  ) {
    this.area = new AreaWidget({ layout_manager: new AreaLayout(), hexpand: true, overflow: Gtk.Overflow.HIDDEN, css_classes: ["wl-area"] });
    this.area._area = this;
    this.guide = new Gtk.DrawingArea({ can_target: false, can_focus: false });
    const guides = this.guides;
    this.guide.set_draw_func((a: any, cr: any, w: number, h: number) => {
      if (!guides.x.length && !guides.y.length) return;
      const { accent } = colors(a);
      cr.setSourceRGBA(accent[0], accent[1], accent[2], 0.9);
      cr.setLineWidth(1);
      for (const x of guides.x) {
        cr.moveTo(Math.round(x) + 0.5, 0);
        cr.lineTo(Math.round(x) + 0.5, h);
      }
      for (const y of guides.y) {
        cr.moveTo(0, Math.round(y) + 0.5);
        cr.lineTo(w, Math.round(y) + 0.5);
      }
      cr.stroke();
      cr.$dispose?.();
    });
    this.guide.set_parent(this.area);

    // Dragging a handle: the gesture is the area's, which does not move while the cards do, so the
    // pointer's travel is measured from a fixed place; the handle is found under the press.
    const drag = new Gtk.GestureDrag({ button: Gdk.BUTTON_PRIMARY });
    this.bag.on(drag, "drag-begin", (g: any, x: number, y: number) => {
      const hit = this.editing && this.free ? handleAt(this.boxes, x, y) : null;
      if (!hit) {
        g.set_state(Gtk.EventSequenceState.DENIED);
        return;
      }
      g.set_state(Gtk.EventSequenceState.CLAIMED);
      this.finishKeys();
      this.drag = { start: startResize(this.frames(), this.W, this.align, hit.i, hit.edge), id: this.entries[hit.i]!.id };
      this.entries[hit.i]?.card.root.add_css_class("resizing");
    });
    this.bag.on(drag, "drag-update", (g: any, dx: number, dy: number) => {
      if (!this.drag) return;
      const state = g.get_current_event_state();
      const r = resizeTo(this.drag.start, dx, dy, { reflow: !!(state & Gdk.ModifierType.SHIFT_MASK), free: !!(state & Gdk.ModifierType.ALT_MASK) });
      this.live = r.frames;
      this.guides.x = r.guides.x;
      this.guides.y = r.guides.y;
      this.showReadouts(r.frames);
      this.guide.queue_draw();
      this.area.queue_resize();
    });
    this.bag.on(drag, "drag-end", (g: any, dx: number, dy: number) => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const state = g.get_current_event_state();
      const r = resizeTo(d.start, dx, dy, { reflow: !!(state & Gdk.ModifierType.SHIFT_MASK), free: !!(state & Gdk.ModifierType.ALT_MASK) });
      this.live = null;
      this.guides.x = [];
      this.guides.y = [];
      this.guide.queue_draw();
      for (const e of this.entries) e.card.root.remove_css_class("resizing");
      this.commit(d.start.frames, r.frames, false);
      this.area.queue_resize();
    });
    this.area.add_controller(drag);

    this.toolbar = wrapRow(["wl-toolbar"]);
    this.toolbar.box.set_visible(false);
    this.toolbar.box.set_margin_bottom(10);
    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    this.widget.append(this.toolbar.box);
    this.widget.append(this.area);
    const esc = new Gtk.EventControllerKey();
    this.bag.on(esc, "key-pressed", (_k: unknown, keyval: number) => {
      if (keyval !== KEY_ESCAPE || !this.editing) return false;
      this.host.leave();
      return true;
    });
    this.widget.add_controller(esc);
  }

  // Outside calls

  /** The cards to show, in the screen's order, and the area's alignment; a card whose payload did not change is not drawn again. */
  update(widgets: Widget[], align: Align): void {
    if (this.disposed) return;
    this.align = align;
    const keep = new Map(this.entries.map((e) => [e.id, e]));
    const next: Entry[] = [];
    for (const w of widgets) {
      const old = keep.get(w.id);
      if (old) {
        keep.delete(w.id);
        old.card.update(w);
        next.push(old);
      } else next.push(this.add(w));
    }
    for (const e of keep.values()) this.drop(e);
    this.entries = next;
    // Handles over every card, the guide over all.
    for (const e of this.entries) for (const h of Object.values(e.handles)) h.insert_before(this.area, null);
    this.guide.insert_before(this.area, null);
    this.renderToolbar();
    this.area.queue_resize();
  }

  setEditing(on: boolean): void {
    if (on === this.editing || this.disposed) return;
    this.editing = on;
    if (!on) {
      this.finishKeys();
      this.confirmReset = false;
      this.clearUndo();
    }
    for (const e of this.entries) e.card.setMode(on ? "edit" : "live");
    this.told.clear();
    this.renderToolbar();
    this.area.queue_resize();
  }

  get isEditing(): boolean {
    return this.editing;
  }

  /** The ages on the cards move on. */
  tick(): void {
    for (const e of this.entries) e.card.tick();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bag.dispose();
    this.toolbarBag.dispose();
    if (this.keys) this.keys = null;
    for (const e of this.entries) this.drop(e);
    this.entries = [];
    this.area._area = null;
    this.guide.unparent();
    this.widget.get_parent()?.remove?.(this.widget);
    this.host = DEAD;
  }

  // Cards

  private add(w: Widget): Entry {
    const bag = new Bag();
    const card = new LiveCard(
      {
        open: this.host.open,
        post: this.host.post,
        replace: this.host.replace,
        writes: true,
        embed: (x) => this.host.embed(x),
        releaseEmbed: (v) => this.host.releaseEmbed(v),
        decorate: this.host.decorate,
      },
      this.space,
      w,
      this.editing ? "edit" : "live",
      true,
    );
    // The card fills the box the area gives it (its own alignment would shrink it to its content) and clips what does not fit.
    card.root.set_valign(Gtk.Align.FILL);
    card.root.set_overflow(Gtk.Overflow.HIDDEN);
    card.root.set_can_target(!this.editing);
    card.root.set_parent(this.area);
    const handles = {} as Record<Edge, any>;
    for (const edge of ["x", "y", "xy"] as const) {
      const h = new Gtk.Box({
        accessible_role: edge === "xy" ? Gtk.AccessibleRole.BUTTON : Gtk.AccessibleRole.SEPARATOR,
        focusable: true,
        tooltip_text: tw(LABELS[edge]),
        visible: false,
        css_classes: ["wl-handle", `wl-${edge}`],
      });
      h.set_cursor_from_name(CURSORS[edge]);
      try {
        h.update_property([Gtk.AccessibleProperty.LABEL], [tw(LABELS[edge])]);
      } catch {}
      const keys = new Gtk.EventControllerKey();
      bag.on(keys, "key-pressed", (_k: unknown, keyval: number, _code: number, state: number) => this.onKey(w.id, edge, keyval, state));
      h.add_controller(keys);
      const focus = new Gtk.EventControllerFocus();
      bag.on(focus, "leave", () => this.finishKeys());
      h.add_controller(focus);
      h.set_parent(this.area);
      handles[edge] = h;
    }
    return { id: w.id, card, handles, bag };
  }

  private drop(e: Entry): void {
    e.bag.dispose();
    e.card.dispose();
    e.card.root.unparent();
    for (const h of Object.values(e.handles)) h.unparent();
    this.told.delete(e.id);
  }

  private cards(): AreaCard[] {
    return this.entries.map((e) => ({ id: e.card.w.id, size: e.card.w.size ?? "1x1", ...(e.card.w.frame ? { frame: e.card.w.frame } : {}) }));
  }

  /** The frames as drawn: the live ones while an edge moves, else the stored ones (or the defaults). */
  private frames(): Frame[] {
    return this.live ?? resolveFrames(this.cards(), this.W);
  }

  // Layout (called by AreaLayout)

  heightFor(forSize: number): number {
    const W = forSize > 0 ? forSize : this.W;
    if (W <= 0 || !this.entries.length) return 0;
    return arrange(this.live ?? resolveFrames(this.cards(), W), W, this.align, (i, width) => this.natural(i, width)).height;
  }

  private natural(i: number, width: number): number {
    const root = this.entries[i]?.card.root;
    return root ? root.measure(Gtk.Orientation.VERTICAL, width)[1] : 0;
  }

  allocate(width: number, height: number): void {
    this.W = width;
    const r = arrange(this.frames(), width, this.align, (i, wd) => this.natural(i, wd));
    this.boxes = r.boxes;
    this.free = r.free;
    const handlesOn = this.editing && r.free;
    this.entries.forEach((e, i) => {
      const target = r.boxes[i]!;
      const from = this.tweenFrom?.get(e.id);
      const b = from && this.tweenK < 1 ? tween(from, target, this.tweenK) : target;
      const root = e.card.root;
      // A child is measured before it is allocated (GTK asks); a card taller than its box is clipped by its own overflow.
      root.measure(Gtk.Orientation.HORIZONTAL, -1);
      root.measure(Gtk.Orientation.VERTICAL, b.width);
      root.size_allocate(new Gdk.Rectangle({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(1, Math.round(b.width)), height: Math.max(1, Math.round(b.height)) }), -1);
      const rects = handleRects(target);
      for (const edge of ["x", "y", "xy"] as const) {
        const h = e.handles[edge];
        if (!handlesOn || !h.get_visible()) continue;
        const q = rects[edge];
        h.measure(Gtk.Orientation.HORIZONTAL, -1);
        h.measure(Gtk.Orientation.VERTICAL, -1);
        h.size_allocate(new Gdk.Rectangle({ x: Math.round(q.x), y: Math.round(q.y), width: Math.max(1, Math.round(q.width)), height: Math.max(1, Math.round(q.height)) }), -1);
      }
    });
    this.guide.measure(Gtk.Orientation.HORIZONTAL, -1);
    this.guide.measure(Gtk.Orientation.VERTICAL, -1);
    this.guide.size_allocate(new Gdk.Rectangle({ x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }), -1);
    this.settleSoon();
  }

  /**
   * After an allocation, outside it: each card hears its box (its size class and rows per page
   * follow), the handles show or hide, the readouts are written. Only what changed is told.
   */
  private settleSoon(): void {
    if (this.settlePending || this.disposed) return;
    this.settlePending = this.bag.idle(() => {
      this.settlePending = 0;
      const handlesOn = this.editing && this.free;
      let shown = false;
      this.entries.forEach((e, i) => {
        const b = this.boxes[i];
        if (!b) return;
        for (const h of Object.values(e.handles)) {
          if (h.get_visible() !== handlesOn) {
            h.set_visible(handlesOn);
            shown = true;
          }
        }
        const key = this.free ? `${Math.round(b.width)}x${Math.round(b.height)}` : "column";
        if (this.told.get(e.id) === key) return;
        this.told.set(e.id, key);
        // A drag or a tween tells the cards at its end.
        if (this.live || this.tweenK < 1) {
          this.told.delete(e.id);
          return;
        }
        e.card.setBox(this.free ? { width: b.width, height: b.height } : null);
        e.card.setReadout(this.editing && this.free ? readoutOf(b) : null);
      });
      if (shown) this.area.queue_allocate();
    });
  }

  /** The readouts while an edge moves (the boxes of the frames being drawn). */
  private showReadouts(frames: Frame[]): void {
    const r = arrange(frames, this.W, this.align, () => 0);
    this.entries.forEach((e, i) => e.card.setReadout(readoutOf(r.boxes[i]!)));
  }

  // Writes: drawn at once, saved, put back with a message when the save fails; the last one can be undone.

  private run(write: LayoutWrite, undo: LayoutWrite, animate: boolean, undoing = false): void {
    if (animate) this.startTween();
    this.host.apply(write);
    this.setError(null);
    this.clearUndo();
    if (!undoing) this.undoable = { undo, redo: write, timer: this.bag.timeout(UNDO_MS, () => this.clearUndo(true)) };
    this.renderToolbar();
    const space = this.space;
    void this.host.save(write).then((ok) => {
      if (ok || this.disposed || space !== this.space) return;
      this.startTween();
      this.host.apply(undo);
      this.clearUndo();
      this.setError(tw("layout.saveFailed"));
    });
  }

  private commit(before: Frame[], after: Frame[], animate: boolean): void {
    const r = framesWrite(this.cards(), before, after);
    if (r) this.run(r.write, r.undo, animate);
    else this.told.clear();
  }

  private op(op: ToolbarOp): void {
    this.confirmReset = false;
    const r = toolbarWrite(op, this.cards(), this.frames(), this.W, this.align);
    if (r) this.run(r.write, r.undo, true);
    else this.renderToolbar();
  }

  private undo(): void {
    const u = this.undoable;
    if (!u) return;
    this.run(u.undo, u.redo, true, true);
  }

  private clearUndo(render = false): void {
    if (this.undoable) this.bag.cancel(this.undoable.timer);
    this.undoable = null;
    if (render) this.renderToolbar();
  }

  private setError(text: string | null): void {
    if (this.error) this.bag.cancel(this.error.timer);
    this.error = text ? { text, timer: this.bag.timeout(ERROR_MS, () => this.setError(null)) } : null;
    this.renderToolbar();
  }

  /** The cards move from where they are to where the write puts them (not under reduced motion). */
  private startTween(): void {
    if (!animationsOn() || !this.free) return;
    this.tweenFrom = new Map(this.entries.map((e, i) => [e.id, this.boxes[i]!]).filter(([, b]) => !!b) as [string, Box][]);
    this.tweenK = 0;
    let t0 = -1;
    this.bag.tick(this.area, (now) => {
      if (this.disposed) return false;
      if (t0 < 0) t0 = now;
      this.tweenK = Math.min(1, (now - t0) / TWEEN_MS);
      this.area.queue_allocate();
      if (this.tweenK < 1) return true;
      this.tweenFrom = null;
      this.told.clear();
      return false;
    });
  }

  // The keyboard: 8px a press, 1px with Shift; saved once the keys rest or the handle loses focus.

  private onKey(id: string, edge: Edge, keyval: number, state: number): boolean {
    const key = KEYS[keyval];
    if (!key || !this.editing || !this.free) return false;
    const { dx, dy } = keyStep(edge, key, !!(state & Gdk.ModifierType.SHIFT_MASK));
    if (!dx && !dy) return false;
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return false;
    if (this.keys && this.keys.i !== i) this.finishKeys();
    const k = this.keys ?? (this.keys = { base: this.frames(), f: this.frames(), i, timer: 0 });
    k.f = nudge(k.f, this.W, this.align, i, dx, dy);
    this.live = k.f;
    this.showReadouts(k.f);
    if (k.timer) this.bag.cancel(k.timer);
    k.timer = this.bag.timeout(KEYS_REST_MS, () => {
      if (this.keys) this.keys.timer = 0;
      this.finishKeys();
    });
    this.area.queue_resize();
    return true;
  }

  private finishKeys(): void {
    const k = this.keys;
    if (!k) return;
    if (k.timer) this.bag.cancel(k.timer);
    this.keys = null;
    this.live = null;
    this.commit(k.base, k.f, false);
    this.area.queue_resize();
  }

  // The toolbar

  private renderToolbar(): void {
    if (this.disposed) return;
    this.toolbarBag.dispose();
    this.toolbarBag = new Bag();
    const bar = this.toolbar;
    bar.clear();
    const on = this.editing && this.entries.length > 0;
    bar.box.set_visible(on);
    if (!on) return;
    try {
      bar.box.update_property([Gtk.AccessibleProperty.LABEL], [tw("layout.toolbar")]);
    } catch {}
    const button = (text: string, hint: string | undefined, run: () => void, classes: string[] = [], sensitive = true) => {
      const b = new Gtk.Button({ label: text, css_classes: classes, sensitive, ...(hint ? { tooltip_text: hint } : {}) });
      this.toolbarBag.on(b, "clicked", run);
      bar.append(b);
      return b;
    };
    // In one column the frames are kept and not applied: nothing to arrange.
    const free = this.free || this.W === 0;
    if (free) {
      button(tw("layout.align"), tw("layout.alignHint"), () => this.op("align"));
      const center = button(tw("layout.center"), tw("layout.centerHint"), () => this.op("center"), this.align === "center" ? ["suggested-action"] : []);
      try {
        center.update_state([Gtk.AccessibleState.PRESSED], [this.align === "center" ? Gtk.AccessibleTristate.TRUE : Gtk.AccessibleTristate.FALSE]);
      } catch {}
      button(tw("layout.split"), tw("layout.splitHint"), () => this.op("split"));
      if (this.confirmReset) {
        const ask = new Gtk.Box({ spacing: 6, css_classes: ["wl-confirm"] });
        ask.append(new Gtk.Label({ label: tw("layout.resetAsk"), wrap: true, xalign: 0 }));
        const cancel = new Gtk.Button({ label: tw("common.cancel") });
        this.toolbarBag.on(cancel, "clicked", () => {
          this.confirmReset = false;
          this.renderToolbar();
        });
        const reset = new Gtk.Button({ label: tw("layout.reset"), css_classes: ["destructive-action"] });
        this.toolbarBag.on(reset, "clicked", () => this.op("reset"));
        ask.append(cancel);
        ask.append(reset);
        bar.append(ask);
        this.toolbarBag.idle(() => reset.grab_focus());
      } else
        button(tw("layout.reset"), tw("layout.resetHint"), () => {
          this.confirmReset = true;
          this.renderToolbar();
        }, [], canReset(this.cards()));
      if (this.undoable) button(`↶ ${tw("layout.undo")}`, undefined, () => this.undo());
    }
    button(tw("screens.done"), undefined, () => this.host.leave(), ["suggested-action"]);
    if (this.error) bar.append(new Gtk.Label({ label: this.error.text, wrap: true, xalign: 0, valign: Gtk.Align.CENTER, accessible_role: Gtk.AccessibleRole.ALERT, css_classes: ["error", "caption"] }));
  }
}

const DEAD: AreaHost = {
  open: () => {},
  post: async () => ({ ok: false, error: "gone" }),
  replace: () => {},
  embed: () => new Gtk.Box(),
  releaseEmbed: () => {},
  decorate: () => {},
  apply: () => {},
  save: async () => false,
  leave: () => {},
};
