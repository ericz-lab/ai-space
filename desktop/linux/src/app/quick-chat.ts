import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gtk from "gi://Gtk?version=4.0";
import { type Agent, pickText } from "../core/catalogue.ts";
import { ChatView } from "./chat-view.ts";
import { lang, prefs, t } from "./env.ts";
import type { AppModel } from "./model.ts";
import type { MainWindow } from "./window.ts";

/**
 * Quick Chat: a small window with one conversation, for a question without the main window.
 * `ai-space --quick-chat` shows it, or hides it when it is in front; bind that command to a key in
 * the desktop's keyboard settings (GNOME and KDE let apps register no global shortcut themselves).
 * Escape hides it; the conversation is the same one the main window's chat shows.
 */
export class QuickChat {
  private window: any;
  private view: ChatView | undefined;
  private picker: any;
  private agents: Agent[] = [];
  private agent: Agent | undefined;

  constructor(
    private readonly app: any,
    private readonly model: AppModel,
    private readonly main: () => MainWindow,
  ) {
    model.on((change, space) => {
      if (!this.window || space !== this.model.current) return;
      if (change === "chat") this.view?.redraw();
      if (change === "catalogue" || change === "selection") this.renderAgents();
    });
  }

  toggle(opts: { text?: string } = {}): void {
    if (this.window?.is_visible() && this.window.is_active() && opts.text === undefined) {
      this.window.set_visible(false);
      return;
    }
    this.ensure();
    this.renderAgents();
    if (opts.text !== undefined) this.view!.setDraft(opts.text);
    this.window.present();
    this.view!.focus();
  }

  private ensure(): void {
    if (this.window) return;
    this.view = new ChatView(this.model, { compact: true, onLink: (uri) => {
      const space = this.model.current;
      if (space) {
        this.main().openUrl(space, uri);
        this.main().present();
      }
    } });
    this.window = new Adw.Window({ application: this.app, title: t("quickChat"), default_width: 520, default_height: 600, hide_on_close: true });
    const header = new Adw.HeaderBar();
    this.picker = Gtk.DropDown.new_from_strings([]);
    this.picker.add_css_class("flat");
    this.picker.connect("notify::selected", () => {
      const a = this.agents[this.picker.get_selected()];
      if (a && a.id !== this.agent?.id) this.choose(a);
    });
    header.set_title_widget(this.picker);
    const fresh = new Gtk.Button({ icon_name: "list-add-symbolic", tooltip_text: t("newConversation") });
    fresh.connect("clicked", () => {
      this.view?.conversation?.newConversation();
      this.view?.focus();
    });
    header.pack_start(fresh);
    const expand = new Gtk.Button({ icon_name: "window-new-symbolic", tooltip_text: t("moveToMainWindow") });
    expand.connect("clicked", () => {
      this.window.set_visible(false);
      const main = this.main();
      main.openChat(this.agent);
      main.present();
    });
    header.pack_end(expand);
    const toolbar = new Adw.ToolbarView({ content: this.view.widget });
    toolbar.add_top_bar(header);
    this.window.set_content(toolbar);
    const keys = new Gtk.EventControllerKey();
    keys.connect("key-pressed", (_c: unknown, keyval: number) => {
      if (keyval !== Gdk.KEY_Escape) return false;
      this.window.set_visible(false);
      return true;
    });
    this.window.add_controller(keys);
  }

  private renderAgents(): void {
    if (!this.window) return;
    const space = this.model.current;
    this.agents = space?.catalogue?.agentInfo ?? [];
    const keep = this.agent && this.agents.find((a) => a.id === this.agent!.id);
    const pick = keep ?? this.agents.find((a) => a.id === prefs.lastAgent) ?? (space ? this.model.assistant(space) : undefined);
    this.picker.set_model(Gtk.StringList.new(this.agents.map((a) => pickText(a.title, a.i18n, "title", lang))));
    const at = pick ? this.agents.indexOf(pick) : -1;
    if (at >= 0) this.picker.set_selected(at);
    this.choose(pick);
  }

  private choose(agent: Agent | undefined): void {
    this.agent = agent;
    this.view?.show(this.model.current, agent);
  }
}
