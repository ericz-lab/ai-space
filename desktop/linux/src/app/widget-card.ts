import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import type { BlockAction, CardAction } from "../../../../src/space/panel/blocks.ts";
import { type Widget, pickText } from "../core/catalogue.ts";
import { signature } from "../core/change.ts";
import { relativeTime } from "../core/format.ts";
import { resolveUrl } from "../core/url.ts";
import { sizeClass } from "../core/widget-area.ts";
import {
  COPIED_MS,
  type CardMode,
  type Change,
  type Controls,
  ENTER_MS,
  FLASH_MS,
  type WidgetAnswer,
  blockAction,
  blocksOf,
  cardActions,
  chosenView,
  clampPage,
  confirmOf,
  controlsOf,
  countUp,
  easeOut,
  flashMarks,
  hasControl,
  inputValue,
  messageMs,
  nearestIndex,
  pagesOf,
  readout,
  rowsPerPage,
  stepPage,
  viewsOf,
} from "../core/widget-interact.ts";
import { type Tone, type WidgetBlock, cardBody, deltaText, embedHeight, embedPath, fraction, gaugeSegments, isOutdated, itemsFor, position, shown, spark, tankLevel, tankValue, toneOf, txt } from "../core/widgets.ts";
import { lang, logError, prefs, savePrefs, t, tw } from "./env.ts";
import { iconWidget } from "./icons.ts";
import type { Space } from "./model.ts";
import { animationsOn } from "./pet.ts";
import { createWebView } from "./web.ts";

/**
 * A widget as a card, drawn as the panel draws it (docs/panel.md#widgets) and the Mac does: the
 * head links to the widget's page; a block card leads with its first block (label, big value,
 * change, chart or bar) and lists the next ones as rows, paged with dots when they do not fit; a
 * list card shows its items with their age; an `embed` widget shows the app's own page in a web
 * view of the Space's session, as the panel's iframe does. Colour inside a card is data, nothing else.
 *
 * A card is touched as the panel's is (docs/app-spec.md#views-copy-and-actions; the rules in
 * core/widget-interact.ts): views, copy, a local card's actions with an in-card confirmation, the
 * trend readout under the pointer, a refresh from its as-of time, a flash where a value changed.
 *
 * Memory (docs/linux-desktop.md#memory): a card is a tree whose handlers reach back into it, so
 * every handler, timer and tick it adds goes through a `Bag`, and `dispose()` (or the next drawing
 * of the part) disconnects them all; drawing functions read plain state objects, never a widget.
 */

/** Signal handlers, timers and tick callbacks of one part of a card, let go of at once. */
export class Bag {
  private conns: [any, number][] = [];
  private timers = new Set<number>();
  private ticks: [any, number][] = [];

  on(obj: any, signal: string, fn: (...args: any[]) => unknown): void {
    this.conns.push([obj, obj.connect(signal, fn)]);
  }

  timeout(ms: number, fn: () => void): number {
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
      this.timers.delete(id);
      fn();
      return GLib.SOURCE_REMOVE;
    });
    this.timers.add(id);
    return id;
  }

  idle(fn: () => void): number {
    const id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this.timers.delete(id);
      fn();
      return GLib.SOURCE_REMOVE;
    });
    this.timers.add(id);
    return id;
  }

  cancel(id: number): void {
    if (!this.timers.delete(id)) return;
    GLib.source_remove(id);
  }

  /** A tick callback on `widget` until `fn` returns false. */
  tick(widget: any, fn: (now: number) => boolean): void {
    const entry: [any, number] = [widget, 0];
    entry[1] = widget.add_tick_callback((_w: unknown, clock: any) => {
      if (fn(clock.get_frame_time() / 1000)) return GLib.SOURCE_CONTINUE;
      this.ticks = this.ticks.filter((x) => x !== entry);
      return GLib.SOURCE_REMOVE;
    });
    this.ticks.push(entry);
  }

  dispose(): void {
    for (const [obj, id] of this.conns) {
      try {
        obj.disconnect(id);
      } catch {}
    }
    this.conns = [];
    for (const id of this.timers) GLib.source_remove(id);
    this.timers.clear();
    for (const [w, id] of this.ticks) {
      try {
        w.remove_tick_callback(id);
      } catch {}
    }
    this.ticks = [];
  }
}

type RGBA = [number, number, number, number];

const TONES: Record<Tone, RGBA> = { positive: [0.18, 0.64, 0.38, 1], negative: [0.88, 0.11, 0.14, 1], warning: [0.9, 0.6, 0.04, 1], neutral: [0.5, 0.5, 0.5, 1] };

/** The widget's text colour and the desktop's accent, for drawing with cairo. */
export function colors(w: any): { fg: RGBA; accent: RGBA } {
  const c = w.get_color?.();
  const fg: RGBA = c ? [c.red, c.green, c.blue, c.alpha] : [0.2, 0.2, 0.2, 1];
  let accent: RGBA = [0.21, 0.52, 0.89, 1];
  try {
    const [ok, a] = w.get_style_context().lookup_color("accent_bg_color");
    if (ok) accent = [a.red, a.green, a.blue, 1];
  } catch {}
  return { fg, accent };
}

const alpha = (c: RGBA, a: number): RGBA => [c[0], c[1], c[2], c[3] * a];

function roundRect(cr: any, x: number, y: number, w: number, h: number, r: number): void {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  cr.newSubPath();
  cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
  cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
  cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
  cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
  cr.closePath();
}

/** How far a drawing's entrance has come, 0…1; 1 when it does not move. Read by the drawing, set by the card's tick. */
type Motion = { k: number };

function drawing(height: number, draw: (cr: any, width: number, height: number, area: any) => void, width?: number): any {
  const area = width ? new Gtk.DrawingArea({ content_height: height, content_width: width, hexpand: false, halign: Gtk.Align.START, valign: Gtk.Align.CENTER }) : new Gtk.DrawingArea({ content_height: height, hexpand: true });
  area.set_draw_func((a: any, cr: any, w: number, h: number) => {
    draw(cr, w, h, a);
    cr.$dispose?.();
  });
  return area;
}

/** What one drawing of the card's body is made of: its drawings to move in, its counted numbers. */
type Part = { draws: any[]; counts: { label: any; target: number; text: (v: number) => string }[]; motion: Motion };
const newPart = (animate: boolean): Part => ({ draws: [], counts: [], motion: { k: animate ? 0 : 1 } });

/**
 * A trend as a line (an area under each unbroken run) or bars, the latest at full strength. With
 * `hover`, the point under the pointer: its bar at full strength, or a rule and a dot over the line.
 */
function sparkArea(b: Extract<WidgetBlock, { type: "trend" }>, height: number, motion: Motion, hover: { i: number }): any {
  const s = spark(b);
  if (!s) {
    const l = new Gtk.Label({ label: t("widgetNoHistory"), xalign: 0 });
    l.add_css_class("dim-label");
    l.add_css_class("caption");
    return l;
  }
  const n = Math.max(b.points.length, 2);
  return drawing(height, (cr, w, h, area) => {
    const { fg, accent } = colors(area);
    const grow = easeOut(motion.k);
    if (s.kind === "line") {
      for (const run of s.runs) {
        if (run.length > 1) {
          cr.setSourceRGBA(...alpha(accent, 0.14 * grow));
          cr.moveTo(run[0]!.x * w, h);
          for (const p of run) cr.lineTo(p.x * w, p.y * (h - 2) + 1);
          cr.lineTo(run[run.length - 1]!.x * w, h);
          cr.closePath();
          cr.fill();
        }
        cr.setSourceRGBA(...alpha(accent, grow));
        cr.setLineWidth(2);
        cr.setLineJoin(1);
        cr.setLineCap(1);
        run.forEach((p, i) => (i ? cr.lineTo(p.x * w, p.y * (h - 2) + 1) : cr.moveTo(p.x * w, p.y * (h - 2) + 1)));
        if (run.length === 1) cr.arc(run[0]!.x * w, run[0]!.y * (h - 2) + 1, 1.5, 0, 2 * Math.PI);
        cr.stroke();
      }
      if (hover.i >= 0) {
        const x = ((hover.i + 0.5) / n) * w;
        cr.setSourceRGBA(...alpha(fg, 0.3));
        cr.setLineWidth(1);
        cr.moveTo(Math.round(x) + 0.5, 0);
        cr.lineTo(Math.round(x) + 0.5, h);
        cr.stroke();
        const p = s.runs.flat().find((q) => Math.round(q.x * n - 0.5) === hover.i);
        if (p) {
          cr.setSourceRGBA(...accent);
          cr.arc(x, p.y * (h - 2) + 1, 3.5, 0, 2 * Math.PI);
          cr.fill();
        }
      }
      return;
    }
    for (const bar of s.bars) {
      const base = bar.negative ? TONES.negative : b.signed ? TONES.positive : accent;
      const index = Math.round((bar.x - 0.15 / n) * n);
      const strong = hover.i >= 0 ? index === hover.i : bar.latest;
      cr.setSourceRGBA(...alpha(base, strong ? 1 : 0.6));
      const bw = Math.max(bar.width * w, 1);
      // The entrance grows each bar from the zero line.
      const top = s.zero + (bar.top - s.zero) * grow;
      const bottom = s.zero + (bar.bottom - s.zero) * grow;
      roundRect(cr, bar.x * w, top * h, bw, Math.max((bottom - top) * h, 1), Math.min(bw * 0.17, 2));
      cr.fill();
    }
    cr.setSourceRGBA(...alpha(fg, 0.18));
    cr.setLineWidth(1);
    cr.moveTo(0, Math.round(s.zero * h) + 0.5);
    cr.lineTo(w, Math.round(s.zero * h) + 0.5);
    cr.stroke();
  });
}

function progressBar(b: Extract<WidgetBlock, { type: "progress" }>, motion: Motion): any {
  return drawing(6, (cr, w, h, area) => {
    const { fg, accent } = colors(area);
    cr.setSourceRGBA(...alpha(fg, 0.12));
    roundRect(cr, 0, 0, w, h, h / 2);
    cr.fill();
    const f = fraction(b) * easeOut(motion.k);
    if (f > 0) {
      cr.setSourceRGBA(...(b.tone && b.tone !== "neutral" ? TONES[b.tone] : accent));
      roundRect(cr, 0, 0, w * f, h, h / 2);
      cr.fill();
    }
  });
}

function gaugeScale(b: Extract<WidgetBlock, { type: "gauge" }>, motion: Motion): any {
  return drawing(14, (cr, w, h, area) => {
    const { fg } = colors(area);
    const y = (h - 6) / 2;
    cr.save();
    roundRect(cr, 0, y, w, 6, 3);
    cr.clip();
    const segments = gaugeSegments(b);
    if (segments.length)
      for (const s of segments) {
        cr.setSourceRGBA(...alpha(TONES[s.tone], 0.85));
        cr.rectangle(s.start * w, y, Math.max((s.end - s.start) * w, 0), 6);
        cr.fill();
      }
    else {
      cr.setSourceRGBA(...alpha(fg, 0.12));
      cr.rectangle(0, y, w, 6);
      cr.fill();
    }
    cr.restore();
    if (b.value !== null) {
      // The marker slides in from the scale's start.
      const x = Math.max(6, Math.min(w - 6, position(b, b.value) * w * easeOut(motion.k)));
      cr.setSourceRGBA(1, 1, 1, 1);
      cr.arc(x, h / 2, 6.5, 0, 2 * Math.PI);
      cr.fill();
      cr.setSourceRGBA(...fg);
      cr.arc(x, h / 2, 5, 0, 2 * Math.PI);
      cr.fill();
    }
  });
}

/** One cylinder filled to value / max in its tone (the accent without one), spilling over past max; drawn in a 64 x 84 box like the panel's. */
function tankShape(k: Extract<WidgetBlock, { type: "tanks" }>["tanks"][number], width: number, motion: Motion): any {
  const height = Math.round((width * 84) / 64);
  return drawing(height, (cr, w, h, area) => {
    const { fg, accent } = colors(area);
    const sx = w / 64, sy = h / 84;
    const l = 8, r = 56, top = 12, bottom = 72, rx = 24, ry = 6, cx = 32;
    const ellipse = (x: number, y: number, ex: number, ey: number) => {
      cr.save();
      cr.translate(x * sx, y * sy);
      cr.scale(ex * sx, ey * sy);
      cr.arc(0, 0, 1, 0, 2 * Math.PI);
      cr.restore();
    };
    const side = (x1: number, x2: number, y: number) => {
      cr.rectangle(x1 * sx, y * sy, (x2 - x1) * sx, (bottom - y) * sy);
      ellipse((x1 + x2) / 2, bottom, (x2 - x1) / 2, ry);
    };
    const color = k.tone && k.tone !== "neutral" ? TONES[k.tone] : accent;
    const level = tankLevel(k) * easeOut(motion.k);
    cr.setSourceRGBA(...alpha(fg, 0.14));
    ellipse(cx, bottom + ry + 3, rx + 4, 3);
    cr.fill();
    cr.setSourceRGBA(...alpha(fg, 0.09));
    side(l, r, top);
    cr.fill();
    if (k.value !== null && level > 0.002) {
      const y = bottom - Math.min(1, level) * (bottom - top);
      cr.setSourceRGBA(...color);
      side(l + 1.5, r - 1.5, y);
      cr.fill();
      cr.save();
      cr.rectangle((cx + 8) * sx, 0, (r - cx - 8) * sx, h);
      cr.clip();
      cr.setSourceRGBA(0, 0, 0, 0.14);
      side(l + 1.5, r - 1.5, y);
      cr.fill();
      cr.restore();
      cr.setSourceRGBA(...color);
      ellipse(cx, y, rx - 1.5, ry - 0.8);
      cr.fill();
      cr.setSourceRGBA(1, 1, 1, 0.28);
      ellipse(cx, y, rx - 1.5, ry - 0.8);
      cr.fill();
    }
    cr.setSourceRGBA(1, 1, 1, 0.22);
    cr.rectangle((l + 5) * sx, (top + 4) * sy, 3 * sx, (bottom - top - 5) * sy);
    cr.fill();
    cr.setSourceRGBA(...alpha(fg, 0.07));
    ellipse(cx, top, rx, ry);
    cr.fill();
    cr.setSourceRGBA(...alpha(fg, 0.32));
    cr.setLineWidth(1.2);
    ellipse(cx, top, rx, ry);
    cr.stroke();
    if (level > 1) {
      cr.setSourceRGBA(...color);
      ellipse(cx - 6, top, 7, 3.5);
      cr.fill();
      roundRect(cr, (cx - 9) * sx, top * sy, 6 * sx, 20 * sy, 3 * sx);
      cr.fill();
    }
  }, width);
}

function dot(tone: Tone | undefined, size: number): any {
  return drawing(size, (cr, w, h, area) => {
    cr.setSourceRGBA(...(tone ? TONES[tone] : alpha(colors(area).fg, 0.45)));
    cr.arc(w / 2, h / 2, size / 2, 0, 2 * Math.PI);
    cr.fill();
  }, size);
}

function toneClass(label: any, tone: Tone | undefined): void {
  if (tone && tone !== "neutral") label.add_css_class(`tone-${tone}`);
}

function label(text: string, classes: string[], opts: Record<string, unknown> = {}): any {
  const l = new Gtk.Label({ label: text, xalign: 0, ellipsize: 3, max_width_chars: 28, ...opts });
  for (const c of classes) l.add_css_class(c);
  return l;
}

function accessibleLabel(w: any, text: string): void {
  try {
    w.update_property([Gtk.AccessibleProperty.LABEL], [text]);
  } catch {}
}

/** What the card tells the drawing of its body: who may do what, and what to call. */
type Ctx = {
  c: Controls;
  busy: string | null;
  ticked: ReadonlySet<string>;
  /** Where the blocks' handlers go: the body's bag, let go of when it is drawn again. */
  bag: Bag;
  part: Part;
  act: (a: BlockAction) => void;
  open: (link: string) => void;
  flash: (label: any, i: number) => void;
};

/** The round check in place of a status dot; ticked while its action is on the way. */
function checkButton(a: BlockAction, ctx: Ctx): any {
  const on = ctx.ticked.has(a.id);
  const name = txt(a.label, lang);
  const b = new Gtk.Button({ accessible_role: Gtk.AccessibleRole.CHECKBOX, tooltip_text: name, valign: Gtk.Align.CENTER, css_classes: ["wb-check", "wb-ctl", ...(on ? ["on"] : [])] });
  if (on) b.set_child(new Gtk.Image({ icon_name: "object-select-symbolic", pixel_size: 12 }));
  accessibleLabel(b, name);
  try {
    b.update_state([Gtk.AccessibleState.CHECKED], [on ? Gtk.AccessibleTristate.TRUE : Gtk.AccessibleTristate.FALSE]);
  } catch {}
  b.set_sensitive(ctx.c.actLive && (ctx.busy === null || on));
  ctx.bag.on(b, "clicked", () => !on && ctx.act(a));
  return b;
}

/** The copy control: copies the block's text and says so in place for 1.5 s; it never opens the block's link. */
function copyButton(text: string, ctx: Ctx): any {
  const b = new Gtk.Button({ icon_name: "edit-copy-symbolic", tooltip_text: tw("widget.copy"), valign: Gtk.Align.CENTER, css_classes: ["flat", "circular", "wb-copy", "wb-ctl"] });
  accessibleLabel(b, tw("widget.copy"));
  b.set_sensitive(ctx.c.live);
  ctx.bag.on(b, "clicked", (button: any) => {
    try {
      button.get_clipboard().set(text);
    } catch (e) {
      logError(e, "copy");
      return;
    }
    button.set_icon_name("object-select-symbolic");
    button.set_tooltip_text(tw("widget.copied"));
    accessibleLabel(button, tw("widget.copied"));
    ctx.bag.timeout(COPIED_MS, () => {
      button.set_icon_name("edit-copy-symbolic");
      button.set_tooltip_text(tw("widget.copy"));
      accessibleLabel(button, tw("widget.copy"));
    });
  });
  return b;
}

/** The trailing controls of a block: copy, then a block button. */
function controls(b: WidgetBlock, ctx: Ctx): any | undefined {
  const a = blockAction(b, ctx.c);
  const button = a?.kind === "button" ? a : undefined;
  if (!b.copy && !button) return undefined;
  const box = new Gtk.Box({ spacing: 4, valign: Gtk.Align.CENTER });
  if (b.copy) box.append(copyButton(b.copy, ctx));
  if (button) {
    const p = new Gtk.Button({ label: txt(button.label, lang), valign: Gtk.Align.CENTER, css_classes: ["pill", "wb-btn", "wb-ctl"] });
    p.set_sensitive(ctx.c.actLive && ctx.busy === null);
    ctx.bag.on(p, "clicked", () => ctx.act(button));
    box.append(p);
  }
  return box;
}

/** Up to three tanks side by side, each with its name and a short value (WidgetBlocks.tsx `Tanks`). */
function tanksRow(b: Extract<WidgetBlock, { type: "tanks" }>, small: boolean, motion: Motion, part: Part): any {
  const box = new Gtk.Box({ spacing: small ? 10 : 8, homogeneous: true });
  for (const k of b.tanks) {
    const value = tankValue(k, lang);
    const v = label(value ?? t("widgetNoData"), small ? ["caption", "numeric"] : ["wb-row-value", "numeric"], { xalign: small ? 0 : 0.5, max_width_chars: 12 });
    if (value === undefined) v.add_css_class("dim-label");
    const name = label(txt(k.label, lang), ["caption", "dim-label"], { xalign: small ? 0 : 0.5, max_width_chars: 14 });
    const shape = tankShape(k, small ? 22 : 48, motion);
    part.draws.push(shape);
    if (small) {
      const cell = new Gtk.Box({ spacing: 6 });
      cell.append(shape);
      const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
      text.append(name);
      text.append(v);
      cell.append(text);
      box.append(cell);
    } else {
      const cell = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, halign: Gtk.Align.CENTER });
      shape.set_halign(Gtk.Align.CENTER);
      cell.append(shape);
      cell.append(name);
      cell.append(v);
      box.append(cell);
    }
  }
  return box;
}

/**
 * A trend's drawing with the readout: the pointer over it shows the nearest point's value and date
 * in place of the latest (`value`, `caption`), leaving puts them back.
 */
function readableSpark(b: Extract<WidgetBlock, { type: "trend" }>, height: number, ctx: Ctx, value: any, caption: any | undefined, latest: { value: string; caption: string }): any {
  const hover = { i: -1 };
  const area = sparkArea(b, height, ctx.part.motion, hover);
  if (!(area instanceof Gtk.DrawingArea)) return area;
  ctx.part.draws.push(area);
  if (!ctx.c.live) return area;
  const motion = new Gtk.EventControllerMotion();
  const show = (i: number) => {
    const r = i >= 0 ? readout(b, i, lang) : undefined;
    value.set_label(r ? (r.value ?? t("widgetNoData")) : latest.value);
    if (caption) {
      caption.set_label(r ? r.date : latest.caption);
      caption.set_visible(!!(r ? r.date : latest.caption));
    }
  };
  ctx.bag.on(motion, "motion", (c: any, x: number) => {
    const i = nearestIndex(x, c.get_widget().get_width(), b.points.length);
    if (i === hover.i) return;
    hover.i = i;
    c.get_widget().queue_draw();
    show(i);
  });
  ctx.bag.on(motion, "leave", (c: any) => {
    hover.i = -1;
    c.get_widget().queue_draw();
    show(-1);
  });
  area.add_controller(motion);
  return area;
}

/** The first block, drawn large. */
function hero(b: WidgetBlock, ctx: Ctx): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  const top = new Gtk.Box({ spacing: 6 });
  const check = blockAction(b, ctx.c)?.kind === "check" ? blockAction(b, ctx.c) : undefined;
  if (check && b.type !== "status") top.append(checkButton(check, ctx));
  top.append(label(txt(b.label, lang), ["caption", "dim-label"], { hexpand: true }));
  const ctl = controls(b, ctx);
  if (ctl) top.append(ctl);
  box.append(top);
  const value = shown(b, lang);
  const tone = toneOf(b);
  const captionText = txt(b.caption, lang);
  let valueLabel: any;
  if (b.type === "status") {
    const line = new Gtk.Box({ spacing: 8 });
    line.append(check ? checkButton(check, ctx) : dot(tone, 10));
    valueLabel = label(value ?? "", ["wb-status"], { wrap: true, lines: 2, hexpand: true });
    if (check && ctx.ticked.has(check.id)) valueLabel.add_css_class("wb-done");
    line.append(valueLabel);
    box.append(line);
    if (b.time) box.append(label(relativeTime(b.time, lang), ["caption", "dim-label", "numeric"]));
  } else if (b.type === "tanks") {
    box.append(tanksRow(b, false, ctx.part.motion, ctx.part));
  } else {
    const line = new Gtk.Box({ spacing: 8 });
    valueLabel = label(value ?? t("widgetNoData"), ["wb-hero"]);
    if (value === undefined) valueLabel.add_css_class("dim-label");
    else if (b.type === "gauge") toneClass(valueLabel, tone);
    line.append(valueLabel);
    // A metric's number counts up on its entrance.
    if (b.type === "metric" && !b.display && b.value !== null && ctx.part.motion.k < 1) {
      const target = b.value;
      ctx.part.counts.push({ label: valueLabel, target, text: (v) => shown({ ...b, value: v }, lang) ?? "" });
      valueLabel.set_label(shown({ ...b, value: countUp(target, 0) }, lang) ?? "");
    }
    const d = deltaText(b, lang, true);
    if (d) {
      const dl = label(d.text, ["caption", "wb-delta"], { valign: Gtk.Align.BASELINE_FILL });
      if (d.tone) toneClass(dl, d.tone);
      else dl.add_css_class("dim-label");
      line.append(dl);
    }
    box.append(line);
  }
  if (valueLabel) ctx.flash(valueLabel, 0);
  const caption = b.type === "trend" || captionText ? label(captionText, ["caption", "dim-label"], { wrap: true, lines: 2, visible: !!captionText }) : undefined;
  if (b.type === "trend") box.append(readableSpark(b, 48, ctx, valueLabel, caption, { value: value ?? t("widgetNoData"), caption: captionText }));
  else if (b.type === "progress") box.append(ctx.part.draws[ctx.part.draws.push(progressBar(b, ctx.part.motion)) - 1]);
  else if (b.type === "gauge") box.append(ctx.part.draws[ctx.part.draws.push(gaugeScale(b, ctx.part.motion)) - 1]);
  if (caption) box.append(caption);
  return box;
}

/** A block after the first: label left, value right, its drawing below. */
function row(b: WidgetBlock, index: number, ctx: Ctx): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 5 });
  const line = new Gtk.Box({ spacing: 6 });
  const tone = toneOf(b);
  const check = blockAction(b, ctx.c)?.kind === "check" ? blockAction(b, ctx.c) : undefined;
  if (check) line.append(checkButton(check, ctx));
  else if (b.type === "status") line.append(dot(tone, 7));
  const name = label(txt(b.label, lang), ["wb-row-label"], { hexpand: true });
  if (check && ctx.ticked.has(check.id)) name.add_css_class("wb-done");
  line.append(name);
  if (b.type === "tanks") {
    const ctl = controls(b, ctx);
    if (ctl) line.append(ctl);
    box.append(line);
    box.append(tanksRow(b, true, ctx.part.motion, ctx.part));
    return box;
  }
  const value = shown(b, lang);
  const v = label(value ?? t("widgetNoData"), ["wb-row-value", "numeric"], { max_width_chars: 22, xalign: 1 });
  if (value === undefined) v.add_css_class("dim-label");
  else if (b.type === "gauge" || b.type === "metric") toneClass(v, tone);
  ctx.flash(v, index);
  line.append(v);
  const d = deltaText(b, lang, false);
  if (d) {
    const dl = label(d.text, ["caption", "wb-delta"], { ellipsize: 0 });
    if (d.tone) toneClass(dl, d.tone);
    else dl.add_css_class("dim-label");
    line.append(dl);
  }
  if (b.type === "status" && b.time) line.append(label(relativeTime(b.time, lang), ["caption", "dim-label"], { ellipsize: 0 }));
  const date = b.type === "trend" ? label("", ["caption", "dim-label", "numeric"], { ellipsize: 0, visible: false }) : undefined;
  if (date) line.append(date);
  const ctl = controls(b, ctx);
  if (ctl) line.append(ctl);
  box.append(line);
  if (b.type === "trend") box.append(readableSpark(b, 22, ctx, v, date, { value: value ?? t("widgetNoData"), caption: "" }));
  else if (b.type === "progress") box.append(ctx.part.draws[ctx.part.draws.push(progressBar(b, ctx.part.motion)) - 1]);
  else if (b.type === "gauge") box.append(ctx.part.draws[ctx.part.draws.push(gaugeScale(b, ctx.part.motion)) - 1]);
  return box;
}

/** A part of the card that opens a link when it has one. */
function linked(child: any, link: string | undefined, ctx: Ctx, own: boolean): any {
  if (!link) return child;
  if (own) {
    // A block with controls of its own is not a button (a button inside one would open the link
    // too): a click on the block opens it, a click on a control does not.
    const click = new Gtk.GestureClick({ button: 1 });
    ctx.bag.on(click, "released", (g: any, _n: number, x: number, y: number) => {
      const box = g.get_widget();
      const hit = box.pick(x, y, Gtk.PickFlags.DEFAULT);
      const button = hit?.get_ancestor(Gtk.Button.$gtype);
      if (button && button !== box && button.is_ancestor(box)) return;
      if (ctx.c.live) ctx.open(link);
    });
    child.add_controller(click);
    child.add_css_class("wb-linked");
    return child;
  }
  child.set_hexpand(true);
  child.set_halign(Gtk.Align.FILL);
  const b = new Gtk.Button({ child, halign: Gtk.Align.FILL, css_classes: ["flat", "wb-link"] });
  ctx.bag.on(b, "clicked", () => ctx.open(link));
  return b;
}

/** What a card needs from the page that shows it. */
export type CardHost = {
  /** The widget's own page, or one of its links (a row, a block). */
  open: (widget: Widget, link?: string) => void;
  /** An action or a refresh (POST /api/widgets/:app/:name/action|refresh): the Space's answer. */
  post: (widget: Widget, what: "action" | "refresh", body?: { action: string; value?: string }) => Promise<WidgetAnswer>;
  /** The fresh card an action or a refresh answered: put in place of this one. */
  replace: (widget: Widget) => void;
  /** The Space has the action and refresh routes (it keeps frames; an older one has neither). */
  writes: boolean;
  /** The web view of an `embed` card, and its end when the card no longer shows it. */
  embed: (widget: Widget) => any;
  releaseEmbed?: (view: any) => void;
  /** Called once with the card's root (a right-click menu). */
  decorate?: (root: any, widgetId: string) => void;
};

/** The card's padding (style.ts `.widget-card`), its children's spacing, and the body's: the stepless area's rows per page count them. */
const PADDING_Y = 8 + 14;
const SPACING = 8;
const BODY_SPACING = 10;
const ROWS_SPACING = 10;
const PAGER_H = 26;

/**
 * One widget card that stays while its screen shows the widget: a new payload, a view, a page, an
 * action draws its parts again in place, and an unchanged payload draws nothing (`signature`).
 */
export class LiveCard {
  readonly root: any;
  w: Widget;
  private sig = "";
  private mode: CardMode;
  /** The size class the inner layout follows: the drawn box's in the stepless area, else the stored size. */
  private size: string;
  /** The box the stepless area gives the card; null elsewhere and in one column (sized by its content). */
  private box: { width: number; height: number } | null = null;
  /** Rows per page measured in the box; null until measured. */
  private per: number | null = null;
  private page = 0;
  private viewId: string | undefined;
  private ticked = new Set<string>();
  private busy: string | null = null;
  private refreshing = false;
  private draft = "";
  private msg: { kind: "error" | "info"; text: string } | null = null;
  private asking: { text: string; label: string; resolve: (ok: boolean) => void } | null = null;
  /** The blocks of the last payload, for the flash of the next one. */
  private prev: { view: string; blocks?: WidgetBlock[] } | undefined;
  private marks: (Change | undefined)[] | undefined;
  private readonly bag = new Bag();
  private part = new Bag();
  private msgTimer = 0;
  private view: any;
  private readout: any;
  private readoutText: string | null = null;
  private fitPending = 0;
  /** The children drawn now, for the measure of rows per page. */
  private parts: { head?: any; views?: any; hero?: any; rows: any[]; foot?: any; pager?: any } = { rows: [] };
  private disposed = false;

  constructor(
    private host: CardHost,
    readonly space: Space,
    w: Widget,
    mode: CardMode,
    /** The entrance plays when the card first appears (a screen's stepless area); a card drawn again with its page does not. */
    private readonly entrance = false,
  ) {
    this.w = w;
    this.mode = mode;
    this.size = w.size ?? "1x1";
    this.root = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: SPACING, valign: Gtk.Align.START, hexpand: true });
    this.root.add_css_class("card");
    this.root.add_css_class("widget-card");
    this.viewId = chosenView(prefs.widgetViews, w.id, viewsOf(w))?.id;
    host.decorate?.(this.root, w.id);
    this.update(w, true);
  }

  /**
   * A payload: drawn again only when it differs from the one shown. Its frame and size are the
   * layout's, not its content: a resize alone draws nothing again (the box decides the inner
   * layout), except a card sized by its stored size, whose rows follow that size.
   */
  update(w: Widget, first = false): void {
    const { frame: _frame, size: _size, ...content } = w;
    const sig = signature(content);
    if (!first && sig === this.sig) {
      const resized = !this.box && (w.size ?? "1x1") !== this.size;
      this.w = w;
      if (resized) {
        this.size = w.size ?? "1x1";
        this.render(false);
      }
      return;
    }
    const view = chosenView(prefs.widgetViews, w.id, viewsOf(w));
    const shownView = view?.id ?? "";
    const blocks = blocksOf(w, view);
    this.marks = first || !animationsOn() ? undefined : flashMarks(this.prev, shownView, blocks);
    this.prev = { view: shownView, blocks };
    this.sig = sig;
    this.w = w;
    this.viewId = view?.id;
    if (!this.box) this.size = w.size ?? "1x1";
    this.render(first && this.entrance);
  }

  setMode(mode: CardMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode !== "live") this.answer(false);
    // In Edit Layout nothing in the card responds; its handles are the area's.
    this.root.set_can_target(mode !== "edit");
    this.render(false);
  }

  /**
   * The card's box in the stepless area (null: one column, sized by its content). The inner layout
   * follows it: the size class with its hysteresis, the rows per page that fit.
   */
  setBox(box: { width: number; height: number } | null): void {
    if (this.disposed) return;
    const before = this.box;
    this.box = box;
    // The hysteresis holds a class the box gave; the first box is judged afresh, as the panel's.
    const size = box ? sizeClass(before ? this.size : undefined, box.width, box.height) : (this.w.size ?? "1x1");
    if (!box) {
      if (before || size !== this.size) {
        this.size = size;
        this.per = null;
        this.render(false);
      }
      return;
    }
    if (size !== this.size || !before) {
      this.size = size;
      this.render(false);
    } else if (!before || before.height !== box.height || before.width !== box.width) this.fitSoon();
  }

  /** The size in the head while the layout is edited, or none. */
  setReadout(text: string | null): void {
    this.readoutText = text;
    if (!this.readout) return;
    this.readout.set_visible(!!text);
    if (text) this.readout.set_label(text);
  }

  /** The ages ("5 min ago") move on. */
  tick(): void {
    if (!this.disposed) this.render(false);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.asking?.resolve(false);
    this.asking = null;
    this.part.dispose();
    this.bag.dispose();
    if (this.view) {
      this.view.get_parent()?.remove?.(this.view);
      this.host.releaseEmbed?.(this.view);
      this.view = undefined;
    }
    let child = this.root.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      this.root.remove(child);
      child = next;
    }
    this.parts = { rows: [] };
    this.readout = undefined;
    this.host = DEAD_HOST;
  }

  // Drawing

  private controls(): Controls {
    return controlsOf(this.w, this.mode);
  }

  /** Draws every part again; `animate`: the entrance plays (first appearance, a view or a page change). */
  private render(animate: boolean): void {
    if (this.disposed) return;
    // Where the focus was, so it comes back to the same control.
    const focus = this.focusKey();
    this.part.dispose();
    this.part = new Bag();
    if (this.view) this.view.get_parent()?.remove?.(this.view);
    let child = this.root.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      this.root.remove(child);
      child = next;
    }
    this.parts = { rows: [] };
    const w = this.w;
    const c = this.controls();
    this.root.set_opacity(w.stale ? 0.6 : 1);
    this.root.set_tooltip_text(w.stale && w.peer ? tw("widget.stale", { peer: w.peer }) : null);
    if (this.size === "2x1" || this.size === "2x2") this.root.add_css_class("wide");
    else this.root.remove_css_class("wide");
    this.root.append((this.parts.head = this.head(c)));
    const views = viewsOf(w);
    const view = views?.find((v) => v.id === this.viewId) ?? views?.[0];
    if (views && view) this.root.append((this.parts.views = this.viewsBar(views, view.id, c)));
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: BODY_SPACING, margin_start: 4, margin_end: 4, vexpand: !!this.box });
    const part = newPart(animate && animationsOn());
    const ctx: Ctx = {
      c,
      busy: this.busy,
      ticked: this.ticked,
      bag: this.part,
      part,
      act: (a) => void this.run(a),
      open: (link) => this.host.open(this.w, link),
      flash: (l, i) => this.flash(l, i),
    };
    switch (cardBody(w)) {
      case "error": {
        const line = new Gtk.Box({ spacing: 8 });
        line.append(new Gtk.Image({ icon_name: "dialog-warning-symbolic", css_classes: ["dim-label"] }));
        line.append(label(w.error || t("widgetDown"), ["dim-label"], { wrap: true, lines: 3 }));
        body.append(line);
        break;
      }
      case "embed":
        body.append(this.embed());
        break;
      case "blocks":
      case "items": {
        const blocks = blocksOf(w, view);
        if (blocks?.length) this.blocks(body, blocks, ctx);
        else if (w.items?.length) this.items(body, ctx);
        else body.append(label(t("widgetEmpty"), ["dim-label"]));
        if (!this.host.writes && blocks?.length && !w.stale && isOutdated(w.asOf, w.staleAfterMs) && w.asOf) body.append(label(t("widgetUpdated", { when: relativeTime(w.asOf, lang) }), ["caption", "dim-label"]));
        break;
      }
      case "empty":
        body.append(label(t("widgetEmpty"), ["dim-label"]));
    }
    if (w.stale) body.append(label(t("widgetStale"), ["caption", "dim-label"]));
    this.root.append(body);
    const foot = this.foot(c);
    if (foot) this.root.append((this.parts.foot = foot));
    this.enter(part);
    this.marks = undefined;
    this.restoreFocus(focus);
    if (this.box) this.fitSoon();
  }

  private head(c: Controls): any {
    const w = this.w;
    const box = new Gtk.Box({ spacing: 6 });
    const head = new Gtk.Box({ spacing: 10 });
    head.append(iconWidget(w.icon, 24, this.space.client, "view-grid-symbolic"));
    head.append(label(pickText(w.title, w.i18n, "title", lang), ["wb-title", "dim-label"], { hexpand: !w.peer }));
    if (w.peer) head.append(label(w.peer, ["caption", "dim-label"], { hexpand: true }));
    head.append(new Gtk.Image({ icon_name: "go-next-symbolic", pixel_size: 12, css_classes: ["dim-label"] }));
    const open = new Gtk.Button({ child: head, hexpand: true, css_classes: ["flat", "wb-head"], tooltip_text: t("open") });
    open.set_sensitive(this.mode !== "edit");
    this.part.on(open, "clicked", () => this.host.open(this.w));
    box.append(open);
    // The as-of time; on a local card of a Space with the route, it refreshes the card.
    const asOf = w.ok !== false && this.host.writes ? w.asOf : undefined;
    if (asOf) {
      const outdated = isOutdated(asOf, w.staleAfterMs);
      const when = outdated ? tw("widget.outdated", { time: relativeTime(asOf, lang) }) : relativeTime(asOf, lang);
      if (c.acts) {
        const inner = new Gtk.Box({ spacing: 4 });
        inner.append(new Gtk.Image({ icon_name: "view-refresh-symbolic", pixel_size: 12 }));
        inner.append(label(when, ["caption", "numeric"], { ellipsize: 0 }));
        const b = new Gtk.Button({ child: inner, valign: Gtk.Align.CENTER, css_classes: ["flat", "wb-asof", ...(outdated ? ["outdated"] : [])] });
        b.set_tooltip_text(`${new Date(asOf).toLocaleString()} · ${this.refreshing ? tw("widget.refreshing") : tw("widget.refresh")}`);
        accessibleLabel(b, `${when} · ${this.refreshing ? tw("widget.refreshing") : tw("widget.refresh")}`);
        b.set_sensitive(c.actLive && !this.refreshing);
        this.part.on(b, "clicked", () => void this.refresh());
        box.append(b);
      } else {
        const l = label(when, ["caption", "dim-label", "numeric", "wb-asof", ...(outdated ? ["outdated"] : [])], { ellipsize: 0, valign: Gtk.Align.CENTER, tooltip_text: new Date(asOf).toLocaleString() });
        box.append(l);
      }
    }
    this.readout = label(this.readoutText ?? "", ["caption", "numeric", "wb-readout"], { ellipsize: 0, valign: Gtk.Align.CENTER, visible: !!this.readoutText });
    box.append(this.readout);
    return box;
  }

  /** The views as a segmented control (linked toggles); Left and Right move between them. */
  private viewsBar(views: NonNullable<Widget["views"]>, current: string, c: Controls): any {
    const bar = new Gtk.Box({ halign: Gtk.Align.START, css_classes: ["linked", "wb-views"] });
    accessibleLabel(bar, tw("widget.views"));
    let group: any;
    for (const v of views) {
      const b = new Gtk.ToggleButton({ label: txt(v.label, lang), active: v.id === current, css_classes: ["wb-view"] });
      b.set_name(`view-${v.id}`);
      if (group) b.set_group(group);
      else group = b;
      b.set_sensitive(c.live);
      this.part.on(b, "toggled", (button: any) => button.get_active() && v.id !== this.viewId && this.choose(v.id));
      bar.append(b);
    }
    const keys = new Gtk.EventControllerKey();
    this.part.on(keys, "key-pressed", (_k: unknown, keyval: number) => {
      const by = keyval === KEY_LEFT ? -1 : keyval === KEY_RIGHT ? 1 : 0;
      if (!by || !this.controls().live) return false;
      const i = views.findIndex((v) => v.id === this.viewId);
      this.choose(views[(i + by + views.length) % views.length]!.id, true);
      return true;
    });
    bar.add_controller(keys);
    return bar;
  }

  private choose(id: string, focus = false): void {
    this.viewId = id;
    this.page = 0;
    prefs.widgetViews = { ...(prefs.widgetViews ?? {}), [this.w.id]: id };
    savePrefs();
    this.prev = { view: id, blocks: blocksOf(this.w, viewsOf(this.w)?.find((v) => v.id === id)) };
    this.render(true);
    if (focus) this.focusNamed(this.parts.views, `view-${id}`);
  }

  private blocks(body: any, blocks: WidgetBlock[], ctx: Ctx): void {
    const [first, ...rest] = blocks;
    const heroBox = hero(first!, ctx);
    body.append((this.parts.hero = linked(heroBox, first!.url, ctx, hasControl(first!, ctx.c))));
    if (!rest.length) return;
    const per = this.box && this.per !== null ? this.per : rowsPerPage(this.size);
    const pages = pagesOf(rest, per);
    this.page = clampPage(this.page, pages.length);
    const rowOf = (b: WidgetBlock, i: number) => {
      const r = linked(row(b, i + 1, ctx), b.url, ctx, hasControl(b, ctx.c));
      this.parts.rows.push(r);
      return r;
    };
    if (pages.length === 1) {
      const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: ROWS_SPACING });
      rest.forEach((b, i) => list.append(rowOf(b, i)));
      body.append(list);
      return;
    }
    // Every page is in one stack, the others hidden, so the card keeps the height of its tallest page.
    const stack = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT, transition_duration: 180, vhomogeneous: true, hhomogeneous: true });
    const pageParts: Part[] = [];
    pages.forEach((p, pi) => {
      const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: ROWS_SPACING, valign: Gtk.Align.START });
      // A page's own drawings, so a page change moves them in.
      const own = pi === this.page ? ctx.part : newPart(false);
      const pctx = { ...ctx, part: own };
      p.forEach((b, j) => {
        const r = linked(row(b, pi * per + j + 1, pctx), b.url, pctx, hasControl(b, ctx.c));
        this.parts.rows.push(r);
        list.append(r);
      });
      pageParts.push(own);
      stack.add_named(list, `p${pi}`);
    });
    stack.set_visible_child_name(`p${this.page}`);
    body.append(stack);
    body.append((this.parts.pager = this.pager(stack, pages.length, pageParts, ctx.c)));
  }

  /** Round dots under the rows, one per page; a click or Left and Right move between them. */
  private pager(stack: any, n: number, parts: Part[], c: Controls): any {
    const pager = new Gtk.Box({ halign: Gtk.Align.CENTER, css_classes: ["wb-pager"] });
    accessibleLabel(pager, tw("widget.pages"));
    const dots: any[] = [];
    const go = (i: number, focus: boolean) => {
      if (i === this.page) return;
      this.page = i;
      stack.set_visible_child_name(`p${i}`);
      dots.forEach((d, k) => (k === i ? d.add_css_class("on") : d.remove_css_class("on")));
      if (focus) dots[i]?.grab_focus();
      if (animationsOn()) {
        parts[i]!.motion.k = 0;
        this.enter(parts[i]!);
      }
    };
    for (let i = 0; i < n; i++) {
      const d = new Gtk.Button({ css_classes: ["flat", "circular", "wb-pdot", ...(i === this.page ? ["on"] : [])], tooltip_text: tw("widget.page", { n: i + 1, total: n }) });
      d.set_child(new Gtk.Box({ css_classes: ["wb-pdot-mark"], halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER }));
      accessibleLabel(d, tw("widget.page", { n: i + 1, total: n }));
      d.set_sensitive(c.live);
      this.part.on(d, "clicked", () => go(i, false));
      dots.push(d);
      pager.append(d);
    }
    const keys = new Gtk.EventControllerKey();
    this.part.on(keys, "key-pressed", (_k: unknown, keyval: number) => {
      const by = keyval === KEY_LEFT ? -1 : keyval === KEY_RIGHT ? 1 : 0;
      if (!by || !this.controls().live) return false;
      go(stepPage(this.page, n, by), true);
      return true;
    });
    pager.add_controller(keys);
    return pager;
  }

  private items(body: any, ctx: Ctx): void {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    for (const item of this.w.items!.slice(0, itemsFor(this.size))) {
      const line = new Gtk.Box({ spacing: 8 });
      line.append(label(item.text, ["wb-item"], { hexpand: true, wrap: true, lines: 2, natural_wrap_mode: 1 }));
      if (item.time) line.append(label(relativeTime(item.time, lang), ["caption", "dim-label"], { ellipsize: 0, valign: Gtk.Align.START }));
      box.append(linked(line, item.url || undefined, ctx, false));
    }
    body.append(box);
  }

  private embed(): any {
    this.view ??= this.host.embed(this.w);
    if (this.box) {
      this.view.set_size_request(-1, 0);
      this.view.set_vexpand(true);
    } else {
      this.view.set_size_request(-1, embedHeight(this.size));
      this.view.set_vexpand(false);
    }
    return this.view;
  }

  /** The footer: the in-card confirmation, else the card's input and buttons; then the message. */
  private foot(c: Controls): any | undefined {
    const { input, buttons } = cardActions(this.w);
    if (!this.asking && !input && !buttons.length && !this.msg) return undefined;
    const foot = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_start: 4, margin_end: 4, css_classes: ["wb-foot"] });
    if (this.asking) {
      const ask = this.asking;
      const row = new Gtk.Box({ spacing: 6, css_classes: ["wb-confirm"] });
      accessibleLabel(row, ask.text);
      row.append(label(ask.text, [], { hexpand: true, wrap: true, lines: 2, ellipsize: 0 }));
      const cancel = new Gtk.Button({ label: tw("common.cancel") });
      this.part.on(cancel, "clicked", () => this.answer(false));
      const ok = new Gtk.Button({ label: ask.label, css_classes: ["suggested-action"] });
      ok.set_name("confirm");
      this.part.on(ok, "clicked", () => this.answer(true));
      row.append(cancel);
      row.append(ok);
      const keys = new Gtk.EventControllerKey();
      this.part.on(keys, "key-pressed", (_k: unknown, keyval: number) => {
        if (keyval !== KEY_ESCAPE) return false;
        this.answer(false);
        return true;
      });
      row.add_controller(keys);
      foot.append(row);
      // The question takes the focus, as the panel's autofocus does.
      this.part.idle(() => ok.grab_focus());
    } else if (input || buttons.length) {
      const row = new Gtk.Box({ spacing: 6 });
      if (input) {
        const name = txt(input.label, lang);
        const entry = new Gtk.Entry({ text: this.draft, placeholder_text: txt(input.placeholder, lang) || name, hexpand: true, max_length: 2000 });
        entry.set_name("input");
        accessibleLabel(entry, name);
        entry.set_sensitive(c.actLive && this.busy === null);
        const send = new Gtk.Button({ icon_name: "go-up-symbolic", tooltip_text: name, css_classes: ["circular", "wb-send"] });
        send.set_name("send");
        accessibleLabel(send, name);
        send.set_sensitive(c.actLive && this.busy === null && !!inputValue(this.draft));
        this.part.on(entry, "changed", (e: any) => {
          this.draft = e.get_text();
          send.set_sensitive(this.controls().actLive && this.busy === null && !!inputValue(this.draft));
        });
        const submit = () => {
          const v = inputValue(this.draft);
          if (!v || this.busy !== null) return;
          void this.run(input, v).then((done) => {
            if (!done || this.disposed) return;
            this.draft = "";
            this.render(false);
          });
        };
        this.part.on(entry, "activate", submit);
        this.part.on(send, "clicked", submit);
        row.append(entry);
        row.append(send);
      }
      for (const a of buttons) {
        const b = new Gtk.Button({ label: txt(a.label, lang), css_classes: ["pill", "wb-btn"] });
        b.set_sensitive(c.actLive && this.busy === null);
        this.part.on(b, "clicked", () => void this.run(a));
        row.append(b);
      }
      foot.append(row);
    }
    if (this.msg) {
      foot.append(label(this.msg.text, ["caption", this.msg.kind === "error" ? "error" : "dim-label"], { wrap: true, lines: 3, ellipsize: 3, accessible_role: Gtk.AccessibleRole.STATUS }));
    }
    return foot;
  }

  // The entrance and the flash

  /** Moves a part's drawings in and counts its numbers up, over ENTER_MS; at once when it does not move. */
  private enter(part: Part): void {
    if (part.motion.k >= 1 || (!part.draws.length && !part.counts.length)) {
      part.motion.k = 1;
      return;
    }
    let t0 = -1;
    const draws = part.draws;
    const counts = part.counts;
    this.part.tick(this.root, (now) => {
      if (t0 < 0) t0 = now;
      const k = Math.min(1, (now - t0) / ENTER_MS);
      part.motion.k = k;
      for (const d of draws) d.queue_draw();
      for (const c of counts) c.label.set_label(c.text(countUp(c.target, k)));
      return k < 1;
    });
  }

  /** Marks a value that changed since the last payload for a moment (not under reduced motion). */
  private flash(l: any, i: number): void {
    const dir = this.marks?.[i];
    if (!dir) return;
    const cls = `wb-flash-${dir}`;
    l.add_css_class(cls);
    this.part.timeout(FLASH_MS, () => l.remove_css_class(cls));
  }

  // Writes

  private ask(a: BlockAction | CardAction): Promise<boolean> {
    const q = confirmOf(a, lang);
    if (!q) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.asking = { ...q, resolve };
      this.render(false);
    });
  }

  private answer(ok: boolean): void {
    const a = this.asking;
    if (!a) return;
    this.asking = null;
    a.resolve(ok);
    if (!ok && !this.disposed) this.render(false);
  }

  private say(kind: "error" | "info", text: string): void {
    this.msg = { kind, text };
    if (this.msgTimer) this.bag.cancel(this.msgTimer);
    this.msgTimer = this.bag.timeout(messageMs(kind), () => {
      this.msgTimer = 0;
      this.msg = null;
      this.render(false);
    });
  }

  /** One action at a time: a check is ticked while it is on the way and unticked when it fails; typed text stays. */
  private async run(a: BlockAction | CardAction, value?: string): Promise<boolean> {
    if (!this.controls().actLive || this.busy) return false;
    this.msg = null;
    if (!(await this.ask(a)) || this.disposed) return false;
    if (a.kind === "check") this.ticked.add(a.id);
    this.busy = a.id;
    this.render(false);
    const r = await this.host.post(this.w, "action", value === undefined ? { action: a.id } : { action: a.id, value });
    if (this.disposed) return false;
    this.busy = null;
    this.ticked.delete(a.id);
    if (!r.ok) {
      this.say("error", tw("widget.actionFailed", { error: r.error }));
      this.render(false);
      return false;
    }
    if (r.message) this.say("info", r.message);
    // The fresh card comes back as this one's update (the catalogue changed); the same payload draws nothing, so the card is drawn here.
    const before = this.sig;
    this.host.replace(r.widget);
    if (this.sig === before && !this.disposed) this.render(false);
    return true;
  }

  private async refresh(): Promise<void> {
    if (!this.controls().actLive || this.refreshing) return;
    this.refreshing = true;
    this.render(false);
    const r = await this.host.post(this.w, "refresh");
    if (this.disposed) return;
    this.refreshing = false;
    const before = this.sig;
    if (r.ok) this.host.replace(r.widget);
    else this.say("error", tw("widget.actionFailed", { error: r.error }));
    if (this.sig === before && !this.disposed) this.render(false);
  }

  // Rows per page in the stepless area

  private fitSoon(): void {
    if (this.fitPending) return;
    this.fitPending = this.part.idle(() => {
      this.fitPending = 0;
      this.fit();
    });
  }

  /** As many rows per page as fit under the hero in the card's box (core rowsPerPage); drawn again when that changes. */
  private fit(): void {
    const box = this.box;
    const p = this.parts;
    if (!box || this.disposed || !p.hero || !p.rows.length) return;
    const inner = Math.max(1, box.width - 20 - 8);
    const nat = (wd: any, width: number) => (wd ? wd.measure(Gtk.Orientation.VERTICAL, width)[1] : 0);
    const avail = Math.max(
      0,
      box.height - PADDING_Y - [p.head, p.views, p.foot].filter(Boolean).reduce((a, wd) => a + nat(wd, box.width - 20) + SPACING, 0) - nat(p.hero, inner) - BODY_SPACING,
    );
    const heights = p.rows.map((r) => nat(r, inner));
    const pagerH = p.pager ? nat(p.pager, inner) + BODY_SPACING : PAGER_H;
    const per = rowsPerPage(this.size, { avail, heights, gap: ROWS_SPACING, pagerH });
    if (per === this.per) return;
    this.per = per;
    this.render(false);
  }

  // Focus across a drawing

  private focusKey(): string | undefined {
    const focus = this.root.get_root?.()?.get_focus?.();
    if (!focus || !focus.is_ancestor?.(this.root)) return undefined;
    for (let w = focus; w && w !== this.root; w = w.get_parent()) {
      const name = w.get_name?.();
      if (name && (name === "input" || name === "send" || name === "confirm" || name.startsWith("view-"))) return name;
    }
    return undefined;
  }

  private restoreFocus(key: string | undefined): void {
    if (!key) return;
    this.part.idle(() => {
      const target = this.findNamed(this.root, key);
      if (!target) return;
      target.grab_focus();
      if (key === "input") target.set_position(-1);
    });
  }

  private focusNamed(scope: any, name: string): void {
    this.part.idle(() => this.findNamed(scope, name)?.grab_focus());
  }

  private findNamed(scope: any, name: string): any {
    if (!scope) return undefined;
    if (scope.get_name?.() === name) return scope;
    for (let c = scope.get_first_child(); c; c = c.get_next_sibling()) {
      const hit = this.findNamed(c, name);
      if (hit) return hit;
    }
    return undefined;
  }
}

const KEY_LEFT = 0xff51;
const KEY_RIGHT = 0xff53;
const KEY_ESCAPE = 0xff1b;

/** What a disposed card is left holding, so nothing it kept is reached through it. */
const DEAD_HOST: CardHost = { open: () => {}, post: async () => ({ ok: false, error: "gone" }), replace: () => {}, writes: false, embed: () => new Gtk.Box() };

/**
 * The cards of Home's library, matches and (on an older Space) screens: drawn with each page and
 * dropped with it, in the library inert (a preview). An embed card keeps its web view while its
 * page is drawn again with the widget still on it, so the app's page is not reloaded; a web view
 * no page draws any more is closed, as are those of a Space that was removed.
 */
export class WidgetCards {
  /** By Space, page and widget; `used` is false from the moment the page is cleared until it draws the widget again. */
  private readonly embeds = new Map<string, { conn: string; page: string; view: any; used: boolean }>();
  /** The cards drawn on each page, disposed when the page is drawn again. */
  private readonly drawn = new Map<string, LiveCard[]>();
  /** The page being drawn, set by Home before it asks for cards. */
  page = "";

  constructor(private readonly host: Omit<CardHost, "embed" | "releaseEmbed">) {}

  /** A page is about to be drawn again: its cards go, its web views stay only if the new drawing asks for them. */
  release(page: string): void {
    for (const c of this.drawn.get(page) ?? []) c.dispose();
    this.drawn.delete(page);
    for (const e of this.embeds.values()) if (e.page === page) e.used = false;
  }

  /** After drawing a Space's pages: closes its web views no page asked for again. */
  keepOnly(conn: string, pages: Set<string>): void {
    for (const [key, e] of this.embeds) if (e.conn === conn && (!e.used || !pages.has(e.page))) this.close(key);
    for (const page of [...this.drawn.keys()]) if (!pages.has(page)) this.release(page);
  }

  /** Closes the web views of Spaces no longer saved. */
  keepSpaces(conns: string[]): void {
    for (const [key, e] of this.embeds) if (!conns.includes(e.conn)) this.close(key);
  }

  private close(key: string): void {
    const e = this.embeds.get(key);
    if (!e) return;
    this.embeds.delete(key);
    e.view.get_parent()?.remove?.(e.view);
    // Ends its page now rather than whenever the collector finds the view.
    e.view.run_dispose();
  }

  /** A card on the page being drawn: live on a screen, a preview in the library and the matches. */
  card(space: Space, w: Widget, mode: CardMode = "live", decorate?: (root: any) => void): any {
    const page = this.page;
    const card = new LiveCard({ ...this.host, decorate: decorate ? (root) => decorate(root) : undefined, embed: (x) => this.embed(space, x, page) }, space, w, mode);
    const list = this.drawn.get(page) ?? [];
    list.push(card);
    this.drawn.set(page, list);
    return card.root;
  }

  private embed(space: Space, w: Widget, page: string): any {
    const key = `${space.conn.id}\n${page}\n${w.id}`;
    const kept = this.embeds.get(key);
    if (kept) {
      kept.view.get_parent()?.remove?.(kept.view);
      kept.used = true;
      return kept.view;
    }
    const view = newEmbedView(space, w, (uri) => this.host.open(w, uri));
    this.embeds.set(key, { conn: space.conn.id, page, view, used: true });
    return view;
  }
}

/** An `embed` card's web view on the Space's session, loading the widget's page. */
export function newEmbedView(space: Space, w: Widget, onExternal: (uri: string) => void): any {
  const view = createWebView({ connectionId: space.conn.id, connection: space.conn.url, onExternal });
  view.add_css_class("wb-embed");
  const url = resolveUrl(embedPath(w, Adw.StyleManager.get_default().get_dark(), lang), space.conn.url);
  if (url) view.load_uri(url);
  return view;
}
