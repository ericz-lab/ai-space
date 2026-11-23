import Adw from "gi://Adw?version=1";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { classifyIdentity } from "../core/check.ts";
import { type Connection, LOCAL_DEFAULT_URL } from "../core/connections.ts";
import { type InstallOutcome, InstallProgress } from "../core/first-launch.ts";
import type { Key } from "../core/i18n.ts";
import { ConnectionUrlError, normalizeConnectionUrl, resolveUrl, sameOrigin } from "../core/url.ts";
import { bytesToText, t } from "./env.ts";
import { installOnThisComputer, lookForLocalSpace, waitForThisComputer } from "./first-launch.ts";
import { appTexture } from "./icons.ts";
import { plainRequest } from "./http.ts";
import type { LocalManager } from "./local-manager.ts";
import { LocalPanel } from "./local-view.ts";
import type { AppModel } from "./model.ts";

/**
 * The first window, before any Space is saved (and Settings' Add). The app without a service
 * (AI Space Desktop) offers two entries: connect to the AI Space on this computer (installed first,
 * behind one progress bar, when there is none) or to one on another machine (core/first-launch.ts). The Local
 * edition, which carries its service, shows its setup and the address form instead.
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

/**
 * Connect to a Space by its address, or, given `editing`, change a saved one's address and name;
 * `onDone` runs once the Space is saved. A Space answering on this computer is one click away:
 * the standard address is asked, unless `suggest` names one already found, or is null for none.
 */
export function connectForm(model: AppModel, onDone: () => void, editing?: Connection, opts: { suggest?: string | null } = {}): any {
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
  const suggestRow = (address: string) => {
    if (model.list.connections.some((c) => sameOrigin(c.url, address))) return;
    const suggest = new Adw.ActionRow({ title: t("localSuggestion", { url: address }), activatable: true });
    suggest.add_suffix(new Gtk.Image({ icon_name: "go-next-symbolic" }));
    suggest.connect("activated", () => {
      model.add(t("thisComputer"), address);
      onDone();
    });
    group.add(suggest);
  };
  if (typeof opts.suggest === "string") suggestRow(opts.suggest);
  else if (opts.suggest === undefined) {
    void probeSpace(LOCAL_DEFAULT_URL).then((problem) => {
      if (!problem) suggestRow(LOCAL_DEFAULT_URL);
    });
  }
  return box;
}

/** How many lines of the installer's output are kept for the failure's details. */
const OUTPUT_LINES = 200;

export class WelcomePage {
  readonly widget: any;
  private readonly body: any;
  /** The part that changes with what was found; only in the app without a service. */
  private readonly holder: any;
  private installing = false;
  private look = 0;
  /** What the look at this computer found: a Space's address, null for none, undefined while looking. */
  private here: string | null | undefined;

  constructor(
    private readonly model: AppModel,
    local: LocalManager,
    private readonly onDone: () => void,
  ) {
    const column = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 24, margin_top: 36, margin_bottom: 36, margin_start: 16, margin_end: 16 });
    const icon = appTexture("icons/hicolor/scalable/apps/dev.ai_space.Desktop.svg");
    if (icon) column.append(new Gtk.Image({ paintable: icon, pixel_size: 96, halign: Gtk.Align.CENTER }));
    const title = new Gtk.Label({ label: t("welcomeTitle"), css_classes: ["title-1"] });
    column.append(title);
    this.body = new Gtk.Label({ label: t("welcomeBody"), wrap: true, justify: Gtk.Justification.CENTER, css_classes: ["dim-label"] });
    column.append(this.body);
    if (local.available) {
      column.append(new LocalPanel(local, model, { onConnected: onDone }).widget);
      column.append(new Gtk.Separator({ margin_top: 12 }));
      column.append(connectForm(model, onDone));
    } else {
      this.holder = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 });
      column.append(this.holder);
    }
    const clamp = new Adw.Clamp({ maximum_size: 560, child: column });
    this.widget = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true, child: clamp });
    // Start at the top, not scrolled to wherever the focus landed.
    this.widget.connect("map", () => GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => (this.widget.get_vadjustment().set_value(0), GLib.SOURCE_REMOVE)));
  }

  /**
   * The window shows this screen (again): the two entries, at once. A look at this computer runs
   * meanwhile, only so the first entry can say what its click will do; it saves nothing.
   */
  enter(): void {
    if (!this.holder || this.installing) return;
    const look = ++this.look;
    this.here = undefined;
    this.choices();
    void lookForLocalSpace().then((found) => {
      if (look !== this.look || this.installing) return;
      this.here = found ?? null;
      if (this.note) this.note.set_label(this.hereNote());
    });
  }

  private note: any;

  private hereNote(): string {
    return this.here === undefined ? t("lookingLocal") : this.here ? t("localFound") : t("localAbsent");
  }

  private show(body: string, children: any[]): void {
    this.body.set_label(body);
    this.body.set_visible(body !== "");
    this.note = undefined;
    for (let c = this.holder.get_first_child(); c; ) {
      const next = c.get_next_sibling();
      this.holder.remove(c);
      c = next;
    }
    for (const c of children) this.holder.append(c);
  }

  /** Saves the Space on this computer under the name the app gives it everywhere, and shows it. */
  private adopt(url: string): void {
    const saved = this.model.list.connections.find((c) => sameOrigin(c.url, url));
    if (saved) this.model.select(saved.id);
    else this.model.add(t("thisComputer"), url);
    this.onDone();
  }

  private button(label: string, run: () => void, classes: string[]): any {
    const b = new Gtk.Button({ label, halign: Gtk.Align.CENTER, css_classes: classes });
    b.connect("clicked", run);
    return b;
  }

  /** The two entries: the AI Space on this computer, or one on another machine. Neither happens unasked. */
  private choices(): void {
    const note = new Gtk.Label({ label: this.hereNote(), wrap: true, justify: Gtk.Justification.CENTER, margin_bottom: 12, css_classes: ["dim-label", "caption"] });
    this.show(t("welcomeBody"), [
      this.button(t("connectLocal"), () => void this.connectLocal(), ["pill", "suggested-action"]),
      note,
      this.button(t("connectRemote"), () => this.connect(), ["pill"]),
    ]);
    this.note = note;
  }

  private connect(): void {
    this.show(t("welcomeBody"), [connectForm(this.model, this.onDone, undefined, { suggest: null }), this.button(t("back"), () => this.choices(), ["flat"])]);
  }

  /** The first entry: the Space on this computer, looked for again at the click; installed first when there is none. */
  private async connectLocal(): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    const spinner = new Gtk.Spinner({ spinning: true, halign: Gtk.Align.CENTER, width_request: 24, height_request: 24 });
    this.show("", [new Gtk.Label({ label: t("connectingLocal"), css_classes: ["title-4"] }), spinner]);
    const found = await lookForLocalSpace();
    this.installing = false;
    if (found) return this.adopt(found);
    this.here = null;
    await this.install();
  }

  /** Runs the release's installer behind one progress bar; then the Space it started is saved and shown. */
  private async install(again?: "look"): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    const lines: string[] = [];
    const meter = new InstallProgress(Date.now(), again ? "starting" : "fetching");
    const status = new Gtk.Label({ label: t("installing"), css_classes: ["title-4"] });
    const bar = new Gtk.ProgressBar({ fraction: meter.value(Date.now()), margin_start: 24, margin_end: 24 });
    let shown = 0;
    const tick = () => {
      shown = Math.max(shown, meter.value(Date.now()));
      bar.set_fraction(shown);
    };
    // The bar creeps on within a step, four times a second, while the installer runs.
    const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => (tick(), GLib.SOURCE_CONTINUE));
    this.show("", [status, bar]);

    let outcome: InstallOutcome;
    try {
      if (again === "look") {
        const url = await waitForThisComputer();
        outcome = url ? { ok: true, url } : { ok: false, reason: "silent", tail: [] };
      } else {
        outcome = await installOnThisComputer({
          line: (line) => {
            lines.push(line);
            if (lines.length > OUTPUT_LINES) lines.shift();
            meter.read(line, Date.now());
            tick();
          },
          starting: () => (meter.enter("starting", Date.now()), tick()),
        });
      }
    } catch (e) {
      outcome = { ok: false, reason: "failed", code: -1, tail: [e instanceof Error ? e.message : String(e)] };
    }
    GLib.source_remove(timer);
    this.installing = false;
    if (outcome.ok) {
      bar.set_fraction(1);
      return this.adopt(outcome.url);
    }

    // What went wrong in one line, the installer's last lines folded away, and another go.
    const why = new Gtk.Label({ label: outcome.reason === "download" ? t("installDownloadFailed") : outcome.reason === "silent" ? t("installSilent") : t("installFailed", { code: outcome.code ?? -1 }), wrap: true, justify: Gtk.Justification.CENTER, css_classes: ["error"] });
    const children: any[] = [why];
    if (outcome.tail.length) {
      const output = new Gtk.Label({ label: outcome.tail.join("\n"), xalign: 0, yalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true, css_classes: ["tool-detail"] });
      children.push(new Gtk.Expander({ label: t("details"), child: output }));
    }
    const buttons = new Gtk.Box({ spacing: 8, halign: Gtk.Align.CENTER });
    buttons.append(this.button(t("back"), () => this.choices(), ["flat"]));
    buttons.append(this.button(t("tryAgain"), () => void this.install(outcome.ok === false && outcome.reason === "silent" ? "look" : undefined), ["pill", "suggested-action"]));
    children.push(buttons);
    this.show("", children);
  }
}
