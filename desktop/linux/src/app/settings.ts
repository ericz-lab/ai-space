import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { APP_ID, APP_ROOT, exists, logError, path, prefs, savePrefs, t, writeText } from "./env.ts";
import type { LocalManager } from "./local-manager.ts";
import { LocalPanel } from "./local-view.ts";
import { PeerPage } from "./peer-view.ts";
import type { AppModel } from "./model.ts";
import { connectForm } from "./welcome.ts";

/**
 * Settings, as one preferences dialog: the saved Spaces (switch, make default, remove, add), how
 * the app behaves (keep running for notifications, start at login, notifications, the Quick Chat
 * shortcut), in the Local edition AI Space on this computer, and this computer as a peer of a
 * Space used elsewhere (peer-view.ts). A Space's own settings stay on
 * its panel page.
 */

const AUTOSTART = path(GLib.get_user_config_dir(), "autostart", `${APP_ID}.desktop`);

/** The command the desktop runs for this app: the launcher the build installed, else `ai-space`. */
export function launcher(): string {
  return GLib.getenv("AISPACE_LAUNCHER") || "ai-space";
}

export function setAutostart(on: boolean): void {
  if (!on) {
    GLib.unlink(AUTOSTART);
    return;
  }
  const text = ["[Desktop Entry]", "Type=Application", "Name=AI Space", `Exec=${GLib.shell_quote(launcher())} --background`, `Icon=${APP_ID}`, "X-GNOME-Autostart-enabled=true", "NoDisplay=true", ""].join("\n");
  void writeText(AUTOSTART, text).catch((e) => logError(e, "autostart"));
}

export function showSettings(parent: any, model: AppModel, local: LocalManager, page?: "local" | "peer"): void {
  const dialog = new Adw.PreferencesDialog({ title: t("settings"), search_enabled: false });

  // General
  const general = new Adw.PreferencesPage({ title: t("general"), icon_name: "emblem-system-symbolic" });
  const spaces = new Adw.PreferencesGroup({ title: t("spaces") });
  general.add(spaces);
  const rows: any[] = [];
  const renderSpaces = () => {
    for (const r of rows.splice(0)) spaces.remove(r);
    for (const c of model.list.connections) {
      const row = new Adw.ActionRow({ title: c.name, subtitle: c.url, activatable: true });
      if (model.current?.conn.id === c.id) row.add_prefix(new Gtk.Image({ icon_name: "object-select-symbolic" }));
      else row.add_prefix(new Gtk.Box({ width_request: 16 }));
      const tags: string[] = [];
      if (c.isDefault) tags.push(t("isDefault"));
      if (c.managed) tags.push(t("managedTag"));
      if (tags.length) row.add_suffix(new Gtk.Label({ label: tags.join(" · "), css_classes: ["dim-label", "caption"] }));
      const menu = new Gtk.MenuButton({ icon_name: "view-more-symbolic", valign: Gtk.Align.CENTER, css_classes: ["flat"] });
      const pop = new Gtk.Popover();
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
      const item = (label: string, run: () => void, destructive = false) => {
        const b = new Gtk.Button({ label, css_classes: ["flat", ...(destructive ? ["destructive-action"] : [])] });
        b.connect("clicked", () => {
          pop.popdown();
          run();
        });
        box.append(b);
      };
      if (!c.isDefault)
        item(t("makeDefault"), () => {
          model.list.setDefault(c.id);
          model.save();
          renderSpaces();
        });
      item(t("remove"), () => {
        model.remove(c.id);
        renderSpaces();
      }, true);
      pop.set_child(box);
      menu.set_popover(pop);
      row.add_suffix(menu);
      row.connect("activated", () => {
        model.select(c.id);
        renderSpaces();
      });
      spaces.add(row);
      rows.push(row);
    }
  };
  renderSpaces();
  const add = new Adw.PreferencesGroup();
  add.add(connectForm(model, () => renderSpaces()));
  general.add(add);

  const behaviour = new Adw.PreferencesGroup({ title: t("behaviour") });
  const background = new Adw.SwitchRow({ title: t("background"), subtitle: t("backgroundBody"), active: prefs.background });
  background.connect("notify::active", () => {
    prefs.background = background.get_active();
    savePrefs();
  });
  behaviour.add(background);
  const autostart = new Adw.SwitchRow({ title: t("autostart"), active: exists(AUTOSTART) });
  autostart.connect("notify::active", () => setAutostart(autostart.get_active()));
  behaviour.add(autostart);
  const notifications = new Adw.SwitchRow({ title: t("notifications"), active: prefs.notifications });
  notifications.connect("notify::active", () => {
    prefs.notifications = notifications.get_active();
    savePrefs();
  });
  behaviour.add(notifications);
  general.add(behaviour);

  /** A command shown to copy into a terminal or the desktop's settings. */
  const commandRow = (command: string) => {
    const row = new Adw.ActionRow({ title: command, title_selectable: true, use_markup: false, css_classes: ["monospace"] });
    const copy = new Gtk.Button({ icon_name: "edit-copy-symbolic", valign: Gtk.Align.CENTER, css_classes: ["flat"] });
    copy.connect("clicked", () => {
      row.get_clipboard().set(command);
      dialog.add_toast(new Adw.Toast({ title: t("copied"), timeout: 1 }));
    });
    row.add_suffix(copy);
    return row;
  };
  const quick = new Adw.PreferencesGroup({ title: t("quickChat"), description: t("quickChatHint") });
  quick.add(commandRow(`${launcher()} --quick-chat`));
  general.add(quick);

  // The launcher turned WebKit's sandbox off because the system blocks what it needs.
  if (GLib.getenv("AISPACE_WEB_SANDBOX") === "off") {
    const sandbox = new Adw.PreferencesGroup({ title: t("sandboxOff"), description: t("sandboxOffBody") });
    sandbox.add(commandRow(`${path(APP_ROOT, "install.sh")} --apparmor`));
    general.add(sandbox);
  }
  dialog.add(general);

  // This computer
  if (local.available) {
    const localPage = new Adw.PreferencesPage({ title: t("thisComputer"), icon_name: "computer-symbolic" });
    const g = new Adw.PreferencesGroup();
    g.add(new LocalPanel(local, model, { onConnected: () => renderSpaces() }).widget);
    localPage.add(g);
    dialog.add(localPage);
    if (page === "local") dialog.set_visible_page(localPage);
    void local.refresh();
  }

  // This computer as a peer of a Space used elsewhere
  const peer = new PeerPage(local, model, { toast: (title) => dialog.add_toast(new Adw.Toast({ title, timeout: 3 })), copyRow: commandRow });
  dialog.add(peer.widget);
  if (page === "peer") dialog.set_visible_page(peer.widget);
  dialog.present(parent);
}
