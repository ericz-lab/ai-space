import Adw from "gi://Adw?version=1";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { pickText } from "../core/catalogue.ts";
import {
  type PackageApp,
  type PackageCatalogue,
  type PackageConnection,
  type PackageOperation,
  type SessionView,
  type StatusData,
  MIN_PASSWORD,
  backupState,
  dateTime,
  decodeBackups,
  decodePackageCatalogue,
  decodePreferences,
  decodeServices,
  listOf,
  modelChoices,
  operationKey,
  problems,
  relTime,
  rollbacks,
  runtimeKey,
  serviceState,
  settled,
  statusSummary,
  untilTime,
} from "../core/settings.ts";
import { resolveUrl } from "../core/url.ts";
import { lang, logError, openExternally, sleep, t, tw } from "./env.ts";
import { iconWidget } from "./icons.ts";
import type { Space } from "./model.ts";
import { type Ctx, badge, choiceRow, confirm, errorText, expander, linkRow, plain, row, waiting } from "./settings-kit.ts";

/**
 * The sections of Settings that show the Space itself, each the web panel's (src/web/App.tsx):
 * Models (ModelPreference), Automation and Usage (links to their pages), Status (SettingsStatus),
 * Packages (Packages) and Account (Auth.tsx's AccountSettings). Every call goes through the
 * Space's client with the session this app signed in with; nothing here uses an operator token.
 */

/** A group whose rows load from the Space; a failure takes the place of the rows. */
function loading(page: any, opts: { title?: string; description?: string }, load: (group: any) => Promise<void>): any {
  const group = new Adw.PreferencesGroup(opts);
  page.add(group);
  const wait = waiting(group);
  void load(group)
    .then(() => group.remove(wait))
    .catch((e) => wait.set_title(tw("common.unavailable", { error: errorText(e) })));
  return group;
}

// ------------------------------------------------------------------ models

export function modelsSection(page: any, ctx: Ctx, space: Space): void {
  loading(page, { description: tw("settings.defaultModelHelp") }, async (group) => {
    let prefs = decodePreferences(await space.client.get("/api/model/preferences"));
    const effective = () => tw("settings.modelEffective", { apps: prefs.appDefault, base: prefs.baseDefault });
    const picker = choiceRow(tw("settings.defaultModel"), modelChoices(prefs.options, prefs.defaultModel, tw("settings.modelEnvironment"), lang), prefs.defaultModel ?? "", (value) => {
      picker.row.set_sensitive(false);
      void space.client
        .send("PUT", "/api/model/preferences", { defaultModel: value || null })
        .then((raw) => {
          prefs = decodePreferences(raw);
          picker.row.set_subtitle(effective());
          // New chats with Space Assistant take the new default: the agents list carries it.
          void ctx.model.refresh(space, { catalogue: true });
        })
        .catch((e) => {
          ctx.toast(errorText(e));
          picker.set(prefs.defaultModel ?? "");
        })
        .finally(() => picker.row.set_sensitive(true));
    }, effective());
    group.add(picker.row);
  });
  const more = new Adw.PreferencesGroup();
  more.add(linkRow(tw("settings.appModels"), () => ctx.open("appModels")));
  page.add(more);
}

// ------------------------------------------------------------------ automation and usage

export function automationSection(page: any, ctx: Ctx): void {
  const g = new Adw.PreferencesGroup();
  g.add(linkRow(tw("settings.tasks"), () => ctx.open("tasks")));
  g.add(linkRow(tw("settings.events"), () => ctx.open("events")));
  page.add(g);
}

export function usageSection(page: any, ctx: Ctx): void {
  const g = new Adw.PreferencesGroup();
  g.add(linkRow(tw("settings.usage"), () => ctx.open("usage")));
  g.add(linkRow(tw("settings.activity"), () => ctx.open("activity")));
  page.add(g);
}

// ------------------------------------------------------------------ status

/** Peers, services and backups, loaded each time the section opens so the health dots are fresh. */
export function statusSection(page: any, ctx: Ctx, space: Space): void {
  const summary = new Adw.PreferencesGroup();
  const head = row(tw("common.loading"));
  summary.add(head);
  page.add(summary);
  const groups: any[] = [];
  void (async () => {
    const [svc, bak] = await Promise.all([
      space.client.get("/api/services").then(decodeServices, () => ({ services: [], peers: [] })),
      space.client.get("/api/backups").then(decodeBackups, () => ({ backups: [], on: true })),
    ]);
    const d: StatusData = { ...svc, backups: bak.backups, backupsOn: bak.on };
    const n = problems(d);
    head.set_title(statusSummary(d, lang));
    head.add_suffix(badge(n ? "down" : "ok", n ? tw("status.issues", { n }) : tw("status.allOk")));

    if (d.peers.length) {
      const g = new Adw.PreferencesGroup({ title: tw("settings.peers") });
      for (const p of d.peers) {
        const tip = [p.url, tw("settings.peerCounts", { apps: p.apps, agents: p.agents, widgets: p.widgets, services: p.services }), p.asOf ? tw("settings.snapshot", { time: relTime(p.asOf, lang) }) : "", p.error ?? ""].filter(Boolean).join("\n");
        const r = row(p.name, p.url, tip);
        r.add_prefix(new Gtk.Image({ icon_name: "network-server-symbolic" }));
        if (p.health !== "ok" && p.asOf) r.add_suffix(new Gtk.Label({ label: relTime(p.asOf, lang), css_classes: ["caption", "dim-label"] }));
        r.add_suffix(badge(p.health === "ok" ? "ok" : "down", tw(p.health === "ok" ? "status.up" : "status.down")));
        g.add(r);
      }
      groups.push(g);
    }

    const services = new Adw.PreferencesGroup({ title: tw("settings.services") });
    if (!d.services.length) services.add(row(tw("settings.noServices")));
    for (const s of d.services) {
      const st = serviceState(s);
      const tip = [
        `${s.peer ? `${s.peer}/` : ""}${s.app} · 127.0.0.1:${s.port}`,
        s.supervisor ? tw(s.supervisor === "space" ? "services.bySpace" : "services.byOperator") : "",
        s.supervision ? s.supervision.action : "",
        s.hidden ? tw("status.hidden") : "",
      ]
        .filter(Boolean)
        .join(" · ") + (s.supervision?.error ? `\n${s.supervision.error}` : "");
      const r = row(pickText(s.title, s.i18n, "title", lang), `${s.peer ? `${s.peer} · ` : ""}:${s.port}`, tip);
      r.add_prefix(iconWidget(s.icon, 24, space.client, "package-x-generic-symbolic"));
      if (st.supervised) {
        const box = new Gtk.Box({ css_classes: ["linked"], valign: Gtk.Align.CENTER });
        for (const [action, icon] of [["start", "media-playback-start-symbolic"], ["stop", "media-playback-stop-symbolic"], ["restart", "view-refresh-symbolic"]] as const) {
          const b = new Gtk.Button({ icon_name: icon, tooltip_text: tw(`services.${action}`), css_classes: ["flat"] });
          b.connect("clicked", () => {
            box.set_sensitive(false);
            void space.client
              .send("POST", `/api/apps/${encodeURIComponent(s.app)}/service`, { action })
              .catch((e) => ctx.toast(`${s.app}: ${errorText(e)}`))
              .finally(() => ctx.rebuild());
          });
          box.append(b);
        }
        r.add_suffix(box);
      }
      r.add_suffix(badge(st.tone, st.key ? tw(st.key) : "?"));
      services.add(r);
    }
    groups.push(services);

    const backups = new Adw.PreferencesGroup({ title: tw("settings.backups") });
    if (!d.backups.length) backups.add(row(tw(d.backupsOn ? "settings.noBackups" : "settings.backupsOff")));
    for (const b of d.backups) {
      const tip = [
        b.lastOkKey ?? "",
        b.lastStatus === "error" && b.lastError ? tw("backup.lastError", { error: b.lastError }) : "",
        b.lastVerifiedAt !== undefined ? (b.lastVerifyOk ? tw("backup.verified", { time: relTime(b.lastVerifiedAt, lang) }) : tw("backup.verifyFailed", { error: b.lastVerifyError ?? "" })) : "",
        b.nextRunAt && !b.retired ? tw("backup.nextRun", { time: untilTime(new Date(b.nextRunAt).toISOString(), lang) }) : "",
        b.retired ? tw("backup.retiredHint") : "",
      ]
        .filter(Boolean)
        .join("\n");
      const r = row(b.app, b.lastOkAt ? relTime(b.lastOkAt, lang) : tw("backup.never"), tip || undefined);
      r.add_prefix(new Gtk.Image({ icon_name: "drive-harddisk-symbolic" }));
      const st = backupState(b);
      r.add_suffix(badge(st.tone, tw(st.key)));
      backups.add(r);
    }
    groups.push(backups);
    for (const g of groups) page.add(g);
  })().catch((e) => head.set_title(tw("common.unavailable", { error: errorText(e) })));
}

// ------------------------------------------------------------------ packages

/** An upload whose outcome is not known yet, by Space, for the life of the app (the panel keeps it in localStorage). */
const pendingUploads = new Map<string, { id: string; upgrade: boolean }>();

async function operationState(space: Space, op: { id: string; upgrade: boolean }): Promise<string | undefined> {
  const raw = await space.client.get(op.upgrade ? "/api/panel/packages/changes" : "/api/panel/packages");
  return listOf<{ id: string; state: string }>(raw, op.upgrade ? "changes" : "operations").find((o) => o.id === op.id)?.state;
}

export function packagesSection(page: any, ctx: Ctx, space: Space): void {
  const conn = space.conn.id;
  const busy = (on: boolean) => page.set_sensitive(!on);
  /** Runs a change, then shows the section again with what it did. */
  const act = (work: () => Promise<unknown>) => {
    busy(true);
    void work()
      .then(() => void ctx.model.refresh(space, { catalogue: true }))
      .catch((e) => ctx.toast(errorText(e)))
      .finally(() => {
        busy(false);
        ctx.rebuild();
      });
  };

  // An upload still settling: its state, checked every 3 s while the section is open.
  const op = pendingUploads.get(conn);
  if (op) {
    const g = new Adw.PreferencesGroup({ title: tw("packages.operation"), description: op.id });
    const state = row(tw("packages.uncertain"));
    g.add(state);
    const dismiss = linkRow(tw("packages.dismiss"), () =>
      confirm(ctx.dialog, tw("packages.dismiss"), tw("packages.dismissConfirm"), tw("packages.dismiss"), () => {
        pendingUploads.delete(conn);
        ctx.rebuild();
      }),
    );
    g.add(dismiss);
    page.add(g);
    void (async () => {
      while (pendingUploads.get(conn) === op && page.get_root()) {
        try {
          const s = await operationState(space, op);
          state.set_title(s ? tw(operationKey(s)) : tw("packages.notRecorded"));
          if (settled(s)) {
            pendingUploads.delete(conn);
            ctx.rebuild();
            return;
          }
        } catch (e) {
          state.set_title(errorText(e));
        }
        await sleep(3000);
      }
    })();
  }

  // Install a .spaceapp
  const upload = new Adw.PreferencesGroup({ title: tw("packages.manage") });
  let file: any;
  const fileRow = row(tw("packages.file"), "—");
  const pick = new Gtk.Button({ icon_name: "document-open-symbolic", valign: Gtk.Align.CENTER, css_classes: ["flat"] });
  fileRow.add_suffix(pick);
  fileRow.set_activatable_widget(pick);
  const upgrade = new Adw.SwitchRow({ title: tw("packages.upgrade") });
  const unsigned = new Adw.SwitchRow({ title: tw("packages.unsigned") });
  const install = new Gtk.Button({ label: tw("packages.install"), sensitive: false, halign: Gtk.Align.END, margin_top: 8, css_classes: ["suggested-action", "pill"] });
  pick.connect("clicked", () => {
    const filter = new Gtk.FileFilter({ name: "Space app (.spaceapp)" });
    filter.add_pattern("*.spaceapp");
    const filters = new Gio.ListStore({ item_type: Gtk.FileFilter });
    filters.append(filter);
    const chooser = new Gtk.FileDialog({ title: tw("packages.file"), filters, default_filter: filter });
    chooser.open(ctx.dialog.get_root(), null, (_d: unknown, res: any) => {
      try {
        file = chooser.open_finish(res);
        fileRow.set_subtitle(file.get_basename());
        install.set_sensitive(!pendingUploads.has(conn));
      } catch {
        /* dismissed */
      }
    });
  });
  install.connect("clicked", () => {
    if (!file || pendingUploads.has(conn)) return;
    const operation = { id: GLib.uuid_string_random(), upgrade: upgrade.get_active() };
    pendingUploads.set(conn, operation);
    install.set_label(tw("packages.working"));
    act(async () => {
      const [bytes] = (await file.load_contents_async(null)) as [Uint8Array];
      const a = await space.client.answer("POST", "/api/panel/packages", {
        body: { type: "application/octet-stream", bytes },
        headers: { "idempotency-key": operation.id, ...(unsigned.get_active() ? { "x-space-allow-unsigned": "true" } : {}), ...(operation.upgrade ? { "x-space-upgrade": "true" } : {}) },
      });
      let result: { ok?: boolean; error?: string; change?: { error?: string; state?: string }; operation?: { error?: string; state?: string } } = {};
      try {
        result = JSON.parse(a.body);
      } catch {}
      const state = result.change?.state ?? result.operation?.state;
      if (settled(state)) pendingUploads.delete(conn);
      if (a.status < 200 || a.status >= 300 || !result.ok) throw new Error(result.error ?? result.change?.error ?? result.operation?.error ?? tw("packages.failed"));
    });
  });
  upload.add(fileRow);
  upload.add(upgrade);
  upload.add(unsigned);
  upload.add(install);
  page.add(upload);

  const local = new Adw.PreferencesGroup({ title: tw("packages.local") });
  const wait = waiting(local);
  page.add(local);
  const remote = new Adw.PreferencesGroup({ title: tw("packages.remote") });
  page.add(remote);
  const conns = new Adw.PreferencesGroup({ title: tw("packages.connections"), description: tw("packages.grantHint") });
  page.add(conns);

  const openButton = (a: PackageApp) => {
    const b = new Gtk.Button({ icon_name: "adw-external-link-symbolic", tooltip_text: tw("packages.open"), valign: Gtk.Align.CENTER, css_classes: ["flat"] });
    b.connect("clicked", () => openExternally(resolveUrl(a.url, `${space.client.base}/`) ?? a.url));
    return b;
  };
  const offlineRows = (exp: any, a: PackageApp) => {
    if (!a.offline) return;
    exp.add_row(row(tw("packages.offline"), a.offline.features.join(" · ") || tw("packages.none")));
    exp.add_row(row(tw("packages.online"), a.offline.online.join(" · ") || tw("packages.none")));
  };

  void (async () => {
    const [cat, connRaw, opsRaw] = await Promise.all([space.client.get("/api/panel/package-catalogue"), space.client.get("/api/panel/connections"), space.client.get("/api/panel/packages")]);
    const data: PackageCatalogue = decodePackageCatalogue(cat);
    const connections = listOf<PackageConnection>(connRaw, "connections");
    const operations = listOf<PackageOperation>(opsRaw, "operations");
    local.remove(wait);
    local.set_description(`${tw("packages.identity")}: ${data.spaceId}`);
    for (const a of data.apps) {
      const exp = expander(a.title || a.app, `${a.version} · ${tw(runtimeKey(a.state))}`);
      if (a.page !== false) exp.add_suffix(openButton(a));
      offlineRows(exp, a);
      exp.add_row(row(tw(a.sourceIncluded ? "packages.sourceYes" : "packages.sourceNo")));
      const back = rollbacks(operations, a.app);
      if (back.length) {
        const picker = choiceRow(tw("packages.rollback"), [{ value: "", label: "—" }, ...back.map((o) => ({ value: o.id, label: `${o.version} · ${o.id.slice(0, 8)}` }))], "", (operationId) => {
          if (!operationId) return;
          picker.set("");
          confirm(ctx.dialog, tw("packages.rollback"), tw("packages.rollbackConfirm"), tw("packages.rollback"), () => act(() => space.client.send("POST", `/api/panel/packages/apps/${encodeURIComponent(a.app)}/rollback`, { operationId })));
        });
        exp.add_row(picker.row);
      }
      const remove = new Adw.ActionRow({ title: tw("packages.remove"), activatable: true, css_classes: ["error"] });
      remove.connect("activated", () =>
        confirm(ctx.dialog, tw("packages.remove"), tw("packages.removeConfirm"), tw("packages.remove"), () =>
          act(async () => {
            const r = await space.client.answer("DELETE", `/api/panel/packages/apps/${encodeURIComponent(a.app)}`, { headers: { Origin: space.client.base } });
            if (r.status < 200 || r.status >= 300) throw new Error(r.body || `HTTP ${r.status}`);
          }),
        ),
      );
      exp.add_row(remove);
      local.add(exp);
    }

    for (const r of data.remotes) {
      const exp = expander(r.spaceId);
      exp.add_suffix(badge(r.available ? "ok" : "down", tw(r.available ? "status.up" : "status.down")));
      for (const a of r.apps) {
        const sub = expander(a.title || a.app, a.version);
        if (a.page !== false) sub.add_suffix(openButton(a));
        offlineRows(sub, a);
        exp.add_row(sub);
      }
      remote.add(exp);
    }

    const patch = (c: PackageConnection, body: Record<string, unknown>) => act(() => space.client.send("PATCH", `/api/panel/connections/${encodeURIComponent(c.id)}`, body));
    for (const c of connections) {
      const exp = expander(c.remoteSpaceId, c.direction === "outgoing" ? tw("packages.connectHub") : tw("packages.acceptPeer"));
      exp.add_suffix(badge(c.connected ? "ok" : "down", tw(c.connected ? "status.up" : "status.down")));
      const on = new Adw.SwitchRow({ title: tw("packages.connected"), active: c.enabled });
      on.connect("notify::active", () => patch(c, { enabled: on.get_active() }));
      exp.add_row(on);
      for (const a of data.apps) {
        const grant = plain(new Adw.SwitchRow({ active: c.apps.includes(a.app) }), a.title || a.app);
        grant.connect("notify::active", () => patch(c, { apps: grant.get_active() ? [...c.apps, a.app] : c.apps.filter((v) => v !== a.app) }));
        exp.add_row(grant);
      }
      const remove = new Adw.ActionRow({ title: tw("packages.removeConnection"), activatable: true, css_classes: ["error"] });
      remove.connect("activated", () =>
        confirm(ctx.dialog, tw("packages.removeConnection"), tw("packages.removeConnectionConfirm"), tw("packages.removeConnection"), () =>
          act(async () => {
            const r = await space.client.answer("DELETE", `/api/panel/connections/${encodeURIComponent(c.id)}`, { headers: { Origin: space.client.base } });
            if (r.status < 200 || r.status >= 300) throw new Error(r.body || `HTTP ${r.status}`);
          }),
        ),
      );
      exp.add_row(remove);
      conns.add(exp);
    }
    conns.add(linkRow(tw("packages.addConnection"), () => addConnection(ctx, space, act)));
  })().catch((e) => wait.set_title(tw("common.unavailable", { error: errorText(e) })));
}

/** Connects to a hub, or accepts a peer; accepting shows the invitation the other Space enters. */
function addConnection(ctx: Ctx, space: Space, act: (work: () => Promise<unknown>) => void): void {
  const d = new Adw.AlertDialog({ heading: tw("packages.addConnection") });
  const list = new Gtk.ListBox({ selection_mode: Gtk.SelectionMode.NONE, css_classes: ["boxed-list"], width_request: 360 });
  let direction = "outgoing";
  const endpoint = new Adw.EntryRow({ title: tw("packages.endpoint") });
  const credential = new Adw.EntryRow({ title: tw("packages.credential") });
  const dir = choiceRow(tw("packages.direction"), [{ value: "outgoing", label: tw("packages.connectHub") }, { value: "incoming", label: tw("packages.acceptPeer") }], direction, (v) => {
    direction = v;
    endpoint.set_visible(v === "outgoing");
    credential.set_visible(v === "outgoing");
  });
  const remoteId = new Adw.EntryRow({ title: tw("packages.remoteId") });
  for (const r of [dir.row, remoteId, endpoint, credential]) list.append(r);
  d.set_extra_child(list);
  d.add_response("cancel", tw("common.cancel"));
  d.add_response("add", tw("packages.addConnection"));
  d.set_response_appearance("add", Adw.ResponseAppearance.SUGGESTED);
  d.connect("response", (_d: unknown, id: string) => {
    if (id !== "add") return;
    const body = { remoteSpaceId: remoteId.get_text().trim(), direction, apps: [], ...(direction === "outgoing" ? { url: endpoint.get_text().trim(), tokenEnv: credential.get_text().trim() } : {}) };
    act(async () => {
      const result = (await space.client.send("POST", "/api/panel/connections", body)) as { token?: string };
      if (result.token) showInvite(ctx, result.token);
    });
  });
  d.present(ctx.dialog);
}

function showInvite(ctx: Ctx, token: string): void {
  const d = new Adw.AlertDialog({ heading: tw("packages.invite") });
  const label = new Gtk.Label({ label: token, selectable: true, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, css_classes: ["monospace"] });
  d.set_extra_child(label);
  d.add_response("copy", t("copy"));
  d.add_response("close", tw("common.close"));
  d.connect("response", (_d: unknown, id: string) => {
    if (id === "copy") label.get_clipboard().set(token);
  });
  d.present(ctx.dialog);
}

// ------------------------------------------------------------------ account

const when = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(lang === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return dateTime(iso, lang);
  }
};

/** Change the password, the signed-in sessions, sign out: only where the Space keeps its own password. */
export function accountSection(page: any, ctx: Ctx, space: Space): void {
  const pass = new Adw.PreferencesGroup();
  const change = new Adw.ExpanderRow({ title: tw("auth.changePassword") });
  const current = new Adw.PasswordEntryRow({ title: tw("auth.current") });
  const next = new Adw.PasswordEntryRow({ title: tw("auth.new") });
  const help = new Adw.ActionRow({ subtitle: tw("auth.changeHelp"), activatable: false });
  const save = new Gtk.Button({ label: tw("common.save"), sensitive: false, valign: Gtk.Align.CENTER, css_classes: ["suggested-action"] });
  help.add_suffix(save);
  const valid = () => save.set_sensitive(Boolean(current.get_text()) && next.get_text().length >= MIN_PASSWORD);
  current.connect("changed", valid);
  next.connect("changed", valid);
  save.connect("clicked", () => {
    change.set_sensitive(false);
    void space.client
      .send("POST", "/api/auth/password", { current: current.get_text(), next: next.get_text() })
      .then(() => {
        ctx.toast(tw("auth.changed"));
        ctx.rebuild();
      })
      .catch((e) => ctx.toast(errorText(e)))
      .finally(() => change.set_sensitive(true));
  });
  change.add_row(current);
  change.add_row(next);
  change.add_row(help);
  pass.add(change);
  page.add(pass);

  loading(page, {}, async (group) => {
    const sessions = listOf<SessionView>(await space.client.get("/api/auth/sessions"), "sessions");
    group.set_title(tw("auth.sessions", { n: sessions.length }));
    for (const s of sessions) {
      const r = row(s.userAgent || tw("auth.unknownClient"), s.current ? tw("auth.thisSession") : tw("auth.lastSeen", { at: when(s.lastSeenAt) }));
      if (!s.current) {
        const revoke = new Gtk.Button({ label: tw("auth.revoke"), valign: Gtk.Align.CENTER });
        revoke.connect("clicked", () => {
          revoke.set_sensitive(false);
          void space.client
            .answer("DELETE", `/api/auth/sessions/${s.id}`, { headers: { Origin: space.client.base } })
            .catch((e) => logError(e, "revoke"))
            .finally(() => ctx.rebuild());
        });
        r.add_suffix(revoke);
      }
      group.add(r);
    }
  });

  const out = new Adw.PreferencesGroup();
  out.add(
    linkRow(tw("auth.signOut"), () => {
      void space.client
        .send("POST", "/api/auth/logout", {})
        .catch((e) => logError(e, "sign out"))
        .finally(() => {
          // The Space now asks to sign in again; the window offers it.
          void ctx.model.refresh(space, { catalogue: true });
          ctx.dialog.close();
        });
    }),
  );
  page.add(out);
}
