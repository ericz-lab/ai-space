import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { type Entry, type Widget, allEntries, entryKey, opensFirst, panelScreens, pickText, search, widgetEntry, widgetLines } from "../core/catalogue.ts";
import { relativeTime } from "../core/format.ts";
import { lang, t } from "./env.ts";
import { iconWidget } from "./icons.ts";
import type { AppModel, Space } from "./model.ts";

/**
 * Home: the command box over the library (docs/panel.md#omnibox). What is typed filters every
 * app, agent and widget, best names first; Return opens the best match when its name holds the
 * whole query and otherwise asks Space Assistant; Ctrl+Return always asks. Below the box: the
 * panel's home screen, then the widgets, apps (with the panel's own tiles) and agents.
 */

export type Builtin = "inbox" | "shortcuts" | "terminal" | "panel" | "settings";

export type HomeActions = {
  open: (space: Space, entry: Entry) => void;
  openBuiltin: (name: Builtin) => void;
  ask: (space: Space, text: string) => void;
  openInBrowser: (space: Space, entry: Entry) => void;
};

const BUILTINS: { name: Builtin; icon: string; label: () => string }[] = [
  { name: "inbox", icon: "mail-unread-symbolic", label: () => t("inbox") },
  { name: "shortcuts", icon: "starred-symbolic", label: () => t("shortcuts") },
  { name: "terminal", icon: "utilities-terminal-symbolic", label: () => t("terminal") },
  { name: "panel", icon: "view-grid-symbolic", label: () => t("panel") },
  { name: "settings", icon: "emblem-system-symbolic", label: () => t("settings") },
];

function flow(minPerLine: number, maxPerLine: number, homogeneous = true): any {
  return new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous, min_children_per_line: minPerLine, max_children_per_line: maxPerLine, column_spacing: 4, row_spacing: 4, valign: Gtk.Align.START });
}

function sectionTitle(text: string): any {
  const l = new Gtk.Label({ label: text, xalign: 0 });
  l.add_css_class("section-title");
  return l;
}

export class HomePage {
  readonly widget: any;
  private readonly entry: any;
  private readonly body: any;
  private readonly results: any;
  private space: Space | undefined;
  private query = "";

  constructor(
    readonly model: AppModel,
    private readonly actions: HomeActions,
  ) {
    const outer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    const clamp = new Adw.Clamp({ maximum_size: 1100, tightening_threshold: 700, margin_start: 16, margin_end: 16, margin_top: 18, margin_bottom: 24 });
    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    this.entry = new Gtk.SearchEntry({ placeholder_text: t("searchPlaceholder"), hexpand: true });
    this.entry.add_css_class("home-search");
    this.entry.connect("search-changed", () => {
      this.query = this.entry.get_text();
      this.render();
    });
    this.entry.connect("activate", () => this.submit(false));
    // Ctrl+Return always asks the assistant.
    const keys = new Gtk.EventControllerKey();
    keys.connect("key-pressed", (_c: unknown, keyval: number, _code: number, state: number) => {
      if ((keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && state & Gdk.ModifierType.CONTROL_MASK) {
        this.submit(true);
        return true;
      }
      return false;
    });
    this.entry.add_controller(keys);
    column.append(this.entry);
    this.results = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, margin_top: 12, visible: false });
    column.append(this.results);
    this.body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    column.append(this.body);
    clamp.set_child(column);
    outer.append(clamp);
    this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: outer });
  }

  focusSearch(): void {
    this.entry.grab_focus();
  }

  show(space: Space | undefined): void {
    this.space = space;
    this.render();
  }

  private submit(alwaysAsk: boolean): void {
    const space = this.space;
    const q = this.query.trim();
    if (!space || !q) return;
    const first = space.catalogue ? search(q, allEntries(space.catalogue), 1)[0] : undefined;
    if (!alwaysAsk && first && opensFirst(q, first)) this.actions.open(space, first);
    else this.actions.ask(space, q);
    this.entry.set_text("");
  }

  private clear(box: any): void {
    let child = box.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      box.remove(child);
      child = next;
    }
  }

  private render(): void {
    this.clear(this.body);
    this.clear(this.results);
    const space = this.space;
    const c = space?.catalogue;
    if (!space || !c) return;
    const q = this.query.trim();
    this.results.set_visible(Boolean(q));
    this.body.set_visible(!q);
    if (q) return this.renderResults(space, q);

    // The panel's home screen, as the panel shows it.
    const home = panelScreens(c)[0];
    const byKey = new Map(allEntries(c).map((e) => [entryKey(e), e]));
    // Its tiles in order: apps, agents and the panel's own windows (`builtin:<name>`).
    const pinnedTiles: (Entry | (typeof BUILTINS)[number])[] = [];
    const pinnedWidgets: Widget[] = [];
    for (const key of home?.items ?? []) {
      const b = key.startsWith("builtin:") ? BUILTINS.find((x) => `builtin:${x.name}` === key) : undefined;
      const e = byKey.get(key);
      if (b) pinnedTiles.push(b);
      else if (e?.kind === "widget") {
        const w = c.widgets.find((x) => x.id === e.ref);
        if (w) pinnedWidgets.push(w);
      } else if (e) pinnedTiles.push(e);
    }
    if (pinnedTiles.length || pinnedWidgets.length) {
      this.body.append(sectionTitle(home?.name && home.name !== "Home" ? home.name : t("pinned")));
      if (pinnedWidgets.length) this.body.append(this.widgetCards(space, pinnedWidgets));
      if (pinnedTiles.length) {
        const box = flow(3, 10);
        for (const x of pinnedTiles) box.append("kind" in x ? this.tile(space, x) : this.builtinTile(space, x));
        this.body.append(box);
      }
    }
    const others = c.widgets.filter((w) => !pinnedWidgets.includes(w));
    if (others.length) {
      this.body.append(sectionTitle(t("widgets")));
      this.body.append(this.widgetCards(space, others));
    }
    this.body.append(sectionTitle(t("apps")));
    const apps = this.tiles(space, c.apps);
    for (const b of BUILTINS) apps.append(this.builtinTile(space, b));
    this.body.append(apps);
    if (c.agents.length) {
      this.body.append(sectionTitle(t("agents")));
      this.body.append(this.tiles(space, c.agents));
    }
    if (space.stale && space.catalogueAt) {
      const note = new Gtk.Label({ label: t("lastKnown", { when: relativeTime(space.catalogueAt, lang) }), xalign: 0, margin_top: 18 });
      note.add_css_class("dim-label");
      this.body.append(note);
    }
  }

  private renderResults(space: Space, q: string): void {
    const c = space.catalogue!;
    const found = search(q, allEntries(c));
    const ask = new Gtk.Button({ halign: Gtk.Align.FILL });
    ask.add_css_class("ask-row");
    ask.add_css_class(found.length && opensFirst(q, found[0]) ? "flat" : "suggested-action");
    const row = new Gtk.Box({ spacing: 10 });
    row.append(new Gtk.Image({ icon_name: "chat-message-new-symbolic", fallback: true } as never));
    row.append(new Gtk.Label({ label: t("askAssistant", { q }), xalign: 0, ellipsize: 3, hexpand: true }));
    ask.set_child(row);
    ask.connect("clicked", () => {
      this.actions.ask(space, q);
      this.entry.set_text("");
    });
    this.results.append(ask);
    if (!found.length) {
      const none = new Gtk.Label({ label: t("noMatches"), margin_top: 24 });
      none.add_css_class("dim-label");
      this.results.append(none);
      return;
    }
    const widgets = found.filter((e) => e.kind === "widget").map((e) => c.widgets.find((w) => w.id === e.ref)).filter((w): w is Widget => Boolean(w));
    const tiles = found.filter((e) => e.kind !== "widget");
    if (tiles.length) this.results.append(this.tiles(space, tiles));
    if (widgets.length) this.results.append(this.widgetCards(space, widgets));
  }

  private tiles(space: Space, entries: Entry[]): any {
    const box = flow(3, 10);
    for (const e of entries) box.append(this.tile(space, e));
    return box;
  }

  private tileButton(icon: any, title: string, tooltip: string, dot?: string): any {
    const button = new Gtk.Button({ tooltip_text: tooltip });
    button.add_css_class("flat");
    button.add_css_class("tile");
    const v = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.CENTER });
    const overlay = new Gtk.Overlay({ child: icon, halign: Gtk.Align.CENTER });
    if (dot) {
      const d = new Gtk.Box({ halign: Gtk.Align.END, valign: Gtk.Align.START });
      d.add_css_class("reach-dot");
      d.add_css_class(`reach-${dot}`);
      overlay.add_overlay(d);
    }
    v.append(overlay);
    const label = new Gtk.Label({ label: title, justify: Gtk.Justification.CENTER, wrap: true, lines: 2, ellipsize: 3, max_width_chars: 12, width_chars: 9 });
    label.add_css_class("tile-title");
    v.append(label);
    button.set_child(v);
    return button;
  }

  private tile(space: Space, e: Entry): any {
    const title = pickText(e.title, e.i18n, "title", lang);
    const detail = pickText(e.detail ?? "", e.i18n, "description", lang);
    const tooltip = [title, detail, e.peer ? `@${e.peer}` : ""].filter(Boolean).join("\n");
    const dot = e.reach === "down" || e.reach === "paused" || e.reach === "peer-offline" ? e.reach : undefined;
    const button = this.tileButton(iconWidget(e.icon, 56, space.client, e.kind === "agent" ? "avatar-default-symbolic" : "application-x-executable-symbolic"), title, tooltip, dot);
    button.connect("clicked", () => this.actions.open(space, e));
    if (e.kind === "app") {
      // Right-click: open in the browser instead.
      const click = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
      click.connect("pressed", () => {
        const pop = new Gtk.Popover({ has_arrow: true });
        const b = new Gtk.Button({ label: t("openInBrowser") });
        b.add_css_class("flat");
        b.connect("clicked", () => {
          pop.popdown();
          this.actions.openInBrowser(space, e);
        });
        pop.set_child(b);
        pop.set_parent(button);
        pop.connect("closed", () => pop.unparent());
        pop.popup();
      });
      button.add_controller(click);
    }
    return button;
  }

  private builtinTile(space: Space, b: (typeof BUILTINS)[number]): any {
    const icon = space.catalogue?.builtinIcons[b.name];
    const widget = icon ? iconWidget(icon, 56, space.client, b.icon) : (() => {
      const box = new Gtk.Box({ width_request: 56, height_request: 56, halign: Gtk.Align.CENTER });
      box.append(new Gtk.Image({ icon_name: b.icon, pixel_size: 34, hexpand: true }));
      return box;
    })();
    const button = this.tileButton(widget, b.label(), b.label());
    button.connect("clicked", () => this.actions.openBuiltin(b.name));
    return button;
  }

  private widgetCards(space: Space, widgets: Widget[]): any {
    const box = flow(1, 4);
    for (const w of widgets) {
      const button = new Gtk.Button();
      button.add_css_class("card");
      button.add_css_class("widget-card");
      const v = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
      const head = new Gtk.Box({ spacing: 8 });
      head.append(iconWidget(w.icon, 20, space.client, "view-grid-symbolic"));
      const title = new Gtk.Label({ label: pickText(w.title, w.i18n, "title", lang), xalign: 0, hexpand: true, ellipsize: 3 });
      title.add_css_class("heading");
      head.append(title);
      if (w.stale || w.ok === false) {
        const d = new Gtk.Box({ valign: Gtk.Align.CENTER });
        d.add_css_class("reach-dot");
        d.add_css_class(w.stale ? "reach-peer-offline" : "reach-down");
        head.append(d);
      }
      v.append(head);
      const lines = widgetLines(w, lang);
      for (const line of lines.length ? lines : ["—"]) {
        const l = new Gtk.Label({ label: line, xalign: 0, ellipsize: 3, single_line_mode: true });
        l.add_css_class("widget-line");
        if (!lines.length || w.error) l.add_css_class("dim-label");
        v.append(l);
      }
      button.set_child(v);
      button.connect("clicked", () => this.actions.open(space, widgetEntry(w)));
      box.append(button);
    }
    return box;
  }
}
