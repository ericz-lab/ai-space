/**
 * What a connected Space may do through this one's `/api/peer/*` routes (docs/app-packages.md#peer-scopes).
 * Like an app grant, a scope is granted by the Space that serves: it says what THIS Space lets the other
 * do here, whichever side dialed. A connection grants none by default; `fullTrust` grants every scope,
 * those added in a later version included (the equivalent of a hub holding this Space's `SPACE_HUB_TOKEN`).
 *
 *   panel     the snapshot (apps, services, widgets, agents, capabilities, model info, CLIs), app icons
 *             and colours, agent avatars, widget embeds: what the hub's lists show, nothing that runs
 *   agents    chat turns, runs (list, events, stop, steer, approvals), sessions, watch streams
 *   events    the event mirror and bus calls into this Space's apps (`x-space-caller` names the caller)
 *   model     answers and pictures from the runtimes `SPACE_PEER_MODEL` offers, cancelling them, the
 *             model ledger (usage and calls) and the app-model rows
 *   tasks     scheduled tasks, their runs, the models a task can run on, a task's model
 *   terminal  the terminal's sessions and their sockets, when `SPACE_TERMINAL_ENABLED` is on here
 *   apps      the app API proxy: GET on any spec-1 app's `/api/` and its sockets (one app at a time is
 *             what a connection's app grant is for; this is the legacy peer's every-app proxy)
 *   manage    what changes this Space: uninstalling an app, an app's model override, the feedback
 *             settings and rows, and a feedback fix (which runs the Fix Engineer and deploys here)
 *
 * Every route `/api/peer/*` serves is in `PEER_ROUTES` with exactly one scope; scopes.test.ts walks the
 * route table against it, and a route missing here is refused over a connection.
 *
 * What applies on top of a scope applies over HTTPS too (serve.ts `createPeerServeHandlers`): a route the
 * peer does not serve is 404 (`terminal` without `SPACE_TERMINAL_ENABLED`, `model/run` and `model/image`
 * without `SPACE_PEER_MODEL`), installed packages stay out, and the hub's own rules (`SPACE_AGENT_CALLERS`,
 * its hidden apps) are the hub's.
 */

export const PEER_SCOPES = ["panel", "agents", "events", "model", "tasks", "terminal", "apps", "manage"] as const;
export type PeerScope = (typeof PEER_SCOPES)[number];
export type PeerMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** Every `/api/peer/*` route (as serve.ts names it) with its method and scope. Static paths before parameters of the same length. */
export const PEER_ROUTES: readonly { method: PeerMethod; path: string; scope: PeerScope }[] = [
  { method: "GET", path: "/api/peer/snapshot", scope: "panel" },
  { method: "GET", path: "/api/peer/apps/:app/icon", scope: "panel" },
  { method: "GET", path: "/api/peer/apps/:app/appcolor", scope: "panel" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/avatar", scope: "panel" },
  { method: "GET", path: "/api/peer/widgets/:app/:name/embed", scope: "panel" },

  { method: "GET", path: "/api/peer/agents/runs", scope: "agents" },
  { method: "POST", path: "/api/peer/agents/:app/:agent/chat", scope: "agents" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/sessions", scope: "agents" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/sessions/:sid", scope: "agents" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/runs", scope: "agents" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/runs/:id", scope: "agents" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/runs/:id/events", scope: "agents" },
  { method: "POST", path: "/api/peer/agents/:app/:agent/runs/:id/stop", scope: "agents" },
  { method: "POST", path: "/api/peer/agents/:app/:agent/runs/:id/steer", scope: "agents" },
  { method: "POST", path: "/api/peer/agents/:app/:agent/runs/:id/approvals/:rid", scope: "agents" },
  { method: "GET", path: "/api/peer/agents/:app/:agent/watch", scope: "agents" },

  { method: "GET", path: "/api/peer/events", scope: "events" },
  { method: "POST", path: "/api/peer/call/:app/:capability", scope: "events" },

  { method: "POST", path: "/api/peer/model/run", scope: "model" },
  { method: "POST", path: "/api/peer/model/image", scope: "model" },
  { method: "POST", path: "/api/peer/model/runs/:ref/cancel", scope: "model" },
  { method: "GET", path: "/api/peer/model/usage", scope: "model" },
  { method: "GET", path: "/api/peer/model/calls", scope: "model" },
  { method: "GET", path: "/api/peer/model/apps", scope: "model" },

  { method: "GET", path: "/api/peer/tasks", scope: "tasks" },
  { method: "GET", path: "/api/peer/tasks/models", scope: "tasks" },
  { method: "GET", path: "/api/peer/tasks/:id/runs", scope: "tasks" },
  { method: "PATCH", path: "/api/peer/tasks/:id/model", scope: "tasks" },

  { method: "GET", path: "/api/peer/terminal", scope: "terminal" },
  { method: "POST", path: "/api/peer/terminal/sessions", scope: "terminal" },
  { method: "DELETE", path: "/api/peer/terminal/sessions/:id", scope: "terminal" },
  { method: "GET", path: "/api/peer/terminal/ws", scope: "terminal" },

  { method: "GET", path: "/api/peer/apps/:app/proxy/*", scope: "apps" },

  { method: "DELETE", path: "/api/peer/apps/:app", scope: "manage" },
  { method: "PATCH", path: "/api/peer/apps/:app/model", scope: "manage" },
  { method: "GET", path: "/api/peer/feedback/settings", scope: "manage" },
  { method: "PUT", path: "/api/peer/feedback/settings", scope: "manage" },
  { method: "GET", path: "/api/peer/feedback", scope: "manage" },
  { method: "POST", path: "/api/peer/feedback/fix", scope: "manage" },
];

export type PeerRouteMatch = { method: PeerMethod; path: string; scope: PeerScope; params: Record<string, string> };

const compiled = PEER_ROUTES.map((r) => ({ ...r, parts: r.path.split("/").slice(1) }));

/**
 * The route a request path falls under (its pattern, scope and parameters), as Bun's router would pick it:
 * a segment is `:name` or literal, a trailing `*` takes the rest. Undefined: no `/api/peer/*` route.
 */
export function peerRouteOf(method: string, pathname: string): PeerRouteMatch | undefined {
  if (!pathname.startsWith("/api/peer/") || pathname.includes("//")) return undefined;
  const segs = pathname.split("/").slice(1);
  let best: (PeerRouteMatch & { literal: number }) | undefined;
  for (const r of compiled) {
    if (r.method !== method) continue;
    const params: Record<string, string> = {};
    const wild = r.parts[r.parts.length - 1] === "*";
    const fixed = wild ? r.parts.slice(0, -1) : r.parts;
    if (wild ? segs.length <= fixed.length : segs.length !== fixed.length) continue;
    let ok = true, literal = 0;
    for (let i = 0; i < fixed.length && ok; i++) {
      const p = fixed[i]!, s = segs[i]!;
      if (p.startsWith(":")) {
        let v: string;
        try { v = decodeURIComponent(s); } catch { ok = false; break; }
        if (!v || v.includes("/")) ok = false;
        else params[p.slice(1)] = v;
      } else if (p === s) literal++;
      else ok = false;
    }
    if (ok && (!best || literal > best.literal)) best = { method: r.method, path: r.path, scope: r.scope, params, literal };
  }
  if (!best) return undefined;
  const { literal: _, ...match } = best;
  return match;
}

/** A scope list from outside: known names only, each once, in the table's order. */
export function parseScopes(raw: unknown): PeerScope[] {
  if (!Array.isArray(raw)) throw new Error(`scopes must be a list of ${PEER_SCOPES.join(", ")}`);
  for (const s of raw) if (typeof s !== "string" || !(PEER_SCOPES as readonly string[]).includes(s)) throw new Error(`unknown scope ${JSON.stringify(s)}; scopes are ${PEER_SCOPES.join(", ")}`);
  if (new Set(raw).size !== raw.length) throw new Error("duplicate scope");
  return PEER_SCOPES.filter((s) => raw.includes(s));
}
