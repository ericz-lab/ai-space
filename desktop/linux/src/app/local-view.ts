import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { type LocalStatus, type ModelOption, ownServiceRunning, updateAvailable } from "../core/local.ts";
import type { Key } from "../core/i18n.ts";
import { normalizeConnectionUrl, sameOrigin } from "../core/url.ts";
import { openExternally, prefs, t } from "./env.ts";
import type { LocalManager } from "./local-manager.ts";
import type { AppModel } from "./model.ts";

/**
 * "AI Space on This Computer": where the Local edition stands and what can be done about it, the
 * same on the welcome screen and in Settings. Not set up: the agent programs found and the
 * default model, then Set Up. Another installation: Connect to It or Take It Over. The app's own:
 * its state, versions and workspace, Update or Repair, Start or Stop, Restart, the log, and
 * removing the background service.
 */

const RUNTIMES: { name: "claude" | "codex" | "dsh"; title: string }[] = [
  { name: "claude", title: "Claude Code" },
  { name: "codex", title: "Codex" },
  { name: "dsh", title: "DeepSeek Harness" },
];

const modelLabel = (m: ModelOption) => `${m.runtime} · ${m.tier} — ${m.model}`;

export class LocalPanel {
  readonly widget: any;
  private key = "";
  /** The default model chosen for Set Up or a takeover, by value (`claude/junior`). */
  private chosenModel: string | undefined;
  private readonly off: () => void;

  constructor(
    private readonly local: LocalManager,
    private readonly model: AppModel,
    private readonly opts: { onConnected?: () => void } = {},
  ) {
    this.widget = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18 });
    this.off = local.on(() => this.render());
    this.widget.connect("destroy", () => this.off());
    this.render();
  }

  private clear(): void {
    for (let c = this.widget.get_first_child(); c; ) {
      const next = c.get_next_sibling();
      this.widget.remove(c);
      c = next;
    }
  }

  render(): void {
    const s = this.local.status;
    const key = JSON.stringify([s, this.local.busy, this.local.failure?.message, this.local.failure?.code, this.local.waitingFor]);
    if (key === this.key) return;
    this.key = key;
    this.clear();
    if (!s) {
      const spinner = new Gtk.Spinner({ spinning: true, halign: Gtk.Align.CENTER, width_request: 24, height_request: 24 });
      this.widget.append(spinner);
      return;
    }
    if (this.local.busy) this.widget.append(this.busyRow());
    if (this.local.failure) this.widget.append(this.failureCard());
    if (s.state === "absent") this.absent(s);
    else if (s.state === "foreign") this.foreign(s);
    else this.managed(s);
  }

  private busyRow(): any {
    const box = new Gtk.Box({ spacing: 10, halign: Gtk.Align.CENTER });
    box.append(new Gtk.Spinner({ spinning: true }));
    box.append(new Gtk.Label({ label: t(`busy.${this.local.busy}` as Key) }));
    return box;
  }

  private failureCard(): any {
    const f = this.local.failure!;
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 8, css_classes: ["card", "card-inner", "failure-card"] });
    const text = f.code === "busy" ? t("busyUpdate", { what: (f.activity?.items ?? []).map((i) => i.label).join(", ") || f.message }) : f.message;
    card.append(new Gtk.Label({ label: text, xalign: 0, wrap: true, selectable: true }));
    if (f.code === "busy") {
      const row = new Gtk.Box({ spacing: 8 });
      const idle = new Gtk.Button({ label: t("updateWhenIdle") });
      idle.connect("clicked", () => void this.local.install({ whenBusy: "wait" }));
      const now = new Gtk.Button({ label: t("updateNow"), css_classes: ["destructive-action"] });
      now.connect("clicked", () => void this.local.install({ whenBusy: "now" }));
      row.append(idle);
      row.append(now);
      card.append(row);
    }
    return card;
  }

  private group(title: string, description?: string): any {
    const g = new Adw.PreferencesGroup({ title, ...(description ? { description } : {}) });
    this.widget.append(g);
    return g;
  }

  private button(label: string, run: () => void, classes: string[] = []): any {
    const b = new Gtk.Button({ label, css_classes: classes, sensitive: !this.local.busy });
    b.connect("clicked", run);
    return b;
  }

  /** The agent programs the service can run, each found or chosen by hand. */
  private runtimes(s: LocalStatus): void {
    const g = this.group(t("agentClis"), t("agentClisBody"));
    for (const r of RUNTIMES) {
      const found = s.runtimes[r.name];
      const row = new Adw.ActionRow({ title: r.title, subtitle: found ?? t("notFound"), subtitle_selectable: true });
      row.add_prefix(new Gtk.Image({ icon_name: found ? "object-select-symbolic" : "action-unavailable-symbolic", css_classes: [found ? "success" : "dim-label"] }));
      const choose = this.button(t("choose"), () => this.choose(r.name, r.title), ["flat"]);
      choose.set_valign(Gtk.Align.CENTER);
      row.add_suffix(choose);
      if (this.chosen(r.name)) {
        const forget = this.button(t("forget"), () => void this.local.chooseRuntime(r.name, undefined), ["flat"]);
        forget.set_valign(Gtk.Align.CENTER);
        row.add_suffix(forget);
      }
      g.add(row);
    }
  }

  private chosen(name: string): boolean {
    return Boolean(prefs.chosenRuntimes[name]);
  }

  private choose(name: string, title: string): void {
    const dialog = new Gtk.FileDialog({ title: t("choosingProgram", { name: title }), modal: true, initial_folder: Gio.File.new_for_path(GLib.get_home_dir()) });
    dialog.open(this.widget.get_root(), null, (_d: unknown, res: unknown) => {
      try {
        const file = dialog.open_finish(res);
        if (file?.get_path()) void this.local.chooseRuntime(name, file.get_path());
      } catch {
        /* dismissed */
      }
    });
  }

  /** The default model a new Space starts with; Set Up waits for one. */
  /**
   * The default model a new Space starts with, chosen on purpose, as on the Mac: nothing is
   * preselected, and Set Up (or Take It Over) waits for a choice. `onChoose` follows the choice.
   */
  private models(s: LocalStatus, onChoose: (m: ModelOption | undefined) => void): void {
    const models = s.models ?? [];
    const g = this.group(t("defaultModel"), t("defaultModelBody"));
    if (!models.length) {
      g.add(new Adw.ActionRow({ title: t("noModels") }));
      return onChoose(undefined);
    }
    const row = new Adw.ComboRow({ title: t("defaultModel"), model: Gtk.StringList.new([t("choose"), ...models.map(modelLabel)]) });
    const at = models.findIndex((m) => m.value === this.chosenModel);
    row.set_selected(at + 1);
    row.connect("notify::selected", () => {
      const m = models[row.get_selected() - 1];
      this.chosenModel = m?.value;
      onChoose(m);
    });
    g.add(row);
    onChoose(models[at]);
  }

  private absent(s: LocalStatus): void {
    this.group(t("setUpTitle"), t("setUpBody", { path: s.workspace.path }));
    this.runtimes(s);
    const go = this.button(t("setUp"), () => void this.local.install({ ...(this.chosenModel ? { defaultModel: this.chosenModel } : {}) }), ["pill", "suggested-action"]);
    go.set_halign(Gtk.Align.CENTER);
    this.models(s, (m) => go.set_sensitive(Boolean(m) && !this.local.busy));
    this.widget.append(go);
  }

  private foreign(s: LocalStatus): void {
    this.group(t("local.foreign"), t("foreignBody", { reason: s.reason ?? t("local.foreign") }));
    this.runtimes(s);
    const connect = this.button(t("connectToIt"), () => {
      const known = this.model.list.connections.find((c) => sameOrigin(c.url, s.url));
      if (known) this.model.select(known.id);
      else this.model.add(t("thisComputer"), normalizeConnectionUrl(s.url));
      this.opts.onConnected?.();
    }, ["pill"]);
    const take = this.button(t("takeOver"), () => void this.local.install({ migrate: true, ...(this.chosenModel ? { defaultModel: this.chosenModel } : {}) }).then(() => !this.local.failure && this.opts.onConnected?.()), ["pill", "suggested-action"]);
    // A takeover stores the default model too when the workspace has none (`no-default-model`).
    if (s.models?.length) this.models(s, (m) => take.set_sensitive(Boolean(m) && !this.local.busy));
    const row = new Gtk.Box({ spacing: 10, halign: Gtk.Align.CENTER });
    row.append(connect);
    row.append(take);
    this.widget.append(row);
  }

  private managed(s: LocalStatus): void {
    const g = this.group(t("localTitle"));
    const running = ownServiceRunning(s) || s.service.running;
    const state = new Adw.ActionRow({ title: t("localState"), subtitle: running ? `${t("localRunning")} · ${s.url}` : s.service.disabled ? t("localStopped") : t("localNotRunning") });
    state.add_prefix(new Gtk.Box({ valign: Gtk.Align.CENTER, css_classes: ["reach-dot", running ? "unread-dot" : "reach-down"] }));
    g.add(state);
    if (s.installed) g.add(new Adw.ActionRow({ title: t("localInstalled"), subtitle: s.installed.version }));
    if (s.bundle) g.add(new Adw.ActionRow({ title: t("localInApp"), subtitle: s.bundle.version }));
    const ws = new Adw.ActionRow({ title: t("localWorkspace"), subtitle: s.workspace.path, subtitle_selectable: true });
    const folder = new Gtk.Button({ icon_name: "folder-open-symbolic", valign: Gtk.Align.CENTER, css_classes: ["flat"], tooltip_text: t("open") });
    folder.connect("clicked", () => openExternally(Gio.File.new_for_path(s.workspace.path).get_uri()));
    ws.add_suffix(folder);
    g.add(ws);
    if (this.local.waitingFor) g.add(new Adw.ActionRow({ title: t("busy.wait"), subtitle: this.local.waitingFor.map((i) => i.label).join(", ") }));

    const actions = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, column_spacing: 8, row_spacing: 8, max_children_per_line: 6, homogeneous: false });
    if (updateAvailable(s)) actions.append(this.button(t("update"), () => void this.local.install(), ["suggested-action"]));
    else actions.append(this.button(t("repair"), () => void this.local.install()));
    if (running) actions.append(this.button(t("stop"), () => void this.local.stop()));
    else actions.append(this.button(t("start"), () => void this.local.start()));
    actions.append(this.button(t("restart"), () => void this.local.restart()));
    actions.append(this.button(t("openLog"), () => this.local.openLog()));
    actions.append(this.button(t("removeService"), () => this.confirmRemove(), ["destructive-action"]));
    this.widget.append(actions);
    this.runtimes(s);
  }

  private confirmRemove(): void {
    const dialog = new Adw.AlertDialog({ heading: t("removeService"), body: t("removeServiceBody") });
    dialog.add_response("cancel", t("cancel"));
    dialog.add_response("remove", t("remove"));
    dialog.set_response_appearance("remove", Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.set_close_response("cancel");
    dialog.connect("response", (_d: unknown, r: string) => r === "remove" && void this.local.removeService());
    dialog.present(this.widget.get_root());
  }
}
