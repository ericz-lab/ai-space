import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { groupById } from "../core/agents.ts";
import { type Agent, pickText } from "../core/catalogue.ts";
import type { SessionInfo } from "../core/conversation.ts";
import { relativeTime } from "../core/format.ts";
import { ChatView } from "./chat-view.ts";
import { lang, prefs, savePrefs, t, tw } from "./env.ts";
import { iconWidget } from "./icons.ts";
import type { AppModel, Space } from "./model.ts";

/**
 * Chat: a sidebar with New Conversation, the Space's agents and the chosen agent's recent
 * conversations, beside the conversation itself. On a narrow window the sidebar folds away
 * behind the header's sidebar button.
 */
export class ChatPage {
  readonly widget: any;
  readonly view: ChatView;
  readonly split: any;
  private readonly agentList: any;
  private readonly sessionList: any;
  private readonly recentTitle: any;
  private space: Space | undefined;
  private agent: Agent | undefined;
  private agentsKey = "";
  private sessionsKey = "";

  constructor(
    private readonly model: AppModel,
    onLink: (uri: string) => void,
  ) {
    this.view = new ChatView(model, { onLink, onMachine: (agent) => this.choose(agent) });
    const side = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    const fresh = new Gtk.Button({ margin_top: 10, margin_bottom: 4, margin_start: 10, margin_end: 10 });
    const freshContent = new Adw.ButtonContent({ icon_name: "list-add-symbolic", label: t("newConversation") });
    fresh.set_child(freshContent);
    fresh.connect("clicked", () => {
      this.view.conversation?.newConversation();
      this.view.focus();
      if (this.split.get_collapsed()) this.split.set_show_sidebar(false);
    });
    side.append(fresh);
    const heading = (text: string) => {
      const l = new Gtk.Label({ label: text, xalign: 0 });
      l.add_css_class("sidebar-heading");
      l.add_css_class("dim-label");
      return l;
    };
    side.append(heading(t("agents")));
    this.agentList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.SINGLE });
    this.agentList.add_css_class("navigation-sidebar");
    this.agentList.connect("row-activated", (_l: unknown, row: any) => {
      const agent = this.space?.catalogue?.agentInfo.find((a) => a.id === row.agentId);
      if (agent && this.space) this.choose(this.model.preferredAgent(this.space, agent));
      if (this.split.get_collapsed()) this.split.set_show_sidebar(false);
    });
    side.append(this.agentList);
    this.recentTitle = heading(t("recent"));
    side.append(this.recentTitle);
    this.sessionList = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE });
    this.sessionList.add_css_class("navigation-sidebar");
    this.sessionList.connect("row-activated", (_l: unknown, row: any) => {
      const s = this.view.conversation?.sessions.find((x) => x.sid === row.sid);
      if (s) void this.view.conversation?.open(s);
      if (this.split.get_collapsed()) this.split.set_show_sidebar(false);
    });
    side.append(this.sessionList);
    const sideScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: side });

    this.split = new Adw.OverlaySplitView({ sidebar: sideScroll, content: this.view.widget, min_sidebar_width: 220, max_sidebar_width: 300, sidebar_width_fraction: 0.26 });
    this.widget = this.split;
    model.on((change, space) => {
      if (space && space !== this.space) return;
      if (change === "catalogue") this.renderAgents();
      if (change === "chat") {
        this.renderSessions();
        this.view.redraw();
      }
    });
  }

  show(space: Space | undefined): void {
    const changed = space !== this.space;
    this.space = space;
    if (changed) {
      this.agentsKey = "";
      this.agent = undefined;
    }
    this.renderAgents();
  }

  /** Opens the chat with an agent (Space Assistant when none is named), optionally with a draft or a message sent at once. */
  choose(agent: Agent | undefined, opts: { draft?: string; send?: string } = {}): void {
    if (!this.space) return;
    agent ??= this.model.assistant(this.space);
    this.agent = agent;
    if (agent) {
      prefs.lastAgent = agent.id;
      savePrefs();
    }
    this.view.show(this.space, agent);
    this.selectRow();
    this.sessionsKey = "";
    void this.view.conversation?.loadSessions();
    this.renderSessions();
    if (opts.send) {
      this.view.setDraft(opts.send);
      this.view.send();
    } else if (opts.draft !== undefined) this.view.setDraft(opts.draft);
    this.view.focus();
  }

  private selectRow(): void {
    // A row stands for the agent on every machine.
    const g = this.agent && groupById(this.space?.catalogue?.agentGroups ?? [], this.agent.id);
    const ids = g ? g.machines.map((m) => m.id) : [this.agent?.id];
    for (let row = this.agentList.get_first_child(); row; row = row.get_next_sibling()) {
      if (ids.includes(row.agentId)) this.agentList.select_row(row);
    }
  }

  private renderAgents(): void {
    const agents = this.space?.catalogue?.agentInfo ?? [];
    // One row per agent, whatever the number of machines it runs on; the composer picks the machine.
    const groups = this.space?.catalogue?.agentGroups ?? [];
    const key = JSON.stringify(groups.map((g) => [g.primary.id, g.primary.title, g.primary.avatar, g.machines.map((m) => m.peer ?? "")]));
    if (key !== this.agentsKey) {
      this.agentsKey = key;
      this.agentList.remove_all();
      for (const { primary: a, machines } of groups) {
        const row = new Gtk.ListBoxRow() as any;
        row.agentId = a.id;
        const box = new Gtk.Box({ spacing: 10, margin_top: 4, margin_bottom: 4 });
        box.append(iconWidget(a.avatar, 26, this.space?.client, "avatar-default-symbolic"));
        const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, valign: Gtk.Align.CENTER });
        const title = new Gtk.Label({ label: pickText(a.title, a.i18n, "title", lang), xalign: 0, ellipsize: Pango.EllipsizeMode.END });
        text.append(title);
        const where = machines.length > 1 ? machines.map((m) => m.peer ?? tw("agents.thisMachine")).join(lang === "zh" ? "、" : ", ") : a.peer;
        if (where) {
          const peer = new Gtk.Label({ label: where, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
          peer.add_css_class("caption");
          peer.add_css_class("dim-label");
          text.append(peer);
        }
        box.append(text);
        row.set_child(box);
        this.agentList.append(row);
      }
    }
    // Keep the chosen agent when it is still there; otherwise the last one used, or Space Assistant.
    if (!this.space) return this.view.show(undefined, undefined);
    const still = this.agent && agents.find((a) => a.id === this.agent!.id);
    if (still) {
      this.agent = still;
      // The machine menu and the offline note follow the catalogue.
      this.view.show(this.space, still);
      this.selectRow();
      return;
    }
    const last = agents.find((a) => a.id === prefs.lastAgent);
    const pick = last ? this.model.preferredAgent(this.space, last) : this.model.assistant(this.space);
    if (pick) this.choose(pick);
    else this.view.show(this.space, undefined);
  }

  private renderSessions(): void {
    const conv = this.view.conversation;
    const sessions: SessionInfo[] = (conv?.sessions ?? []).slice(0, 30);
    const key = JSON.stringify([sessions.map((s) => [s.sid, s.title, s.ts]), conv?.sessionId]);
    if (key === this.sessionsKey) return;
    this.sessionsKey = key;
    this.sessionList.remove_all();
    this.recentTitle.set_visible(sessions.length > 0);
    for (const s of sessions) {
      const row = new Gtk.ListBoxRow() as any;
      row.sid = s.sid;
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, margin_top: 3, margin_bottom: 3 });
      const title = new Gtk.Label({ label: s.title || "…", xalign: 0, ellipsize: Pango.EllipsizeMode.END });
      if (s.sid === conv?.sessionId) title.add_css_class("heading");
      box.append(title);
      const when = new Gtk.Label({ label: relativeTime(s.ts, lang), xalign: 0 });
      when.add_css_class("caption");
      when.add_css_class("dim-label");
      box.append(when);
      row.set_child(box);
      this.sessionList.append(row);
    }
  }
}
