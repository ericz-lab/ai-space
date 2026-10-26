import Adw from "gi://Adw?version=1";
import Gdk from "gi://Gdk?version=4.0";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { parseDeepLink } from "../core/desktop.ts";
import type { Detail, Section } from "../core/settings.ts";
import { APP_ID, APP_ROOT, log, logError, path, prefs, readTextSync, t } from "./env.ts";
import { Notifier } from "./inbox.ts";
import { LocalManager } from "./local-manager.ts";
import { startMemoryStats } from "./memory.ts";
import { AppModel } from "./model.ts";
import { QuickChat } from "./quick-chat.ts";
import { applyAppearance, showSettings } from "./settings.ts";
import { installStyles } from "./style.ts";
import { MainWindow, type View } from "./window.ts";

/**
 * The application: one instance per user (a second launch hands its arguments to the first),
 * `aispace://` links, `--quick-chat` for a desktop shortcut, `--background` for the login item.
 * With "keep running" on, closing the window hides it and notifications keep arriving.
 */

export function appVersion(): { version: string; commit?: string; edition: string } {
  try {
    return JSON.parse(readTextSync(path(APP_ROOT, "VERSION.json")) ?? "") as { version: string; commit?: string; edition: string };
  } catch {
    return { version: "dev", edition: "client" };
  }
}

export class Application {
  readonly app: any;
  private model!: AppModel;
  private local!: LocalManager;
  private main: MainWindow | undefined;
  private quick!: QuickChat;
  private started = false;

  constructor() {
    this.app = new Adw.Application({ application_id: APP_ID, flags: Gio.ApplicationFlags.HANDLES_COMMAND_LINE });
    this.app.add_main_option("quick-chat", 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE, "Show or hide Quick Chat", null);
    this.app.add_main_option("background", 0, GLib.OptionFlags.NONE, GLib.OptionArg.NONE, "Start without showing the window (for login)", null);
    this.app.add_main_option("screenshot", 0, GLib.OptionFlags.HIDDEN, GLib.OptionArg.FILENAME, "Debug: save the window as a PNG after a few seconds, then quit", "FILE");
    this.app.add_main_option("page", 0, GLib.OptionFlags.HIDDEN, GLib.OptionArg.STRING, "Debug: the view to show (home, chat, inbox, terminal)", "VIEW");
    this.app.add_main_option("action", 0, GLib.OptionFlags.HIDDEN, GLib.OptionArg.STRING_ARRAY, "Debug: window actions to run once the Space answers (new-terminal, search, …)", "ACTION");
    this.app.connect("startup", () => this.startup());
    this.app.connect("activate", () => this.window().present());
    this.app.connect("command-line", (_a: unknown, cmd: any) => {
      this.commandLine(cmd);
      // Lets a second `ai-space …` return now, not when GJS collects `cmd` (GLib 2.80+).
      cmd.done?.();
      return 0;
    });
  }

  run(argv: string[]): number {
    return this.app.run([GLib.get_prgname() ?? "ai-space", ...argv]);
  }

  private startup(): void {
    if (this.started) return;
    this.started = true;
    installStyles();
    applyAppearance(prefs.appearance);
    const theme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
    theme.add_search_path(path(APP_ROOT, "data", "icons"));
    Gtk.Window.set_default_icon_name(APP_ID);

    this.model = new AppModel();
    this.local = new LocalManager(this.model);
    this.quick = new QuickChat(this.app, this.model, () => this.window());
    const notifier = new Notifier(this.app, this.model, (space, item) => this.window().openInboxItem(space, item));
    this.model.onFreshInbox = (space, items) => notifier.post(space, items);

    const act = (name: string, run: () => void, accels: string[] = []) => {
      const a = new Gio.SimpleAction({ name });
      a.connect("activate", run);
      this.app.add_action(a);
      if (accels.length) this.app.set_accels_for_action(`app.${name}`, accels);
    };
    act("quit", () => this.app.quit(), ["<Control>q"]);
    act("quick-chat", () => this.quick.toggle(), ["<Control><Shift>space"]);
    act("settings", () => showSettings(this.window().window, this.model, this.local), ["<Control>comma"]);
    act("peer-settings", () => showSettings(this.window().window, this.model, this.local, "peer"));
    act("about", () => this.about());

    if (this.local.available) {
      void this.local.refresh().then(async () => {
        await this.local.ensureSignIn();
        await this.local.autoUpdate();
      });
    }
    this.model.refreshAll();
    this.model.startPolling();
    startMemoryStats();
  }

  private window(): MainWindow {
    if (!this.main) {
      this.main = new MainWindow(this.app, this.model, this.local);
      // Keep running: closing hides the window and notifications keep arriving. Otherwise closing
      // it quits, Quick Chat and tab windows included.
      this.main.window.connect("close-request", () => {
        if (!prefs.background) {
          GLib.idle_add(GLib.PRIORITY_DEFAULT, () => (this.app.quit(), GLib.SOURCE_REMOVE));
          return false;
        }
        this.main!.window.set_visible(false);
        return true;
      });
    }
    return this.main;
  }

  private commandLine(cmd: any): void {
    const options = cmd.get_options_dict();
    const args = (cmd.get_arguments() as string[]).slice(1);
    const has = (k: string) => options.contains(k);
    if (has("quick-chat")) {
      this.quick.toggle();
      return;
    }
    const links = args.filter((a) => a.startsWith("aispace:"));
    if (links.length) {
      for (const l of links) {
        const link = parseDeepLink(l);
        if (link) this.window().handleLink(link);
        else log("not an aispace link", l);
      }
      return;
    }
    const main = this.window();
    if (has("page")) main.show(options.lookup_value("page", null).unpack() as View);
    if (has("action")) {
      const actions = options.lookup_value("action", null).deepUnpack() as string[];
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        for (const a of actions) {
          const [name, arg] = a.split("=", 2) as [string, string | undefined];
          if (name === "ask" && arg && this.model.current) main.ask(this.model.current, arg);
          else if (name === "query" && arg !== undefined) main.home.setQuery(arg);
          else if (name === "settings" && arg) {
            const [section, detail] = arg.split("/") as [Section, Detail | undefined];
            showSettings(main.window, this.model, this.local, section, detail);
          }
          else (name.startsWith("app.") ? this.app.lookup_action(name.slice(4)) : main.window.lookup_action(name))?.activate(null);
        }
        return GLib.SOURCE_REMOVE;
      });
    }
    if (has("screenshot")) {
      const file = new TextDecoder().decode(options.lookup_value("screenshot", null).get_bytestring() as Uint8Array).replace(/\0$/, "");
      main.present();
      this.screenshot(main.window, file);
      return;
    }
    if (has("background") && !cmd.get_is_remote()) {
      // Started at login: the window waits until the person opens the app.
      return;
    }
    main.present();
  }

  /** Debug: the window as a PNG after it has had time to load, then quit. */
  private screenshot(window: any, file: string): void {
    let tries = 0;
    const shoot = () => {
      try {
        const paintable = new Gtk.WidgetPaintable({ widget: window });
        const snapshot = Gtk.Snapshot.new();
        paintable.snapshot(snapshot, window.get_width(), window.get_height());
        const node = snapshot.to_node();
        // A frame in the middle of being drawn can come back empty: try again shortly.
        if (!node && ++tries < 10) return true;
        window.get_renderer().render_texture(node, null).save_to_png(file);
        log("screenshot", file);
      } catch (e) {
        logError(e, "screenshot");
      }
      this.app.quit();
      return GLib.SOURCE_REMOVE;
    };
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, Number(GLib.getenv("AISPACE_SCREENSHOT_DELAY") ?? "4000"), () => {
      GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, shoot);
      return GLib.SOURCE_REMOVE;
    });
  }

  private about(): void {
    const v = appVersion();
    const dialog = new Adw.AboutDialog({
      application_name: t("appName"),
      application_icon: APP_ID,
      version: v.commit ? `${v.version} (${v.commit.slice(0, 10)})` : v.version,
      comments: v.edition === "local" ? t("localTitle") : "",
      website: "https://github.com/ericz-lab/ai-space",
    });
    dialog.present(this.window().window);
  }
}
