import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import Adw from "gi://Adw?version=1";
import {
  type CardIcon,
  type CardStyle,
  type CardTag,
  type ShownCard,
  type ShownItem,
  agendaDays,
  canUndo,
  cardStyle,
  compactValue,
  galleryLine,
  leadOf,
  openIds,
  pillOf,
  shownItem,
  undoLabel,
  undoable,
} from "../core/cards.ts";
import type { Conversation } from "../core/conversation.ts";
import { lang, tw } from "./env.ts";
import type { SpaceClient } from "./http.ts";
import { isImageIcon, loadTexture } from "./icons.ts";

/**
 * The cards under an agent's reply (docs/chat-cards.md and the second version's section 11): what
 * its tools did this turn, in a narrow card (at most 460 px) headed by the app that did it, drawn
 * in one of five styles. Every state (the items' answers, busy, the note, read-only) lives on the
 * conversation's `ShownCard`, so a reply drawn again while it streams keeps it; handlers reach the
 * conversation and the card's data, never the widgets around them. Colours are the theme's.
 */

export type CardsContext = {
  conv: Conversation;
  /** The reply is the conversation's latest: its live cards may act. */
  actionable: boolean;
  client: SpaceClient | undefined;
  /** The heading's app: its icon (emoji or image) and name; either may be missing. */
  app: { icon?: string; name?: string };
  /** An item's link opens as the client opens an app's page (its tab, or the browser). */
  onLink: (url: string) => void;
};

/** Symbolic names for the card icons, each with a fallback the Adwaita theme has had for long (GTK picks the first it finds). */
const ICONS: Record<CardIcon, string[]> = {
  check: ["object-select-symbolic"],
  note: ["document-edit-symbolic", "text-x-generic-symbolic"],
  link: ["insert-link-symbolic", "adw-external-link-symbolic"],
  calendar: ["x-office-calendar-symbolic", "preferences-system-time-symbolic"],
  image: ["image-x-generic-symbolic"],
  file: ["text-x-generic-symbolic", "document-open-symbolic"],
  person: ["avatar-default-symbolic"],
  chart: ["utilities-system-monitor-symbolic", "speedometer-symbolic"],
  clock: ["preferences-system-time-symbolic"],
  flag: ["emblem-important-symbolic", "dialog-information-symbolic"],
  bell: ["preferences-system-notifications-symbolic", "mail-unread-symbolic"],
  folder: ["folder-symbolic", "folder-open-symbolic"],
};
const UNDO = ["edit-undo-symbolic"];
const CHEVRON = ["go-next-symbolic"];

function symbolic(names: string[], size: number, classes: string[] = []): any {
  return new Gtk.Image({ gicon: Gio.ThemedIcon.new_from_names(names), pixel_size: size, css_classes: classes });
}

function text(s: string, classes: string[], opts: { ellipsize?: boolean; wrap?: boolean; hexpand?: boolean } = {}): any {
  const l = new Gtk.Label({ label: s, xalign: 0, hexpand: opts.hexpand ?? false, css_classes: classes });
  if (opts.ellipsize) {
    l.set_ellipsize(Pango.EllipsizeMode.END);
    l.set_single_line_mode(true);
  } else if (opts.wrap) {
    l.set_wrap(true);
    l.set_wrap_mode(Pango.WrapMode.WORD_CHAR);
  }
  return l;
}

const escape = (s: string) => GLib.markup_escape_text(s, -1);

/**
 * At most `max` pixels wide, on the left; narrower when the place is narrower (Quick Chat). A
 * custom layout: Adw.Clamp would centre the card under the reply.
 */
function capped(child: any, max: number): any {
  const box = new Gtk.Box();
  const minWidth = () => child.measure(Gtk.Orientation.HORIZONTAL, -1)[0] as number;
  const width = (avail: number) => Math.max(minWidth(), Math.min(avail, max));
  box.set_layout_manager(
    Gtk.CustomLayout.new(
      () => Gtk.SizeRequestMode.HEIGHT_FOR_WIDTH,
      (_w: unknown, orientation: number, forSize: number) => {
        if (orientation === Gtk.Orientation.HORIZONTAL) {
          const min = minWidth();
          return [min, Math.max(min, max), -1, -1];
        }
        const [min, nat] = child.measure(Gtk.Orientation.VERTICAL, forSize < 0 ? -1 : width(forSize));
        return [min, nat, -1, -1];
      },
      (_w: unknown, w: number, h: number, baseline: number) => child.allocate(width(w), h, baseline, null),
    ),
  );
  box.append(child);
  return box;
}

/** A 4:3 transparent picture: a cell takes its height from its width through it (GtkPicture keeps the paintable's ratio). */
let ratioTexture: any;
function ratio43(): any {
  ratioTexture ??= Gdk.MemoryTexture.new(4, 3, Gdk.MemoryFormat.R8G8B8A8, new GLib.Bytes(new Uint8Array(4 * 3 * 4)), 16);
  return new Gtk.Picture({ paintable: ratioTexture, can_shrink: true, content_fit: Gtk.ContentFit.FILL, hexpand: true });
}

/**
 * A picture of an item: the divider colour with the image icon until it loads, and when it does
 * not. `fill` sets the size (the gallery's 4:3 sizer); what the caller adds over it stays on top.
 */
function thumbnail(url: string | undefined, client: SpaceClient | undefined, size: number, classes: string[], opts: { fill?: any; dim?: boolean } = {}): any {
  const overlay = new Gtk.Overlay({ css_classes: ["chat-card-thumb", ...classes] });
  overlay.set_overflow(Gtk.Overflow.HIDDEN);
  overlay.set_child(opts.fill ?? new Gtk.Box({ width_request: size, height_request: size }));
  const empty = new Gtk.Box({ css_classes: ["chat-card-thumb-empty"] });
  const glyph = symbolic(ICONS.image, Math.min(24, Math.round(size / 2.5)), ["dim-label"]);
  glyph.set_hexpand(true);
  glyph.set_halign(Gtk.Align.CENTER);
  glyph.set_valign(Gtk.Align.CENTER);
  empty.append(glyph);
  overlay.add_overlay(empty);
  const pic = new Gtk.Picture({ content_fit: Gtk.ContentFit.COVER, can_shrink: true });
  overlay.add_overlay(pic);
  if (opts.dim) {
    empty.set_opacity(0.4);
    pic.set_opacity(0.4);
  }
  if (url) {
    void loadTexture(url, client, size).then((texture) => {
      if (!texture || !overlay.get_parent()) return;
      pic.set_paintable(texture);
      empty.set_visible(false);
    });
  }
  return overlay;
}

/** The app's icon on a 20 px plate: an emoji, or its picture once loaded; nothing without one or when it does not load. */
function appMark(icon: string | undefined, client: SpaceClient | undefined): any | undefined {
  if (!icon) return undefined;
  const plate = new Gtk.Box({ width_request: 20, height_request: 20, valign: Gtk.Align.CENTER, css_classes: ["chat-card-app-icon"] });
  plate.set_overflow(Gtk.Overflow.HIDDEN);
  if (!isImageIcon(icon)) {
    plate.add_css_class("solid");
    const l = new Gtk.Label({ hexpand: true });
    l.set_markup(`<span size="10pt">${escape(icon)}</span>`);
    plate.append(l);
    return plate;
  }
  plate.set_visible(false);
  void loadTexture(icon, client, 20).then((texture) => {
    if (!texture || !plate.get_parent()) return;
    plate.append(new Gtk.Picture({ paintable: texture, content_fit: Gtk.ContentFit.COVER, can_shrink: true, width_request: 20, height_request: 20 }));
    plate.set_visible(true);
  });
  return plate;
}

function tagLabel(tag: CardTag): any {
  return new Gtk.Label({ label: tag.text, valign: Gtk.Align.CENTER, css_classes: ["chat-card-tag", `tone-${tag.tone}`] });
}

/** A line of short parts that wraps when it is too long: Adw.WrapBox where there is one (libadwaita 1.7), else a flow box. */
function wrapLine(parts: any[]): any {
  const WrapBox = (Adw as any).WrapBox;
  if (WrapBox) {
    const w = new WrapBox({ child_spacing: 8, line_spacing: 2, css_classes: ["chat-card-meta"] });
    for (const p of parts) w.append(p);
    return w;
  }
  const flow = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous: false, column_spacing: 8, row_spacing: 2, min_children_per_line: 1, max_children_per_line: 30, can_focus: false, css_classes: ["chat-card-meta"] });
  for (const p of parts) {
    flow.append(p);
    const child = flow.get_last_child();
    child?.set_can_focus(false);
  }
  return flow;
}

/** The secondary line: (rows) the time words with a calendar icon or (agenda) the time, the detail's parts, the tags, the id. */
function metaLine(i: ShownItem, lead: { when?: string; time?: string }): any {
  const parts: any[] = [];
  if (lead.when) {
    const w = new Gtk.Box({ spacing: 4 });
    w.append(symbolic(ICONS.calendar, 12));
    w.append(text(lead.when, []));
    parts.push(w);
  }
  if (lead.time) parts.push(text(lead.time, ["chat-card-time", "numeric"]));
  for (const seg of i.detail) parts.push(text(seg, []));
  for (const tag of i.tags ?? []) parts.push(tagLabel(tag));
  parts.push(text(`#${i.id}`, []));
  return wrapLine(parts);
}

function pill(i: ShownItem): any | undefined {
  const p = pillOf(i);
  if (!p) return undefined;
  return new Gtk.Label({ label: tw(p === "undone" ? "chat.card.undone" : p === "changed" ? "chat.card.changed" : "chat.card.done"), valign: Gtk.Align.CENTER, css_classes: ["chat-card-pill", p === "changed" ? "warn" : p === "done" ? "ok" : "muted"] });
}

/** The state circle: hollow while active, a check when done, dashed when undone. */
function mark(status: ShownItem["status"]): any {
  const m = new Gtk.Box({ width_request: 18, height_request: 18, valign: Gtk.Align.CENTER, css_classes: ["chat-card-mark", status] });
  if (status === "done") {
    const check = symbolic(ICONS.check, 11);
    check.set_hexpand(true);
    m.append(check);
  }
  return m;
}

function lead(i: ShownItem, style: CardStyle, client: SpaceClient | undefined): any {
  const kind = leadOf(i, style);
  if (kind === "image") return thumbnail(i.image, client, 36, ["small"]);
  if (kind === "icon") {
    const box = new Gtk.Box({ width_request: 18, height_request: 18, valign: Gtk.Align.CENTER });
    const img = symbolic(ICONS[i.icon!], 16, ["chat-card-icon"]);
    img.set_hexpand(true);
    box.append(img);
    return box;
  }
  return mark(i.status);
}

function rowUndoButton(ctx: CardsContext, shown: ShownCard, i: ShownItem): any {
  const b = new Gtk.Button({ valign: Gtk.Align.CENTER, tooltip_text: tw("chat.card.undo"), sensitive: !shown.busy, css_classes: ["flat", "circular", "chat-card-row-undo"] });
  b.set_child(symbolic(UNDO, 16));
  b.update_property([Gtk.AccessibleProperty.LABEL], [tw("chat.card.undoItem", { title: i.title })]);
  const conv = ctx.conv;
  b.connect("clicked", () => void conv.undoCard(shown, [i.id]));
  return b;
}

/** A pressable row that opens a link; the row's look stays the card's. */
function linkRow(content: any, url: string, ctx: CardsContext, classes: string[]): any {
  const b = new Gtk.Button({ child: content, css_classes: ["flat", "chat-card-press", ...classes] });
  const open = ctx.onLink;
  b.connect("clicked", () => open(url));
  return b;
}

function sep(): any {
  return new Gtk.Separator({ css_classes: ["chat-card-sep"] });
}

// Styles

/** rows (the first version's look) and agenda: a lead, two lines of text, a pill, the item's Undo or a chevron. */
function listRows(shown: ShownCard, items: ShownItem[], style: "rows" | "agenda", ctx: CardsContext, body: any): void {
  const live = canUndo(shown, ctx.actionable);
  const many = shown.card.items.length > 1;
  const now = GLib.DateTime.new_now_local();
  const days = style === "agenda" ? agendaDays(items.map((i) => i.date), lang === "zh" ? "zh" : "en", { year: now.get_year(), month: now.get_month() }) : [];
  items.forEach((i, n) => {
    if (n) body.append(sep());
    const rowUndo = many && undoable(shown, ctx.actionable, i.id);
    // Read-only, the whole row opens the item; while the card can act, the title is the link.
    const rowLink = !live && Boolean(i.url);
    const row = new Gtk.Box({ spacing: 12, css_classes: ["chat-card-row", i.status, ...(rowUndo ? ["acts"] : []), ...(many ? [] : ["single"])] });
    if (style === "agenda") {
      const d = days[n]!;
      const block = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: 44, valign: Gtk.Align.CENTER, css_classes: ["chat-card-day"] });
      if (d.day) {
        block.append(new Gtk.Label({ label: d.day, css_classes: ["chat-card-day-num", "numeric"] }));
        block.append(new Gtk.Label({ label: d.weekday ?? "", css_classes: ["chat-card-day-sub"] }));
        if (d.month) block.append(new Gtk.Label({ label: d.month, css_classes: ["chat-card-day-sub"] }));
      }
      row.append(block);
    }
    row.append(lead(i, style, ctx.client));
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, hexpand: true, valign: Gtk.Align.CENTER });
    const name = text("", ["chat-card-name"], { wrap: true });
    if (i.url && !rowLink) {
      name.set_markup(`<a href="${escape(i.url)}">${escape(i.title)}</a>`);
      const open = ctx.onLink;
      name.connect("activate-link", (_l: unknown, uri: string) => {
        open(uri);
        return true;
      });
    } else name.set_text(i.title);
    col.append(name);
    // An undone agenda item shows no time, as it shows no other detail.
    const time = i.status === "removed" ? undefined : days[n]?.time;
    col.append(metaLine(i, style === "agenda" ? { ...(time ? { time } : {}) } : { ...(i.when ? { when: i.when } : {}) }));
    if (style === "rows" && i.progress !== undefined) {
      col.append(new Gtk.ProgressBar({ fraction: i.progress, css_classes: ["chat-card-progress"], margin_top: 3 }));
    }
    row.append(col);
    const p = pill(i);
    if (p) row.append(p);
    if (rowUndo) row.append(rowUndoButton(ctx, shown, i));
    if (rowLink && !p) row.append(symbolic(CHEVRON, 16, ["dim-label"]));
    body.append(rowLink ? linkRow(row, i.url!, ctx, []) : row);
  });
}

/** compact: one 36 px line per item, a dot for its state, the title and a short value; the whole line opens it. */
function compactRows(items: ShownItem[], ctx: CardsContext, body: any): void {
  items.forEach((i, n) => {
    if (n) body.append(sep());
    const row = new Gtk.Box({ spacing: 10, css_classes: ["chat-card-compact", i.status] });
    row.append(new Gtk.Box({ width_request: 6, height_request: 6, valign: Gtk.Align.CENTER, css_classes: ["chat-card-dot", i.status] }));
    row.append(text(i.title, ["chat-card-compact-title"], { ellipsize: true, hexpand: true }));
    const v = compactValue(i);
    if (v) row.append(text(v, ["chat-card-compact-value", "numeric"]));
    body.append(i.url ? linkRow(row, i.url, ctx, []) : row);
  });
}

/** gallery: a grid of 4:3 pictures (3 columns, 2 when narrower than 360 px), the title and one line under each. */
function gallery(shown: ShownCard, items: ShownItem[], ctx: CardsContext, body: any): void {
  const many = shown.card.items.length > 1;
  const grid = new Gtk.FlowBox({ homogeneous: true, min_children_per_line: 2, max_children_per_line: 3, column_spacing: 8, row_spacing: 8, selection_mode: Gtk.SelectionMode.NONE, activate_on_single_click: true, css_classes: ["chat-card-gallery"] });
  for (const i of items) {
    // 3 × 115 + 2 × 8 = 361: three columns from a 360 px content width up.
    const cell = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 3, width_request: 115 });
    const removed = i.status === "removed";
    const pic = thumbnail(i.image, ctx.client, 160, ["large"], { fill: ratio43(), dim: removed });
    // A single picture is undone from the header, as a single row is.
    if (many && undoable(shown, ctx.actionable, i.id)) {
      const b = rowUndoButton(ctx, shown, i);
      b.remove_css_class("flat");
      b.set_halign(Gtk.Align.END);
      b.set_valign(Gtk.Align.START);
      b.set_margin_top(6);
      b.set_margin_end(6);
      b.add_css_class("chat-card-thumb-undo");
      pic.add_overlay(b);
    }
    if (removed) {
      const gone = new Gtk.Label({ label: tw("chat.card.undone"), halign: Gtk.Align.START, valign: Gtk.Align.START, margin_top: 6, margin_start: 6, css_classes: ["chat-card-pill", "muted", "chat-card-gone"] });
      pic.add_overlay(gone);
    }
    cell.append(pic);
    cell.append(text(i.title, ["chat-card-cell-title", ...(removed ? ["struck"] : [])], { ellipsize: true }));
    const line = galleryLine(i);
    if (line) cell.append(text(line, ["chat-card-cell-sub"], { ellipsize: true }));
    grid.append(cell);
    const child = grid.get_last_child();
    if (!i.url) child?.set_can_focus(false);
  }
  const open = ctx.onLink;
  grid.connect("child-activated", (_g: unknown, child: any) => {
    const url = items[child.get_index()]?.url;
    if (url) open(url);
  });
  body.append(grid);
}

/** stat: big values side by side (at least 96 px each, wrapping), the title under each; no state, no undo. The 1 px gaps over the divider colour are the lines between cells. */
function stats(items: ShownItem[], ctx: CardsContext, body: any): void {
  const grid = new Gtk.FlowBox({ homogeneous: true, min_children_per_line: 1, max_children_per_line: Math.max(1, items.length), column_spacing: 1, row_spacing: 1, selection_mode: Gtk.SelectionMode.NONE, activate_on_single_click: true, css_classes: ["chat-card-stats"] });
  for (const i of items) {
    const cell = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, width_request: 96, css_classes: ["chat-card-stat", i.status] });
    // An undone cell fades, its value struck through.
    if (i.status === "removed") cell.set_opacity(0.4);
    cell.append(text(i.value ?? "", ["chat-card-stat-value", "numeric", ...(i.status === "removed" ? ["struck"] : [])], { ellipsize: true }));
    const under = new Gtk.Box({ spacing: 6 });
    under.append(text(i.title, ["chat-card-stat-title"], { ellipsize: true, hexpand: true }));
    if (i.tags?.[0]) under.append(tagLabel(i.tags[0]));
    cell.append(under);
    grid.append(cell);
    const child = grid.get_last_child();
    if (!i.url) child?.set_can_focus(false);
  }
  const open = ctx.onLink;
  grid.connect("child-activated", (_g: unknown, child: any) => {
    const url = items[child.get_index()]?.url;
    if (url) open(url);
  });
  body.append(grid);
}

function chatCard(shown: ShownCard, ctx: CardsContext): any {
  const { card } = shown;
  const style = cardStyle(card);
  const live = canUndo(shown, ctx.actionable);
  const frame = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["chat-card", card.kind, `style-${style}`, ...(live ? ["live"] : [])] });
  frame.set_overflow(Gtk.Overflow.HIDDEN);

  const head = new Gtk.Box({ spacing: 8, css_classes: ["chat-card-head"] });
  const icon = appMark(ctx.app.icon, ctx.client);
  if (icon) head.append(icon);
  if (ctx.app.name) head.append(text(ctx.app.name, ["chat-card-app"]));
  head.append(text(card.title ?? "", ["chat-card-title"], { ellipsize: true, hexpand: true }));
  const open = openIds(shown, ctx.actionable);
  if (open.length) {
    const b = new Gtk.Button({ valign: Gtk.Align.CENTER, sensitive: !shown.busy, css_classes: ["chat-card-undo"] });
    const inner = new Gtk.Box({ spacing: 6 });
    inner.append(symbolic(UNDO, 14));
    inner.append(new Gtk.Label({ label: undoLabel(tw, card.items.length, open.length) }));
    b.set_child(inner);
    const conv = ctx.conv;
    const actionable = ctx.actionable;
    b.connect("clicked", () => void conv.undoCard(shown, openIds(shown, actionable)));
    head.append(b);
  }
  frame.append(head);

  const items = card.items.map((i) => shownItem(i, shown.states[i.id]));
  if (card.kind === "value" && card.text) {
    frame.append(sep());
    frame.append(text(card.text, ["chat-card-value", "numeric"], { wrap: true }));
  }
  if (items.length) {
    frame.append(sep());
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, css_classes: ["chat-card-body"] });
    if (style === "compact") compactRows(items, ctx, body);
    else if (style === "gallery") gallery(shown, items, ctx, body);
    else if (style === "stat") stats(items, ctx, body);
    else listRows(shown, items, style, ctx, body);
    frame.append(body);
  }
  if (shown.note) {
    frame.append(sep());
    frame.append(text(shown.note, ["chat-card-note", ...(shown.readOnly ? [] : ["error"])], { wrap: true }));
  }
  return frame;
}

/** The cards of one reply, one under the other. */
export function chatCards(cards: ShownCard[], ctx: CardsContext): any {
  const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 4 });
  for (const c of cards) column.append(chatCard(c, ctx));
  return capped(column, 460);
}
