import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { canonicalItems } from "../core/agents.ts";
import { type Entry, type Widget, allEntries, entriesByKey, entryKey, fold, opensFirst, pageUrl, panelScreens, pickText, search, seededScreens, widgetEntry } from "../core/catalogue.ts";
import { signature } from "../core/change.ts";
import { relativeTime } from "../core/format.ts";
import { RESOLVE_AFTER_MS, RESOLVE_PATH, type ShortcutOffer, shortcutOffer } from "../core/shortcuts.ts";
import { type BuiltinName, HOME, LIBRARY, type Screen, builtinArt, move, newScreen, openingPage, pageAfter, pagesOf, pin, removeScreen, rename, screenTitle, unpin } from "../core/screens.ts";
import { lang, logError, prefs, t, tw } from "./env.ts";
import { builtinTexture, iconWidget } from "./icons.ts";
import { collectSoon } from "./memory.ts";
import type { AppModel, Space } from "./model.ts";
import { ScreenStore } from "./screen-store.ts";
import { WidgetCards } from "./widget-card.ts";

/**
 * Home, laid out as the Mac's launcher: pages side by side, moved through with a sideways swipe
 * on the touchpad, the dots above them, or Ctrl+Page Up and Ctrl+Page Down. The first page is the
 * library of every app, agent and widget with the command box (docs/panel.md#omnibox); each screen
 * is a page of its own, and the window opens on the first one, which carries the command box too
 * (while it holds a query that page shows the matches instead of the screen). A screen draws its
 * tiles in one grid and its widget cards below, in its order. The screens are this computer's
 * (ScreenStore): copied from the panel once, then changed here without touching the Space.
 * Right-click a tile or a card to add it to a screen or take it off; the ⋯ button and a
 * right-click on a screen's empty part hold the screen's own actions.
 */

export type Builtin = BuiltinName;

export type HomeActions = {
  open: (space: Space, entry: Entry) => void;
  openBuiltin: (name: Builtin) => void;
  ask: (space: Space, text: string) => void;
  openInBrowser: (space: Space, entry: Entry) => void;
  /** A link of a widget (a row, a block), opened as the app's tab or in the browser. */
  openLink: (space: Space, url: string) => void;
  /** The panel's Shortcuts page on the action the sentence names, its form filled from it (core/shortcuts.ts). */
  runShortcut: (space: Space, text: string) => void;
};

/**
 * The panel's own tiles, in its order, and the web panel's. They are drawn with the picture the
 * Space names for them (`builtins` of `GET /api/apps`, an icon pack's included), else the panel's
 * own, shipped with the app; `icon` is the glyph of a tile with neither.
 */
const BUILTINS: { name: Builtin; icon: string; label: () => string }[] = [
  { name: "store", icon: "system-software-install-symbolic", label: () => tw("store.title") },
  { name: "inbox", icon: "mail-unread-symbolic", label: () => t("inbox") },
  { name: "shortcuts", icon: "starred-symbolic", label: () => t("shortcuts") },
  { name: "terminal", icon: "utilities-terminal-symbolic", label: () => t("terminal") },
  { name: "panel", icon: "view-grid-symbolic", label: () => t("panel") },
  { name: "settings", icon: "emblem-system-symbolic", label: () => t("settings") },
];

/** How often, and how many times, Home looks whether its carousel reached the page it opens on (syncPages). */
const PLACE_MS = 100;
const PLACE_TRIES = 30;

type Tile = { entry: Entry } | { builtin: (typeof BUILTINS)[number] };

/** `key` is what the page draws now: it is drawn again only when that changes. */
type Page = { id: string; widget: any; body: any; entry?: any; key?: string; note?: any };

function flow(min: number, max: number, spacing = 4, homogeneous = true): any {
  return new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous, min_children_per_line: min, max_children_per_line: max, column_spacing: spacing, row_spacing: spacing, valign: Gtk.Align.START });
}

function sectionTitle(text: string): any {
  const l = new Gtk.Label({ label: text, xalign: 0 });
  l.add_css_class("section-title");
  return l;
}

function clear(box: any): void {
  let child = box.get_first_child();
  while (child) {
    const next = child.get_next_sibling();
    box.remove(child);
    child = next;
  }
}

/** How long the ages on Home ("5 min ago") may stand before the pages are drawn again. */
const AGES_MS = 5 * 60_000;

const titles = { main: t("screenMain"), numbered: (n: number) => t("screenN", { n }) };

export class HomePage {
  readonly widget: any;
  private readonly carousel: any;
  private readonly dots: any;
  private readonly menuButton: any;
  private readonly store = new ScreenStore();
  private readonly cards: WidgetCards;
  private pages: Page[] = [];
  private space: Space | undefined;
  private query = "";
  /** What the Space said the text runs (core/shortcuts.ts), for the text it answered. */
  private offer: { q: string; offer: ShortcutOffer | null } | undefined;
  private resolveTimer = 0;
  /** The page on show, by id: the window opens on the home screen (openingPage), never on the library. */
  private shownId = openingPage([]);
  /** While the pages are first placed, the page they are headed for: the carousel's own reports of page 0 meanwhile are not a swipe. */
  private placing: string | undefined;
  /** What the dots show now. */
  private dotsKey = "";
  /** Which stretch of AGES_MS the ages on the pages were written in (tick). */
  private ages = Math.floor(Date.now() / AGES_MS);

  constructor(
    readonly model: AppModel,
    private readonly actions: HomeActions,
  ) {
    this.cards = new WidgetCards({
      open: (w, link) => {
        const space = this.space;
        if (!space) return;
        if (link) this.actions.openLink(space, link);
        else this.actions.open(space, widgetEntry(w));
      },
    });
    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    const bar = new Gtk.CenterBox({ margin_top: 6, margin_start: 12, margin_end: 12 });
    this.dots = new Gtk.Box({ spacing: 2, halign: Gtk.Align.CENTER });
    bar.set_center_widget(this.dots);
    this.menuButton = new Gtk.Button({ icon_name: "view-more-symbolic", tooltip_text: t("screenActions"), css_classes: ["flat", "circular"] });
    this.menuButton.connect("clicked", () => this.screenMenu(this.menuButton));
    bar.set_end_widget(this.menuButton);
    this.widget.append(bar);
    this.carousel = new Adw.Carousel({ vexpand: true, hexpand: true, allow_scroll_wheel: false, allow_long_swipes: false, reveal_duration: 200 });
    this.carousel.connect("page-changed", (_c: unknown, index: number) => {
      const page = this.pages[index];
      if (!page || (this.placing && page.id !== this.placing)) return;
      this.shownId = page.id;
      this.renderDots();
    });
    this.widget.append(this.carousel);
    this.store.on(() => this.render());
    model.on((change) => {
      if (change === "connections") {
        this.store.keepOnly(model.list.connections.map((c) => c.id));
        this.cards.keepSpaces(model.list.connections.map((c) => c.id));
      }
    });
  }

  // Outside calls

  /** Puts text in the command box as if typed (the hidden `--action query=<text>`). */
  setQuery(text: string): void {
    const page = this.pageOf(this.shownId === LIBRARY ? LIBRARY : HOME);
    if (this.shownId !== LIBRARY) this.showPage(HOME, false);
    page?.entry?.set_text(text);
    page?.entry?.grab_focus();
  }

  focusSearch(): void {
    // The box on the page on show, else the first screen's.
    const page = this.pageOf(this.shownId === LIBRARY ? LIBRARY : HOME);
    if (this.shownId !== LIBRARY && this.shownId !== HOME) this.showPage(HOME, true);
    page?.entry?.grab_focus();
  }

  /** The next page (1) or the previous one (-1). */
  step(by: number): void {
    const i = this.pages.findIndex((p) => p.id === this.shownId);
    const next = this.pages[i + by];
    if (next) this.showPage(next.id, true);
  }

  show(space: Space | undefined): void {
    // Another Space, and the first one after the welcome screen, opens on its home screen.
    const opening = space !== this.space;
    if (opening) this.query = "";
    this.space = space;
    if (space?.catalogue) {
      this.store.seed(space.conn.id, panelScreens(space.catalogue), seededScreens(space.catalogue));
      // What the App Store installed since, and pinned to the panel's home screen, lands on this one
      // too; a catalogue from disk, of an earlier day, says nothing new.
      if (!space.stale) this.store.adopt(space.conn.id, space.catalogue.apps.map(entryKey), panelScreens(space.catalogue));
      // A screen pinned with one machine's variant of an agent shows the agent's single tile (agents.ts).
      const groups = space.catalogue.agentGroups;
      const screens = this.store.screens(space.conn.id);
      if (groups.length && screens.some((sc) => canonicalItems(sc.items, groups).join("\n") !== sc.items.join("\n"))) {
        this.store.edit(space.conn.id, (all) => all.map((sc) => ({ ...sc, items: canonicalItems(sc.items, groups) })));
      }
    }
    if (opening && space) {
      const first = openingPage(this.store.screens(space.conn.id));
      // With the same pages as the Space before, syncPages moves nothing: go there by hand.
      if (this.shownId !== first && this.pageOf(first)) this.showPage(first, false);
      else this.shownId = first;
    }
    this.render();
  }

  // Pages

  private pageOf(id: string): Page | undefined {
    return this.pages.find((p) => p.id === id);
  }

  private showPage(id: string, animate: boolean): void {
    const page = this.pageOf(id);
    if (!page) return;
    this.placing = undefined;
    this.shownId = id;
    this.carousel.scroll_to(page.widget, animate);
    this.renderDots();
  }

  private makePage(id: string): Page {
    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    let entry: any;
    if (id === LIBRARY || id === HOME) {
      entry = this.searchEntry();
      column.append(entry);
    }
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    column.append(body);
    const clamp = new Adw.Clamp({ maximum_size: 1120, tightening_threshold: 700, margin_start: 16, margin_end: 16, margin_top: 10, margin_bottom: 24, child: column });
    const scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, hexpand: true, child: clamp });
    if (id !== LIBRARY) {
      // The empty part of a screen takes the right click; a tile or a card keeps its own.
      const click = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
      click.connect("pressed", (g: any, _n: number, x: number, y: number) => this.screenMenu(g.get_widget(), { x, y }));
      scroller.add_controller(click);
    }
    return { id, widget: scroller, body, entry };
  }

  /** One page per screen after the library; rebuilt only when the screens themselves change. */
  private syncPages(screens: Screen[]): void {
    const ids = pagesOf(screens);
    if (ids.join("\n") === this.pages.map((p) => p.id).join("\n")) return;
    const keep = new Map(this.pages.map((p) => [p.id, p]));
    for (const p of this.pages) this.carousel.remove(p.widget);
    this.pages = ids.map((id) => keep.get(id) ?? this.makePage(id));
    for (const p of this.pages) this.carousel.append(p.widget);
    this.shownId = pageAfter(this.shownId, screens);
    // The carousel's first page is the library, and it only knows where the others are once it
    // has a size and its new pages have grown to theirs (`reveal_duration`); a jump made before
    // that goes nowhere or is cut short. So the jump is made again until the carousel is on the
    // page and stays there, for at most PLACE_TRIES looks: a slow first start (the first launch,
    // with the Space still answering) would otherwise leave the window on the library.
    const target = this.shownId;
    this.placing = target;
    let tries = 0;
    let there = 0;
    const place = () => {
      // The pages changed again, or the person went to a page: that one decides now.
      if (this.placing !== target) return GLib.SOURCE_REMOVE;
      const page = this.pageOf(target);
      if (!page || this.shownId !== target) {
        this.placing = undefined;
        return GLib.SOURCE_REMOVE;
      }
      if (Math.abs(this.carousel.position - this.pages.indexOf(page)) > 0.01) {
        there = 0;
        this.carousel.scroll_to(page.widget, false);
      } else there++;
      // On the page at two looks in a row, and past the time the pages take to grow.
      if (++tries >= PLACE_TRIES || (there >= 2 && tries * PLACE_MS >= 400)) {
        this.placing = undefined;
        return GLib.SOURCE_REMOVE;
      }
      return GLib.SOURCE_CONTINUE;
    };
    const settle = () => {
      GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
        if (this.placing === target && this.shownId === target) {
          const page = this.pageOf(target);
          if (page && Math.abs(this.carousel.position - this.pages.indexOf(page)) > 0.01) this.carousel.scroll_to(page.widget, false);
        }
        return GLib.SOURCE_REMOVE;
      });
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLACE_MS, place);
    };
    if (this.carousel.get_mapped()) settle();
    else {
      const id = this.carousel.connect("map", () => {
        this.carousel.disconnect(id);
        settle();
      });
    }
  }

  private renderDots(): void {
    const space = this.space;
    const screens = space ? this.store.screens(space.conn.id) : [];
    const key = space ? signature([space.conn.id, this.shownId, screens.map((s) => [s.id, s.name])]) : "";
    if (key === this.dotsKey) return;
    this.dotsKey = key;
    clear(this.dots);
    if (!space) return;
    const dot = (id: string, tooltip: string, child: any) => {
      const b = new Gtk.Button({ child, tooltip_text: tooltip, css_classes: ["flat", "pager-dot"] });
      if (id === this.shownId) b.add_css_class("active");
      b.connect("clicked", () => this.showPage(id, true));
      this.dots.append(b);
    };
    dot(LIBRARY, t("library"), new Gtk.Image({ icon_name: "view-app-grid-symbolic", pixel_size: 14 }));
    screens.forEach((s, i) => dot(s.id, screenTitle(screens, i, titles), new Gtk.Label({ label: "●" })));
    this.menuButton.set_visible(this.shownId !== LIBRARY);
  }

  // The command box

  private searchEntry(): any {
    const entry = new Gtk.SearchEntry({ placeholder_text: t("searchPlaceholder"), hexpand: true, margin_bottom: 8 });
    entry.add_css_class("home-search");
    entry.connect("search-changed", () => {
      const q = entry.get_text();
      if (q === this.query) return;
      this.query = q;
      this.resolveSoon();
      // Both boxes hold the same query.
      for (const p of this.pages) if (p.entry && p.entry !== entry && p.entry.get_text() !== q) p.entry.set_text(q);
      this.render();
    });
    entry.connect("activate", () => void this.submit(false));
    entry.connect("stop-search", () => entry.set_text(""));
    // Ctrl+Return always asks the assistant.
    const keys = new Gtk.EventControllerKey();
    keys.connect("key-pressed", (_c: unknown, keyval: number, _code: number, state: number) => {
      if ((keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter) && state & Gdk.ModifierType.CONTROL_MASK) {
        void this.submit(true);
        return true;
      }
      return false;
    });
    entry.add_controller(keys);
    return entry;
  }

  private clearQuery(): void {
    for (const p of this.pages) p.entry?.set_text("");
    this.query = "";
  }

  /** Asks the Space what the text runs, once typing pauses; an answer for a text no longer in the box is dropped. */
  private resolveSoon(): void {
    if (this.resolveTimer) GLib.source_remove(this.resolveTimer);
    this.resolveTimer = 0;
    const q = this.query.trim();
    if (!q || this.offer?.q === q) return;
    this.resolveTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESOLVE_AFTER_MS, () => {
      this.resolveTimer = 0;
      void this.resolve(q);
      return GLib.SOURCE_REMOVE;
    });
  }

  private async resolve(q: string): Promise<ShortcutOffer | null> {
    const space = this.space;
    if (!space) return null;
    if (this.offer?.q === q) return this.offer.offer;
    try {
      const answer = await space.client.send("POST", RESOLVE_PATH, { text: q, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
      const offer = shortcutOffer(answer, lang, t("calculator"));
      if (this.query.trim() === q) {
        this.offer = { q, offer };
        this.render();
      }
      return offer;
    } catch (e) {
      // An older Space has no resolver, or it does not answer: the box searches the library as before.
      logError(e, "shortcuts");
      return null;
    }
  }

  private async submit(alwaysAsk: boolean): Promise<void> {
    const space = this.space;
    const q = this.query.trim();
    if (!space || !q) return;
    if (!alwaysAsk && (await this.resolve(q))) {
      if (this.query.trim() !== q) return;
      this.actions.runShortcut(space, q);
      this.clearQuery();
      this.render();
      return;
    }
    if (this.query.trim() !== q) return;
    const first = space.catalogue ? search(q, allEntries(space.catalogue), 1)[0] : undefined;
    if (!alwaysAsk && first && opensFirst(q, first)) this.actions.open(space, first);
    else this.actions.ask(space, q);
    this.clearQuery();
    this.render();
  }

  // Drawing

  /**
   * Draws each page whose content changed since it was last drawn: the catalogue (a new version
   * only when it differs), the page's screen, the query, the widgets switch. The Space is looked at
   * every 30 seconds and the answer is nearly always the same, so nearly always nothing is drawn.
   */
  private render(): void {
    const space = this.space;
    const c = space?.catalogue;
    if (!space || !c) {
      for (const p of this.pages) this.empty(p);
      this.renderDots();
      collectSoon();
      return;
    }
    const screens = this.store.screens(space.conn.id);
    this.syncPages(screens);
    const q = this.query.trim();
    let drawn = false;
    for (const page of this.pages) {
      const index = screens.findIndex((s) => s.id === page.id);
      const query = page.id === LIBRARY || page.id === HOME ? q : "";
      const offer = query && this.offer?.q === query ? this.offer.offer : null;
      const key = signature([space.conn.id, space.catalogueVersion, space.stale, query, offer, page.id === LIBRARY ? null : (screens[index] ?? null), prefs.noWidgets === true, this.ages]);
      if (key === page.key) continue;
      this.empty(page);
      page.key = key;
      drawn = true;
      this.cards.page = page.id;
      if (page.id === LIBRARY) {
        if (q) this.results(space, page.body, q);
        else this.library(space, page.body);
      } else if (page.id === HOME && q) this.results(space, page.body, q);
      else this.screen(space, page.body, screens, index);
      if (space.stale && space.catalogueAt) {
        page.note = new Gtk.Label({ label: t("lastKnown", { when: relativeTime(space.catalogueAt, lang) }), xalign: 0, margin_top: 18 });
        page.note.add_css_class("dim-label");
        page.body.append(page.note);
      }
    }
    if (drawn) {
      // Web views of widgets no page draws any more are closed; the widgets dropped are collected.
      this.cards.keepOnly(space.conn.id, new Set(this.pages.map((p) => p.id)));
      collectSoon();
    }
    this.renderDots();
  }

  /** A page with nothing drawn on it, to be drawn again. */
  private empty(page: Page): void {
    this.cards.release(page.id);
    clear(page.body);
    page.key = undefined;
    page.note = undefined;
  }

  /**
   * Once a minute: "last known … ago" moves on in place, and every few minutes the pages are drawn
   * again so the ages on the cards ("5 min") move on too, even when nothing new came.
   */
  tick(): void {
    const space = this.space;
    if (space?.stale && space.catalogueAt) for (const p of this.pages) p.note?.set_label(t("lastKnown", { when: relativeTime(space.catalogueAt, lang) }));
    const ages = Math.floor(Date.now() / AGES_MS);
    if (ages === this.ages) return;
    this.ages = ages;
    this.render();
  }

  /** Everything the Space has, pinned or not: apps with the panel's own tiles, agents, widgets. */
  private library(space: Space, body: any): void {
    const c = space.catalogue!;
    body.append(sectionTitle(t("apps")));
    body.append(this.grid(space, [...c.apps.map((entry) => ({ entry })), ...BUILTINS.map((builtin) => ({ builtin }))], undefined));
    if (c.agents.length) {
      body.append(sectionTitle(t("agents")));
      body.append(this.grid(space, c.agents.map((entry) => ({ entry })), undefined));
    }
    if (c.widgets.length) {
      body.append(sectionTitle(t("widgets")));
      body.append(this.widgetGrid(space, c.widgets, undefined));
    }
  }

  /** What matches the query, best names first, under the row that asks Space Assistant. */
  private results(space: Space, body: any, q: string): void {
    const c = space.catalogue!;
    const found = search(q, allEntries(c));
    // The action the text names takes Enter, before a library match and the assistant.
    const offer = this.offer?.q === q ? this.offer.offer : null;
    if (offer) {
      const run = new Gtk.Button({ halign: Gtk.Align.FILL, margin_bottom: 6, tooltip_text: t("enterRuns") });
      run.add_css_class("ask-row");
      run.add_css_class("suggested-action");
      const line = new Gtk.Box({ spacing: 10 });
      line.append(new Gtk.Image({ icon_name: "starred-symbolic" }));
      const words = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
      const title = new Gtk.Label({ label: offer.title, xalign: 0, ellipsize: 3 });
      title.add_css_class("heading");
      words.append(title);
      if (offer.detail) words.append(new Gtk.Label({ label: offer.detail, xalign: 0, ellipsize: 3 }));
      line.append(words);
      run.set_child(line);
      run.connect("clicked", () => {
        this.actions.runShortcut(space, q);
        this.clearQuery();
        this.render();
      });
      body.append(run);
    }
    const ask = new Gtk.Button({ halign: Gtk.Align.FILL, margin_bottom: 6 });
    ask.add_css_class("ask-row");
    ask.add_css_class(offer || (found.length && opensFirst(q, found[0])) ? "flat" : "suggested-action");
    const row = new Gtk.Box({ spacing: 10 });
    row.append(new Gtk.Image({ icon_name: "chat-message-new-symbolic" }));
    row.append(new Gtk.Label({ label: t("askAssistant", { q }), xalign: 0, ellipsize: 3, hexpand: true }));
    ask.set_child(row);
    ask.connect("clicked", () => {
      this.actions.ask(space, q);
      this.clearQuery();
      this.render();
    });
    body.append(ask);
    const f = fold(q);
    const builtins = BUILTINS.filter((b) => fold(b.label()).includes(f) || b.name.startsWith(f));
    const tiles: Tile[] = [...found.filter((e) => e.kind !== "widget").map((entry) => ({ entry })), ...builtins.map((builtin) => ({ builtin }))];
    const widgets = found.filter((e) => e.kind === "widget").map((e) => c.widgets.find((w) => w.id === e.ref)).filter((w): w is Widget => Boolean(w));
    if (!tiles.length && !widgets.length) {
      const none = new Gtk.Label({ label: t("noMatches"), margin_top: 24 });
      none.add_css_class("dim-label");
      body.append(none);
      return;
    }
    if (tiles.length) body.append(this.grid(space, tiles, undefined));
    if (widgets.length) body.append(this.widgetGrid(space, widgets, undefined));
  }

  /** One screen: its tiles in one grid, its widget cards below, in the screen's order. */
  private screen(space: Space, body: any, screens: Screen[], index: number): void {
    const screen = screens[index];
    if (!screen) return;
    const c = space.catalogue!;
    const byKey = entriesByKey(c);
    const tiles: Tile[] = [];
    const widgets: Widget[] = [];
    for (const key of screen.items) {
      const b = BUILTINS.find((x) => `builtin:${x.name}` === key);
      if (b) {
        tiles.push({ builtin: b });
        continue;
      }
      const e = byKey.get(key);
      if (!e) continue;
      if (e.kind === "widget") {
        // Settings › General › Widgets off: the screen keeps its tiles only.
        const w = prefs.noWidgets ? undefined : c.widgets.find((x) => x.id === e.ref);
        if (w) widgets.push(w);
      } else tiles.push({ entry: e });
    }
    if (screen.name) body.append(sectionTitle(screen.name));
    if (tiles.length) body.append(this.grid(space, tiles, screen.id));
    if (widgets.length) {
      const grid = this.widgetGrid(space, widgets, screen.id);
      grid.set_margin_top(14);
      body.append(grid);
    }
    if (!tiles.length && !widgets.length) {
      const empty = new Adw.StatusPage({ icon_name: "view-app-grid-symbolic", title: t("screenEmpty"), description: t("screenEmptyBody"), vexpand: true });
      const open = new Gtk.Button({ label: t("openLibrary"), halign: Gtk.Align.CENTER, css_classes: ["pill", "suggested-action"] });
      open.connect("clicked", () => this.showPage(LIBRARY, true));
      empty.set_child(open);
      body.append(empty);
    }
  }

  private grid(space: Space, tiles: Tile[], screen: string | undefined): any {
    const box = flow(3, 10);
    for (const x of tiles) box.append("entry" in x ? this.tile(space, x.entry, screen) : this.builtinTile(space, x.builtin, screen));
    return box;
  }

  private widgetGrid(space: Space, widgets: Widget[], screen: string | undefined): any {
    // Each row of cards as tall as its tallest card, not the tallest card of all.
    const box = flow(1, 3, 12, false);
    for (const w of widgets) {
      const card = this.cards.card(space, w);
      this.onRightClick(card, (anchor, x, y) => this.entryMenu(anchor, space, widgetEntry(w), screen, { x, y }));
      box.append(card);
    }
    return box;
  }

  private tileButton(icon: any, title: string, tooltip: string | undefined, dot?: string): any {
    const button = new Gtk.Button({ ...(tooltip ? { tooltip_text: tooltip } : {}) });
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

  private tile(space: Space, e: Entry, screen: string | undefined): any {
    const title = pickText(e.title, e.i18n, "title", lang);
    const detail = pickText(e.detail ?? "", e.i18n, "description", lang);
    // The library's tiles tell what they are; a screen's show none, as on the Mac.
    const where = e.machines ? tw("agents.onMachines", { machines: e.machines.map((m) => m || tw("agents.thisMachine")).join(lang === "zh" ? "、" : ", ") }) : e.peer ? `@${e.peer}` : "";
    const tooltip = screen ? undefined : [title, detail, where].filter(Boolean).join("\n");
    const dot = e.reach === "down" || e.reach === "paused" || e.reach === "peer-offline" ? e.reach : undefined;
    const button = this.tileButton(iconWidget(e.icon, 56, space.client, e.kind === "agent" ? "avatar-default-symbolic" : "application-x-executable-symbolic", false, e.kind === "agent"), title, tooltip, dot);
    button.connect("clicked", () => this.actions.open(space, e));
    this.onRightClick(button, (anchor, x, y) => this.entryMenu(anchor, space, e, screen, { x, y }));
    return button;
  }

  /** A built-in tile's picture: the Space's own for it, the panel's until that loads or with none, else the glyph. */
  private builtinIcon(space: Space, b: (typeof BUILTINS)[number], size: number): any {
    const icon = space.catalogue?.builtinIcons[b.name];
    const art = builtinTexture(builtinArt(b.name), size);
    if (icon || art) return iconWidget(icon, size, space.client, b.icon, false, false, art);
    const box = new Gtk.Box({ width_request: size, height_request: size, halign: Gtk.Align.CENTER });
    box.append(new Gtk.Image({ icon_name: b.icon, pixel_size: Math.round(size * 0.6), hexpand: true }));
    return box;
  }

  private builtinTile(space: Space, b: (typeof BUILTINS)[number], screen: string | undefined): any {
    const button = this.tileButton(this.builtinIcon(space, b, 56), b.label(), screen ? undefined : b.label());
    button.connect("clicked", () => this.actions.openBuiltin(b.name));
    this.onRightClick(button, (anchor, x, y) => this.pinMenu(anchor, space, `builtin:${b.name}`, screen, { x, y }, () => this.actions.openBuiltin(b.name)));
    return button;
  }

  // Menus

  /**
   * A right click on `widget`. The handler is handed the widget instead of holding it: a gesture's
   * handler that held its own widget would keep it, and the whole tile or card, alive for good (the
   * widget holds the gesture, and GJS keeps the handler of an object something else holds).
   */
  private onRightClick(widget: any, run: (anchor: any, x: number, y: number) => void): void {
    const click = new Gtk.GestureClick({ button: Gdk.BUTTON_SECONDARY });
    click.connect("pressed", (g: any, _n: number, x: number, y: number) => {
      g.set_state(Gtk.EventSequenceState.CLAIMED);
      run(g.get_widget(), x, y);
    });
    widget.add_controller(click);
  }

  private popover(anchor: any, at?: { x: number; y: number }): { pop: any; box: any; item: (label: string, run: () => void, destructive?: boolean) => void; separator: () => void } {
    const pop = new Gtk.Popover({ has_arrow: !at });
    if (at) pop.set_pointing_to(new Gdk.Rectangle({ x: Math.round(at.x), y: Math.round(at.y), width: 1, height: 1 }));
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
    pop.set_child(box);
    pop.set_parent(anchor);
    pop.connect("closed", () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (pop.unparent(), GLib.SOURCE_REMOVE)));
    const item = (label: string, run: () => void, destructive = false) => {
      const b = new Gtk.Button({ child: new Gtk.Label({ label, xalign: 0 }), css_classes: ["flat", ...(destructive ? ["destructive-action"] : [])] });
      // The button finds its popover rather than holding it, so the closed menu can be collected.
      b.connect("clicked", (button: any) => {
        button.get_ancestor(Gtk.Popover.$gtype)?.popdown();
        run();
      });
      box.append(b);
    };
    const separator = () => box.append(new Gtk.Separator({ margin_top: 3, margin_bottom: 3 }));
    return { pop, box, item, separator };
  }

  private toggle(space: Space, screen: string, key: string): void {
    this.store.edit(space.conn.id, (all) => (all.find((s) => s.id === screen)?.items.includes(key) ? unpin(all, screen, key) : pin(all, screen, key)));
  }

  /** The screens part of a menu: take it off this screen, or put it on (or off) any of them. */
  private screenItems(m: ReturnType<HomePage["popover"]>, space: Space, key: string, screen: string | undefined): void {
    const screens = this.store.screens(space.conn.id);
    if (screen) m.item(t("removeFromScreen"), () => this.store.edit(space.conn.id, (all) => unpin(all, screen, key)));
    if (screens.length <= 1) {
      if (!screen) {
        const on = screens[0]?.items.includes(key);
        m.item(on ? t("removeFromMain") : t("addToMain"), () => this.toggle(space, HOME, key));
      }
      return;
    }
    const heading = new Gtk.Label({ label: t("addToScreen"), xalign: 0, margin_start: 10, margin_top: 4 });
    heading.add_css_class("caption-heading");
    heading.add_css_class("dim-label");
    m.box.append(heading);
    screens.forEach((s, i) => {
      const check = new Gtk.CheckButton({ label: screenTitle(screens, i, titles), active: s.items.includes(key), margin_start: 6 });
      check.connect("toggled", () => this.toggle(space, s.id, key));
      m.box.append(check);
    });
  }

  private pinMenu(anchor: any, space: Space, key: string, screen: string | undefined, at: { x: number; y: number }, open: () => void): void {
    const m = this.popover(anchor, at);
    m.item(t("open"), open);
    m.separator();
    this.screenItems(m, space, key, screen);
    m.pop.popup();
  }

  private entryMenu(anchor: any, space: Space, e: Entry, screen: string | undefined, at: { x: number; y: number }): void {
    const m = this.popover(anchor, at);
    m.item(t("open"), () => this.actions.open(space, e));
    m.separator();
    this.screenItems(m, space, entryKey(e), screen);
    const url = e.kind === "agent" ? undefined : pageUrl(e.link, space.client.base, lang);
    if (url) {
      m.separator();
      m.item(t("openInBrowser"), () => this.actions.openInBrowser(space, e));
      m.item(t("copyLink"), () => anchor.get_clipboard().set(url));
    }
    m.pop.popup();
  }

  /** The actions on the screen on show: from the ⋯ button or a right click on the screen. */
  private screenMenu(anchor: any, at?: { x: number; y: number }): void {
    const space = this.space;
    if (!space?.catalogue || this.shownId === LIBRARY) return;
    const conn = space.conn.id;
    const screens = this.store.screens(conn);
    const id = this.shownId;
    const index = screens.findIndex((s) => s.id === id);
    if (index < 0) return;
    const m = this.popover(anchor, at);
    m.item(t("newScreen"), () => {
      const made = newScreen(this.store.screens(conn));
      if (!made) return;
      this.shownId = made.id;
      this.store.edit(conn, () => made.screens);
    });
    m.item(t("renameScreen"), () => this.renameScreen(space, id));
    m.item(t("editScreen"), () => this.editScreen(space, id));
    m.item(t("copyPanelLayout"), () => this.confirm(t("copyPanelLayoutTitle"), t("copyPanelLayoutBody"), t("replace"), () => this.store.reset(conn, panelScreens(space.catalogue!))));
    if (id !== HOME) {
      m.separator();
      m.item(
        t("deleteScreen"),
        () =>
          this.confirm(t("deleteScreenTitle"), t("deleteScreenBody"), t("deleteScreen"), () => {
            this.shownId = screens[index - 1]?.id ?? HOME;
            this.store.edit(conn, (all) => removeScreen(all, id));
          }),
        true,
      );
    }
    m.pop.popup();
  }

  private confirm(heading: string, body: string, action: string, run: () => void): void {
    const d = new Adw.AlertDialog({ heading, body });
    d.add_response("cancel", t("cancel"));
    d.add_response("ok", action);
    d.set_response_appearance("ok", Adw.ResponseAppearance.DESTRUCTIVE);
    d.set_default_response("cancel");
    d.connect("response", (_d: unknown, r: string) => r === "ok" && run());
    d.present(this.widget);
  }

  private renameScreen(space: Space, id: string): void {
    const screens = this.store.screens(space.conn.id);
    const index = screens.findIndex((s) => s.id === id);
    const d = new Adw.AlertDialog({ heading: t("renameScreen").replace(/…$/, ""), body: t("renameScreenBody") });
    const entry = new Gtk.Entry({ text: screens[index]?.name ?? "", placeholder_text: screenTitle(screens.map((s) => ({ ...s, name: "" })), index, titles), activates_default: true });
    d.set_extra_child(entry);
    d.add_response("cancel", t("cancel"));
    d.add_response("ok", t("save"));
    d.set_response_appearance("ok", Adw.ResponseAppearance.SUGGESTED);
    d.set_default_response("ok");
    d.connect("response", (_d: unknown, r: string) => r === "ok" && this.store.edit(space.conn.id, (all) => rename(all, id, entry.get_text())));
    d.present(this.widget);
  }

  /** One screen's entries as a list to put in order and take off; tiles and widgets apart, as the screen draws them. */
  private editScreen(space: Space, id: string): void {
    const conn = space.conn.id;
    const dialog = new Adw.PreferencesDialog({ title: t("editScreen").replace(/…$/, ""), search_enabled: false, content_width: 460, content_height: 560 });
    const page = new Adw.PreferencesPage();
    dialog.add(page);
    let groups: any[] = [];
    const draw = () => {
      for (const g of groups) page.remove(g);
      groups = [];
      const c = space.catalogue;
      const screens = this.store.screens(conn);
      const screen = screens.find((s) => s.id === id);
      if (!c || !screen) return;
      const byKey = entriesByKey(c);
      const shownKeys = screen.items.filter((k) => byKey.has(k) || BUILTINS.some((b) => k === `builtin:${b.name}`));
      const tiles = shownKeys.filter((k) => byKey.get(k)?.kind !== "widget");
      const widgets = shownKeys.filter((k) => byKey.get(k)?.kind === "widget");
      const group = (title: string, keys: string[]) => {
        const g = new Adw.PreferencesGroup({ title });
        keys.forEach((key, i) => {
          const e = byKey.get(key);
          const b = BUILTINS.find((x) => `builtin:${x.name}` === key);
          const row = new Adw.ActionRow({ title: e ? pickText(e.title, e.i18n, "title", lang) : (b?.label() ?? key), subtitle: e?.peer ?? "", use_markup: false });
          row.add_prefix(e ? iconWidget(e.icon, 28, space.client, e.kind === "agent" ? "avatar-default-symbolic" : "application-x-executable-symbolic", false, e.kind === "agent") : b ? this.builtinIcon(space, b, 28) : new Gtk.Image({ icon_name: "view-grid-symbolic", pixel_size: 22 }));
          const button = (icon: string, tip: string, sensitive: boolean, run: () => void) => {
            const btn = new Gtk.Button({ icon_name: icon, tooltip_text: tip, valign: Gtk.Align.CENTER, sensitive, css_classes: ["flat"] });
            btn.connect("clicked", run);
            row.add_suffix(btn);
          };
          button("go-up-symbolic", t("moveUp"), i > 0, () => this.store.edit(conn, (all) => move(all, id, keys, i, i - 1)));
          button("go-down-symbolic", t("moveDown"), i < keys.length - 1, () => this.store.edit(conn, (all) => move(all, id, keys, i, i + 1)));
          button("list-remove-symbolic", t("removeFromScreen"), true, () => this.store.edit(conn, (all) => unpin(all, id, key)));
          g.add(row);
        });
        page.add(g);
        groups.push(g);
      };
      if (tiles.length) group(t("appsAndAgents"), tiles);
      if (widgets.length) group(t("widgets"), widgets);
      const note = new Adw.PreferencesGroup({ description: shownKeys.length ? t("editScreenNote") : t("screenEmpty") });
      page.add(note);
      groups.push(note);
    };
    draw();
    const off = this.store.on(draw);
    dialog.connect("closed", off);
    dialog.present(this.widget);
  }
}
