import { ago, until } from "./output.ts";
import { type Noun } from "./types.ts";
import { type TaskView, taskRef } from "./common.ts";

/**
 * `space status`: the machine at a glance, composed from six routes the panel
 * already answers from its caches: health, services, tasks, backups, model
 * load and peers. There is no `/api/status`: this is the only reader.
 */

type Services = { services: { app: string; peer?: string; port: number; health: string; status: string }[]; peers: unknown[] };
type Backups = { target: string | null; backups: { app: string; lastOkAt?: number; lastStatus?: string; lastError?: string; stale: boolean; nextRunAt?: number }[] };
type Model = { backend: string; runtimes: { name: string; kind: string; backend: string; default: boolean }[]; maxConcurrency: number; running: number; waiting: number };
type Peers = { peers: { name: string; url: string; health: string; asOf?: string; stale: boolean; apps: number; error?: string }[] };

export const statusNoun: Noun = {
  name: "status",
  summary: "the machine at a glance: health, services, tasks, backups, model load, peers",
  defaultVerb: "show",
  verbs: {
    show: {
      usage: "",
      summary: "one screen",
      run: async (ctx) => {
        const c = await ctx.client();
        const health = await c.get<{ ok: boolean }>("/healthz");
        const [services, tasks, backups, model, peers] = await Promise.all([
          c.get<Services>("/api/services").catch(() => undefined),
          c.get<{ tasks: TaskView[] }>("/api/tasks").catch(() => undefined),
          c.get<Backups>("/api/backups").catch(() => undefined),
          c.get<Model>("/api/model/status").catch(() => undefined),
          c.get<Peers>("/api/peers").catch(() => undefined),
        ]);
        const now = Date.now();
        const failing = (tasks?.tasks ?? []).filter((t) => t.enabled && !t.orphaned && t.state.lastStatus === "error");
        const overdue = (tasks?.tasks ?? []).filter((t) => t.enabled && t.state.nextRunAt && Date.parse(t.state.nextRunAt) < now - 5 * 60_000 && !t.state.runningAt);
        const running = (tasks?.tasks ?? []).filter((t) => t.state.runningAt);
        const down = (services?.services ?? []).filter((s) => s.health === "down");
        const staleBackups = (backups?.backups ?? []).filter((b) => b.stale);
        if (ctx.flags.json) {
          ctx.print.data({ ok: health.ok, url: c.url, services: services?.services ?? [], tasks: { total: tasks?.tasks.length ?? 0, failing, overdue, running }, backups: backups?.backups ?? [], model, peers: peers?.peers ?? [] });
          return 0;
        }
        const p = ctx.print;
        p.line(`ai-space at ${c.url}: ${health.ok ? "ok" : "not ok"}`);
        p.line("");
        const svc = services?.services ?? [];
        p.line(`services  ${svc.length} · ${svc.filter((s) => s.health === "ok").length} up${down.length ? ` · ${down.length} DOWN: ${down.map((s) => (s.peer ? `${s.peer}/${s.app}` : s.app)).join(", ")}` : ""}`);
        const all = tasks?.tasks ?? [];
        p.line(`tasks     ${all.length} · ${all.filter((t) => t.enabled).length} enabled${running.length ? ` · ${running.length} running` : ""}${failing.length ? ` · ${failing.length} FAILING: ${failing.map(taskRef).join(", ")}` : ""}${overdue.length ? ` · ${overdue.length} overdue: ${overdue.map(taskRef).join(", ")}` : ""}`);
        if (backups) {
          const b = backups.backups;
          p.line(`backups   ${backups.target ? `${b.length} apps → ${backups.target}` : "no target (SPACE_BACKUP_URL)"}${staleBackups.length ? ` · ${staleBackups.length} STALE: ${staleBackups.map((x) => x.app).join(", ")}` : b.length ? " · all fresh" : ""}`);
        }
        if (model) p.line(`model     ${model.runtimes.map((r) => `${r.name}${r.default ? "*" : ""}`).join(", ")} · ${model.running} running, ${model.waiting} waiting (cap ${model.maxConcurrency})`);
        if (peers?.peers.length) p.line(`peers     ${peers.peers.map((x) => `${x.name} ${x.health}${x.asOf ? ` (${ago(x.asOf, now)})` : ""}`).join(" · ")}`);
        if (failing.length) {
          p.line("");
          p.table(failing, [
            { title: "failing task", get: taskRef },
            { title: "last run", get: (t) => ago(t.state.lastRunAt, now) },
            { title: "next", get: (t) => until(t.state.nextRunAt, now) },
            { title: "error", get: (t) => (t.state.lastError ?? "").slice(0, 80) },
          ]);
        }
        return 0;
      },
    },
  },
};
