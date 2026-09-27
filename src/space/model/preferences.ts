import type { Database } from "bun:sqlite";
import type { RuntimeRegistry } from "../runtimes/registry.ts";

/** Workspace-wide model preference, shared by app calls and new Base chats. */
export class ModelPreferences {
  constructor(private readonly db: Database, private readonly runtimes: RuntimeRegistry) {
    db.exec("CREATE TABLE IF NOT EXISTS model_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  }

  options() {
    return this.runtimes.tierOptions().filter((o) => {
      const kind = this.runtimes.get(o.runtime)?.kind;
      return (kind === "claude-code" || kind === "codex-cli") && o.capabilities.complete && o.capabilities.chat;
    });
  }

  read(): string | undefined {
    return this.db.query<{ value: string }, []>("SELECT value FROM model_preferences WHERE key = 'default'").get()?.value;
  }

  update(value: unknown) {
    if (value === null) {
      this.db.query("DELETE FROM model_preferences WHERE key = 'default'").run();
      return;
    }
    if (typeof value !== "string" || !this.options().some((o) => o.value === value)) throw new Error("select a configured Codex or Claude model tier");
    this.db.query("INSERT INTO model_preferences (key, value) VALUES ('default', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(value);
  }
}

/** Like other panel preferences, these routes use the panel's access boundary. */
export function createModelPreferenceRoutes(preferences: ModelPreferences, defaults: { model: string; base: string }) {
  const view = () => ({ ok: true, defaultModel: preferences.read() ?? null, appDefault: preferences.read() ?? defaults.model, baseDefault: preferences.read() ?? defaults.base, options: preferences.options() });
  return {
    "/api/model/preferences": {
      GET: () => Response.json(view(), { headers: { "cache-control": "no-store" } }),
      PUT: async (req: Request) => {
        try {
          const body = await req.json();
          preferences.update(body?.defaultModel);
          return Response.json(view(), { headers: { "cache-control": "no-store" } });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
        }
      },
    },
  };
}
