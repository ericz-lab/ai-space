import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { machinesOf } from "../core/agents.ts";
import { type Agent, pickText } from "../core/catalogue.ts";
import { type MachineInventory, decodeInventory, usableClis } from "../core/inventory.ts";
import { type ChatImage, type ChatStep, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_IMAGES_BYTES, PERMISSIONS, type Permission, granting, imageType, questionAnswer, retryable } from "../core/chat.ts";
import type { ChatMessage, Conversation } from "../core/conversation.ts";
import { markdownBlocks } from "../core/markdown.ts";
import { allCommands, stepGroups, toolSummary, toolVariant } from "../../../../src/web/chat-steps.ts";
import type { Key } from "../core/i18n.ts";
import { coalesce, lang, prefs, savePrefs, t, tw } from "./env.ts";
import { iconWidget } from "./icons.ts";
import { collectSoon } from "./memory.ts";
import type { AppModel, Space } from "./model.ts";

/**
 * One conversation drawn natively, shared by the main window's chat and Quick Chat: the person's
 * messages in the accent colour, the agent's as borderless text in a column of about 72
 * characters, each tool call one quiet line that opens to its input and output, approvals and
 * questions as cards, a failed turn as a card with its reason and Try Again.
 */

const TOOL_TITLES: Record<string, string> = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", search: "Search", web: "Web", code: "Code", task: "Agent", plan: "Plan" };

function toolTitle(name: string): string {
  const v = toolVariant(name);
  if (v !== "other") return TOOL_TITLES[v]!;
  return name.replace(/^mcp__/, "").replace(/__/g, " · ");
}

function label(text: string, opts: { markup?: boolean; classes?: string[]; xalign?: number; selectable?: boolean; wrap?: boolean } = {}): any {
  const l = new Gtk.Label({ xalign: opts.xalign ?? 0, wrap: opts.wrap ?? true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: opts.selectable ?? true, use_markup: Boolean(opts.markup) });
  if (opts.markup) l.set_markup(text);
  else l.set_text(text);
  for (const c of opts.classes ?? []) l.add_css_class(c);
  // A selectable label grabs focus on click; keep the composer's focus.
  l.set_focus_on_click?.(false);
  return l;
}

function markdown(text: string, onLink: (uri: string) => boolean): any {
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
  // Links go to the app's own tab or the browser, never inside the label.
  const rich = (markup: string, classes: string[] = []) => {
    const l = label(markup, { markup: true, classes });
    l.connect("activate-link", (_l: unknown, uri: string) => onLink(uri));
    return l;
  };
  for (const b of markdownBlocks(text)) {
    switch (b.kind) {
      case "paragraph":
        box.append(rich(b.markup));
        break;
      case "heading":
        box.append(rich(b.markup, [`md-heading-${Math.min(3, b.level)}`]));
        break;
      case "item": {
        const row = new Gtk.Box({ spacing: 6, margin_start: 4 + b.depth * 18 });
        row.append(label(b.bullet, { selectable: false, wrap: false }));
        const body = rich(b.markup);
        body.set_hexpand(true);
        row.append(body);
        box.append(row);
        break;
      }
      case "quote":
        box.append(rich(b.markup, ["md-quote", "dim-label"]));
        break;
      case "code":
      case "table": {
        const l = label(b.text, { wrap: false, classes: ["md-code"] });
        box.append(new Gtk.ScrolledWindow({ vscrollbar_policy: Gtk.PolicyType.NEVER, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, child: l, propagate_natural_height: true }));
        break;
      }
      case "rule":
        box.append(new Gtk.Separator({ margin_top: 4, margin_bottom: 4 }));
        break;
    }
  }
  return box;
}

function base64(bytes: Uint8Array): string {
  return GLib.base64_encode(bytes);
}

/** `onMachine`: the person picked another machine's variant of the agent in the machine menu. */
export type ChatViewOptions = { compact?: boolean; onLink: (uri: string) => void; onMachine?: (agent: Agent) => void };

// The agent CLIs each machine has, named in the machine menu; read once a minute at most, per Space.
const inventories = new Map<string, { at: number; rows: MachineInventory[] }>();

export class ChatView {
  readonly widget: any;
  private readonly list: any;
  private readonly scroller: any;
  private readonly empty: any;
  private readonly emptyAvatar: any;
  private readonly emptyTitle: any;
  private readonly emptyBody: any;
  private readonly input: any;
  private readonly attachments: any;
  private readonly stopButton: any;
  private readonly sendButton: any;
  private readonly permission: any;
  private readonly error: any;
  private readonly machine: any;
  private readonly offline: any;
  private machines: Agent[] = [];
  private machinesKey = "";
  private space: Space | undefined;
  private agent: Agent | undefined;
  private conv: Conversation | undefined;
  private rows: { id: string; sig: string; widget: any }[] = [];
  private images: ChatImage[] = [];
  private composing = false;
  private stick = true;
  readonly redraw = coalesce(() => this.render(), 50);

  constructor(
    private readonly model: AppModel,
    private readonly o: ChatViewOptions,
  ) {
    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true, hexpand: true });
    this.list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 14, margin_top: 16, margin_bottom: 16, margin_start: 16, margin_end: 16 });
    const clamp = new Adw.Clamp({ maximum_size: 760, tightening_threshold: 600, child: this.list });
    // Before the first message: the agent's avatar, name and what it does.
    this.empty = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12, vexpand: true, valign: Gtk.Align.CENTER, margin_start: 24, margin_end: 24 });
    this.emptyAvatar = new Gtk.Box({ halign: Gtk.Align.CENTER });
    this.emptyTitle = new Gtk.Label({ css_classes: ["title-2"], wrap: true, justify: Gtk.Justification.CENTER });
    this.emptyBody = new Gtk.Label({ css_classes: ["dim-label"], wrap: true, justify: Gtk.Justification.CENTER, max_width_chars: 60 });
    this.empty.append(this.emptyAvatar);
    this.empty.append(this.emptyTitle);
    this.empty.append(this.emptyBody);
    const stack = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, vexpand: true });
    stack.append(this.empty);
    stack.append(clamp);
    this.scroller = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: stack });
    // Follow the reply while the person is at the bottom; leave the view alone once they scroll up.
    const adj = this.scroller.get_vadjustment();
    adj.connect("value-changed", () => (this.stick = adj.get_value() + adj.get_page_size() >= adj.get_upper() - 40));
    adj.connect("changed", () => {
      if (this.stick) adj.set_value(adj.get_upper() - adj.get_page_size());
    });
    this.widget.append(this.scroller);

    // The composer.
    const composerClamp = new Adw.Clamp({ maximum_size: 760, tightening_threshold: 600, margin_start: 12, margin_end: 12, margin_bottom: 12 });
    const composer = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4 });
    composer.add_css_class("card");
    composer.add_css_class("composer");
    this.error = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_start: 6 });
    this.error.add_css_class("error");
    composer.append(this.error);
    // A machine that does not answer cannot take a message (the web's chat.machineOfflineNote).
    this.offline = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_start: 6, margin_top: 4 });
    this.offline.add_css_class("dim-label");
    composer.append(this.offline);
    this.attachments = new Gtk.Box({ spacing: 6, visible: false, margin_start: 4, margin_top: 4 });
    composer.append(this.attachments);
    this.input = new Gtk.TextView({ wrap_mode: Gtk.WrapMode.WORD_CHAR, accepts_tab: false, top_margin: 6, bottom_margin: 6, left_margin: 6, right_margin: 6 });
    this.input.add_css_class("inline");
    this.input.connect("preedit-changed", (_v: unknown, text: string) => (this.composing = text.length > 0));
    const keys = new Gtk.EventControllerKey();
    keys.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
    keys.connect("key-pressed", (_c: unknown, keyval: number, _code: number, state: number) => {
      const enter = keyval === Gdk.KEY_Return || keyval === Gdk.KEY_KP_Enter;
      // Return confirms an input method's candidate first; Shift+Return is a new line.
      if (enter && !this.composing && !(state & Gdk.ModifierType.SHIFT_MASK)) {
        this.send();
        return true;
      }
      if (keyval === Gdk.KEY_v && state & Gdk.ModifierType.CONTROL_MASK && this.pasteImage()) return true;
      return false;
    });
    this.input.add_controller(keys);
    const inputScroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true, max_content_height: 180, min_content_height: 36, child: this.input });
    composer.append(inputScroll);
    const bar = new Gtk.Box({ spacing: 6 });
    const attach = new Gtk.Button({ icon_name: "mail-attachment-symbolic", tooltip_text: t("attachImage") });
    attach.add_css_class("flat");
    attach.connect("clicked", () => void this.chooseImages());
    bar.append(attach);
    this.permission = Gtk.DropDown.new_from_strings(PERMISSIONS.map((p) => t(`perm.${p}` as Key)));
    this.permission.set_tooltip_text(t("permission"));
    this.permission.add_css_class("flat");
    this.permission.set_selected(Math.max(0, PERMISSIONS.indexOf(prefs.permission)));
    this.permission.connect("notify::selected", () => {
      prefs.permission = PERMISSIONS[this.permission.get_selected()] ?? "";
      savePrefs();
    });
    bar.append(this.permission);
    // The same agent on several machines: which one this conversation talks to.
    this.machine = Gtk.DropDown.new_from_strings([]);
    this.machine.set_tooltip_text(tw("chat.machineTitle"));
    this.machine.add_css_class("flat");
    this.machine.set_visible(false);
    this.machine.connect("notify::selected", () => this.pickMachine(this.machines[this.machine.get_selected()]));
    bar.append(this.machine);
    bar.append(new Gtk.Box({ hexpand: true }));
    this.stopButton = new Gtk.Button({ icon_name: "media-playback-stop-symbolic", tooltip_text: t("stop"), visible: false });
    this.stopButton.add_css_class("circular");
    this.stopButton.connect("clicked", () => this.conv?.stop());
    bar.append(this.stopButton);
    this.sendButton = new Gtk.Button({ icon_name: "go-up-symbolic", tooltip_text: t("send") });
    this.sendButton.add_css_class("circular");
    this.sendButton.add_css_class("suggested-action");
    this.sendButton.connect("clicked", () => this.send());
    bar.append(this.sendButton);
    composer.append(bar);
    composerClamp.set_child(composer);
    this.widget.append(composerClamp);

    // Pictures dropped on the conversation are attached.
    const drop = Gtk.DropTarget.new(Gdk.FileList.$gtype, Gdk.DragAction.COPY);
    drop.connect("drop", (_d: unknown, value: any) => {
      for (const f of value.get_files()) void this.attachFile(f);
      return true;
    });
    this.widget.add_controller(drop);
  }

  get conversation(): Conversation | undefined {
    return this.conv;
  }

  show(space: Space | undefined, agent: Agent | undefined): void {
    const same = this.space === space && this.agent?.id === agent?.id;
    this.space = space;
    this.agent = agent;
    this.conv = space && agent ? this.model.conversation(space, agent) : undefined;
    if (!same) {
      for (const r of this.rows) this.list.remove(r.widget);
      this.rows = [];
      this.stick = true;
    }
    const name = agent ? pickText(agent.title, agent.i18n, "title", lang) : "";
    this.emptyTitle.set_text(name);
    this.emptyBody.set_text(agent ? pickText(agent.description ?? "", agent.i18n, "description", lang) : t("noAgents"));
    const old = this.emptyAvatar.get_first_child();
    if (old) this.emptyAvatar.remove(old);
    if (agent) this.emptyAvatar.append(iconWidget(agent.avatar, 72, space?.client, "avatar-default-symbolic"));
    this.renderMachines();
    this.render();
  }

  private renderMachines(): void {
    const agent = this.agent;
    const groups = this.space?.catalogue?.agentGroups ?? [];
    this.machines = agent ? machinesOf(groups, agent) : [];
    if (agent && !this.machines.some((m) => m.id === agent.id)) this.machines = [agent, ...this.machines];
    const several = this.machines.length > 1;
    this.machine.set_visible(several);
    this.offline.set_text(agent?.stale ? tw("chat.machineOfflineNote", { machine: agent.peer ?? tw("chat.thisMachine") }) : "");
    this.offline.set_visible(Boolean(agent?.stale));
    this.sendButton.set_sensitive(!agent?.stale);
    if (!several || !this.space) return;
    const inv = inventories.get(this.space.conn.id);
    const rows = inv?.rows ?? [];
    const labels = this.machines.map((m) => {
      const clis = usableClis(rows, m.peer);
      return `${m.peer ?? tw("chat.thisMachine")}${clis.length ? ` · ${clis.join(", ")}` : ""}${m.stale ? ` (${tw("chat.machineOffline")})` : ""}`;
    });
    const key = JSON.stringify(labels);
    if (key !== this.machinesKey) {
      this.machinesKey = key;
      this.machine.set_model(Gtk.StringList.new(labels));
    }
    const at = this.machines.findIndex((m) => m.id === agent!.id);
    if (this.machine.get_selected() !== at) this.machine.set_selected(at);
    if (!inv || Date.now() - inv.at > 60_000) {
      const space = this.space;
      inventories.set(space.conn.id, { at: Date.now(), rows });
      void space.client.get("/api/model/inventory").then((body) => {
        inventories.set(space.conn.id, { at: Date.now(), rows: decodeInventory(body) });
        if (this.space === space) this.renderMachines();
      }, () => {});
    }
  }

  private pickMachine(m: Agent | undefined): void {
    const agent = this.agent;
    if (!m || !agent || m.id === agent.id) return;
    // An offline machine is listed but not picked: back to the one in use.
    if (m.stale) {
      this.machine.set_selected(this.machines.findIndex((x) => x.id === agent.id));
      return;
    }
    this.model.rememberMachine(m);
    this.o.onMachine?.(m);
  }

  focus(): void {
    this.input.grab_focus();
  }

  setDraft(text: string): void {
    this.input.get_buffer().set_text(text, -1);
    this.focus();
  }

  /** A picture added to the next message, as one attached by hand (the floating ball's drop). */
  attachImage(name: string, bytes: Uint8Array): void {
    this.addImage(name, bytes);
  }

  draft(): string {
    const b = this.input.get_buffer();
    return b.get_text(b.get_start_iter(), b.get_end_iter(), false);
  }

  send(): void {
    const text = this.draft();
    if (!this.conv || this.agent?.stale || (!text.trim() && !this.images.length)) return;
    this.conv.send(text, this.images);
    this.input.get_buffer().set_text("", -1);
    this.images = [];
    this.renderAttachments();
    this.stick = true;
  }

  private showError(text: string | undefined): void {
    this.error.set_text(text ?? "");
    this.error.set_visible(Boolean(text));
  }

  // Images

  private addImage(name: string, bytes: Uint8Array): void {
    const type = imageType(bytes);
    const total = this.images.reduce((n, i) => n + (i.data.length * 3) / 4, 0) + bytes.length;
    if (!type || bytes.length > MAX_IMAGE_BYTES || this.images.length >= MAX_IMAGES || total > MAX_IMAGES_BYTES) return this.showError(t("imageTooLarge"));
    this.showError(undefined);
    this.images.push({ name, mediaType: type, data: base64(bytes) });
    this.renderAttachments();
  }

  private async attachFile(file: any): Promise<void> {
    try {
      const [bytes] = (await file.load_contents_async(null)) as [Uint8Array];
      this.addImage(file.get_basename() ?? "image", bytes);
    } catch {
      this.showError(t("imageTooLarge"));
    }
  }

  private async chooseImages(): Promise<void> {
    const filter = new Gtk.FileFilter();
    filter.add_mime_type("image/png");
    filter.add_mime_type("image/jpeg");
    filter.add_mime_type("image/gif");
    filter.add_mime_type("image/webp");
    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter.$gtype });
    filters.append(filter);
    const dialog = new Gtk.FileDialog({ title: t("attachImage"), filters, modal: true });
    dialog.open_multiple(this.widget.get_root(), null, (_d: unknown, res: unknown) => {
      try {
        const files = dialog.open_multiple_finish(res);
        for (let i = 0; i < files.get_n_items(); i++) void this.attachFile(files.get_item(i));
      } catch {
        /* dismissed */
      }
    });
  }

  /** A picture on the clipboard is attached instead of pasted as text. */
  private pasteImage(): boolean {
    const clipboard = this.widget.get_clipboard();
    const formats = clipboard.get_formats();
    if (!formats.contain_gtype(Gdk.Texture.$gtype) || formats.contain_mime_type("text/plain")) return false;
    clipboard.read_texture_async(null, (_c: unknown, res: unknown) => {
      try {
        const texture = clipboard.read_texture_finish(res);
        if (texture) this.addImage("pasted.png", texture.save_to_png_bytes().get_data());
      } catch {}
    });
    return true;
  }

  private renderAttachments(): void {
    let child = this.attachments.get_first_child();
    while (child) {
      const next = child.get_next_sibling();
      this.attachments.remove(child);
      child = next;
    }
    this.images.forEach((img, i) => {
      const overlay = new Gtk.Overlay();
      try {
        const texture = Gdk.Texture.new_from_bytes(new GLib.Bytes(GLib.base64_decode(img.data)));
        overlay.set_child(new Gtk.Picture({ paintable: texture, width_request: 56, height_request: 56, content_fit: Gtk.ContentFit.COVER, css_classes: ["attachment"] }));
      } catch {
        overlay.set_child(new Gtk.Image({ icon_name: "image-x-generic-symbolic", pixel_size: 40 }));
      }
      const remove = new Gtk.Button({ icon_name: "window-close-symbolic", halign: Gtk.Align.END, valign: Gtk.Align.START, css_classes: ["circular", "osd"] });
      remove.connect("clicked", () => {
        this.images.splice(i, 1);
        this.renderAttachments();
      });
      overlay.add_overlay(remove);
      this.attachments.append(overlay);
    });
    this.attachments.set_visible(this.images.length > 0);
  }

  // Messages

  private render(): void {
    const conv = this.conv;
    const messages = conv?.messages ?? [];
    this.empty.set_visible(messages.length === 0);
    this.stopButton.set_visible(Boolean(conv?.busy));
    this.showError(conv?.error);
    const name = this.agent ? pickText(this.agent.title, this.agent.i18n, "title", lang) : "";
    this.input.set_tooltip_text(t("messagePlaceholder", { agent: name }));
    this.permission.set_selected(Math.max(0, PERMISSIONS.indexOf(prefs.permission)));
    // Order changed (a queued reply inserted, another conversation opened): draw everything again.
    if (messages.length < this.rows.length || this.rows.some((r, i) => messages[i]?.id !== r.id)) {
      for (const r of this.rows) this.list.remove(r.widget);
      if (this.rows.length) collectSoon();
      this.rows = [];
    }
    messages.forEach((m, i) => {
      const last = i === messages.length - 1;
      const sig = JSON.stringify([m.text, m.steps, m.failure, m.pending, m.activity, m.denied, m.note, m.stopped, m.images.length, last && !conv!.busy]);
      const row = this.rows[i];
      if (row && row.sig === sig) return;
      const widget = this.message(m, last);
      if (row) {
        this.list.insert_child_after(widget, row.widget);
        this.list.remove(row.widget);
        this.rows[i] = { id: m.id, sig, widget };
        // A streamed reply is drawn again many times a second: the old drawings go soon after.
        collectSoon();
      } else {
        this.list.append(widget);
        this.rows.push({ id: m.id, sig, widget });
      }
    });
  }

  private link = (uri: string): boolean => {
    this.o.onLink(uri);
    return true;
  };

  private message(m: ChatMessage, last: boolean): any {
    if (m.role === "user") {
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6, halign: Gtk.Align.END, margin_start: 64 });
      if (m.images.length) {
        const pics = new Gtk.Box({ spacing: 6, halign: Gtk.Align.END });
        for (const img of m.images) {
          try {
            pics.append(new Gtk.Picture({ paintable: Gdk.Texture.new_from_bytes(new GLib.Bytes(GLib.base64_decode(img.data))), width_request: 96, height_request: 96, content_fit: Gtk.ContentFit.COVER, css_classes: ["attachment"] }));
          } catch {}
        }
        box.append(pics);
      }
      if (m.text) {
        const bubble = new Gtk.Box({ halign: Gtk.Align.END });
        bubble.add_css_class("user-bubble");
        bubble.append(label(m.text, { selectable: true }));
        box.append(bubble);
      }
      return box;
    }
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_end: 24 });
    box.add_css_class("agent-message");
    if (m.steps.length) {
      for (const g of stepGroups(m.steps)) box.append(Array.isArray(g) ? this.tools(g, m.historic) : this.step(g));
    } else if (m.text && !m.failure) {
      box.append(markdown(m.text, this.link));
    }
    if (m.steps.length && m.note) box.append(label(m.note, { classes: ["dim-label"] }));
    if (m.steps.length && m.stopped) box.append(label(t("stopped"), { classes: ["dim-label"] }));
    for (const p of m.pending) {
      const l = label(t("waitingRead", { text: p }), { classes: ["dim-label", "pending-line"] });
      l.set_ellipsize(Pango.EllipsizeMode.END);
      box.append(l);
    }
    if (m.activity) {
      const row = new Gtk.Box({ spacing: 8 });
      row.append(new Gtk.Spinner({ spinning: true }));
      const a = m.activity;
      const text = a.kind === "starting" ? t("starting") : a.kind === "reconnecting" ? t("reconnecting") : a.kind === "thinking" ? t("thinking") : t("running", { tool: toolTitle(a.tool) });
      row.append(label(text, { classes: ["dim-label", "activity-line"], selectable: false }));
      box.append(row);
    }
    if (m.failure) box.append(this.failure(m, last));
    if (last && m.denied.length && !this.conv?.busy) {
      const row = new Gtk.Box({ spacing: 10 });
      const grant = new Gtk.Button({ label: t("grantRetry") });
      grant.add_css_class("pill");
      grant.connect("clicked", () => this.conv?.grantAndRetry());
      row.append(grant);
      const scope = granting(prefs.permission, m.denied) as Permission;
      row.append(label(t("grantScope", { scope: t(`perm.${scope}` as Key) }), { classes: ["dim-label"], selectable: false }));
      box.append(row);
    }
    return box;
  }

  private failure(m: ChatMessage, last: boolean): any {
    const f = m.failure!;
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 });
    card.add_css_class("card");
    card.add_css_class("card-inner");
    card.add_css_class("failure-card");
    const head = new Gtk.Box({ spacing: 8 });
    head.append(new Gtk.Image({ icon_name: "dialog-warning-symbolic" }));
    head.append(label(t(`fail.${f.kind}` as Key, { code: f.code ?? "" }), { classes: ["heading"] }));
    card.append(head);
    if (f.detail) card.append(label(f.detail, { classes: ["dim-label", "caption"] }));
    if (last && retryable(f) && this.conv?.retryableMessage !== undefined) {
      const retry = new Gtk.Button({ label: t("tryAgain"), halign: Gtk.Align.START });
      retry.connect("clicked", () => this.conv?.retry());
      card.append(retry);
    }
    return card;
  }

  private step(s: ChatStep): any {
    switch (s.kind) {
      case "text":
        return markdown(s.text, this.link);
      case "steer":
        return label(t("youAdded", { text: s.text }), { classes: ["dim-label"] });
      case "approval":
        return s.questions?.length ? this.questionCard(s) : this.approvalCard(s);
      default:
        return this.toolRow(s);
    }
  }

  /** A run of tool calls stacks as one tight list; a restored one folds to a single line. */
  private tools(steps: ChatStep[], historic: boolean): any {
    const list = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    list.add_css_class("tool-group");
    for (const s of steps) list.append(this.toolRow(s));
    if (!historic || steps.length < 2) return list;
    const fold = new Gtk.Expander({ label: allCommands(steps) ? t("ranCommands", { n: steps.length }) : t("calledTools", { n: steps.length }), child: list });
    fold.add_css_class("tool-row");
    return fold;
  }

  private toolRow(s: ChatStep): any {
    const head = new Gtk.Box({ spacing: 8 });
    const dot = new Gtk.Label({ label: "●" });
    dot.add_css_class("tool-dot");
    dot.add_css_class(s.state === "running" ? "tool-running" : s.state === "failed" ? "tool-failed" : s.state === "completed" ? "tool-ok" : "dim-label");
    head.append(dot);
    const kind = new Gtk.Label({ label: toolTitle(s.name) });
    kind.add_css_class("tool-kind");
    head.append(kind);
    const summary = new Gtk.Label({ label: toolSummary(s.text), xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    summary.add_css_class(s.state === "failed" ? "tool-failed" : "dim-label");
    head.append(summary);
    if (s.state === "running") head.append(new Gtk.Spinner({ spinning: true }));
    const detail = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 4, margin_start: 22, margin_top: 4, margin_bottom: 6 });
    const block = (title: string, text: string) => {
      detail.append(label(title, { classes: ["caption", "dim-label"], selectable: false }));
      const l = label(text, { wrap: true, classes: ["tool-detail"] });
      detail.append(l);
    };
    block(t("input"), s.text || "—");
    block(t("output"), s.output || (s.state === "incomplete" ? t("noResult") : s.state === "running" ? "…" : "—"));
    const row = new Gtk.Expander({ label_widget: head, child: detail });
    row.add_css_class("tool-row");
    if (s.state === "failed") row.add_css_class("tool-failed");
    return row;
  }

  private stateLabel(s: ChatStep): string {
    return s.state === "allowed" ? t("allowed") : s.state === "denied" ? t("denied") : t("notAnswered");
  }

  private approvalCard(s: ChatStep): any {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8 });
    card.add_css_class("card");
    card.add_css_class("card-inner");
    card.append(label(t("wantsTo", { tool: toolTitle(s.name) }), { classes: ["heading"] }));
    if (s.text) card.append(label(s.text, { classes: ["tool-detail"] }));
    if (s.output) card.append(label(s.output, { classes: ["dim-label"] }));
    if (s.state !== "waiting") {
      card.append(label(this.stateLabel(s), { classes: ["dim-label"], selectable: false }));
      return card;
    }
    const row = new Gtk.Box({ spacing: 8 });
    const problem = label("", { classes: ["error", "caption"] });
    problem.set_visible(false);
    // The buttons' handlers find the row and the problem line from the button: a handler holding
    // the widgets around its button would keep the card alive after the message is drawn again.
    const answer = async (button: any, allow: boolean) => {
      const row = button.get_parent();
      const problem = row?.get_next_sibling();
      row?.set_sensitive(false);
      const why = await this.conv?.answer(s.id.replace(/^approval:/, ""), allow);
      if (why) {
        problem?.set_text(why);
        problem?.set_visible(true);
        row?.set_sensitive(true);
      }
    };
    const allow = new Gtk.Button({ label: t("allow") });
    allow.add_css_class("suggested-action");
    allow.connect("clicked", (b: any) => void answer(b, true));
    const deny = new Gtk.Button({ label: t("deny") });
    deny.connect("clicked", (b: any) => void answer(b, false));
    row.append(allow);
    row.append(deny);
    card.append(row);
    card.append(problem);
    return card;
  }

  /** The agent's question: one choice of one question goes back on the click; anything else with Send. */
  private questionCard(s: ChatStep): any {
    const questions = s.questions!;
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 });
    card.add_css_class("card");
    card.add_css_class("card-inner");
    if (s.state !== "waiting") {
      for (const q of questions) {
        card.append(label(q.question, { classes: ["heading"] }));
        const a = s.answers?.[q.id];
        card.append(label(a?.length ? a.join(", ") : s.state === "denied" ? t("skipped") : this.stateLabel(s), { classes: ["dim-label"] }));
      }
      return card;
    }
    const id = s.id.replace(/^approval:/, "");
    const problem = label("", { classes: ["error", "caption"] });
    problem.set_visible(false);
    // As in approvalCard, a handler reaches the card through the widget it is on, never holds it.
    const reply = async (from: any, allow: boolean, answers?: Record<string, string[]>) => {
      let c = from;
      while (c && !c.has_css_class("card-inner")) c = c.get_parent();
      const problem = c?.get_last_child();
      c?.set_sensitive(false);
      const why = await this.conv?.answer(id, allow, answers);
      if (why) {
        problem?.set_text(why);
        problem?.set_visible(true);
        c?.set_sensitive(true);
      }
    };
    const oneClick = questions.length === 1 && !questions[0]!.multiSelect;
    const picks = new Map<string, Set<string>>();
    const typed = new Map<string, any>();
    for (const q of questions) {
      if (q.header) card.append(label(q.header.toUpperCase(), { classes: ["caption", "dim-label"], selectable: false }));
      card.append(label(q.question, { classes: ["heading"] }));
      const chosen = new Set<string>();
      picks.set(q.id, chosen);
      let group: any = null;
      for (const opt of q.options) {
        if (oneClick) {
          const b = new Gtk.Button({ halign: Gtk.Align.FILL });
          const v = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2 });
          v.append(label(opt.label, { selectable: false }));
          if (opt.description) v.append(label(opt.description, { classes: ["caption", "dim-label"], selectable: false }));
          b.set_child(v);
          b.connect("clicked", (button: any) => void reply(button, true, { [q.id]: [opt.label] }));
          card.append(b);
          continue;
        }
        const check = new Gtk.CheckButton({ label: opt.label, tooltip_text: opt.description || null });
        if (!q.multiSelect) {
          if (group) check.set_group(group);
          else group = check;
        }
        check.connect("toggled", (check: any) => {
          if (check.get_active()) {
            if (!q.multiSelect) chosen.clear();
            chosen.add(opt.label);
          } else chosen.delete(opt.label);
        });
        card.append(check);
      }
      const entry = new Gtk.Entry({ placeholder_text: t("yourAnswer") });
      if (oneClick) entry.connect("activate", (entry: any) => entry.get_text().trim() && void reply(entry, true, { [q.id]: questionAnswer(false, [], entry.get_text()) }));
      typed.set(q.id, entry);
      card.append(entry);
    }
    const row = new Gtk.Box({ spacing: 8 });
    if (!oneClick) {
      const sendB = new Gtk.Button({ label: t("send") });
      sendB.add_css_class("suggested-action");
      sendB.connect("clicked", (button: any) => {
        const answers: Record<string, string[]> = {};
        for (const q of questions) answers[q.id] = questionAnswer(q.multiSelect, [...(picks.get(q.id) ?? [])], typed.get(q.id)?.get_text() ?? "");
        void reply(button, true, answers);
      });
      row.append(sendB);
    }
    const skip = new Gtk.Button({ label: t("skip") });
    skip.connect("clicked", (button: any) => void reply(button, false));
    row.append(skip);
    card.append(row);
    card.append(problem);
    return card;
  }
}
