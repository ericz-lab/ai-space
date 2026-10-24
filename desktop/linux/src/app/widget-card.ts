import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import { type Widget, pickText } from "../core/catalogue.ts";
import { relativeTime } from "../core/format.ts";
import { resolveUrl } from "../core/url.ts";
import { type Tone, type WidgetBlock, cardBody, deltaText, embedHeight, embedPath, fraction, gaugeSegments, isOutdated, itemsFor, position, rowsFor, shown, spark, toneOf, txt } from "../core/widgets.ts";
import { lang, t } from "./env.ts";
import { iconWidget } from "./icons.ts";
import type { Space } from "./model.ts";
import { createWebView } from "./web.ts";

/**
 * A widget as a card, drawn as the panel draws it (docs/panel.md#widgets) and the Mac does: the
 * head links to the widget's page; a block card leads with its first block (label, big value,
 * change, chart or bar) and lists the next ones as rows, as many as its size holds; a list card
 * shows its items with their age; an `embed` widget shows the app's own page in a web view of the
 * Space's session, as the panel's iframe does. Colour inside a card is data, nothing else.
 */

export type CardActions = {
  /** The widget's own page, or one of its links (a row, a block). */
  open: (widget: Widget, link?: string) => void;
};

type RGBA = [number, number, number, number];

const TONES: Record<Tone, RGBA> = { positive: [0.18, 0.64, 0.38, 1], negative: [0.88, 0.11, 0.14, 1], warning: [0.9, 0.6, 0.04, 1], neutral: [0.5, 0.5, 0.5, 1] };

function colors(w: any): { fg: RGBA; accent: RGBA } {
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

function drawing(height: number, draw: (cr: any, width: number, height: number, area: any) => void, width?: number): any {
  const area = width ? new Gtk.DrawingArea({ content_height: height, content_width: width, hexpand: false, halign: Gtk.Align.START, valign: Gtk.Align.CENTER }) : new Gtk.DrawingArea({ content_height: height, hexpand: true });
  area.set_draw_func((a: any, cr: any, w: number, h: number) => {
    draw(cr, w, h, a);
    cr.$dispose?.();
  });
  return area;
}

/** A trend as a line (an area under each unbroken run) or bars, the latest at full strength. */
function sparkArea(b: Extract<WidgetBlock, { type: "trend" }>, height: number): any {
  const s = spark(b);
  if (!s) {
    const l = new Gtk.Label({ label: t("widgetNoHistory"), xalign: 0 });
    l.add_css_class("dim-label");
    l.add_css_class("caption");
    return l;
  }
  return drawing(height, (cr, w, h, area) => {
    const { fg, accent } = colors(area);
    if (s.kind === "line") {
      for (const run of s.runs) {
        if (run.length > 1) {
          cr.setSourceRGBA(...alpha(accent, 0.14));
          cr.moveTo(run[0]!.x * w, h);
          for (const p of run) cr.lineTo(p.x * w, p.y * (h - 2) + 1);
          cr.lineTo(run[run.length - 1]!.x * w, h);
          cr.closePath();
          cr.fill();
        }
        cr.setSourceRGBA(...accent);
        cr.setLineWidth(2);
        cr.setLineJoin(1);
        cr.setLineCap(1);
        run.forEach((p, i) => (i ? cr.lineTo(p.x * w, p.y * (h - 2) + 1) : cr.moveTo(p.x * w, p.y * (h - 2) + 1)));
        if (run.length === 1) cr.arc(run[0]!.x * w, run[0]!.y * (h - 2) + 1, 1.5, 0, 2 * Math.PI);
        cr.stroke();
      }
      return;
    }
    for (const bar of s.bars) {
      const base = bar.negative ? TONES.negative : b.signed ? TONES.positive : accent;
      cr.setSourceRGBA(...alpha(base, bar.latest ? 1 : 0.6));
      const bw = Math.max(bar.width * w, 1);
      roundRect(cr, bar.x * w, bar.top * h, bw, Math.max((bar.bottom - bar.top) * h, 1), Math.min(bw * 0.17, 2));
      cr.fill();
    }
    cr.setSourceRGBA(...alpha(fg, 0.18));
    cr.setLineWidth(1);
    cr.moveTo(0, Math.round(s.zero * h) + 0.5);
    cr.lineTo(w, Math.round(s.zero * h) + 0.5);
    cr.stroke();
  });
}

function progressBar(b: Extract<WidgetBlock, { type: "progress" }>): any {
  return drawing(6, (cr, w, h, area) => {
    const { fg, accent } = colors(area);
    cr.setSourceRGBA(...alpha(fg, 0.12));
    roundRect(cr, 0, 0, w, h, h / 2);
    cr.fill();
    const f = fraction(b);
    if (f > 0) {
      cr.setSourceRGBA(...(b.tone && b.tone !== "neutral" ? TONES[b.tone] : accent));
      roundRect(cr, 0, 0, w * f, h, h / 2);
      cr.fill();
    }
  });
}

function gaugeScale(b: Extract<WidgetBlock, { type: "gauge" }>): any {
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
      const x = Math.max(6, Math.min(w - 6, position(b, b.value) * w));
      cr.setSourceRGBA(1, 1, 1, 1);
      cr.arc(x, h / 2, 6.5, 0, 2 * Math.PI);
      cr.fill();
      cr.setSourceRGBA(...fg);
      cr.arc(x, h / 2, 5, 0, 2 * Math.PI);
      cr.fill();
    }
  });
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

/** The first block, drawn large. */
function hero(b: WidgetBlock): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
  box.append(label(txt(b.label, lang), ["caption", "dim-label"]));
  const value = shown(b, lang);
  const tone = toneOf(b);
  if (b.type === "status") {
    const line = new Gtk.Box({ spacing: 8 });
    const d = dot(tone, 10);
    line.append(d);
    line.append(label(value ?? "", ["wb-status"], { wrap: true, lines: 2, hexpand: true }));
    box.append(line);
    if (b.time) box.append(label(relativeTime(b.time, lang), ["caption", "dim-label", "numeric"]));
  } else {
    const line = new Gtk.Box({ spacing: 8 });
    const v = label(value ?? t("widgetNoData"), ["wb-hero"]);
    if (value === undefined) v.add_css_class("dim-label");
    else if (b.type === "gauge") toneClass(v, tone);
    line.append(v);
    const d = deltaText(b, lang, true);
    if (d) {
      const dl = label(d.text, ["caption", "wb-delta"], { valign: Gtk.Align.BASELINE_FILL });
      if (d.tone) toneClass(dl, d.tone);
      else dl.add_css_class("dim-label");
      line.append(dl);
    }
    box.append(line);
  }
  if (b.type === "trend") box.append(sparkArea(b, 48));
  else if (b.type === "progress") box.append(progressBar(b));
  else if (b.type === "gauge") box.append(gaugeScale(b));
  const caption = txt(b.caption, lang);
  if (caption) box.append(label(caption, ["caption", "dim-label"], { wrap: true, lines: 2 }));
  return box;
}

/** A block after the first: label left, value right, its drawing below. */
function row(b: WidgetBlock): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 5 });
  const line = new Gtk.Box({ spacing: 6 });
  const tone = toneOf(b);
  if (b.type === "status") {
    const d = dot(tone, 7);
    line.append(d);
  }
  line.append(label(txt(b.label, lang), ["wb-row-label"], { hexpand: true }));
  const value = shown(b, lang);
  const v = label(value ?? t("widgetNoData"), ["wb-row-value", "numeric"], { max_width_chars: 22, xalign: 1 });
  if (value === undefined) v.add_css_class("dim-label");
  else if (b.type === "gauge" || b.type === "metric") toneClass(v, tone);
  line.append(v);
  const d = deltaText(b, lang, false);
  if (d) {
    const dl = label(d.text, ["caption", "wb-delta"], { ellipsize: 0 });
    if (d.tone) toneClass(dl, d.tone);
    else dl.add_css_class("dim-label");
    line.append(dl);
  }
  if (b.type === "status" && b.time) line.append(label(relativeTime(b.time, lang), ["caption", "dim-label"], { ellipsize: 0 }));
  box.append(line);
  if (b.type === "trend") box.append(sparkArea(b, 22));
  else if (b.type === "progress") box.append(progressBar(b));
  else if (b.type === "gauge") box.append(gaugeScale(b));
  return box;
}

/** A part of the card that opens a link when it has one. */
function linked(child: any, link: string | undefined, open: (link: string) => void): any {
  if (!link) return child;
  child.set_hexpand(true);
  child.set_halign(Gtk.Align.FILL);
  const b = new Gtk.Button({ child, halign: Gtk.Align.FILL, css_classes: ["flat", "wb-link"] });
  b.connect("clicked", () => open(link));
  return b;
}

/**
 * The cards of one page. An embed page keeps its web view across redraws (the catalogue is looked
 * at again every minute), so the app's page is not reloaded each time.
 */
export class WidgetCards {
  private readonly embeds = new Map<string, any>();

  constructor(private readonly actions: CardActions) {}

  card(space: Space, w: Widget): any {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, valign: Gtk.Align.START, hexpand: true });
    card.add_css_class("card");
    card.add_css_class("widget-card");
    if (w.size === "2x1" || w.size === "2x2") card.add_css_class("wide");
    if (w.stale) card.set_opacity(0.6);

    const head = new Gtk.Box({ spacing: 10 });
    head.append(iconWidget(w.icon, 24, space.client, "view-grid-symbolic"));
    head.append(label(pickText(w.title, w.i18n, "title", lang), ["wb-title", "dim-label"], { hexpand: !w.peer }));
    if (w.peer) head.append(label(w.peer, ["caption", "dim-label"], { hexpand: true }));
    head.append(new Gtk.Image({ icon_name: "go-next-symbolic", pixel_size: 12, css_classes: ["dim-label"] }));
    const headButton = new Gtk.Button({ child: head, css_classes: ["flat", "wb-head"], tooltip_text: t("open") });
    headButton.connect("clicked", () => this.actions.open(w));
    card.append(headButton);

    const open = (link: string) => this.actions.open(w, link);
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10, margin_start: 4, margin_end: 4 });
    switch (cardBody(w)) {
      case "error": {
        const line = new Gtk.Box({ spacing: 8 });
        line.append(new Gtk.Image({ icon_name: "dialog-warning-symbolic", css_classes: ["dim-label"] }));
        line.append(label(w.error || t("widgetDown"), ["dim-label"], { wrap: true, lines: 3 }));
        body.append(line);
        break;
      }
      case "embed":
        body.append(this.embed(space, w));
        break;
      case "blocks": {
        const [first, ...rest] = w.blocks!;
        body.append(linked(hero(first!), first!.url, open));
        const rows = rest.slice(0, rowsFor(w.size));
        if (rows.length) {
          const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
          for (const b of rows) box.append(linked(row(b), b.url, open));
          body.append(box);
        }
        if (!w.stale && isOutdated(w.asOf, w.staleAfterMs) && w.asOf) body.append(label(t("widgetUpdated", { when: relativeTime(w.asOf, lang) }), ["caption", "dim-label"]));
        break;
      }
      case "items": {
        const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
        for (const item of w.items!.slice(0, itemsFor(w.size))) {
          const line = new Gtk.Box({ spacing: 8 });
          line.append(label(item.text, ["wb-item"], { hexpand: true, wrap: true, lines: 2, natural_wrap_mode: 1 }));
          if (item.time) line.append(label(relativeTime(item.time, lang), ["caption", "dim-label"], { ellipsize: 0, valign: Gtk.Align.START }));
          box.append(linked(line, item.url || undefined, open));
        }
        body.append(box);
        break;
      }
      case "empty":
        body.append(label(t("widgetEmpty"), ["dim-label"]));
    }
    if (w.stale) body.append(label(t("widgetStale"), ["caption", "dim-label"]));
    card.append(body);
    return card;
  }

  private embed(space: Space, w: Widget): any {
    const key = `${space.conn.id}:${w.id}`;
    let view = this.embeds.get(key);
    if (view) {
      view.get_parent()?.remove?.(view);
      return view;
    }
    view = createWebView({ connectionId: space.conn.id, connection: space.conn.url, onExternal: (uri) => this.actions.open(w, uri) });
    view.set_size_request(-1, embedHeight(w.size));
    view.set_vexpand(false);
    view.add_css_class("wb-embed");
    const url = resolveUrl(embedPath(w, Adw.StyleManager.get_default().get_dark(), lang), space.conn.url);
    if (url) view.load_uri(url);
    this.embeds.set(key, view);
    return view;
  }
}
