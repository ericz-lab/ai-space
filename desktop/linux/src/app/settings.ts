import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { type Appearance, type Detail, type Section, APPEARANCES, SECTION_LABEL, WEB_SECTIONS, appearanceOf, decodeAuth, hasAccount } from "../core/settings.ts";
import type { Connection } from "../core/connections.ts";
import { LANGS } from "../../../../src/web/messages.ts";
import { APP_ID, APP_ROOT, exists, logError, path, prefs, savePrefs, t, tw, writeText } from "./env.ts";
import type { LocalManager } from "./local-manager.ts";
import { LocalPanel } from "./local-view.ts";
import type { AppModel } from "./model.ts";
import { PeerPage } from "./peer-view.ts";
import { type Ctx, choiceRow, loadLabels, plain } from "./settings-kit.ts";
import { activityPage, appModelsPage, eventsPage, tasksPage, usagePage } from "./settings-pages.ts";
import { accountSection, automationSection, modelsSection, packagesSection, statusSection, usageSection } from "./settings-space.ts";
import { connectForm } from "./welcome.ts";

/**
 * Settings, laid out as the web panel's (src/web/App.tsx, SettingsNav.tsx): the sections listed on
 * the left (General, Appearance, Models, Automation, Usage, Status, Packages, and Account where the
 * Space keeps its own password), one section on the right, and the pages a section opens (App
 * models, Scheduled tasks, Events and calls, Model usage, App usage) inside the pane with Back.
 * The words are the panel's. General also holds what only this app has: the saved Spaces and how
 * the app runs. This Computer (the Local edition) and Peer follow the panel's sections.
 * The Space sections show the current Space; the section shown last opens next time.
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

/** Light, dark or the desktop's choice, for the whole app and the pages it shows. */
export function applyAppearance(mode: Appearance | undefined): void {
  const scheme = mode === "dark" ? Adw.ColorScheme.FORCE_DARK : mode === "light" ? Adw.ColorScheme.FORCE_LIGHT : Adw.ColorScheme.DEFAULT;
  Adw.StyleManager.get_default().set_color_scheme(scheme);
}

const ICONS: Record<Section, string> = {
  general: "emblem-system-symbolic",
  appearance: "preferences-desktop-appearance-symbolic",
  models: "applications-science-symbolic",
  automation: "preferences-system-time-symbolic",
  usage: "speedometer-symbolic",
  status: "network-wired-symbolic",
  packages: "package-x-generic-symbolic",
  account: "avatar-default-symbolic",
  local: "computer-symbolic",
  peer: "network-server-symbolic",
};

const SPACE_SECTIONS: Section[] = ["models", "automation", "usage", "status", "packages", "account"];

const label = (s: Section) => (s === "local" ? t("thisComputer") : s === "peer" ? t("peer") : tw(SECTION_LABEL[s]));

export function showSettings(parent: any, model: AppModel, local: LocalManager, page?: Section, detail?: Detail): void {
  const dialog = new Adw.Dialog({ title: tw("settings.title"), content_width: 980, content_height: 700, width_request: 360, height_request: 420 });
  const toasts = new Adw.ToastOverlay();
  const split = new Adw.NavigationSplitView({ min_sidebar_width: 190, max_sidebar_width: 240, sidebar_width_fraction: 0.24 });
  toasts.set_child(split);
  dialog.set_child(toasts);
  const narrow = new Adw.Breakpoint({ condition: Adw.BreakpointCondition.parse("max-width: 640sp") });
  narrow.add_setter(split, "collapsed", true);
  dialog.add_breakpoint(narrow);
  const toast = (title: string) => toasts.add_toast(new Adw.Toast({ title, timeout: 3 }));

  // The section list
  const sections: Section[] = [...WEB_SECTIONS, ...(local.available ? (["local"] as const) : []), "peer"];
  const list = new Gtk.ListBox({ css_classes: ["navigation-sidebar"] });
  const rows = new Map<Section, any>();
  for (const s of sections) {
    const r = new Gtk.ListBoxRow();
    const box = new Gtk.Box({ spacing: 12, margin_top: 2, margin_bottom: 2 });
    box.append(new Gtk.Image({ icon_name: ICONS[s] }));
    box.append(new Gtk.Label({ label: label(s), xalign: 0 }));
    r.set_child(box);
    rows.set(s, r);
    list.append(r);
  }
  // A line between the panel's sections and this computer's own.
  list.set_header_func((r: any, before: any) => {
    const s = sections[r.get_index()];
    r.set_header(before && (s === "local" || (s === "peer" && !local.available)) ? new Gtk.Separator({ margin_top: 6, margin_bottom: 6 }) : null);
  });
  // Account shows only where the Space keeps its own password and this app is signed in to it.
  rows.get("account").set_visible(false);
  const sideToolbar = new Adw.ToolbarView();
  sideToolbar.add_top_bar(new Adw.HeaderBar());
  sideToolbar.set_content(new Gtk.ScrolledWindow({ child: list, hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true }));
  split.set_sidebar(new Adw.NavigationPage({ title: tw("settings.title"), child: sideToolbar }));

  // The section on the right, with its pages
  const nav = new Adw.NavigationView();
  const content = new Adw.NavigationPage({ title: label("general"), child: nav });
  split.set_content(content);

  let current: Section = "general";
  /** The Space a section was built for, and whether it had answered. */
  const spaceKey = () => `${model.current?.conn.id ?? ""}:${Boolean(model.current?.ready)}`;
  let builtFor = "";
  let labels: ReturnType<typeof loadLabels> | undefined;
  const ctx: Ctx = {
    model,
    get space() {
      return model.current;
    },
    dialog,
    toast,
    open: (detail) => openDetail(detail),
    rebuild: () => show(current, false),
    labels: () => (labels ??= loadLabels(model.current)),
  };

  const openDetail = (detail: Detail) => {
    const space = model.current;
    if (!space) return;
    const build = { usage: usagePage, activity: activityPage, appModels: appModelsPage, tasks: tasksPage, events: eventsPage }[detail];
    nav.push(build(ctx, space));
  };

  const show = (s: Section, remember = true) => {
    current = s;
    if (remember) {
      prefs.settingsSection = s;
      savePrefs();
    }
    const quiet = list.get_selected_row() === rows.get(s);
    if (!quiet) list.select_row(rows.get(s));
    content.set_title(label(s));
    builtFor = spaceKey();
    labels = undefined;
    nav.replace([sectionPage(s, ctx, local, model, toast)]);
    split.set_show_content(true);
  };
  list.connect("row-selected", (_l: unknown, r: any) => {
    const s = r ? sections[r.get_index()] : undefined;
    if (s && (s !== current || !nav.get_visible_page())) show(s);
  });

  const saved = page ?? prefs.settingsSection;
  const start: Section = saved && sections.includes(saved) && saved !== "account" ? saved : "general";
  current = start;
  list.select_row(rows.get(start));
  show(start, false);

  // The Space sections follow the current Space: built again once it answers, or when another is chosen.
  let pendingDetail = detail;
  let accountFor = "";
  const sync = () => {
    const space = model.current;
    if (space?.ready && pendingDetail) {
      openDetail(pendingDetail);
      pendingDetail = undefined;
    }
    const id = space?.ready ? space.conn.id : "";
    if (id === accountFor) return;
    accountFor = id;
    rows.get("account").set_visible(false);
    if (!space?.ready) return;
    void space.client
      .get("/api/auth/session")
      .then((raw) => {
        if (accountFor !== id || !hasAccount(decodeAuth(raw))) return;
        rows.get("account").set_visible(true);
        if (saved === "account" && current === start) show("account", false);
      })
      .catch(() => {});
  };
  const off = model.on((change) => {
    if (change !== "state" && change !== "selection") return;
    if (SPACE_SECTIONS.includes(current) && builtFor !== spaceKey() && nav.get_navigation_stack().get_n_items() <= 1) {
      // Account is gone on a Space that has none.
      show(current === "account" ? "general" : current, false);
    }
    sync();
  });
  dialog.connect("closed", off);
  if (local.available) void local.refresh();
  dialog.present(parent);
  sync();
}

/** A section's page: a header naming the Space it shows, and its rows. */
function sectionPage(s: Section, ctx: Ctx, local: LocalManager, model: AppModel, toast: (title: string) => void): any {
  const page = new Adw.NavigationPage({ title: label(s), tag: s });
  const toolbar = new Adw.ToolbarView();
  const bar = new Adw.HeaderBar();
  const space = model.current;
  if (SPACE_SECTIONS.includes(s) && space) bar.set_title_widget(new Adw.WindowTitle({ title: label(s), subtitle: space.conn.name }));
  toolbar.add_top_bar(bar);
  page.set_child(toolbar);

  if (s === "peer") {
    const peer = new PeerPage(local, model, { toast, copyRow: (command) => commandRow(command, toast) });
    toolbar.set_content(peer.widget);
    return page;
  }
  if (SPACE_SECTIONS.includes(s) && !space?.ready) {
    toolbar.set_content(new Adw.StatusPage({ icon_name: "network-offline-symbolic", title: t("settingsNeedSpace"), description: t("settingsNeedSpaceBody", { name: space?.conn.name ?? t("spaces") }), vexpand: true }));
    return page;
  }
  const prefsPage = new Adw.PreferencesPage();
  toolbar.set_content(prefsPage);
  switch (s) {
    case "general":
      general(prefsPage, ctx, model, toast);
      break;
    case "appearance":
      appearance(prefsPage);
      break;
    case "local": {
      const g = new Adw.PreferencesGroup();
      g.add(new LocalPanel(local, model, { onConnected: () => ctx.rebuild() }).widget);
      prefsPage.add(g);
      break;
    }
    case "models":
      modelsSection(prefsPage, ctx, space!);
      break;
    case "automation":
      automationSection(prefsPage, ctx);
      break;
    case "usage":
      usageSection(prefsPage, ctx);
      break;
    case "status":
      statusSection(prefsPage, ctx, space!);
      break;
    case "packages":
      packagesSection(prefsPage, ctx, space!);
      break;
    case "account":
      accountSection(prefsPage, ctx, space!);
      break;
  }
  return page;
}

/** A command shown to copy into a terminal or the desktop's settings. */
function commandRow(command: string, toast: (title: string) => void): any {
  const row = plain(new Adw.ActionRow({ title_selectable: true, css_classes: ["monospace"] }), command);
  const copy = new Gtk.Button({ icon_name: "edit-copy-symbolic", valign: Gtk.Align.CENTER, css_classes: ["flat"] });
  copy.connect("clicked", () => {
    row.get_clipboard().set(command);
    toast(t("copied"));
  });
  row.add_suffix(copy);
  return row;
}

/**
 * General: the panel's rows that mean something here (Widgets, Language), then this app's own: the
 * saved Spaces, adding one, how the app runs, the Quick Chat command, and WebKit's sandbox.
 */
function general(page: any, ctx: Ctx, model: AppModel, toast: (title: string) => void): void {
  const panel = new Adw.PreferencesGroup();
  const widgets = new Adw.SwitchRow({ title: tw("settings.widgets"), active: !prefs.noWidgets });
  widgets.connect("notify::active", () => {
    prefs.noWidgets = !widgets.get_active();
    savePrefs();
    model.emit("catalogue", model.current);
  });
  panel.add(widgets);
  const language = choiceRow(
    tw("settings.language"),
    [{ value: "", label: t("languageSystem") }, ...LANGS.map((l) => ({ value: l.code, label: l.label }))],
    prefs.language ?? "",
    (value) => {
      if (value === "en" || value === "zh") prefs.language = value;
      else delete prefs.language;
      savePrefs();
      toast(t("restartToApply"));
    },
  );
  panel.add(language.row);
  page.add(panel);

  const spaces = new Adw.PreferencesGroup({ title: t("spaces") });
  page.add(spaces);
  const rows: any[] = [];
  const renderSpaces = () => {
    for (const r of rows.splice(0)) spaces.remove(r);
    for (const c of model.list.connections) {
      const row = plain(new Adw.ActionRow({ activatable: true }), c.name, c.url);
      if (model.current?.conn.id === c.id) row.add_prefix(new Gtk.Image({ icon_name: "object-select-symbolic" }));
      else row.add_prefix(new Gtk.Box({ width_request: 16 }));
      const tags: string[] = [];
      if (c.isDefault) tags.push(t("isDefault"));
      if (c.managed) tags.push(t("managedTag"));
      if (tags.length) row.add_suffix(new Gtk.Label({ label: tags.join(" · "), css_classes: ["dim-label", "caption"] }));
      const menu = new Gtk.MenuButton({ icon_name: "view-more-symbolic", valign: Gtk.Align.CENTER, css_classes: ["flat"] });
      const pop = new Gtk.Popover();
      const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
      const item = (text: string, run: () => void, destructive = false) => {
        const b = new Gtk.Button({ label: text, css_classes: ["flat", ...(destructive ? ["destructive-action"] : [])] });
        b.connect("clicked", () => {
          pop.popdown();
          run();
        });
        box.append(b);
      };
      item(t("editSpace"), () => editSpace(ctx.dialog, model, c, renderSpaces));
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
        // The Space sections follow the Space chosen here.
        ctx.rebuild();
      });
      spaces.add(row);
      rows.push(row);
    }
  };
  renderSpaces();
  const add = new Adw.PreferencesGroup();
  add.add(connectForm(model, () => renderSpaces()));
  page.add(add);

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
  page.add(behaviour);

  const quick = new Adw.PreferencesGroup({ title: t("quickChat"), description: t("quickChatHint") });
  quick.add(commandRow(`${launcher()} --quick-chat`, toast));
  page.add(quick);

  // The launcher turned WebKit's sandbox off because the system blocks what it needs.
  if (GLib.getenv("AISPACE_WEB_SANDBOX") === "off") {
    const sandbox = new Adw.PreferencesGroup({ title: t("sandboxOff"), description: t("sandboxOffBody") });
    sandbox.add(commandRow(`${path(APP_ROOT, "install.sh")} --apparmor`, toast));
    page.add(sandbox);
  }

  const about = new Adw.PreferencesGroup();
  const aboutRow = new Adw.ActionRow({ title: t("about"), activatable: true });
  aboutRow.add_suffix(new Gtk.Image({ icon_name: "go-next-symbolic" }));
  aboutRow.connect("activated", () => ctx.dialog.get_root()?.get_application()?.lookup_action("about")?.activate(null));
  about.add(aboutRow);
  page.add(about);
}

/** A saved Space's address and name, changed in a dialog over Settings; the address is checked as when connecting. */
function editSpace(parent: any, model: AppModel, c: Connection, done: () => void): void {
  const dialog = new Adw.Dialog({ title: t("editSpaceTitle"), content_width: 460 });
  const view = new Adw.ToolbarView();
  view.add_top_bar(new Adw.HeaderBar());
  const form = connectForm(model, () => {
    dialog.close();
    done();
  }, c);
  for (const side of ["top", "bottom", "start", "end"]) form[`set_margin_${side}`](18);
  view.set_content(form);
  dialog.set_child(view);
  dialog.present(parent);
}

/** Appearance: the panel's mode row (Follow system, Light, Dark), for this app and the pages in it. */
function appearance(page: any): void {
  const group = new Adw.PreferencesGroup({ title: tw("appearance.mode"), description: t("appearanceHint") });
  let first: any;
  const mode = appearanceOf(prefs.appearance);
  for (const a of APPEARANCES) {
    const check = new Gtk.CheckButton({ active: a.mode === mode, valign: Gtk.Align.CENTER });
    if (first) check.set_group(first);
    else first = check;
    const row = new Adw.ActionRow({ title: tw(a.key), activatable_widget: check });
    row.add_prefix(check);
    check.connect("toggled", () => {
      if (!check.get_active()) return;
      prefs.appearance = a.mode;
      savePrefs();
      applyAppearance(a.mode);
    });
    group.add(row);
  }
  page.add(group);
}
