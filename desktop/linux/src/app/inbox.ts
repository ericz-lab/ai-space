import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import type { InboxItem } from "../core/desktop.ts";
import { relativeTime } from "../core/format.ts";
import { lang, prefs, t } from "./env.ts";
import type { AppModel, Space } from "./model.ts";

/**
 * The inbox: the Space's open threads, newest first. Opening one marks it read and goes to its
 * page; Done takes it off the list. The same threads arrive as desktop notifications with Mark
 * as Read and Done on them.
 */
export class InboxPage {
  readonly widget: any;
  private readonly list: any;
  private readonly stack: any;
  private readonly markAll: any;
  private space: Space | undefined;
  private key = "";

  constructor(
    private readonly model: AppModel,
    private readonly openUrl: (space: Space, url: string) => void,
  ) {
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
    const bar = new Gtk.Box({ margin_top: 12, margin_start: 16, margin_end: 16, spacing: 8 });
    const title = new Gtk.Label({ label: t("inbox"), xalign: 0, hexpand: true });
    title.add_css_class("title-2");
    bar.append(title);
    this.markAll = new Gtk.Button({ label: t("markAllRead") });
    this.markAll.connect("clicked", () => this.space && void this.model.markAllRead(this.space));
    bar.append(this.markAll);
    const barClamp = new Adw.Clamp({ maximum_size: 820, child: bar });
    box.append(barClamp);

    this.list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, margin_top: 12, margin_bottom: 24, margin_start: 16, margin_end: 16, valign: Gtk.Align.START });
    this.list.add_css_class("boxed-list");
    this.list.connect("row-activated", (_l: unknown, row: any) => this.activate(row.item));
    const empty = new Adw.StatusPage({ icon_name: "mail-read-symbolic", title: t("inboxEmpty"), description: t("inboxEmptyBody"), vexpand: true });
    this.stack = new Gtk.Stack();
    this.stack.add_named(new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: new Adw.Clamp({ maximum_size: 820, child: this.list }) }), "list");
    this.stack.add_named(empty, "empty");
    box.append(this.stack);
    this.widget = box;
    model.on((change, space) => {
      if (change === "inbox" && space === this.space) this.render();
    });
  }

  show(space: Space | undefined): void {
    if (space !== this.space) this.key = "";
    this.space = space;
    this.render();
    if (space?.ready) void this.model.loadInbox(space);
  }

  private activate(item: InboxItem): void {
    const space = this.space;
    if (!space) return;
    if (item.unread) void this.model.markInbox(space, [item.thread], { read: true });
    if (item.url) this.openUrl(space, item.url);
  }

  private render(): void {
    const items = (this.space?.inbox.items ?? []).filter((i) => !i.done);
    const key = JSON.stringify(items.map((i) => [i.thread, i.lastAt, i.unread, i.count]));
    this.markAll.set_sensitive(items.some((i) => i.unread));
    this.stack.set_visible_child_name(items.length ? "list" : "empty");
    if (key === this.key) return;
    this.key = key;
    this.list.remove_all();
    for (const item of items) this.list.append(this.row(item));
  }

  private row(item: InboxItem): any {
    const row = new Gtk.ListBoxRow({ activatable: true }) as any;
    row.item = item;
    const box = new Gtk.Box({ spacing: 12, margin_top: 10, margin_bottom: 10, margin_start: 12, margin_end: 8 });
    const urgent = item.level === "alert" || item.level === "warn";
    const dot = new Gtk.Box({ valign: Gtk.Align.START, margin_top: 6, css_classes: ["reach-dot", urgent ? "reach-down" : "unread-dot"], opacity: item.unread ? 1 : 0 });
    box.append(dot);
    const text = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, hexpand: true });
    const head = new Gtk.Box({ spacing: 8 });
    const title = new Gtk.Label({ label: item.title || item.app, xalign: 0, hexpand: true, ellipsize: Pango.EllipsizeMode.END });
    if (item.unread) title.add_css_class("heading");
    head.append(title);
    const when = new Gtk.Label({ label: relativeTime(item.lastAt, lang) });
    when.add_css_class("dim-label");
    when.add_css_class("inbox-time");
    head.append(when);
    text.append(head);
    // The app's name is the title when the thread has none; the line below then carries only the count.
    const sub = [item.title ? item.app : "", item.count > 1 ? String(item.count) : ""].filter(Boolean).join(" · ");
    if (sub) text.append(new Gtk.Label({ label: sub, xalign: 0, css_classes: ["caption", "dim-label"] }));
    const body = new Gtk.Label({ label: item.text, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, lines: 3, ellipsize: Pango.EllipsizeMode.END });
    text.append(body);
    box.append(text);
    const actions = new Gtk.Box({ spacing: 2, valign: Gtk.Align.CENTER });
    if (item.unread) {
      const read = new Gtk.Button({ icon_name: "mail-read-symbolic", tooltip_text: t("markRead"), css_classes: ["flat", "circular"] });
      read.connect("clicked", () => this.space && void this.model.markInbox(this.space, [item.thread], { read: true }));
      actions.append(read);
    }
    const done = new Gtk.Button({ icon_name: "object-select-symbolic", tooltip_text: t("done"), css_classes: ["flat", "circular"] });
    done.connect("clicked", () => this.space && void this.model.markInbox(this.space, [item.thread], { done: true, read: true }));
    actions.append(done);
    box.append(actions);
    row.set_child(box);
    return row;
  }
}

/**
 * Desktop notifications for new inbox threads, through the desktop's notification service. Each
 * carries Mark as Read and Done; clicking it opens the thread. The actions are the application's
 * (`app.inbox-open` and friends) so they work after the window has closed.
 */
export class Notifier {
  constructor(
    private readonly app: any,
    private readonly model: AppModel,
    private readonly openThread: (space: Space, item: InboxItem) => void,
  ) {
    const action = (name: string, run: (space: Space, item: InboxItem) => void) => {
      const a = new Gio.SimpleAction({ name, parameter_type: new GLib.VariantType("s") });
      a.connect("activate", (_a: unknown, param: any) => {
        const [connection, thread] = JSON.parse(param.unpack()) as [string, string];
        const space = this.model.space(connection);
        const item = space?.inbox.items.find((i) => i.thread === thread);
        if (space && item) run(space, item);
        else if (space) this.model.select(space.conn.id);
      });
      app.add_action(a);
    };
    action("inbox-open", (space, item) => this.openThread(space, item));
    action("inbox-read", (space, item) => void this.model.markInbox(space, [item.thread], { read: true }));
    action("inbox-done", (space, item) => void this.model.markInbox(space, [item.thread], { read: true, done: true }));
  }

  post(space: Space, items: InboxItem[]): void {
    if (!prefs.notifications || !items.length) return;
    const many = this.model.list.connections.length > 1;
    for (const item of items.slice(0, 5)) {
      const n = new Gio.Notification();
      n.set_title(item.title || item.app);
      const body = item.text.length > 400 ? `${item.text.slice(0, 400)}…` : item.text;
      n.set_body(many ? `${item.app} · ${space.conn.name}\n${body}` : body);
      if (item.level === "alert" || item.level === "warn") n.set_priority(Gio.NotificationPriority.HIGH);
      const target = new GLib.Variant("s", JSON.stringify([space.conn.id, item.thread]));
      n.set_default_action_and_target_value("app.inbox-open", target);
      n.add_button_with_target_value(t("markRead"), "app.inbox-read", target);
      n.add_button_with_target_value(t("done"), "app.inbox-done", target);
      // One notification per thread: a newer message replaces the older one.
      this.app.send_notification(`${space.conn.id}/${item.thread}`, n);
    }
  }
}
