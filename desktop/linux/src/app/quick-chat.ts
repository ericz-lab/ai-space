import Gdk from "gi://Gdk?version=4.0";
// Registers GdkX11's types, so an X11 surface answers get_xid().
import "gi://GdkX11?version=4.0";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { groupById } from "../core/agents.ts";
import { type Agent, pickText } from "../core/catalogue.ts";
import { CHAT_WIDTH, withLead } from "../core/floating-ball.ts";
import { ChatView } from "./chat-view.ts";
import { DEBUG, lang, log, prefs, t } from "./env.ts";
import { iconWidget } from "./icons.ts";
import type { AppModel } from "./model.ts";
import { installStyles } from "./style.ts";
import type { MainWindow } from "./window.ts";

/**
 * Quick Chat: a small floating panel with one conversation, for a question without the main
 * window, drawn as the Mac's (Design Studio's design 12): 380 px wide with rounded corners, a 40 px
 * header (the agent, a spinner while it works, New Conversation, Close), then the conversation once
 * there is one, then the field. Only the header and the field while empty; it grows with the replies.
 *
 * `ai-space --quick-chat` shows it, or hides it when it is in front; bind that command to a key in
 * the desktop's keyboard settings (GNOME and KDE let apps register no global shortcut themselves).
 * A section of the floating ball opens it beside the ball. Escape or a click elsewhere hides it;
 * the conversation is the same one the main window's chat shows.
 *
 * Where XWayland is there, the panel is an X11 window: a Wayland window can neither be placed nor
 * kept above others, and the ball process (an X11 client) places this one beside itself (`placer`).
 */
export class QuickChat {
  /** Set by the floating ball while it runs: puts the panel's X11 window beside the ball. */
  placer: ((xid: number, width: number, height: number) => void) | undefined;
  private window: any;
  private view: ChatView | undefined;
  private agents: Agent[] = [];
  private agent: Agent | undefined;
  private agentAvatar: any;
  private agentName: any;
  private popover: any;
  private list: any;
  private spinner: any;
  private fresh: any;
  /** Opened from the floating ball: kept beside it as it grows. */
  private near = false;

  constructor(
    private readonly app: any,
    private readonly model: AppModel,
    private readonly main: () => MainWindow,
  ) {
    model.on((change, space) => {
      if (!this.window || space !== this.model.current) return;
      if (change === "chat") {
        this.view?.redraw();
        this.renderBusy();
      }
      if (change === "catalogue" || change === "selection") this.renderAgents();
    });
  }

  /** The window while it is on screen (for the debug screenshot). */
  get shown(): any {
    return this.window?.is_visible() ? this.window : undefined;
  }

  toggle(opts: { text?: string } = {}): void {
    if (this.window?.is_visible() && this.window.is_active && opts.text === undefined) {
      this.hide();
      return;
    }
    this.ensure();
    this.near = false;
    this.renderAgents();
    if (opts.text !== undefined) this.view!.setDraft(opts.text);
    this.window.present();
    this.view!.focus();
  }

  /**
   * Shows Quick Chat on an agent (a section of the floating ball), beside the ball: `lead` goes
   * before the draft once, `picture` joins the next message, and `startupId` (the click's, from the
   * ball) lets the window come to the front. It never sends by itself.
   */
  open(opts: { agent?: Agent; lead?: string; picture?: { name: string; bytes: Uint8Array }; startupId?: string } = {}): void {
    this.ensure();
    if (opts.agent) this.agent = opts.agent;
    this.renderAgents();
    if (opts.lead) this.view!.setDraft(withLead(this.view!.draft(), opts.lead));
    if (opts.picture) this.view!.attachImage(opts.picture.name, opts.picture.bytes);
    if (opts.startupId) this.window.set_startup_id(opts.startupId);
    const wasShown = this.window.is_visible();
    this.near = Boolean(this.placer);
    // Hidden until it stands beside the ball, so it does not show first where the desktop put it.
    if (this.near && !wasShown) this.window.set_opacity(0);
    this.window.present();
    this.view!.focus();
    this.place();
    if (this.near && !wasShown) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 80, () => (this.window.set_opacity(1), GLib.SOURCE_REMOVE));
    // Whether the desktop let the window come to the front.
    if (DEBUG) GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => (log("quick chat", { agent: this.agent?.id, picture: opts.picture?.name, startupId: Boolean(opts.startupId), active: Boolean(this.window.is_active), xid: this.xid() }), GLib.SOURCE_REMOVE));
  }

  hide(): void {
    this.popover?.popdown();
    this.window?.set_visible(false);
  }

  /** The panel's X11 window, when it is on XWayland. */
  private xid(): number | undefined {
    const surface = this.window?.get_surface();
    return surface && typeof surface.get_xid === "function" ? surface.get_xid() : undefined;
  }

  /** Beside the ball, at the panel's current height (it grows upward from there). */
  private place(): void {
    if (!this.near || !this.placer || !this.window?.is_visible()) return;
    const xid = this.xid();
    const surface = this.window.get_surface();
    if (!xid || !surface) return;
    this.placer(xid, surface.get_width() || CHAT_WIDTH, surface.get_height() || 96);
  }

  /** XWayland's display, opened once; none on a desktop without it. */
  private static x11: any;
  private static x11Display(): any {
    if (QuickChat.x11 !== undefined) return QuickChat.x11;
    QuickChat.x11 = null;
    const name = GLib.getenv("DISPLAY");
    if (!name || Gdk.Display.get_default()?.constructor?.$gtype?.name === "GdkX11Display") return null;
    try {
      const display = Gdk.DisplayManager.get().open_display(name);
      if (display) {
        installStyles(display);
        QuickChat.x11 = display;
      }
    } catch (e) {
      log("quick chat: no X11 display", String(e));
    }
    return QuickChat.x11;
  }

  private ensure(): void {
    if (this.window) return;
    this.view = new ChatView(this.model, { compact: true, floating: true, onMachine: (agent) => this.choose(agent), onLink: (uri) => {
      const space = this.model.current;
      if (space) {
        this.main().openUrl(space, uri);
        this.main().present();
      }
    } });
    this.window = new Gtk.Window({ application: this.app, title: t("quickChat"), decorated: false, resizable: false, default_width: CHAT_WIDTH, hide_on_close: true });
    const x11 = QuickChat.x11Display();
    if (x11) this.window.set_display(x11);
    else installStyles();
    this.window.add_css_class("quick-chat");

    const panel = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, width_request: CHAT_WIDTH });
    panel.add_css_class("qc-panel");
    panel.set_overflow(Gtk.Overflow.HIDDEN);

    // The header: the agent (a list of every agent), what it is doing, New Conversation, Close.
    const header = new Gtk.Box({ spacing: 8, margin_start: 12, margin_end: 12, height_request: 40 });
    const who = new Gtk.Box({ spacing: 8 });
    this.agentAvatar = new Gtk.Box({ hexpand: false });
    this.agentName = new Gtk.Label({ ellipsize: Pango.EllipsizeMode.END, max_width_chars: 22 });
    this.agentName.add_css_class("qc-agent-name");
    who.append(this.agentAvatar);
    who.append(this.agentName);
    who.append(new Gtk.Image({ icon_name: "pan-down-symbolic", pixel_size: 12, css_classes: ["dim-label"] }));
    this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ["navigation-sidebar"] });
    this.list.connect("row-activated", (_l: unknown, row: any) => {
      const a = this.agents[row.get_index()];
      const space = this.model.current;
      this.popover.popdown();
      if (a && space) this.choose(this.model.preferredAgent(space, a));
      this.renderAgents();
      this.view?.focus();
    });
    const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: 380, width_request: 320, child: this.list });
    this.popover = new Gtk.Popover({ child: scroll, has_arrow: false });
    const picker = new Gtk.MenuButton({ child: who, popover: this.popover, tooltip_text: `${t("chooseAgent")} (Ctrl+J)`, valign: Gtk.Align.CENTER });
    picker.add_css_class("flat");
    picker.add_css_class("qc-agent");
    header.append(picker);
    this.spinner = new Gtk.Spinner({ visible: false, valign: Gtk.Align.CENTER });
    header.append(this.spinner);
    header.append(new Gtk.Box({ hexpand: true }));
    this.fresh = this.roundButton("document-edit-symbolic", `${t("newConversation")} (Ctrl+N)`, () => {
      this.view?.conversation?.newConversation();
      this.view?.focus();
    });
    header.append(this.fresh);
    header.append(this.roundButton("window-close-symbolic", `${t("close")} (Esc)`, () => this.hide()));
    // Dragging the header moves the panel, as dragging a title bar does.
    const drag = new Gtk.GestureDrag();
    drag.connect("drag-begin", (g: any, x: number, y: number) => {
      const surface = this.window.get_surface();
      const device = g.get_device();
      if (surface && device) surface.begin_move(device, 1, x, y, g.get_current_event_time());
    });
    header.add_controller(drag);
    panel.append(header);
    panel.append(this.view.widget);
    this.window.set_child(panel);

    const keys = new Gtk.EventControllerKey();
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keys.connect("key-pressed", (_c: unknown, keyval: number, _code: number, state: number) => {
      if (keyval === Gdk.KEY_Escape) {
        this.hide();
        return true;
      }
      if (!(state & Gdk.ModifierType.CONTROL_MASK)) return false;
      if (keyval === Gdk.KEY_n) this.view?.conversation?.newConversation();
      else if (keyval === Gdk.KEY_j) picker.popup();
      else if (keyval === Gdk.KEY_o) {
        this.hide();
        const main = this.main();
        main.openChat(this.agent);
        main.present();
      } else return false;
      return true;
    });
    this.window.add_controller(keys);

    // A click anywhere else hides the panel, as a popover does; its own agent list does not.
    this.window.connect("notify::is-active", () => {
      if (this.window.is_active) return;
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        if (this.window.is_visible() && !this.window.is_active && !this.popover.get_visible()) this.hide();
        return GLib.SOURCE_REMOVE;
      });
    });
    // Growing with the replies: placed again so its bottom stays beside the ball.
    this.window.connect("realize", () => {
      this.window.get_surface()?.connect("notify::height", () => this.place());
    });
  }

  private roundButton(icon: string, tooltip: string, action: () => void): any {
    const b = new Gtk.Button({ child: new Gtk.Image({ icon_name: icon, pixel_size: 10 }), tooltip_text: tooltip, valign: Gtk.Align.CENTER });
    b.add_css_class("qc-round");
    b.connect("clicked", action);
    return b;
  }

  private renderAgents(): void {
    if (!this.window) return;
    const space = this.model.current;
    // One entry per agent (its group's primary); the machine is the main window's choice.
    const groups = space?.catalogue?.agentGroups ?? [];
    this.agents = groups.map((g) => g.primary);
    const all = space?.catalogue?.agentInfo ?? [];
    const keep = this.agent && all.find((a) => a.id === this.agent!.id);
    const last = all.find((a) => a.id === prefs.lastAgent);
    const pick = keep ?? (space && last ? this.model.preferredAgent(space, last) : undefined) ?? (space ? this.model.assistant(space) : undefined);
    this.choose(pick);
    const current = this.groupPrimary();
    this.list.remove_all();
    for (const a of this.agents) {
      const row = new Gtk.Box({ spacing: 10 });
      row.add_css_class("qc-agent-row");
      const avatar = iconWidget(a.avatar, 30, space?.client, "avatar-default-symbolic", true);
      avatar.set_hexpand(false);
      avatar.add_css_class("qc-avatar");
      avatar.set_overflow(Gtk.Overflow.HIDDEN);
      row.append(avatar);
      const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true, valign: Gtk.Align.CENTER });
      const title = new Gtk.Label({ label: `${pickText(a.title, a.i18n, "title", lang)}${a.peer ? ` · ${a.peer}` : ""}`, xalign: 0, ellipsize: Pango.EllipsizeMode.END });
      if (a.id === current) title.add_css_class("heading");
      text.append(title);
      const description = pickText(a.description ?? "", a.i18n, "description", lang);
      if (description) {
        const d = new Gtk.Label({ label: description, xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ["dim-label", "caption"] });
        text.append(d);
      }
      row.append(text);
      if (a.id === current) row.append(new Gtk.Image({ icon_name: "object-select-symbolic", css_classes: ["accent"] }));
      this.list.append(row);
    }
  }

  /** The id of the entry standing for the chosen agent's group. */
  private groupPrimary(): string | undefined {
    const g = this.agent && groupById(this.model.current?.catalogue?.agentGroups ?? [], this.agent.id);
    return g ? g.primary.id : this.agent?.id;
  }

  private choose(agent: Agent | undefined): void {
    this.agent = agent;
    const space = this.model.current;
    this.view?.show(space, agent);
    const old = this.agentAvatar.get_first_child();
    if (old) this.agentAvatar.remove(old);
    if (agent) {
      const avatar = iconWidget(agent.avatar, 22, space?.client, "avatar-default-symbolic", true);
      avatar.set_hexpand(false);
      avatar.add_css_class("qc-avatar");
      avatar.set_overflow(Gtk.Overflow.HIDDEN);
      this.agentAvatar.append(avatar);
    }
    this.agentName.set_text(agent ? pickText(agent.title, agent.i18n, "title", lang) : t("chooseAgent"));
    this.renderBusy();
  }

  /** The spinner while a turn runs; New Conversation only when there is one to leave and nothing runs. */
  private renderBusy(): void {
    const conv = this.view?.conversation;
    this.spinner.set_visible(Boolean(conv?.busy));
    this.spinner.set_spinning(Boolean(conv?.busy));
    this.fresh.set_sensitive(Boolean(conv && !conv.busy && conv.messages.length));
  }
}
