import Adw from "gi://Adw?version=1";
import Gtk from "gi://Gtk?version=4.0";
import Pango from "gi://Pango";
import { pickText } from "../core/catalogue.ts";
import {
  type CallInfo,
  type CapabilityApp,
  type DeliveryInfo,
  type DeviceRow,
  type EventInfo,
  type Metric,
  type ModelOption,
  type RunInfo,
  type TaskInfo,
  type UsageRow,
  type UsageWindow,
  ACTIVITY_WINDOWS,
  DELIVERY,
  KINDS,
  METRICS,
  MODEL_WINDOWS,
  RUN_STATUS,
  activityBars,
  activityRange,
  activityTotals,
  byApp,
  callTokens,
  catalogueApps,
  dateTime,
  dayKey,
  decodeAppModels,
  decodeTasks,
  decodeUsage,
  deviceLabel,
  fmtCost,
  fmtDuration,
  fmtMetric,
  fmtTokens,
  history,
  listOf,
  modelChoices,
  previewData,
  relTime,
  scheduleText,
  taskBadges,
  taskCounts,
  taskModels,
  taskStatus,
  untilTime,
  type AppModelRow,
  type WebKey,
  modelOn,
} from "../core/settings.ts";
import { lang, tw } from "./env.ts";
import type { Space } from "./model.ts";
import { colors } from "./widget-card.ts";
import { type Ctx, badge, cards, choiceRow, detailPage, errorText, expander, heading, note, row, segmented, table } from "./settings-kit.ts";

/**
 * The pages a Settings section opens inside the pane, each the web panel's window of the same
 * name: App models (AppModels.tsx), Scheduled tasks (Tasks.tsx), Events and calls (Events.tsx),
 * Model usage (Usage.tsx) and App usage (Activity.tsx). Read-only apart from the model pickers,
 * which use the same panel routes as the web page.
 */

const sourceText = (source: string) => tw(`appModels.source.${source}` as WebKey);

// ------------------------------------------------------------------ app models

export function appModelsPage(ctx: Ctx, space: Space): any {
  return detailPage(
    tw("appModels.title"),
    async (body) => {
      const [raw, labels] = await Promise.all([space.client.get("/api/model/apps"), ctx.labels()]);
      const data = decodeAppModels(raw);
      const title = (app: string) => labels.get(app)?.title ?? app;
      for (const a of [...data.apps].sort((x, y) => title(x.app).localeCompare(title(y.app), lang))) {
        const group = new Adw.PreferencesGroup({ title: title(a.app) });
        const subtitle = (r: AppModelRow) => [r.model, sourceText(r.source), r.manifest ? tw("appModels.declared", { model: r.manifest }) : ""].filter(Boolean).join(" · ");
        const pickers = new Map<string, ReturnType<typeof choiceRow>>();
        for (const r of a.rows) {
          const picker = choiceRow(r.tag ?? tw("appModels.allTags"), modelChoices(data.options, r.override, tw("appModels.noOverride"), lang, false), r.override ?? "", (value) => {
            picker.row.set_sensitive(false);
            void space.client
              .send("PATCH", `/api/panel/apps/${encodeURIComponent(a.app)}/model`, { ...(r.tag === null ? {} : { tag: r.tag }), model: value || null })
              .then((next) => {
                // The answer is the app's rows again: the layer that now decides each one.
                for (const n of decodeAppModels({ apps: [next] }).apps[0]?.rows ?? []) pickers.get(n.tag ?? "")?.row.set_subtitle(subtitle(n));
              })
              .catch((e) => {
                ctx.toast(errorText(e));
                picker.set(r.override ?? "");
              })
              .finally(() => picker.row.set_sensitive(true));
          }, subtitle(r));
          pickers.set(r.tag ?? "", picker);
          group.add(picker.row);
        }
        body.append(group);
      }
    },
    { subtitle: tw("appModels.summary") },
  );
}

// ------------------------------------------------------------------ tasks

function runsInto(exp: any, runs: RunInfo[]): void {
  if (!runs.length) exp.add_row(row(tw("tasks.noRuns")));
  for (const r of runs) {
    const st = RUN_STATUS[r.status] ?? RUN_STATUS.skipped;
    const tags = [r.trigger === "manual" ? tw("tasks.manualRun") : "", r.eventIds?.length ? tw("tasks.eventRun", { n: r.eventIds.length }) : ""].filter(Boolean);
    const title = [relTime(r.startedAt, lang), ...tags].join(" · ");
    const sub = [fmtDuration(r.endedAt - r.startedAt, lang), r.error ?? ""].filter(Boolean).join(" · ");
    const target = r.output ? expander(title, sub, dateTime(r.startedAt, lang)) : row(title, sub, dateTime(r.startedAt, lang));
    target.add_prefix(badge(st.tone));
    target.add_suffix(new Gtk.Label({ label: tw(st.key), css_classes: ["caption", "dim-label"] }));
    if (r.output) target.add_row(new Gtk.Label({ label: r.output, xalign: 0, wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, selectable: true, css_classes: ["monospace", "run-output"] }));
    exp.add_row(target);
  }
}

export function tasksPage(ctx: Ctx, space: Space): any {
  /** Tasks opened by the person stay open across a reload. */
  const open = new Set<string>();
  let models: Promise<ModelOption[]> | undefined;
  const modelsOf = () => (models ??= space.client.get("/api/tasks/models").then((raw) => listOf<ModelOption>(raw, "models")));
  return detailPage(tw("tasks.title"), async (body) => {
    const [tasks, labels] = await Promise.all([space.client.get("/api/tasks").then(decodeTasks), ctx.labels()]);
    const n = taskCounts(tasks);
    body.append(note(`${tw("tasks.summary", { active: n.active, total: n.total })}${n.failing ? tw("tasks.failing", { n: n.failing }) : ""}`));
    if (!tasks.length) body.append(note(tw("tasks.empty")));
    for (const g of byApp(tasks, (app) => labels.get(app)?.title ?? app, lang, (t) => t.name)) {
      const group = new Adw.PreferencesGroup({ title: g.title });
      group.set_header_suffix(new Gtk.Label({ label: String(g.rows.length), css_classes: ["dim-label"] }));
      for (const t of g.rows) group.add(taskRow(ctx, space, t, open, modelsOf));
      body.append(group);
    }
  });
}

function taskRow(ctx: Ctx, space: Space, t: TaskInfo, open: Set<string>, modelsOf: () => Promise<ModelOption[]>): any {
  const st = taskStatus(t);
  const next = t.enabled && !t.orphaned && t.state.nextRunAt ? untilTime(t.state.nextRunAt, lang) : "";
  const meta = [
    tw(st.key, { n: st.n ?? 0 }),
    t.state.lastDurationMs !== undefined ? fmtDuration(t.state.lastDurationMs, lang) : "",
    t.state.lastRunAt ? relTime(t.state.lastRunAt, lang) : "",
    next ? tw("tasks.next", { time: next }) : "",
    t.state.pending ? tw("tasks.pending", { n: t.state.pending.events }) : "",
    t.target.kind,
    t.model ?? "",
  ].filter(Boolean);
  const schedule = [...t.triggers.map((g) => tw("tasks.on", { event: g.event })), ...(t.schedule.kind !== "manual" || !t.triggers.length ? [scheduleText(t.schedule, lang)] : [])].join(" · ");
  const title = [t.name, ...taskBadges(t).map((b) => `[${b}]`)].join(" ");
  const exp = expander(title, meta.join(" · "), t.description || `${t.app}/${t.name}`);
  exp.add_prefix(badge(st.tone));
  exp.add_suffix(new Gtk.Label({ label: schedule, ellipsize: Pango.EllipsizeMode.END, max_width_chars: 24, css_classes: ["caption", "dim-label"] }));
  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    if (t.description) exp.add_row(row(t.description));
    if (!t.modelSelectable) exp.add_row(row(tw("tasks.modelUnsupported")));
    else {
      const holder = row(tw("tasks.model"), tw("common.loading"));
      exp.add_row(holder);
      void modelsOf()
        .then((options) => {
          const current = t.overrides.model ?? "";
          const picker = choiceRow(tw("tasks.model"), modelChoices(taskModels(options, t), current, tw("tasks.modelDefault", { model: t.base?.model ?? tw("chat.modelDefault") }), lang, false), current, (value) => {
            picker.row.set_sensitive(false);
            void space.client
              .send("PATCH", `/api/panel/tasks/${encodeURIComponent(t.id)}/model`, { model: value || null })
              .then(() => ctx.toast(tw("tasks.modelSaved")))
              .catch((e) => {
                ctx.toast(errorText(e));
                picker.set(current);
              })
              .finally(() => picker.row.set_sensitive(!t.orphaned));
          }, tw("tasks.modelNextRun"));
          picker.row.set_sensitive(!t.orphaned);
          exp.remove(holder);
          exp.add_row(picker.row);
          return space.client.get(`/api/tasks/${encodeURIComponent(t.id)}/runs?limit=20`);
        })
        .then((raw) => raw && runsInto(exp, listOf<RunInfo>(raw, "runs")))
        .catch((e) => holder.set_subtitle(tw("common.unavailable", { error: errorText(e) })));
      return;
    }
    void space.client
      .get(`/api/tasks/${encodeURIComponent(t.id)}/runs?limit=20`)
      .then((raw) => runsInto(exp, listOf<RunInfo>(raw, "runs")))
      .catch((e) => exp.add_row(row(tw("common.unavailable", { error: errorText(e) }))));
  };
  exp.connect("notify::expanded", () => {
    if (exp.get_expanded()) {
      open.add(t.id);
      fill();
    } else open.delete(t.id);
  });
  if (open.has(t.id)) exp.set_expanded(true);
  return exp;
}

// ------------------------------------------------------------------ events

export function eventsPage(_ctx: Ctx, space: Space): any {
  const open = new Set<number>();
  return detailPage(tw("events.title"), async (body) => {
    const [events, apps] = await Promise.all([
      space.client.get("/api/events?limit=100").then((raw) => listOf<EventInfo>(raw, "events")),
      space.client.get("/api/capabilities").then((raw) => listOf<CapabilityApp>(raw, "apps"), () => [] as CapabilityApp[]),
    ]);
    const providers = apps.filter((a) => a.provides?.length).length;
    const publishers = apps.filter((a) => a.publishes?.length).length;
    body.append(note(tw("events.summary", { n: events.length, providers, publishers })));

    const cat = new Adw.PreferencesGroup({ title: tw("events.catalogue") });
    const listed = catalogueApps(apps);
    if (!listed.length) cat.add(row(tw("events.noCatalogue")));
    for (const a of listed) {
      const exp = expander(a.app, a.peer ?? "");
      for (const c of a.provides ?? []) {
        const s = a.stats?.find((x) => x.capability === c.name);
        const r = row(`${tw("events.provides")} · ${c.name}`, c.description, `${c.method} ${c.path}${c.callers ? ` · ${c.callers.join(", ")}` : ""}`);
        if (s) r.add_suffix(new Gtk.Label({ label: tw("events.calls", { n: s.calls, failed: s.failures }), css_classes: ["caption", "dim-label"] }));
        exp.add_row(r);
      }
      for (const p of a.publishes ?? []) exp.add_row(row(`${tw("events.publishes")} · ${p.name}`, p.description));
      for (const c of a.consumes ?? []) exp.add_row(row(`${tw("events.consumes")} · ${c.event}`, c.kind === "task" ? tw("events.viaTask", { task: c.task ?? "" }) : c.kind === "http" ? `${c.method} ${c.path}` : tw("events.viaStream")));
      cat.add(exp);
    }
    body.append(cat);

    const recent = new Adw.PreferencesGroup({ title: tw("events.recent") });
    if (!events.length) recent.add(row(tw("events.empty")));
    for (const e of events) {
      const exp = expander(e.peer ? `${e.name} · ${e.peer}` : e.name, [relTime(e.at, lang), previewData(e.data)].filter(Boolean).join(" · "), JSON.stringify(e.data));
      let filled = false;
      const fill = () => {
        if (filled) return;
        filled = true;
        void space.client
          .get(`/api/events/${e.id}`)
          .then((raw) => {
            const rows = listOf<DeliveryInfo>(raw, "deliveries");
            if (!rows.length) exp.add_row(row(tw("events.noDeliveries")));
            for (const d of rows) {
              const st = DELIVERY[d.status] ?? DELIVERY.pending;
              const r = row(`${d.app} · ${d.kind}${d.path ? ` ${d.path}` : ""}`, d.lastError, d.nextAt ? dateTime(d.nextAt, lang) : undefined);
              r.add_prefix(badge(st.tone));
              r.add_suffix(new Gtk.Label({ label: `${tw(st.key)} · ${tw("events.attempts", { n: d.attempts })}`, css_classes: ["caption", "dim-label"] }));
              exp.add_row(r);
            }
          })
          .catch((err) => exp.add_row(row(tw("common.unavailable", { error: errorText(err) }))));
      };
      exp.connect("notify::expanded", () => {
        if (exp.get_expanded()) {
          open.add(e.id);
          fill();
        } else open.delete(e.id);
      });
      if (open.has(e.id)) exp.set_expanded(true);
      recent.add(exp);
    }
    body.append(recent);
  });
}

// ------------------------------------------------------------------ model usage

type RGB = readonly number[];

/** A drawing in the widget's text colour and the desktop's accent. */
function drawing(width: number, height: number, draw: (cr: any, w: number, h: number, fg: RGB, accent: RGB) => void): any {
  const area = new Gtk.DrawingArea({ content_width: width, content_height: height, valign: Gtk.Align.CENTER });
  area.set_draw_func((a: any, cr: any, w: number, h: number) => {
    const { fg, accent } = colors(a);
    draw(cr, w, h, fg, accent);
    cr.$dispose?.();
  });
  return area;
}

/** The year as a grid of days, a column per week (Usage.tsx's `.usage-grid`), with each day's figure as a tooltip. */
function dayGrid(h: ReturnType<typeof history>, metric: Metric): any {
  const cell = 11;
  const top = 16;
  const area = drawing(h.weeks.length * cell, top + 7 * cell, (cr, _w, _h, fg, accent) => {
    const alpha = [0.08, 0.3, 0.5, 0.72, 1];
    h.grid.forEach((col, x) =>
      col.forEach((d, y) => {
        if (d.level < 0) return;
        if (d.level === 0) cr.setSourceRGBA(fg[0], fg[1], fg[2], alpha[0]);
        else cr.setSourceRGBA(accent[0], accent[1], accent[2], alpha[d.level]);
        cr.rectangle(x * cell + 1, top + y * cell + 1, cell - 2, cell - 2);
        cr.fill();
      }),
    );
    cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.6);
    cr.setFontSize(10);
    for (const m of h.months) {
      cr.moveTo(m.col * cell, 11);
      cr.showText(new Date(Date.UTC(2000, m.month, 1)).toLocaleDateString(lang === "zh" ? "zh-CN" : "en", { month: "short", timeZone: "UTC" }));
    }
  });
  area.set_has_tooltip(true);
  area.connect("query-tooltip", (_a: unknown, x: number, y: number, _k: boolean, tip: any) => {
    const d = h.grid[Math.floor(x / cell)]?.[Math.floor((y - top) / cell)];
    if (!d || y < top) return false;
    tip.set_text(`${d.day} · ${d.calls ? fmtMetric(metric, d.value) : tw("usage.noCalls")}`);
    return true;
  });
  return new Gtk.ScrolledWindow({ child: area, vscrollbar_policy: Gtk.PolicyType.NEVER, propagate_natural_height: true });
}

/** The last twelve weeks as bars, the figure above and the week below each (`.usage-bars`). */
function weekBars(h: ReturnType<typeof history>, metric: Metric): any {
  const box = new Gtk.Box({ spacing: 6, homogeneous: true });
  for (const b of h.bars) {
    const col = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 2, tooltip_text: `${dayKey(b.week)} · ${fmtMetric(metric, b.value)}` });
    col.append(new Gtk.Label({ label: fmtMetric(metric, b.value), css_classes: ["caption", "dim-label"], ellipsize: Pango.EllipsizeMode.END }));
    col.append(
      drawing(24, 70, (cr, w, height, _fg, accent) => {
        const bh = Math.max(2, Math.round((b.value / h.max) * height));
        cr.setSourceRGBA(accent[0], accent[1], accent[2], b.partial ? 0.5 : 1);
        cr.rectangle(w * 0.2, height - bh, w * 0.6, bh);
        cr.fill();
      }),
    );
    col.append(new Gtk.Label({ label: dayKey(b.week).slice(5).replace("-", "/"), css_classes: ["caption", "dim-label"] }));
    box.append(col);
  }
  return box;
}

export function usagePage(ctx: Ctx, space: Space): any {
  let window: (typeof MODEL_WINDOWS)[number] = "24h";
  let metric: Metric = "tokens";
  return detailPage(tw("usage.title"), async (body, reload) => {
    const [usage, calls, labels] = await Promise.all([
      space.client.get(`/api/model/usage?window=${window}`).then(decodeUsage),
      space.client.get("/api/model/calls?limit=30").then((raw) => listOf<CallInfo>(raw, "calls")),
      ctx.labels(),
    ]);
    const label = (app: string) => labels.get(app)?.title ?? app;
    body.append(
      heading(
        tw("usage.backend", { backend: usage.backend }),
        segmented(MODEL_WINDOWS, window, (w) => w, (w) => {
          window = w;
          reload();
        }),
      ),
    );
    body.append(note(tw("usage.costNote")));
    const tot = usage.totals;
    body.append(
      cards([
        { value: tot.calls.toLocaleString(), label: `${tw("usage.calls")}${tot.errors ? tw("usage.errors", { n: tot.errors }) : ""}` },
        { value: fmtTokens(tot.tokens), label: tw("usage.tokens") },
        { value: fmtCost(tot.costUsd), label: tw("usage.cost") },
        { value: fmtDuration(tot.durationMs, lang), label: tw("usage.time") },
      ]),
    );
    if (!tot.calls) body.append(note(tw("usage.empty")));
    const tokenCells = (r: { inputTokens?: number; cacheWriteTokens?: number; cacheReadTokens?: number; outputTokens?: number }) => [fmtTokens(r.inputTokens), fmtTokens(r.cacheWriteTokens), fmtTokens(r.cacheReadTokens), fmtTokens(r.outputTokens)];
    const tokenHeads = [tw("usage.input"), tw("usage.cacheWrite"), tw("usage.cacheRead"), tw("usage.output")];
    if (usage.byTag.length) {
      body.append(heading(tw("usage.byTag")));
      body.append(
        table(
          [tw("usage.app"), tw("usage.tag"), tw("usage.model"), tw("usage.calls"), ...tokenHeads, tw("usage.cost")],
          usage.byTag.map((r) => ({ cells: [label(r.app), r.tag, modelOn(r), r.errors ? `${r.calls} (${r.errors})` : String(r.calls), ...tokenCells(r), fmtCost(r.costUsd)], tooltip: r.errors ? `${r.app}${tw("usage.errors", { n: r.errors })}` : r.app, ...(r.errors ? { alert: 3 } : {}) })),
          { numeric: (c) => c > 2 },
        ),
      );
    }
    if (usage.byModel.length) {
      body.append(heading(tw("usage.byModel")));
      const origin = (o: string) => (o === "task" ? tw("usage.originTask") : o === "import" ? tw("usage.originImport") : o === "peer" ? tw("usage.originPeer") : tw("usage.originRun"));
      body.append(
        table(
          [tw("usage.model"), tw("usage.calls"), ...tokenHeads, tw("usage.cost")],
          [
            ...usage.byModel.map((r) => ({ cells: [modelOn(r), String(r.calls), ...tokenCells(r), fmtCost(r.costUsd)] })),
            ...usage.byBackend.map((r) => ({ cells: [`${r.backend} · ${origin(r.origin)}`, String(r.calls), ...tokenCells(r), fmtCost(r.costUsd)], dim: true })),
          ],
        ),
      );
    }
    if (usage.history.totals.calls > 0) {
      const h = history(usage.history, metric, Date.now());
      body.append(
        heading(
          tw("usage.history"),
          segmented(METRICS, metric, (m) => tw(`usage.metric.${m}`), (m) => {
            metric = m;
            reload();
          }),
        ),
      );
      const ht = usage.history.totals;
      body.append(
        cards([
          { value: String(h.daysRecorded), label: tw("usage.daysRecorded") },
          { value: ht.calls.toLocaleString(), label: `${tw("usage.calls")}${ht.errors ? tw("usage.errors", { n: ht.errors }) : ""}` },
          { value: fmtTokens(ht.tokens), label: tw("usage.tokens") },
          { value: fmtCost(ht.costUsd), label: tw("usage.costPerDay", { cost: fmtCost(h.daysRecorded ? ht.costUsd / h.daysRecorded : 0) }) },
        ]),
      );
      body.append(dayGrid(h, metric));
      if (h.bars.length) body.append(weekBars(h, metric));
    }
    if (calls.length) {
      const group = new Adw.PreferencesGroup({ title: tw("usage.recent") });
      for (const c of calls) {
        const tokens = callTokens(c);
        const tip = c.error || `${c.app}/${c.tag} · ${c.backend}${c.modelSource ? ` · ${sourceText(c.modelSource)}` : ""}`;
        const r = row(modelOn(c), [`${label(c.app)} · ${c.tag}`, relTime(c.startedAt, lang), c.error ?? ""].filter(Boolean).join(" · "), tip);
        r.add_prefix(badge(c.status === "ok" ? "ok" : "down"));
        r.add_suffix(new Gtk.Label({ label: [tokens !== undefined ? fmtTokens(tokens) : "", c.costUsd !== undefined ? fmtCost(c.costUsd) : "", fmtDuration(c.durationMs, lang)].filter(Boolean).join(" · "), css_classes: ["caption", "dim-label", "numeric"] }));
        group.add(r);
      }
      body.append(group);
    }
  });
}

// ------------------------------------------------------------------ app usage

function spark(values: number[]): any {
  const max = Math.max(1, ...values);
  return drawing(Math.max(60, values.length * 3), 20, (cr, w, h, fg, accent) => {
    const step = w / values.length;
    values.forEach((v, i) => {
      if (v > 0) {
        const bh = Math.max(1.5, (v / max) * h);
        cr.setSourceRGBA(accent[0], accent[1], accent[2], 1);
        cr.rectangle(i * step, h - bh, Math.max(1, step * 0.66), bh);
      } else {
        cr.setSourceRGBA(fg[0], fg[1], fg[2], 0.15);
        cr.rectangle(i * step, h - 1, Math.max(1, step * 0.66), 1);
      }
      cr.fill();
    });
  });
}

export function activityPage(ctx: Ctx, space: Space): any {
  let window: UsageWindow = "30d";
  let kind: (typeof KINDS)[number]["value"] = "all";
  const builtin: Record<string, WebKey> = { inbox: "inbox.title", shortcuts: "sc.title", terminal: "term.title", settings: "settings.title" };
  return detailPage(tw("activity.title"), async (body, reload) => {
    const q = kind === "all" ? "" : `&kind=${kind}`;
    const [rows, devices, labels] = await Promise.all([
      space.client.get(`/api/usage?window=${window}${q}`).then((raw) => listOf<UsageRow>(raw, "usage")),
      // A device report failure must not hide the application report.
      space.client.get(`/api/usage/devices?window=${window}`).then((raw) => listOf<DeviceRow>(raw, "devices"), () => undefined),
      ctx.labels(),
    ]);
    const nameOf = (k: string, key: string) => {
      if (k === "builtin") return builtin[key] ? tw(builtin[key]) : key;
      if (k === "app") return labels.get(key)?.title ?? key;
      const agent = space.catalogue?.agents.find((a) => a.ref === key);
      return agent ? pickText(agent.title, agent.i18n, "title", lang) : key;
    };
    body.append(
      heading(
        tw("activity.title"),
        segmented(ACTIVITY_WINDOWS, window, (w) => (w === "all" ? tw("activity.all") : w), (w) => {
          window = w;
          reload();
        }),
      ),
    );

    const devGroup = new Adw.PreferencesGroup({ title: tw("activity.devices"), description: tw("activity.devicesNote") });
    if (devices === undefined) devGroup.add(row(tw("activity.devicesUnavailable")));
    else if (!devices.length) devGroup.add(row(tw("activity.devicesEmpty")));
    for (const d of devices ?? []) {
      const exp = expander(deviceLabel(d), [`${tw("activity.sessions")} ${d.sessions}`, `${tw("activity.foreground")} ${fmtDuration(d.activeMs, lang)}`, relTime(d.lastAt, lang)].join(" · "), d.deviceId);
      exp.add_row(row(tw("activity.deviceAppsNote")));
      if (!d.apps) exp.add_row(row(tw("activity.deviceAppsUnavailable")));
      else if (!d.apps.length) exp.add_row(row(tw("activity.deviceAppsEmpty")));
      for (const app of d.apps ?? []) exp.add_row(row(nameOf("app", app.key), `${tw("activity.opens")} ${app.opens} · ${tw("activity.foreground")} ${app.activeMs === null ? tw("activity.timeUnmeasured") : fmtDuration(app.activeMs, lang)}`));
      devGroup.add(exp);
    }
    body.append(devGroup);

    body.append(note(tw("activity.note")));
    const kinds = segmented(
      KINDS.map((k) => k.value),
      kind,
      (v) => tw(KINDS.find((k) => k.value === v)!.key),
      (v) => {
        kind = v;
        reload();
      },
    );
    kinds.set_halign(Gtk.Align.START);
    body.append(kinds);
    const range = activityRange(rows, window, Date.now());
    const utcDate = (at: number) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(at);
    const windowLabel = window === "all" ? tw("activity.all") : tw("activity.days", { days: Number.parseInt(window) });
    body.append(note(`${tw("activity.range", { window: windowLabel, start: utcDate(range.start), end: utcDate(range.end) })}${range.first ? ` ${tw("activity.first", { date: utcDate(Date.parse(`${range.first}T00:00:00Z`)) })}` : ""}`));
    const tot = activityTotals(rows);
    const dash = "—";
    body.append(
      cards([
        { value: tot.opens.toLocaleString(), label: tw("activity.opens") },
        { value: tot.timeMs ? fmtDuration(tot.timeMs, lang) : dash, label: tw("activity.time") },
        { value: tot.top ? nameOf(tot.top.kind, tot.top.key) : dash, label: tw("activity.top") },
      ]),
    );
    if (!rows.length) {
      body.append(note(tw("activity.empty")));
      return;
    }
    body.append(
      table(
        [tw("activity.name"), tw("activity.opens"), tw("activity.time"), tw("activity.avg"), tw("activity.last"), tw("activity.trend", { window: windowLabel })],
        rows.map((r) => ({
          cells: [
            nameOf(r.kind, r.key),
            String(r.opens),
            r.activeMs === null ? dash : fmtDuration(r.activeMs, lang),
            r.activeMs !== null && r.sessions ? fmtDuration(r.activeMs / r.sessions, lang) : dash,
            r.lastAt ? relTime(r.lastAt, lang) : dash,
            spark(activityBars(r, range)),
          ],
          tooltip: `${r.kind} · ${r.key}`,
        })),
      ),
    );
  });
}
