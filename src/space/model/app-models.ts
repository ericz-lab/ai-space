import type { Database } from "bun:sqlite";
import { MODEL_TIERS } from "../runtimes/types.ts";
import { sameOrigin } from "../terminal/api.ts";
import { APP_PATTERN, MODEL_PATTERN, TAG_PATTERN } from "./types.ts";

/**
 * Which model an app's call runs on when the request names none (docs/model.md#app-models).
 * Layers, first match wins:
 *
 *   request           the body's `model` (an app's explicit choice, or a task's x-space-model)
 *   choice            (chat only) the person's pick in the chat widget, above even the request
 *   override-tag      the panel's override for this app and tag
 *   override-app      the panel's override for this app
 *   manifest-tag      `model.tags.<tag>` in the app's space.yaml
 *   manifest-default  `model.default` in the app's space.yaml
 *   default           the space's default model (Settings, else SPACE_MODEL_DEFAULT)
 *
 * A layer whose model this space cannot run (a runtime or tier it lacks) is
 * skipped, so a manifest written for another machine falls through to the next
 * layer instead of failing the call. A bare tier in the manifest (`intermediate`)
 * runs on the runtime of the space's default, so one manifest fits a space that
 * runs on Codex and one that runs on Claude.
 */

export type AppModelSpec = { default?: string; tags: Record<string, string> };
export type ModelSource = "request" | "choice" | "override-tag" | "override-app" | "manifest-tag" | "manifest-default" | "default";
export type ResolvedModel = { model: string; source: ModelSource };

/**
 *   model:
 *     default: junior                # tier, runtime/tier or model id; default: the space's default
 *     tags:                          # per purpose, keyed by the `tag` the app sends
 *       translate: basic
 *       curate: codex/intermediate
 */
export function parseAppModelSpec(raw: unknown): AppModelSpec {
  if (typeof raw === "string") return { default: parseModel(raw, "model"), tags: {} };
  if (!isRecord(raw)) throw new Error("model must be a model name or a mapping with default / tags");
  for (const key of Object.keys(raw)) if (key !== "default" && key !== "tags") throw new Error(`model: unknown key "${key}"`);
  const spec: AppModelSpec = { tags: {} };
  if (raw.default !== undefined) spec.default = parseModel(raw.default, "model.default");
  if (raw.tags !== undefined) {
    if (!isRecord(raw.tags)) throw new Error("model.tags must map tags to models");
    for (const [tag, value] of Object.entries(raw.tags)) {
      if (!TAG_PATTERN.test(tag)) throw new Error(`model.tags: invalid tag "${tag}"`);
      spec.tags[tag] = parseModel(value, `model.tags.${tag}`);
    }
  }
  return spec;
}

function parseModel(v: unknown, where: string): string {
  if (typeof v !== "string" || !MODEL_PATTERN.test(v.trim())) throw new Error(`${where} must be a model tier, runtime/tier or model id`);
  return v.trim();
}

export type AppModelsOptions = {
  /** The app's parsed `model:` section, from the registry. */
  manifest: (app: string) => AppModelSpec | undefined;
  /** The space's default model, as the Settings preference or the environment names it. */
  fallback: () => string;
  /** Whether this space can run a model value; a layer that fails is skipped. */
  runnable: (model: string) => boolean;
  /** What the panel may pick: the configured runtime/tier values. */
  options: () => { value: string }[];
};

type OverrideRow = { app: string; tag: string; model: string };

export class AppModels {
  constructor(private readonly db: Database, private readonly opts: AppModelsOptions) {
    // tag '' is the app-wide override; the primary key keeps one row per app and tag.
    db.exec("CREATE TABLE IF NOT EXISTS model_overrides (app TEXT NOT NULL, tag TEXT NOT NULL, model TEXT NOT NULL, PRIMARY KEY (app, tag))");
  }

  /** The model for a call of `app` with `tag` that names none itself. Without a tag only the app-wide layers apply. */
  resolve(app: string, tag?: string): ResolvedModel {
    for (const layer of this.layers(app, tag)) if (layer.model && this.opts.runnable(layer.model)) return { model: layer.model, source: layer.source };
    return { model: this.opts.fallback(), source: "default" };
  }

  private layers(app: string, tag: string | undefined): { model: string | undefined; source: ModelSource }[] {
    const over = this.overrides(app);
    const spec = this.opts.manifest(app);
    return [
      { model: tag === undefined ? undefined : over.tags[tag], source: "override-tag" },
      { model: over.app, source: "override-app" },
      { model: tag === undefined ? undefined : this.qualify(spec?.tags[tag]), source: "manifest-tag" },
      { model: this.qualify(spec?.default), source: "manifest-default" },
    ];
  }

  /** A bare tier runs on the runtime of the space's default. */
  qualify(model: string | undefined): string | undefined {
    if (!model || model.includes("/") || !(MODEL_TIERS as readonly string[]).includes(model)) return model;
    const fallback = this.opts.fallback();
    const slash = fallback.indexOf("/");
    return slash < 0 ? model : `${fallback.slice(0, slash)}/${model}`;
  }

  overrides(app: string): { app?: string; tags: Record<string, string> } {
    const rows = this.db.query<OverrideRow, [string]>("SELECT app, tag, model FROM model_overrides WHERE app = ? ORDER BY tag").all(app);
    const out: { app?: string; tags: Record<string, string> } = { tags: {} };
    for (const r of rows) {
      if (r.tag === "") out.app = r.model;
      else out.tags[r.tag] = r.model;
    }
    return out;
  }

  /** The values an override may take. */
  options(): { value: string }[] {
    return this.opts.options();
  }

  /** Set or clear (model null) the override for an app, or for one of its tags. */
  setOverride(app: string, tag: string | null, model: string | null): void {
    if (!APP_PATTERN.test(app)) throw new Error("invalid app");
    if (tag !== null && !TAG_PATTERN.test(tag)) throw new Error("tag must match [a-z0-9][a-z0-9._-]{0,63}");
    if (model === null) {
      this.db.query("DELETE FROM model_overrides WHERE app = ? AND tag = ?").run(app, tag ?? "");
      return;
    }
    if (!this.options().some((o) => o.value === model)) throw new Error("select a configured runtime/tier");
    this.db.query("INSERT INTO model_overrides (app, tag, model) VALUES (?, ?, ?) ON CONFLICT(app, tag) DO UPDATE SET model = excluded.model").run(app, tag ?? "", model);
  }

  /** What the panel shows for one app: the declared and overridden values, and what each tag runs on now. */
  view(app: string, seenTags: string[] = []) {
    const spec = this.opts.manifest(app);
    const over = this.overrides(app);
    const tags = [...new Set([...Object.keys(spec?.tags ?? {}), ...Object.keys(over.tags), ...seenTags])].sort();
    const row = (tag: string | null) => ({
      tag,
      manifest: tag === null ? spec?.default : spec?.tags[tag],
      override: tag === null ? over.app : over.tags[tag],
      ...this.resolve(app, tag ?? undefined),
    });
    return { app, rows: [row(null), ...tags.map(row)] };
  }
}

export type AppModelRoutesOptions = {
  appModels: AppModels;
  /** Registered app names; overrides are only kept for apps the space knows. */
  apps: () => string[];
  /** Tags the app used recently, from the ledger, so a tag without a declaration can be overridden too. */
  seenTags: (app: string) => string[];
};

/**
 * GET   /api/model/apps                   every app's rows (see `view`) and the values the panel may pick
 * GET   /api/apps/:app/model              one app's rows
 * PATCH /api/panel/apps/:app/model        {tag?, model} sets, {tag?, model: null} clears; same-origin browser requests only, like the task model route
 */
export function createAppModelRoutes(opts: AppModelRoutesOptions) {
  const { appModels } = opts;
  const known = (app: string) => opts.apps().includes(app);
  const view = (app: string) => appModels.view(app, opts.seenTags(app));
  return {
    "/api/model/apps": {
      GET: () => json({ ok: true, apps: opts.apps().sort().map(view), options: appModels.options() }),
    },
    "/api/apps/:app/model": {
      GET: (req: Request & { params: Record<string, string> }) => (known(req.params.app!) ? json({ ok: true, ...view(req.params.app!) }) : error(404, "unknown app")),
    },
    "/api/panel/apps/:app/model": {
      PATCH: async (req: Request & { params: Record<string, string> }) => {
        if (!req.headers.get("origin") || !sameOrigin(req)) return error(403, "same-origin browser request required");
        if (req.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return error(415, "application/json required");
        const app = req.params.app!;
        if (!known(app)) return error(404, "unknown app");
        try {
          const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
          if (!isRecord(body) || !("model" in body) || Object.keys(body).some((k) => k !== "model" && k !== "tag")) throw new Error("body must be {tag?, model}");
          const tag = body.tag === undefined || body.tag === null ? null : body.tag;
          if (tag !== null && typeof tag !== "string") throw new Error("tag must be a string");
          if (body.model !== null && typeof body.model !== "string") throw new Error("model must be a string or null");
          appModels.setOverride(app, tag, body.model as string | null);
          return json({ ok: true, ...view(app) });
        } catch (e) {
          return error(400, (e as Error).message);
        }
      },
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function error(status: number, message: string): Response {
  return json({ ok: false, error: message }, status);
}
