import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { appForUrl } from "../core/desktop.ts";
import { type Entry, pageUrl, pickText } from "../core/catalogue.ts";
import { lang, openExternally, t } from "./env.ts";
import { isImageIcon, loadTexture } from "./icons.ts";
import type { AppModel, Space } from "./model.ts";
import { createWebView } from "./web.ts";

/**
 * The Space's pages in tabs: apps, the web panel and links from the inbox or a chat. A link to
 * another app opens in that app's tab; a link off the Space opens in the browser. A tab can move
 * to a window of its own and back. Each tab is a web view in the connection's session.
 */

export type TabRequest = { space: Space; url: string; title: string; icon?: string; key: string };

type Tab = { key: string; space: Space; view: any; page: any };

export class WebTabs {
  readonly widget: any;
  readonly view: any;
  private readonly bar: any;
  private readonly tabs = new Map<any, Tab>();
  private readonly back: any;
  private readonly forward: any;
  private readonly address: any;
  /** Called when the last tab closes (the window goes back to Home), or when a page asks to sign in. */
  onEmpty: (() => void) | undefined;
  /** For "Open in New Window": the app makes the window and hands this its own `WebTabs`. */
  detach: ((tab: any) => void) | undefined;

  constructor(
    private readonly model: AppModel,
    opts: { detached?: boolean } = {},
  ) {
    this.view = new Adw.TabView({ vexpand: true });
    this.bar = new Adw.TabBar({ view: this.view, autohide: false });
    const toolbar = new Gtk.Box({ spacing: 4, margin_top: 4, margin_bottom: 4, margin_start: 6, margin_end: 6 });
    const button = (icon: string, tip: string, run: () => void) => {
      const b = new Gtk.Button({ icon_name: icon, tooltip_text: tip, css_classes: ["flat"] });
      b.connect("clicked", run);
      toolbar.append(b);
      return b;
    };
    this.back = button("go-previous-symbolic", t("back"), () => this.current()?.view.go_back());
    this.forward = button("go-next-symbolic", t("forward"), () => this.current()?.view.go_forward());
    button("view-refresh-symbolic", t("reload"), () => this.current()?.view.reload());
    this.address = new Gtk.Label({ xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.MIDDLE, selectable: true, margin_start: 6 });
    this.address.add_css_class("dim-label");
    this.address.add_css_class("caption");
    toolbar.append(this.address);
    button("web-browser-symbolic", t("openInBrowser"), () => {
      const uri = this.current()?.view.get_uri();
      if (uri) openExternally(uri);
    });
    if (!opts.detached) button("window-new-symbolic", t("openInNewWindow"), () => this.view.get_selected_page() && this.detach?.(this.view.get_selected_page()));

    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    box.append(this.bar);
    box.append(toolbar);
    box.append(this.view);
    this.widget = box;

    this.view.connect("notify::selected-page", () => this.sync());
    this.view.connect("close-page", (_v: unknown, page: any) => {
      this.tabs.delete(page);
      this.view.close_page_finish(page, true);
      if (!this.view.get_n_pages()) this.onEmpty?.();
      return true;
    });
    // A tab moved in from another window brings its web view along.
    this.view.connect("page-attached", (_v: unknown, page: any) => {
      const tab = (page.get_child() as any)._aispaceTab as Tab | undefined;
      if (tab) {
        tab.page = page;
        this.tabs.set(page, tab);
      }
      this.sync();
    });
    this.view.connect("page-detached", (_v: unknown, page: any) => {
      this.tabs.delete(page);
      if (!this.view.get_n_pages()) this.onEmpty?.();
    });
    // Context menu entries on a tab.
    const menu = new Gio.Menu();
    menu.append(t("reload"), "tab.reload");
    menu.append(t("openInBrowser"), "tab.browser");
    menu.append(opts.detached ? t("moveToMainWindow") : t("openInNewWindow"), "tab.detach");
    menu.append(t("close"), "tab.close");
    this.view.set_menu_model(menu);
    const group = new Gio.SimpleActionGroup();
    const act = (name: string, run: (tab: Tab) => void) => {
      const a = new Gio.SimpleAction({ name });
      a.connect("activate", () => {
        const page = this.menuPage ?? this.view.get_selected_page();
        const tab = page && this.tabs.get(page);
        if (tab) run(tab);
      });
      group.add_action(a);
    };
    act("reload", (tab) => tab.view.reload());
    act("browser", (tab) => tab.view.get_uri() && openExternally(tab.view.get_uri()));
    act("detach", (tab) => this.detach?.(tab.page));
    act("close", (tab) => this.view.close_page(tab.page));
    this.widget.insert_action_group("tab", group);
    this.view.connect("setup-menu", (_v: unknown, page: any) => (this.menuPage = page ?? undefined));
  }

  private menuPage: any;

  get count(): number {
    return this.view.get_n_pages();
  }

  private current(): Tab | undefined {
    const p = this.view.get_selected_page();
    return p ? this.tabs.get(p) : undefined;
  }

  private sync(): void {
    const tab = this.current();
    this.back.set_sensitive(Boolean(tab?.view.can_go_back()));
    this.forward.set_sensitive(Boolean(tab?.view.can_go_forward()));
    this.address.set_text(tab?.view.get_uri() ?? "");
  }

  /** Opens (or shows the open tab of) an app, the panel or a page of the Space. */
  open(r: TabRequest): void {
    for (const [page, tab] of this.tabs) {
      if (tab.key === r.key && tab.space === r.space) {
        this.view.set_selected_page(page);
        if (tab.view.get_uri() !== r.url && r.key.startsWith("url:")) tab.view.load_uri(r.url);
        return;
      }
    }
    const space = r.space;
    const tab: Tab = { key: r.key, space, view: undefined, page: undefined };
    tab.view = createWebView({
      connectionId: space.conn.id,
      connection: space.conn.url,
      onExternal: (uri) => this.route(space, uri),
      onFinished: () => {
        this.sync();
        // Signing in happens on a page; once one loads, look at the Space again.
        if (space.state.kind === "signin") void this.model.refresh(space);
      },
      onFailed: (_uri, message) => this.showFailure(tab, message),
      onTitle: (title) => title && tab.page?.set_title(title),
    });
    tab.view._aispaceTab = tab;
    tab.view.connect("notify::uri", () => tab === this.current() && this.sync());
    tab.view.connect("notify::is-loading", () => tab.page?.set_loading(tab.view.is_loading));
    tab.page = this.view.append(tab.view);
    tab.page.set_title(r.title);
    if (r.icon && isImageIcon(r.icon)) {
      void loadTexture(r.icon, space.client, 16).then((tex) => tex && tab.page.set_icon(tex));
    }
    this.tabs.set(tab.page, tab);
    this.view.set_selected_page(tab.page);
    tab.view.load_uri(r.url);
  }

  /** A link that left its page: another app's tab when it belongs to one, the browser otherwise. */
  route(space: Space, uri: string): void {
    const apps = space.catalogue?.apps ?? [];
    const app = appForUrl(uri, apps, space.client.base, lang);
    if (app) this.open({ space, url: uri, title: pickText(app.title, app.i18n, "title", lang), ...(app.icon ? { icon: app.icon } : {}), key: `app:${app.ref}` });
    else openExternally(uri);
  }

  openEntry(space: Space, entry: Entry): boolean {
    const url = pageUrl(entry.link, space.client.base, lang);
    if (!url) return false;
    this.open({ space, url, title: pickText(entry.title, entry.i18n, "title", lang), ...(entry.icon ? { icon: entry.icon } : {}), key: `${entry.kind}:${entry.ref}` });
    return true;
  }

  openPanel(space: Space, path = "/"): void {
    this.open({ space, url: `${space.client.base}${path}`, title: t("panel"), key: path === "/" ? "panel" : `url:${path}` });
  }

  private showFailure(tab: Tab, message: string): void {
    const uri = tab.view.get_uri() ?? "";
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    tab.view.load_alternate_html(
      `<!doctype html><meta charset="utf-8"><body style="font:15px system-ui;padding:48px;color:#666;max-width:560px;margin:auto"><h2 style="color:#333">${esc(t("unreachableTitle"))}</h2><p>${esc(message)}</p><p style="font-size:13px">${esc(uri)}</p><button onclick="location.href=${esc(JSON.stringify(uri))}">${esc(t("tryAgain"))}</button></body>`,
      uri,
      uri,
    );
  }

  /** Every tab of a Space, for when the Space is removed or another one is shown. */
  closeSpace(space: Space | undefined): void {
    for (const [page, tab] of [...this.tabs]) if (!space || tab.space === space) this.view.close_page(page);
  }

  /** Moves a tab of another `WebTabs` in. */
  adopt(page: any, from: WebTabs): void {
    from.view.transfer_page(page, this.view, this.view.get_n_pages());
    this.view.set_selected_page(page);
  }
}
