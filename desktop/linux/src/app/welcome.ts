import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { classifyIdentity } from "../core/check.ts";
import { type Connection, LOCAL_DEFAULT_URL } from "../core/connections.ts";
import type { Key } from "../core/i18n.ts";
import { ConnectionUrlError, normalizeConnectionUrl, resolveUrl, sameOrigin } from "../core/url.ts";
import { bytesToText, t } from "./env.ts";
import { appTexture } from "./icons.ts";
import { plainRequest } from "./http.ts";
import type { LocalManager } from "./local-manager.ts";
import { LocalPanel } from "./local-view.ts";
import type { AppModel } from "./model.ts";

/**
 * The first window, before any Space is saved (and Settings' Add): connect to a Space by its
 * address, with a Space already answering on this computer offered in one click; in the Local
 * edition, set up AI Space on this computer instead.
 */

/** Whether the address answers as a Space (or asks to sign in first), before it is saved. */
export async function probeSpace(url: string): Promise<string | undefined> {
  try {
    const r = await plainRequest("GET", resolveUrl("/api/space", url) ?? url, { Accept: "application/json" });
    const verdict = classifyIdentity(r.status, bytesToText(r.bytes));
    if ("state" in verdict && (verdict.state.kind === "unreachable" || verdict.state.kind === "incompatible")) return verdict.state.detail ?? t("incompatibleTitle");
    return undefined;
  } catch (e) {
    return `${t("unreachableTitle")}: ${(e as Error).message}`;
  }
}

/** The address field with its checks; `onDone` runs once the Space is saved. */
/** Connect to a Space by its address, or, given `editing`, change a saved one's address and name. */
export function connectForm(model: AppModel, onDone: () => void, editing?: Connection): any {
  const group = new Adw.PreferencesGroup({ title: editing ? "" : t("connectTitle") });
  const url = new Adw.EntryRow({ title: t("spaceUrl"), input_purpose: Gtk.InputPurpose.URL, show_apply_button: false, text: editing?.url ?? "" });
  const name = new Adw.EntryRow({ title: t("spaceName"), text: editing?.name ?? "" });
  group.add(url);
  group.add(name);
  const error = new Gtk.Label({ xalign: 0, wrap: true, visible: false, margin_top: 8, css_classes: ["error"] });
  const button = new Gtk.Button({ label: editing ? t("save") : t("connect"), halign: Gtk.Align.END, margin_top: 10, css_classes: ["pill", "suggested-action"] });
  const spinner = new Gtk.Spinner({ visible: false });
  const go = async () => {
    error.set_visible(false);
    let normalized: string;
    try {
      normalized = normalizeConnectionUrl(url.get_text());
    } catch (e) {
      error.set_text(e instanceof ConnectionUrlError ? t(`url.${e.code}` as Key) : String(e));
      error.set_visible(true);
      return;
    }
    // A new address must answer as a Space; a new name alone needs no look.
    if (!editing || !sameOrigin(editing.url, normalized)) {
      button.set_sensitive(false);
      spinner.set_visible(true);
      spinner.start();
      const problem = await probeSpace(normalized);
      spinner.stop();
      spinner.set_visible(false);
      button.set_sensitive(true);
      if (problem) {
        error.set_text(problem);
        error.set_visible(true);
        return;
      }
    }
    if (editing) {
      model.update(editing.id, name.get_text(), normalized);
      onDone();
      return;
    }
    model.add(name.get_text(), normalized);
    url.set_text("");
    name.set_text("");
    onDone();
  };
  url.connect("entry-activated", () => void go());
  name.connect("entry-activated", () => void go());
  button.connect("clicked", () => void go());
  const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL });
  box.append(group);
  box.append(error);
  const row = new Gtk.Box({ spacing: 8, halign: Gtk.Align.END });
  row.append(spinner);
  row.append(button);
  box.append(row);
  if (editing) return box;
  // A Space already answering on this computer is one click away.
  void probeSpace(LOCAL_DEFAULT_URL).then((problem) => {
    if (problem || model.list.connections.some((c) => c.url === LOCAL_DEFAULT_URL)) return;
    const suggest = new Adw.ActionRow({ title: t("localSuggestion", { url: LOCAL_DEFAULT_URL }), activatable: true });
    suggest.add_suffix(new Gtk.Image({ icon_name: "go-next-symbolic" }));
    suggest.connect("activated", () => {
      model.add(t("thisComputer"), LOCAL_DEFAULT_URL);
      onDone();
    });
    group.add(suggest);
  });
  return box;
}

export class WelcomePage {
  readonly widget: any;

  constructor(model: AppModel, local: LocalManager, onDone: () => void) {
    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24, margin_top: 36, margin_bottom: 36, margin_start: 16, margin_end: 16 });
    const icon = appTexture("icons/hicolor/scalable/apps/dev.ai_space.Desktop.svg");
    if (icon) column.append(new Gtk.Image({ paintable: icon, pixel_size: 96, halign: Gtk.Align.CENTER }));
    const title = new Gtk.Label({ label: t("welcomeTitle"), css_classes: ["title-1"] });
    column.append(title);
    const body = new Gtk.Label({ label: t("welcomeBody"), wrap: true, justify: Gtk.Justification.CENTER, css_classes: ["dim-label"] });
    column.append(body);
    if (local.available) {
      column.append(new LocalPanel(local, model, { onConnected: onDone }).widget);
      column.append(new Gtk.Separator({ margin_top: 12 }));
    }
    column.append(connectForm(model, onDone));
    const clamp = new Adw.Clamp({ maximum_size: 560, child: column });
    this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    // Start at the top, not scrolled to wherever the focus landed.
    this.widget.connect("map", () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => (this.widget.get_vadjustment().set_value(0), GLib.SOURCE_REMOVE)));
  }
}
