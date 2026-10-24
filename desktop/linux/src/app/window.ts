import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { type Agent, type Entry, pageUrl, pickText } from "../core/catalogue.ts";
import type { DeepLink, InboxItem } from "../core/desktop.ts";
import { relativeTime } from "../core/format.ts";
import { ChatPage } from "./chat-page.ts";
import { lang, openExternally, prefs, savePrefs, t } from "./env.ts";
import { type Builtin, HomePage } from "./home.ts";
import { InboxPage } from "./inbox.ts";
import type { LocalManager } from "./local-manager.ts";
import type { AppModel, Space } from "./model.ts";
import { showSettings } from "./settings.ts";
import { WebTabs } from "./tabs.ts";
import { TerminalPage } from "./terminal.ts";
import { WelcomePage } from "./welcome.ts";

/**
 * The main window: Home, Chat, Inbox, Terminal and the open Pages as views switched from the
 * header (from a bar at the bottom on a narrow window), the Space menu at the start of the
 * header, and a banner when the Space needs a sign-in, cannot be reached or shows what was last
 * known. Before any Space is saved it shows the welcome screen instead.
 */

export type View = "home" | "chat" | "inbox" | "terminal" | "pages";

export class MainWindow {
  readonly window: any;
  readonly home: HomePage;
  readonly chat: ChatPage;
  readonly inbox: InboxPage;
  readonly terminal: TerminalPage;
  readonly tabs: WebTabs;
  private readonly stack: any;
  private readonly root: any;
  private readonly banner: any;
  private readonly spaceButton: any;
  private readonly sidebarButton: any;
  private readonly pages: Record<View, any> = {} as Record<View, any>;
  private welcome: WelcomePage | undefined;
  private shown: Space | undefined;

  constructor(
    readonly app: any,
    private readonly model: AppModel,
    private readonly local: LocalManager,
  ) {
    this.window = new Adw.ApplicationWindow({ application: app, title: t("appName"), default_width: prefs.window.width, default_height: prefs.window.height, width_request: 360, height_request: 400 });
    if (prefs.window.maximized) this.window.maximize();
    this.window.connect("close-request", () => {
      const [width, height] = [this.window.get_width(), this.window.get_height()];
      prefs.window = { width: this.window.is_maximized() ? prefs.window.width : width, height: this.window.is_maximized() ? prefs.window.height : height, maximized: this.window.is_maximized() };
      savePrefs();
      return false;
    });

    const openLink = (uri: string) => {
      const space = this.model.current;
      if (space) this.openUrl(space, uri);
    };
    this.home = new HomePage(model, {
      open: (space, entry) => this.openEntry(space, entry),
      openBuiltin: (name) => this.openBuiltin(name),
      ask: (space, text) => this.ask(space, text),
      openInBrowser: (space, entry) => {
        const url = pageUrl(entry.link, space.client.base, lang);
        if (url) openExternally(url);
      },
      openLink: (space, url) => this.openUrl(space, url),
    });
    this.chat = new ChatPage(model, openLink);
    this.inbox = new InboxPage(model, (space, url) => this.openUrl(space, url));
    this.terminal = new TerminalPage(model);
    this.tabs = new WebTabs(model);
    this.tabs.onEmpty = () => {
      this.pages.pages.set_visible(false);
      if (this.stack.get_visible_child_name() === "pages") this.show("home");
    };
    this.tabs.detach = (page) => this.detachTab(page);

    // Views
    this.stack = new Adw.ViewStack({ vexpand: true });
    const add = (name: View, child: any, title: string, icon: string) => {
      this.pages[name] = this.stack.add_titled_with_icon(child, name, title, icon);
    };
    add("home", this.home.widget, t("home"), "go-home-symbolic");
    add("chat", this.chat.widget, t("chat"), "chat-message-new-symbolic");
    add("inbox", this.inbox.widget, t("inbox"), "mail-unread-symbolic");
    add("terminal", this.terminal.widget, t("terminal"), "utilities-terminal-symbolic");
    add("pages", this.tabs.widget, t("apps"), "view-grid-symbolic");
    this.pages.pages.set_visible(false);
    this.stack.connect("notify::visible-child-name", () => this.onView());

    // Header
    const header = new Adw.HeaderBar();
    const switcher = new Adw.ViewSwitcher({ stack: this.stack, policy: Adw.ViewSwitcherPolicy.WIDE });
    header.set_title_widget(switcher);
    this.sidebarButton = new Gtk.ToggleButton({ icon_name: "sidebar-show-symbolic", tooltip_text: t("recent"), visible: false });
    this.chat.split.bind_property("show-sidebar", this.sidebarButton, "active", GObject.BindingFlags.SYNC_CREATE | GObject.BindingFlags.BIDIRECTIONAL);
    header.pack_start(this.sidebarButton);
    this.spaceButton = new Gtk.MenuButton({ always_show_arrow: true, tooltip_text: t("spaces") });
    header.pack_start(this.spaceButton);
    const menu = new Gio.Menu();
    menu.append(t("quickChat"), "app.quick-chat");
    menu.append(t("reload"), "win.reload");
    const second = new Gio.Menu();
    second.append(t("settings"), "app.settings");
    second.append(t("about"), "app.about");
    second.append(t("quit"), "app.quit");
    menu.append_section(null, second);
    header.pack_end(new Gtk.MenuButton({ icon_name: "open-menu-symbolic", menu_model: menu, primary: true, tooltip_text: t("settings") }));

    this.banner = new Adw.Banner({ revealed: false });
    this.banner.connect("button-clicked", () => this.bannerAction());

    const bottom = new Adw.ViewSwitcherBar({ stack: this.stack });
    const toolbar = new Adw.ToolbarView({ content: this.stack });
    toolbar.add_top_bar(header);
    toolbar.add_top_bar(this.banner);
    toolbar.add_bottom_bar(bottom);

    // Narrow: views move to the bottom bar, the chat's sidebar folds away.
    const narrow = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse("max-width: 680sp") });
    narrow.add_setter(switcher, "visible", false);
    narrow.add_setter(bottom, "reveal", true);
    narrow.add_setter(this.chat.split, "collapsed", true);
    this.window.add_breakpoint(narrow);

    this.root = new Gtk.Stack({ transition_type: Gtk.StackTransitionType.CROSSFADE });
    this.root.add_named(toolbar, "main");
    this.window.set_content(this.root);

    this.installActions();
    model.on((change, space) => this.onModel(change, space));
    this.showSpace();
  }

  private presented = false;

  present(): void {
    this.window.present();
    if (this.presented) return;
    this.presented = true;
    // The saved Spaces could not be read: say so once; the file was kept, not overwritten.
    if (this.model.loadError) {
      const dialog = new Adw.AlertDialog({ heading: t("spaces"), body: t("connectionsUnreadable", { path: this.model.loadError }) });
      dialog.add_response("ok", "OK");
      dialog.present(this.window);
    }
  }

  private installActions(): void {
    const act = (name: string, run: () => void, accels: string[] = []) => {
      const a = new Gio.SimpleAction({ name });
      a.connect("activate", run);
      this.window.add_action(a);
      if (accels.length) this.app.set_accels_for_action(`win.${name}`, accels);
    };
    act("home", () => this.show("home"), ["<Control>1"]);
    act("chat", () => this.show("chat"), ["<Control>2"]);
    act("inbox", () => this.show("inbox"), ["<Control>3"]);
    act("terminal", () => this.show("terminal"), ["<Control>4"]);
    act("pages", () => this.tabs.count && this.show("pages"), ["<Control>5"]);
    act("search", () => {
      this.show("home");
      this.home.focusSearch();
    }, ["<Control>f", "<Control>l"]);
    act("new-conversation", () => {
      this.show("chat");
      this.chat.view.conversation?.newConversation();
      this.chat.view.focus();
    }, ["<Control>n"]);
    act("reload", () => {
      const space = this.model.current;
      if (space) void this.model.refresh(space);
    }, ["F5", "<Control>r"]);
    // Home's pages: the library, then the screens.
    act("previous-screen", () => this.stack.get_visible_child_name() === "home" && this.home.step(-1), ["<Control>Page_Up"]);
    act("next-screen", () => this.stack.get_visible_child_name() === "home" && this.home.step(1), ["<Control>Page_Down"]);
    act("panel", () => this.model.current && this.openPanel(this.model.current), ["<Control><Shift>p"]);
    act("new-terminal", () => {
      this.show("terminal");
      this.terminal.newTab();
    }, ["<Control><Shift>t"]);
  }

  show(view: View): void {
    if (view === "pages") this.pages.pages.set_visible(true);
    this.stack.set_visible_child_name(view);
  }

  private onView(): void {
    const view = this.stack.get_visible_child_name() as View;
    this.sidebarButton.set_visible(view === "chat");
    const space = this.model.current;
    if (view === "inbox") this.inbox.show(space);
    if (view === "terminal") this.terminal.show(space);
    if (view === "chat") this.chat.view.focus();
  }

  // The Space shown

  private showSpace(): void {
    const space = this.model.current;
    if (!space) {
      if (!this.welcome) {
        this.welcome = new WelcomePage(this.model, this.local, () => this.showSpace());
        const box = new Adw.ToolbarView({ content: this.welcome.widget });
        box.add_top_bar(new Adw.HeaderBar());
        this.root.add_named(box, "welcome");
      }
      this.root.set_visible_child_name("welcome");
      return;
    }
    this.root.set_visible_child_name("main");
    if (this.shown !== space) {
      // Pages and terminals belong to the Space they were opened on.
      this.tabs.closeSpace(undefined);
      this.shown = space;
    }
    this.renderSpaceMenu();
    this.renderBanner();
    this.home.show(space);
    this.chat.show(space);
    this.inbox.show(space);
    if (this.stack.get_visible_child_name() === "terminal") this.terminal.show(space);
    this.renderBadge();
    if (space.state.kind === "connecting" && !space.refreshing) void this.model.refresh(space);
  }

  private onModel(change: string, space: Space | undefined): void {
    if (change === "connections" || change === "selection") {
      if (change === "selection" || !this.model.current || this.root.get_visible_child_name() === "welcome") this.showSpace();
      else this.renderSpaceMenu();
      return;
    }
    if (space !== this.model.current) {
      if (change === "inbox") this.renderSpaceMenu();
      return;
    }
    if (change === "state") {
      this.renderBanner();
      this.renderSpaceMenu();
    }
    if (change === "catalogue") {
      this.home.show(space);
      this.renderBanner();
    }
    if (change === "inbox") this.renderBadge();
  }

  private renderBadge(): void {
    const unread = this.model.current?.inbox.summary.unread ?? 0;
    this.pages.inbox.set_badge_number(unread);
    this.pages.inbox.set_needs_attention(unread > 0);
  }

  private renderSpaceMenu(): void {
    const current = this.model.current;
    const dot = (s: Space) => (s.state.kind === "ready" ? "" : s.state.kind === "connecting" ? "…" : " ⚠");
    const box = new Gtk.Box({ spacing: 6 });
    box.append(new Gtk.Label({ label: current ? `${current.conn.name}${dot(current)}` : t("spaces"), ellipsize: Pango.EllipsizeMode.END, max_width_chars: 22 }));
    this.spaceButton.set_child(box);
    const pop = new Gtk.Popover();
    const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ["navigation-sidebar"] });
    for (const c of this.model.list.connections) {
      const s = this.model.space(c.id)!;
      const row = new Gtk.ListBoxRow() as any;
      row.connId = c.id;
      const r = new Gtk.Box({ spacing: 8, margin_top: 4, margin_bottom: 4 });
      r.append(new Gtk.Image({ icon_name: c.id === current?.conn.id ? "object-select-symbolic" : "", pixel_size: 16, width_request: 16 }));
      const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
      text.append(new Gtk.Label({ label: c.name, xalign: 0 }));
      const sub = new Gtk.Label({ label: c.url, xalign: 0, css_classes: ["caption", "dim-label"] });
      text.append(sub);
      r.append(text);
      const unread = s.inbox.summary.unread;
      if (unread && c.id !== current?.conn.id) r.append(new Gtk.Label({ label: String(unread), css_classes: ["caption", "accent"] }));
      row.set_child(r);
      list.append(row);
    }
    list.connect("row-activated", (_l: unknown, row: any) => {
      pop.popdown();
      this.model.select(row.connId);
    });
    const v = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    v.append(list);
    const manage = new Gtk.Button({ label: t("manageSpaces"), css_classes: ["flat"] });
    manage.connect("clicked", () => {
      pop.popdown();
      showSettings(this.window, this.model, this.local);
    });
    v.append(manage);
    pop.set_child(v);
    this.spaceButton.set_popover(pop);
  }

  private renderBanner(): void {
    const space = this.model.current;
    const b = this.banner;
    if (!space) return b.set_revealed(false);
    const s = space.state;
    if (s.kind === "signin") {
      b.set_title(t("signInTitle"));
      b.set_button_label(t("signIn"));
      b.set_revealed(true);
    } else if (s.kind === "unreachable") {
      b.set_title(space.catalogue ? `${t("unreachableTitle")} · ${t("lastKnown", { when: relativeTime(space.catalogueAt, lang) })}` : `${t("unreachableTitle")}: ${s.detail ?? ""}`);
      b.set_button_label(t("tryAgain"));
      b.set_revealed(true);
    } else if (s.kind === "incompatible") {
      b.set_title(`${t("incompatibleTitle")}: ${s.detail ?? ""}`);
      b.set_button_label(t("openInBrowser"));
      b.set_revealed(true);
    } else b.set_revealed(false);
  }

  private bannerAction(): void {
    const space = this.model.current;
    if (!space) return;
    const s = space.state.kind;
    // Signing in happens on the panel's own page; the app looks again once it loads.
    if (s === "signin") {
      if (space.conn.managed) void this.local.signIn(space, true).then((ok) => (ok ? this.model.refresh(space) : this.openPanel(space)));
      else this.openPanel(space);
    } else if (s === "unreachable") void this.model.refresh(space);
    else if (s === "incompatible") Gio.AppInfo.launch_default_for_uri(space.conn.url, null);
  }

  // Opening things

  openPanel(space: Space, path = "/"): void {
    this.tabs.openPanel(space, path);
    this.show("pages");
  }

  openEntry(space: Space, entry: Entry): void {
    if (entry.kind === "agent") {
      const agent = space.catalogue?.agentInfo.find((a) => a.id === entry.ref);
      if (agent) return this.openChat(agent);
    }
    if (this.tabs.openEntry(space, entry)) this.show("pages");
  }

  openBuiltin(name: Builtin): void {
    const space = this.model.current;
    if (name === "inbox") this.show("inbox");
    else if (name === "terminal") this.show("terminal");
    else if (name === "settings") showSettings(this.window, this.model, this.local);
    // The web panel, and Shortcuts, which only the panel has.
    else if (space) this.openPanel(space);
  }

  /** A link: another app's tab, a page of the Space, or the browser. */
  openUrl(space: Space, url: string): void {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `${space.client.base}${url.startsWith("/") ? "" : "/"}${url}`;
    if (absolute.startsWith(space.client.base)) {
      const before = this.tabs.count;
      this.tabs.route(space, absolute);
      if (this.tabs.count === before) this.tabs.open({ space, url: absolute, title: t("panel"), key: `url:${absolute}` });
      this.show("pages");
    } else this.tabs.route(space, absolute);
  }

  openChat(agent?: Agent, opts: { draft?: string; send?: string } = {}): void {
    this.show("chat");
    this.chat.choose(agent, opts);
  }

  /** The command box's question goes to Space Assistant in a new conversation. */
  ask(space: Space, text: string): void {
    const agent = this.model.assistant(space);
    if (!agent) return;
    this.show("chat");
    this.chat.choose(agent);
    const conv = this.chat.view.conversation;
    if (conv && !conv.busy && conv.messages.length) conv.newConversation();
    if (conv?.busy) this.chat.view.setDraft(text);
    else {
      this.chat.view.setDraft(text);
      this.chat.view.send();
    }
  }

  openInboxItem(space: Space, item: InboxItem): void {
    this.model.select(space.conn.id);
    if (item.unread) void this.model.markInbox(space, [item.thread], { read: true });
    if (item.url) this.openUrl(space, item.url);
    else this.show("inbox");
    this.present();
  }

  /** `aispace://` links: they may fill in a message but never send one. */
  handleLink(link: DeepLink): void {
    const space = this.model.current;
    this.present();
    if (!space) return;
    if (link.kind === "inbox") this.show("inbox");
    else if (link.kind === "chat") {
      const agent = link.agent ? space.catalogue?.agentInfo.find((a) => a.id === link.agent || `${a.app}/${a.name}` === link.agent || a.name === link.agent) : undefined;
      this.openChat(agent, link.text !== undefined ? { draft: link.text } : {});
    } else if (link.kind === "open") {
      const app = space.catalogue?.apps.find((a) => a.ref === link.app || pickText(a.title, a.i18n, "title", lang) === link.app);
      if (app) this.openEntry(space, app);
    }
  }

  private detachTab(page: any): void {
    const win = new TabWindow(this.app, this.model, this);
    win.tabs.adopt(page, this.tabs);
    win.window.present();
  }
}

/** A window with tabs moved out of the main one; its tabs move back with "Move to Main Window". */
export class TabWindow {
  readonly window: any;
  readonly tabs: WebTabs;

  constructor(app: any, model: AppModel, main: MainWindow) {
    this.tabs = new WebTabs(model, { detached: true });
    this.window = new Adw.ApplicationWindow({ application: app, title: t("appName"), default_width: 1000, default_height: 720 });
    const view = new Adw.ToolbarView({ content: this.tabs.widget });
    view.add_top_bar(new Adw.HeaderBar());
    this.window.set_content(view);
    this.tabs.onEmpty = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (this.window.close(), GLib.SOURCE_REMOVE));
    this.tabs.detach = (page) => {
      main.tabs.adopt(page, this.tabs);
      main.present();
      main.show("pages");
    };
  }
}
