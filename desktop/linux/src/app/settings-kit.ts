import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { pickText } from "../core/catalogue.ts";
import type { Choice, Detail, Tone } from "../core/settings.ts";
import { lang, logError, t, tw } from "./env.ts";
import type { AppModel, Space } from "./model.ts";

/**
 * What the Settings sections and pages share (settings.ts, settings-space.ts, settings-pages.ts):
 * the Space they show, how to open a page inside the pane, toasts, and the small widgets the web
 * panel's rows are made of (status dots, tables, pickers, confirmations).
 */

export type Ctx = {
  model: AppModel;
  space: Space | undefined;
  dialog: any;
  toast(title: string): void;
  /** Opens a page inside the pane, with Back (the panel's `settingsPage`). */
  open(detail: Detail): void;
  /** Builds the current section again (after a change elsewhere, such as the account). */
  rebuild(): void;
  /** App titles and icons by app id, `GET /api/apps?all=1`, once per dialog. */
  labels(): Promise<Map<string, { title: string; icon: string }>>;
};

/** Labels from `/api/apps?all=1`: headless and hidden apps still get a name. */
export async function loadLabels(space: Space | undefined): Promise<Map<string, { title: string; icon: string }>> {
  const out = new Map<string, { title: string; icon: string }>();
  if (!space) return out;
  try {
    const raw = (await space.client.get("/api/apps?all=1")) as { apps?: { id?: string; name?: string; title?: string; i18n?: Record<string, { title?: string }>; icon?: string }[] };
    // By id (a peer's apps are `peer/name`) and by name, as the usage and task routes name them.
    for (const a of raw.apps ?? []) {
      const key = a.id ?? a.name;
      if (!key) continue;
      const label = { title: pickText(a.title ?? key, a.i18n, "title", lang), icon: a.icon ?? "" };
      out.set(key, label);
      if (a.name && !out.has(a.name)) out.set(a.name, label);
    }
  } catch (e) {
    logError(e, "app labels");
  }
  return out;
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A coloured dot with a word, the panel's `.status` badge. */
export function badge(tone: Tone, text?: string): any {
  const box = new Gtk.Box({ spacing: 6, valign: Gtk.Align.CENTER });
  box.append(new Gtk.Box({ css_classes: ["status-dot", `status-${tone}`], valign: Gtk.Align.CENTER }));
  if (text) box.append(new Gtk.Label({ label: text, css_classes: ["caption", "dim-label"] }));
  return box;
}

export function note(text: string, opts: { error?: boolean; selectable?: boolean } = {}): any {
  return new Gtk.Label({ label: text, wrap: true, xalign: 0, selectable: opts.selectable ?? false, css_classes: ["dim-label", ...(opts.error ? ["error"] : []), "setnote"] });
}

/** Sets a row's texts as plain text: GJS may apply construct properties before `use_markup: false`, so they are set after it. */
export function plain<T>(w: T, title: string, subtitle?: string): T {
  const r = w as any;
  r.set_use_markup(false);
  r.set_title(title || " ");
  if (subtitle !== undefined) r.set_subtitle(subtitle);
  return w;
}

/** A row that folds out, with plain texts. */
export const expander = (title: string, subtitle?: string, tooltip?: string): any => plain(new Adw.ExpanderRow(tooltip ? { tooltip_text: tooltip } : {}), title, subtitle);

/** A group showing one line while its rows load, or an error in their place. */
export function waiting(group: any, text = tw("common.loading")): any {
  const row = plain(new Adw.ActionRow({ sensitive: false }), text);
  group.add(row);
  return row;
}

/** A row that opens a page or does something, with a chevron: the panel's `.setlink` rows. */
export function linkRow(title: string, run: () => void, subtitle?: string): any {
  const row = plain(new Adw.ActionRow({ activatable: true }), title, subtitle);
  row.add_suffix(new Gtk.Image({ icon_name: "go-next-symbolic" }));
  row.connect("activated", run);
  return row;
}

/** A plain row: title, optional subtitle, never markup (texts come from apps). */
export function row(title: string, subtitle?: string, tooltip?: string): any {
  return plain(new Adw.ActionRow(tooltip ? { tooltip_text: tooltip } : {}), title, subtitle);
}

/**
 * A picker of choices (the panel's `<select>`): `onPick` runs when the person picks another one, not
 * while the row is filled. Returns the row and a setter to show a value without picking it.
 */
export function choiceRow(title: string, choices: Choice[], value: string, onPick: (value: string) => void, subtitle?: string): { row: any; set(value: string): void } {
  const model = Gtk.StringList.new(choices.map((c) => c.label));
  const row = plain(new Adw.ComboRow({ model }), title, subtitle);
  let quiet = true;
  const set = (v: string) => {
    quiet = true;
    row.set_selected(Math.max(0, choices.findIndex((c) => c.value === v)));
    quiet = false;
  };
  set(value);
  row.connect("notify::selected", () => {
    if (quiet) return;
    const c = choices[row.get_selected()];
    if (c) onPick(c.value);
  });
  return { row, set };
}

/** Linked toggle buttons, one pressed (the panel's window buttons: 5h 24h 7d 30d). */
export function segmented<T extends string>(values: readonly T[], current: T, label: (v: T) => string, onPick: (v: T) => void): any {
  const box = new Gtk.Box({ css_classes: ["linked"], valign: Gtk.Align.CENTER });
  let first: any;
  for (const v of values) {
    const b = new Gtk.ToggleButton({ label: label(v), active: v === current, css_classes: ["small-toggle"] });
    if (first) b.set_group(first);
    else first = b;
    b.connect("toggled", () => {
      if (b.get_active() && v !== current) {
        current = v;
        onPick(v);
      }
    });
    box.append(b);
  }
  return box;
}

/** Figures in a row of cards (the panel's `.usage-cards`). */
export function cards(items: { value: string; label: string; tooltip?: string }[]): any {
  const box = new Gtk.FlowBox({ selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, min_children_per_line: 2, max_children_per_line: 4, column_spacing: 10, row_spacing: 10 });
  for (const i of items) {
    const card = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, css_classes: ["card", "usage-card"], ...(i.tooltip ? { tooltip_text: i.tooltip } : {}) });
    card.append(new Gtk.Label({ label: i.value, xalign: 0, ellipsize: Pango.EllipsizeMode.END, css_classes: ["usage-figure"] }));
    card.append(new Gtk.Label({ label: i.label, xalign: 0, wrap: true, css_classes: ["caption", "dim-label"] }));
    box.append(card);
  }
  return box;
}

/** A table in a card, scrolling sideways when it is wider than the pane (the panel's `.usage-table`). A cell is text or a widget; `alert` tints one cell (a count with failures). */
export function table(headers: string[], rows: { cells: (string | any)[]; tooltip?: string; dim?: boolean; alert?: number }[], opts: { numeric?: (col: number) => boolean } = {}): any {
  const grid = new Gtk.Grid({ column_spacing: 18, row_spacing: 6, margin_start: 12, margin_end: 12, margin_top: 10, margin_bottom: 10 });
  const numeric = opts.numeric ?? ((c: number) => c > 0);
  headers.forEach((h, c) => grid.attach(new Gtk.Label({ label: h, xalign: numeric(c) ? 1 : 0, css_classes: ["caption-heading", "dim-label"] }), c, 0, 1, 1));
  rows.forEach((r, i) => {
    r.cells.forEach((cell, c) => {
      const w =
        typeof cell === "string"
          ? new Gtk.Label({ label: cell, xalign: numeric(c) ? 1 : 0, ellipsize: c === 0 ? Pango.EllipsizeMode.END : Pango.EllipsizeMode.NONE, ...(c === 0 ? { width_chars: 12, max_width_chars: 28 } : {}), css_classes: ["table-cell", ...(r.dim ? ["dim-label"] : []), ...(r.alert === c ? ["error"] : [])] })
          : cell;
      if (r.tooltip) w.set_tooltip_text(r.tooltip);
      grid.attach(w, c, i + 1, 1, 1);
    });
  });
  return new Gtk.ScrolledWindow({ child: grid, vscrollbar_policy: Gtk.PolicyType.NEVER, hscrollbar_policy: Gtk.PolicyType.AUTOMATIC, propagate_natural_height: true, css_classes: ["card"] });
}

/** Asks before something that cannot be undone. */
export function confirm(parent: any, heading: string, body: string, action: string, run: () => void, destructive = true): void {
  const d = new Adw.AlertDialog({ heading, body });
  d.add_response("cancel", tw("common.cancel"));
  d.add_response("ok", action);
  d.set_response_appearance("ok", destructive ? Adw.ResponseAppearance.DESTRUCTIVE : Adw.ResponseAppearance.SUGGESTED);
  d.set_default_response("cancel");
  d.connect("response", (_d: unknown, id: string) => id === "ok" && run());
  d.present(parent);
}

/**
 * A page opened inside the pane: a header with Back and Reload, and a scrolling, width-limited
 * body that `fill` builds again on each reload (the panel's windows also refresh on a timer; here
 * a rebuild would fold open rows, so Reload is the person's).
 */
export function detailPage(title: string, fill: (body: any, reload: () => void) => void | Promise<void>, opts: { subtitle?: string } = {}): any {
  const page = new Adw.NavigationPage({ title });
  const toolbar = new Adw.ToolbarView();
  const bar = new Adw.HeaderBar();
  const reloadButton = new Gtk.Button({ icon_name: "view-refresh-symbolic", tooltip_text: t("reload") });
  bar.pack_end(reloadButton);
  toolbar.add_top_bar(bar);
  const scroll = new Gtk.ScrolledWindow({ hscrollbar_policy: Gtk.PolicyType.NEVER, vexpand: true });
  const clamp = new Adw.Clamp({ maximum_size: 880, tightening_threshold: 600 });
  scroll.set_child(clamp);
  toolbar.set_content(scroll);
  page.set_child(toolbar);
  const reload = () => {
    const body = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 18, margin_top: 18, margin_bottom: 24, margin_start: 12, margin_end: 12 });
    if (opts.subtitle) body.append(note(opts.subtitle));
    clamp.set_child(body);
    void Promise.resolve(fill(body, reload)).catch((e) => body.append(note(tw("common.unavailable", { error: errorText(e) }), { error: true })));
  };
  reloadButton.connect("clicked", reload);
  reload();
  return page;
}

/** A heading over a block of a page (the panel's `.task-app` lines). */
export function heading(text: string, end?: any): any {
  const box = new Gtk.Box({ spacing: 8 });
  box.append(new Gtk.Label({ label: text, xalign: 0, hexpand: true, css_classes: ["heading"] }));
  if (end) box.append(end);
  return box;
}
