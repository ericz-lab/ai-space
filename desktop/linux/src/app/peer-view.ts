import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { DEFAULT_HUB_PORT, TUNNEL_UNIT, hubLines, parseEnvText, parseSshTarget, peerSideUpdates, readPeerSide, readTunnelUnit, renderTunnelUnit, suggestPeerName, tokenHex, tunnelAddress, updateEnvText, validHubPort, validPeerName } from "../core/peer.ts";
import { logError, path, prefs, readText, readTextSync, savePrefs, sleep, t, writeText } from "./env.ts";
import type { LocalManager } from "./local-manager.ts";
import type { AppModel } from "./model.ts";

/**
 * Settings › Peer: makes this computer's Space a peer of a Space used elsewhere (the hub,
 * docs/peers.md). Three steps, one group each: let a hub in (the hub token, the name, the
 * terminal, written to the workspace `.env`), give the hub a way to reach this computer (an SSH
 * reverse tunnel the app keeps as a systemd user service, or an address of the person's own such
 * as a Cloudflare tunnel), and the lines for the hub's `.env`, with a check of what the hub sees.
 */

type Opts = { toast: (title: string) => void; copyRow: (text: string) => any };

const UNIT_FILE = path(GLib.get_user_config_dir(), "systemd", "user", TUNNEL_UNIT);

async function run(argv: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    const [out] = (await proc.communicate_utf8_async(null, null)) as [string | null];
    return { ok: proc.get_successful(), out: (out ?? "").trim() };
  } catch (e) {
    return { ok: false, out: e instanceof Error ? e.message : String(e) };
  }
}

const systemctl = (...args: string[]) => run(["systemctl", "--user", ...args]);

/** 32 bytes from the kernel's random source, as hex (GJS has no `crypto`). */
function randomToken(): string {
  const stream = Gio.File.new_for_path("/dev/urandom").read(null);
  try {
    return tokenHex(stream.read_bytes(32, null).get_data() as Uint8Array);
  } finally {
    stream.close(null);
  }
}

const mask = (token: string) => (token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "•".repeat(token.length));

export class PeerPage {
  readonly widget = new Adw.PreferencesPage({ title: t("peer"), icon_name: "network-server-symbolic" });
  private envFile = "";
  private envText = "";
  private token = "";
  private port = 8700;
  private dirty = false;

  private readonly enable = new Adw.SwitchRow({ title: t("peerEnable"), subtitle: t("peerEnableBody") });
  private readonly name = new Adw.EntryRow({ title: t("peerName") });
  private readonly terminal = new Adw.SwitchRow({ title: t("peerTerminal"), subtitle: t("peerTerminalBody") });
  private readonly tokenRow = new Adw.ActionRow({ title: t("hubToken"), use_markup: false });
  private readonly fileRow = new Adw.ActionRow({ title: t("peerEnvFile"), subtitle_selectable: true, use_markup: false, css_classes: ["property"] });
  private readonly save = new Gtk.Button({ label: t("save"), valign: Gtk.Align.CENTER, css_classes: ["suggested-action"], sensitive: false });

  private readonly reachGroup = new Adw.PreferencesGroup({ title: t("peerReach") });
  private readonly reach = new Adw.ComboRow({ title: t("peerReachHow"), model: Gtk.StringList.new([t("reachSsh"), t("reachAddress")]) });
  private readonly target = new Adw.EntryRow({ title: t("hubSsh") });
  private readonly hubPort = Adw.SpinRow.new_with_range(1024, 65535, 1);
  private readonly tunnelRow = new Adw.ActionRow({ title: t("tunnel"), use_markup: false });
  private readonly tunnelStart = new Gtk.Button({ label: t("tunnelStart"), valign: Gtk.Align.CENTER });
  private readonly tunnelStop = new Gtk.Button({ label: t("tunnelStop"), valign: Gtk.Align.CENTER, css_classes: ["flat"] });
  private readonly tunnelRemove = new Gtk.Button({ icon_name: "user-trash-symbolic", tooltip_text: t("tunnelRemove"), valign: Gtk.Align.CENTER, css_classes: ["flat"] });
  private readonly address = new Adw.EntryRow({ title: t("peerAddress") });
  private readonly headers = new Adw.EntryRow({ title: t("peerHeaders") });

  private readonly hubGroup = new Adw.PreferencesGroup({ title: t("peerOnHub"), description: t("peerOnHubBody") });
  private linesRow: any;
  private readonly checkRow = new Adw.ComboRow({ title: t("peerCheck"), use_markup: false });
  private readonly check = new Gtk.Button({ label: t("peerCheckButton"), valign: Gtk.Align.CENTER });

  constructor(
    private readonly local: LocalManager,
    private readonly model: AppModel,
    private readonly opts: Opts,
  ) {
    this.buildPeerSide();
    this.buildReach();
    this.buildHub();
    void this.load();
    void this.refreshTunnel();
    // The Local status names the workspace once it arrives; read that one unless edits are pending.
    const off = local.on(() => {
      if (!this.dirty && this.workspaceEnv() !== this.envFile) void this.load();
    });
    this.widget.connect("destroy", off);
  }

  /** This computer's Space: the Local edition's workspace, else SPACE_HOME, else ~/.ai-space. */
  private workspaceEnv(): string {
    const ws = this.local.status?.workspace.path ?? (GLib.getenv("SPACE_HOME") || path(GLib.get_home_dir(), ".ai-space"));
    return path(ws, ".env");
  }

  // 1. This computer lets a hub in.

  private buildPeerSide(): void {
    const g = new Adw.PreferencesGroup({ title: t("peerThis"), description: t("peerThisBody") });
    g.set_header_suffix(this.save);
    g.add(this.enable);
    g.add(this.name);
    g.add(this.terminal);
    const copy = new Gtk.Button({ icon_name: "edit-copy-symbolic", tooltip_text: t("copy"), valign: Gtk.Align.CENTER, css_classes: ["flat"] });
    copy.connect("clicked", () => {
      this.tokenRow.get_clipboard().set(this.token);
      this.opts.toast(t("copied"));
    });
    const renew = new Gtk.Button({ icon_name: "view-refresh-symbolic", tooltip_text: t("hubTokenNew"), valign: Gtk.Align.CENTER, css_classes: ["flat"] });
    renew.connect("clicked", () => {
      this.token = randomToken();
      this.changed();
      this.opts.toast(t("hubTokenNewBody"));
    });
    this.tokenRow.add_suffix(copy);
    this.tokenRow.add_suffix(renew);
    g.add(this.tokenRow);
    g.add(this.fileRow);
    this.widget.add(g);

    this.enable.connect("notify::active", () => {
      if (this.enable.get_active() && !this.token) this.token = randomToken();
      this.changed();
    });
    this.name.connect("changed", () => this.changed());
    this.terminal.connect("notify::active", () => this.changed());
    this.save.connect("clicked", () => void this.write());
  }

  private loading = false;

  private async load(): Promise<void> {
    this.envFile = this.workspaceEnv();
    this.envText = (await readText(this.envFile)) ?? "";
    const side = readPeerSide(parseEnvText(this.envText));
    this.loading = true;
    this.token = side.token;
    this.port = side.port;
    this.enable.set_active(side.enabled);
    this.name.set_text(side.name || suggestPeerName(GLib.get_host_name()));
    this.terminal.set_active(side.terminal);
    this.fileRow.set_subtitle(this.envFile);
    this.loading = false;
    this.dirty = false;
    this.render();
  }

  private changed(): void {
    if (this.loading) return;
    this.dirty = true;
    this.render();
  }

  private validName(): boolean {
    return validPeerName(this.name.get_text().trim());
  }

  private render(): void {
    const on = this.enable.get_active();
    for (const w of [this.name, this.terminal, this.tokenRow]) w.set_sensitive(on);
    if (this.validName() || !on) this.name.remove_css_class("error");
    else this.name.add_css_class("error");
    this.tokenRow.set_subtitle(this.token ? mask(this.token) : "—");
    this.save.set_sensitive(this.dirty && (!on || this.validName()));
    this.renderLines();
  }

  private async write(): Promise<void> {
    const updates = peerSideUpdates({ enabled: this.enable.get_active(), token: this.token, name: this.name.get_text().trim(), terminal: this.terminal.get_active() });
    try {
      const current = (await readText(this.envFile)) ?? "";
      this.envText = updateEnvText(current, updates);
      await writeText(this.envFile, this.envText, 0o600);
    } catch (e) {
      logError(e, "peer settings");
      this.opts.toast(t("peerSaveFailed", { error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    this.dirty = false;
    this.render();
    // The Space reads its .env when it starts.
    if (this.local.status?.state === "managed") {
      this.opts.toast(t("peerSavedRestarting"));
      await this.local.restart();
    } else this.opts.toast(t("peerSavedRestart"));
  }

  // 2. The hub reaches this computer.

  private buildReach(): void {
    const g = this.reachGroup;
    this.hubPort.set_use_markup(false);
    this.hubPort.set_title(t("hubPort"));
    this.hubPort.set_subtitle(t("hubPortBody"));
    const saved = prefs.peer ?? { reach: "ssh", target: "", hubPort: DEFAULT_HUB_PORT, address: "", headers: "" };
    this.reach.set_selected(saved.reach === "address" ? 1 : 0);
    this.target.set_text(saved.target);
    this.hubPort.set_value(saved.hubPort || DEFAULT_HUB_PORT);
    this.address.set_text(saved.address);
    this.headers.set_text(saved.headers);
    // What the app already runs wins over what it remembers.
    const unit = readTunnelUnit(readTextSync(UNIT_FILE) ?? "");
    if (unit) {
      this.target.set_text(unit.target);
      this.hubPort.set_value(unit.hubPort);
    }
    this.tunnelRow.add_suffix(this.tunnelStart);
    this.tunnelRow.add_suffix(this.tunnelStop);
    this.tunnelRow.add_suffix(this.tunnelRemove);
    for (const w of [this.reach, this.target, this.hubPort, this.tunnelRow, this.address, this.headers]) g.add(w);
    this.widget.add(g);

    const remember = () => {
      prefs.peer = { reach: this.reach.get_selected() === 1 ? "address" : "ssh", target: this.target.get_text().trim(), hubPort: this.hubPort.get_value(), address: this.address.get_text().trim(), headers: this.headers.get_text().trim() };
      savePrefs();
      this.renderReach();
      this.renderLines();
    };
    this.reach.connect("notify::selected", remember);
    this.target.connect("changed", remember);
    this.hubPort.connect("notify::value", remember);
    this.address.connect("changed", remember);
    this.headers.connect("changed", remember);
    this.tunnelStart.connect("clicked", () => void this.startTunnel());
    this.tunnelStop.connect("clicked", () => void this.tunnelDo(["disable", "--now", TUNNEL_UNIT]));
    this.tunnelRemove.connect("clicked", () => void this.removeTunnel());
    this.renderReach();
  }

  private get ssh(): boolean {
    return this.reach.get_selected() === 0;
  }

  private tunnelState = "";

  private renderReach(): void {
    const ssh = this.ssh;
    for (const w of [this.target, this.hubPort, this.tunnelRow]) w.set_visible(ssh);
    for (const w of [this.address, this.headers]) w.set_visible(!ssh);
    this.reachGroup.set_description(ssh ? t("reachSshBody") : t("reachAddressBody"));
    const target = parseSshTarget(this.target.get_text());
    if (target || !this.target.get_text().trim()) this.target.remove_css_class("error");
    else this.target.add_css_class("error");
    const running = this.tunnelState === "active" || this.tunnelState === "activating";
    this.tunnelStart.set_label(running ? t("tunnelApply") : t("tunnelStart"));
    this.tunnelStart.set_sensitive(Boolean(target) && validHubPort(this.hubPort.get_value()));
    this.tunnelStop.set_visible(running);
    this.tunnelRemove.set_visible(GLib.file_test(UNIT_FILE, GLib.FileTest.EXISTS));
  }

  private async refreshTunnel(): Promise<void> {
    if (!GLib.file_test(UNIT_FILE, GLib.FileTest.EXISTS)) {
      this.tunnelState = "";
      this.tunnelRow.set_subtitle(t("tunnelNone"));
    } else {
      this.tunnelState = (await systemctl("is-active", TUNNEL_UNIT)).out.split("\n")[0] ?? "";
      let line = this.tunnelState === "active" ? t("tunnelRunning") : this.tunnelState === "inactive" ? t("tunnelStopped") : t("tunnelFailing");
      if (this.tunnelState !== "active" && this.tunnelState !== "inactive") {
        const last = (await run(["journalctl", "--user", "-u", TUNNEL_UNIT, "-n", "1", "--no-pager", "-o", "cat"])).out;
        if (last && !last.startsWith("--")) line += ` — ${last}`;
      }
      this.tunnelRow.set_subtitle(line);
    }
    this.renderReach();
  }

  private async startTunnel(): Promise<void> {
    const ssh = GLib.find_program_in_path("ssh");
    if (!ssh) return this.opts.toast(t("noSsh"));
    let unit: string;
    try {
      unit = renderTunnelUnit({ ssh, target: this.target.get_text(), hubPort: this.hubPort.get_value(), localPort: this.port });
    } catch (e) {
      return this.opts.toast(e instanceof Error ? e.message : String(e));
    }
    try {
      await writeText(UNIT_FILE, unit, 0o644);
    } catch (e) {
      return this.opts.toast(t("peerSaveFailed", { error: e instanceof Error ? e.message : String(e) }));
    }
    await systemctl("daemon-reload");
    await systemctl("enable", TUNNEL_UNIT);
    await this.tunnelDo(["restart", TUNNEL_UNIT], 3000);
  }

  private async tunnelDo(args: string[], settle = 300): Promise<void> {
    this.tunnelRow.set_sensitive(false);
    const r = await systemctl(...args);
    if (!r.ok && r.out) this.opts.toast(r.out.split("\n")[0]!);
    // ssh gives up within seconds when the hub refuses the key or the port.
    await sleep(settle);
    await this.refreshTunnel();
    this.tunnelRow.set_sensitive(true);
  }

  private async removeTunnel(): Promise<void> {
    await systemctl("disable", "--now", TUNNEL_UNIT);
    GLib.unlink(UNIT_FILE);
    await systemctl("daemon-reload");
    await this.refreshTunnel();
  }

  // 3. The hub's side.

  private hubAddress(): string {
    return this.ssh ? tunnelAddress(this.hubPort.get_value()) : this.address.get_text().trim();
  }

  private buildHub(): void {
    this.checkRow.set_subtitle(t("peerCheckBody"));
    this.checkRow.add_suffix(this.check);
    this.hubGroup.add(this.checkRow);
    this.widget.add(this.hubGroup);
    const others = () => this.model.list.connections.filter((c) => !c.managed);
    const fill = () => {
      const list = others();
      this.checkRow.set_model(Gtk.StringList.new(list.map((c) => c.name)));
      const current = list.findIndex((c) => c.id === this.model.current?.conn.id);
      if (current >= 0) this.checkRow.set_selected(current);
      this.checkRow.set_sensitive(list.length > 0);
    };
    fill();
    this.check.connect("clicked", () => void this.checkHub(others()[this.checkRow.get_selected()]?.id));
  }

  private renderLines(): void {
    if (this.linesRow) this.hubGroup.remove(this.linesRow);
    const name = this.name.get_text().trim();
    const address = this.hubAddress();
    const ready = this.enable.get_active() && this.token && validPeerName(name) && address;
    this.linesRow = ready ? this.opts.copyRow(hubLines(name, address, this.token, this.ssh ? undefined : this.headers.get_text())) : new Adw.ActionRow({ title: t("peerLinesIncomplete"), css_classes: ["dim-label"] });
    this.hubGroup.add(this.linesRow);
    // Keep the check below the lines.
    this.hubGroup.remove(this.checkRow);
    this.hubGroup.add(this.checkRow);
  }

  private async checkHub(id: string | undefined): Promise<void> {
    const space = id ? this.model.space(id) : undefined;
    if (!space) return;
    const name = this.name.get_text().trim();
    this.check.set_sensitive(false);
    this.checkRow.set_subtitle(t("peerChecking"));
    try {
      const r = (await space.client.get("/api/peers")) as { peers?: { name: string; health: string; error?: string; stale?: boolean }[] };
      const p = r.peers?.find((x) => x.name === name);
      this.checkRow.set_subtitle(!p ? t("peerNotListed", { name }) : p.health === "ok" && !p.stale ? t("peerOk", { name }) : t("peerDown", { name, error: p.error ?? p.health }));
    } catch (e) {
      this.checkRow.set_subtitle(e instanceof Error ? e.message : String(e));
    } finally {
      this.check.set_sensitive(true);
    }
  }
}
