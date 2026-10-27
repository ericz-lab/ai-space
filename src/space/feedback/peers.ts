import type { FeedbackSettings } from "./types.ts";

/**
 * Feedback for apps that run on a peer (docs/feedback.md#apps-on-a-peer). An app page asks the space
 * that serves it whether to show the button, so a switch set on the hub has to reach the peer the
 * app runs on. The hub is where the owner sets things: each time its Settings → Feedback is read or
 * saved, every peer gets the hub's choices for its own apps, and the hub shows those apps, their
 * state and their recent feedback.
 */

/** A peer as the hub reaches it: its name and a request to its `/api/peer/...` routes. */
export type PeerLink = {
  name: string;
  request: (path: string, init?: RequestInit & { headers?: Record<string, string> }) => Promise<Response>;
};

export type PeerApp = { app: string; title: string; zh?: string; status: string; enabled: boolean };

/** What a peer's `/api/peer/feedback/settings` answers (its own settings view, without its peers). */
export type PeerSettingsView = {
  settings: FeedbackSettings;
  apps: PeerApp[];
  machines: { value: string; label: string }[];
  models: { value: string }[];
  counts: Record<string, number>;
};

/** One peer on the hub's Settings page. */
export type PeerFeedback = {
  name: string;
  /** Reached, and it has feedback. */
  ok: boolean;
  /** Why not, when not. */
  error?: string;
  /** Its settings match what the hub sent (false: the last push failed). */
  synced: boolean;
  apps: PeerApp[];
  counts: Record<string, number>;
};

export type SettingsPatch = Partial<Omit<FeedbackSettings, "apps">> & { apps: Record<string, "on" | "off" | "default"> };

/**
 * The patch that makes a peer follow the hub: the switches, mode, effort and errors as they are,
 * each of the peer's apps set as the hub sets it (an app the hub has no word on goes back to the
 * default), and the engineer's machine and model only where the peer can use them.
 *
 * "Fix on" is a machine name as the hub sees it. The peer's own name, or the hub ("") when the peer
 * does not know the hub by name, means the app's own machine; another machine is kept when the peer
 * knows it too. A model the peer does not offer leaves the peer's own choice alone.
 */
export function patchForPeer(hub: FeedbackSettings, hubName: string, peer: { name: string; view: PeerSettingsView }): SettingsPatch {
  const { view } = peer;
  const apps: SettingsPatch["apps"] = {};
  for (const a of view.apps) apps[a.app] = hub.apps[a.app] ?? "default";
  const known = new Set(view.machines.map((m) => m.value).filter(Boolean));
  const wanted = hub.machine === "" ? hubName : hub.machine;
  const machine = wanted === peer.name || !known.has(wanted) ? "" : wanted;
  const patch: SettingsPatch = { enabled: hub.enabled, appsDefault: hub.appsDefault, mode: hub.mode, effort: hub.effort, errors: hub.errors, machine, apps };
  if (hub.model === "" || view.models.some((m) => m.value === hub.model)) patch.model = hub.model;
  return patch;
}

/** Whether the peer already holds everything the patch would set. */
export function holds(s: FeedbackSettings, patch: SettingsPatch): boolean {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "apps") continue;
    if (s[k as keyof FeedbackSettings] !== v) return false;
  }
  for (const [app, v] of Object.entries(patch.apps)) if ((s.apps[app] ?? "default") !== v) return false;
  return true;
}

const TIMEOUT_MS = 5_000;

export class PeerFeedbackSync {
  constructor(private readonly opts: { peers: () => PeerLink[]; hubName: string; timeoutMs?: number; log?: (line: string) => void }) {}

  /** Every peer's state, after bringing its settings in line with the hub's. Peers are asked at the same time. */
  async views(hub: FeedbackSettings): Promise<PeerFeedback[]> {
    return Promise.all(this.opts.peers().map((p) => this.one(p, hub)));
  }

  /** The peers' recent feedback, each row marked with its peer; a peer that does not answer adds nothing. */
  async recent(limit: number): Promise<Record<string, unknown>[]> {
    const lists = await Promise.all(
      this.opts.peers().map(async (p) => {
        try {
          const j = await this.call<{ items?: Record<string, unknown>[] }>(p, `/api/peer/feedback?limit=${limit}`);
          return (j.items ?? []).map((i) => ({ ...i, peer: p.name }));
        } catch {
          return [];
        }
      }),
    );
    return lists.flat();
  }

  /** Start a peer's waiting feedback, or fix some of its rows again. */
  async fix(peer: string, body: { app?: string; ids?: number[] }): Promise<{ queued: number }> {
    const p = this.opts.peers().find((x) => x.name === peer);
    if (!p) throw new PeerError(404, `unknown peer: ${peer}`);
    const j = await this.call<{ queued?: number }>(p, "/api/peer/feedback/fix", { method: "POST", body: JSON.stringify(body) });
    return { queued: Number(j.queued ?? 0) };
  }

  private async one(p: PeerLink, hub: FeedbackSettings): Promise<PeerFeedback> {
    const failed = (error: string): PeerFeedback => ({ name: p.name, ok: false, error, synced: false, apps: [], counts: {} });
    let view: PeerSettingsView;
    try {
      view = await this.call<PeerSettingsView>(p, "/api/peer/feedback/settings");
    } catch (e) {
      return failed((e as Error).message);
    }
    const patch = patchForPeer(hub, this.opts.hubName, { name: p.name, view });
    if (!holds(view.settings, patch)) {
      try {
        view = await this.call<PeerSettingsView>(p, "/api/peer/feedback/settings", { method: "PUT", body: JSON.stringify(patch) });
      } catch (e) {
        this.opts.log?.(`[feedback] ${p.name}: settings not sent: ${(e as Error).message}`);
        return { name: p.name, ok: true, error: (e as Error).message, synced: false, apps: view.apps, counts: view.counts ?? {} };
      }
    }
    return { name: p.name, ok: true, synced: holds(view.settings, patch), apps: view.apps, counts: view.counts ?? {} };
  }

  private async call<T>(p: PeerLink, path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await p.request(path, { ...init, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(this.opts.timeoutMs ?? TIMEOUT_MS) });
    } catch (e) {
      throw new PeerError(502, `unreachable: ${String((e as Error).message ?? e).slice(0, 200)}`);
    }
    // A peer on an ai-space without these routes answers 404: say so plainly.
    if (res.status === 404) throw new PeerError(502, "its ai-space has no feedback for a hub yet (upgrade it)");
    const j = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
    if (!res.ok || !j || j.ok === false) throw new PeerError(res.status >= 400 && res.status < 500 ? res.status : 502, j?.error ?? `HTTP ${res.status}`);
    return j;
  }
}

export class PeerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
