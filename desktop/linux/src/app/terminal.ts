import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import Gtk from "gi://Gtk?version=4.0";
import WebKit from "gi://WebKit?version=6.0";
import { escapeSegment } from "../core/url.ts";
import { APP_ROOT, logError, openExternally, path, readTextSync, t } from "./env.ts";
import type { AppModel, Space } from "./model.ts";
import { createWebView } from "./web.ts";

/**
 * Terminal: shells on the Space's machine and on its peers, one tab each. Each tab is xterm.js
 * (desktop/linux/terminal/terminal.ts) in a web view whose page counts as the Space's origin, so
 * the session request and its socket go exactly as the panel's terminal sends them. Nothing here
 * decides what runs: the server picks the shell, the directory and the environment.
 */

type Machine = { name: string; peer?: string; enabled: boolean; health: "ok" | "down" };
type Status = { enabled: boolean; passphrase: boolean; machines: Machine[] };

const baseOf = (m: Machine) => (m.peer ? `/api/peers/${escapeSegment(m.peer)}/terminal` : "/api/terminal");

let page: { js: string; css: string } | undefined | null;
function terminalPage(): { js: string; css: string } | undefined {
  if (page === undefined) {
    const js = readTextSync(path(APP_ROOT, "terminal", "terminal.js"));
    const css = readTextSync(path(APP_ROOT, "terminal", "xterm.css"));
    page = js && css ? { js, css } : null;
  }
  return page ?? undefined;
}

const inline = (s: string) => s.replace(/<\/(script|style)/gi, "<\\/$1");

export class TerminalPage {
  readonly widget: any;
  private readonly tabs: any;
  private readonly stack: any;
  private readonly machines: any;
  private readonly problem: any;
  private status: Status | undefined;
  private space: Space | undefined;
  /** The passphrase for each machine, kept in memory only, as the panel does. */
  private readonly passphrases = new Map<string, string>();
  private readonly counters = new Map<string, number>();
  private readonly views = new Set<any>();

  constructor(private readonly model: AppModel) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    const bar = new Gtk.Box({ spacing: 6, margin_top: 6, margin_bottom: 6, margin_start: 8, margin_end: 8 });
    this.machines = Gtk.DropDown.new_from_strings([]);
    this.machines.set_visible(false);
    this.machines.set_tooltip_text(t("terminalMachine"));
    bar.append(this.machines);
    const add = new Gtk.Button({ icon_name: "tab-new-symbolic", tooltip_text: t("newTerminal") });
    add.connect("clicked", () => this.newTab());
    bar.append(add);
    this.problem = new Gtk.Label({ xalign: 0, hexpand: true, wrap: true, visible: false });
    this.problem.add_css_class("error");
    this.problem.add_css_class("caption");
    bar.append(this.problem);
    box.append(bar);

    this.tabs = new Adw.TabView({ vexpand: true });
    this.tabs.connect("close-page", (_v: unknown, p: any) => {
      const view = p.get_child();
      view.evaluate_javascript("window.closeSession && window.closeSession()", -1, null, null, null, null);
      this.views.delete(view);
      this.tabs.close_page_finish(p, true);
      this.update();
      return true;
    });
    const tabBar = new Adw.TabBar({ view: this.tabs, autohide: false });
    const terms = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    terms.append(tabBar);
    terms.append(this.tabs);

    const empty = new Adw.StatusPage({ icon_name: "utilities-terminal-symbolic", title: t("terminalEmpty"), description: t("terminalEmptyBody"), vexpand: true });
    const open = new Gtk.Button({ label: t("newTerminal"), halign: Gtk.Align.CENTER, css_classes: ["pill", "suggested-action"] });
    open.connect("clicked", () => this.newTab());
    empty.set_child(open);
    this.stack = new Gtk.Stack({ vexpand: true });
    this.stack.add_named(empty, "empty");
    this.stack.add_named(terms, "tabs");
    box.append(this.stack);
    this.widget = box;

    // Shown before the Space answered: load the machines once it does.
    model.on((change, space) => {
      if (change === "state" && space === this.space && space?.ready && !this.status) void this.load();
    });
    // Open terminals follow the desktop's light and dark style.
    Adw.StyleManager.get_default().connect("notify::dark", () => {
      const dark = Adw.StyleManager.get_default().get_dark();
      for (const v of this.views) v.evaluate_javascript(`window.setDark && window.setDark(${dark})`, -1, null, null, null, null);
    });
  }

  show(space: Space | undefined): void {
    if (space !== this.space) {
      // Sessions belong to one Space; another Space starts with none.
      for (let i = this.tabs.get_n_pages() - 1; i >= 0; i--) this.tabs.close_page(this.tabs.get_nth_page(i));
      this.passphrases.clear();
      this.status = undefined;
    }
    this.space = space;
    this.update();
    void this.load();
  }

  private update(): void {
    this.stack.set_visible_child_name(this.tabs.get_n_pages() ? "tabs" : "empty");
  }

  private async load(): Promise<void> {
    const space = this.space;
    if (!space?.ready) return;
    try {
      const s = (await space.client.get("/api/terminal")) as Status;
      if (space !== this.space) return;
      this.status = { enabled: Boolean(s.enabled), passphrase: Boolean(s.passphrase), machines: Array.isArray(s.machines) ? s.machines : [] };
      const label = (m: Machine) => `${m.peer ? m.name : t("thisMachine", { name: m.name })}${!m.enabled ? ` · ${t("machineOff")}` : ""}`;
      const keep = this.chosen()?.name;
      this.machines.set_model(Gtk.StringList.new(this.status.machines.map(label)));
      const at = this.status.machines.findIndex((m) => m.name === keep);
      const first = this.status.machines.findIndex((m) => m.enabled);
      this.machines.set_selected(Math.max(0, at >= 0 ? at : first));
      this.machines.set_visible(this.status.machines.length > 1);
      this.say(undefined);
    } catch (e) {
      this.say((e as Error).message);
    }
  }

  private chosen(): Machine | undefined {
    return this.status?.machines[this.machines.get_selected()];
  }

  private say(text: string | undefined): void {
    this.problem.set_text(text ?? "");
    this.problem.set_visible(Boolean(text));
  }

  newTab(machine?: Machine): void {
    const space = this.space;
    if (!space) return;
    if (!this.status) {
      void this.load().then(() => this.status && this.newTab());
      return;
    }
    const m = machine ?? this.chosen();
    if (!m) return;
    if (!m.enabled) return this.say(t("terminalOff", { name: m.name }));
    const assets = terminalPage();
    if (!assets) return this.say(t("terminalUnavailable"));
    this.say(undefined);
    const n = (this.counters.get(m.name) ?? 0) + 1;
    this.counters.set(m.name, n);
    const title = `${m.name} ${n}`;

    const content = new WebKit.UserContentManager();
    content.register_script_message_handler("aispace", null);
    const view = createWebView({ connectionId: space.conn.id, connection: space.conn.url, onExternal: openExternally, contentManager: content });
    this.views.add(view);
    const p = this.tabs.append(view);
    p.set_title(title);
    p.set_loading(true);
    this.tabs.set_selected_page(p);
    this.update();
    content.connect("script-message-received::aispace", (_c: unknown, value: any) => {
      let msg: { type?: string; title?: string; state?: string; error?: string };
      try {
        msg = JSON.parse(value.to_string()) as typeof msg;
      } catch {
        return;
      }
      if (msg.type === "title" && msg.title) p.set_title(msg.title);
      else if (msg.type === "state") {
        p.set_loading(false);
        p.set_indicator_icon(msg.state === "closed" ? new Gio.ThemedIcon({ name: "media-playback-stop-symbolic" }) : null);
      } else if (msg.type === "passphrase") this.askPassphrase(m, msg.error ?? "", p);
      else if (msg.type === "signin") void this.model.refresh(space);
    });

    const cfg = {
      base: baseOf(m),
      ...(this.passphrases.get(m.name) ? { passphrase: this.passphrases.get(m.name) } : {}),
      dark: Adw.StyleManager.get_default().get_dark(),
      font: '"Monospace", "DejaVu Sans Mono", "Liberation Mono", monospace',
      fontSize: 13,
      text: { exited: t("term.exited"), signal: t("term.signal"), closed: t("term.closed"), closedIdle: t("term.closedIdle"), closedKilled: t("term.closedKilled"), closedShutdown: t("term.closedShutdown") },
    };
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${inline(assets.css)}
html,body{margin:0;height:100%;overflow:hidden}#term{position:absolute;inset:4px 2px 2px 8px}</style></head>
<body><div id="term"></div><script>window.AISPACE_TERMINAL=${JSON.stringify(cfg).replace(/</g, "\\u003c")}</script><script>${inline(assets.js)}</script></body></html>`;
    try {
      // The page's origin is the Space's, so its requests carry the connection's session.
      view.load_html(html, `${space.client.base}/`);
    } catch (e) {
      logError(e, "terminal");
    }
  }

  private askPassphrase(m: Machine, error: string, p: any): void {
    const dialog = new Adw.AlertDialog({ heading: t("passphraseTitle"), body: error ? `${t("passphraseBody")}\n\n${error}` : t("passphraseBody") });
    const entry = new Gtk.PasswordEntry({ show_peek_icon: true, activates_default: true });
    dialog.set_extra_child(entry);
    dialog.add_response("cancel", t("cancel"));
    dialog.add_response("unlock", t("unlock"));
    dialog.set_response_appearance("unlock", Adw.ResponseAppearance.SUGGESTED);
    dialog.set_default_response("unlock");
    dialog.set_close_response("cancel");
    dialog.connect("response", (_d: unknown, response: string) => {
      if (response !== "unlock" || !entry.get_text()) return;
      this.passphrases.set(m.name, entry.get_text());
      this.tabs.close_page(p);
      this.newTab(m);
    });
    dialog.present(this.widget.get_root());
  }
}
