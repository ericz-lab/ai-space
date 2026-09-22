import type { AgentView, AppView, ServiceView } from "../panel/view.ts";
import type { WidgetView } from "../panel/widgets.ts";
import type { AppCapabilities } from "../bus/bus.ts";
import { PeerClient, type PeerClientOptions, type PeerStatus } from "./client.ts";
import type { PeerConfig } from "./config.ts";
import { mergeAgents, mergeApps, mergeServices, mergeWidgets } from "./merge.ts";
import type { PeerStore } from "./store.ts";

/**
 * Every configured peer, in name order, and the merged views the panel lists
 * append after its local entries. Reads never wait on a peer.
 */
export class PeerHub {
  private readonly clients = new Map<string, PeerClient>();

  constructor(configs: PeerConfig[], opts: PeerClientOptions = {}) {
    for (const c of configs) this.clients.set(c.name, new PeerClient(c, opts));
    opts.store?.prune(configs.map((c) => c.name));
  }

  names(): string[] {
    return [...this.clients.keys()];
  }

  get(name: string): PeerClient | undefined {
    return this.clients.get(name);
  }

  start(): void {
    for (const c of this.clients.values()) c.start();
  }

  stop(): void {
    for (const c of this.clients.values()) c.stop();
  }

  refreshAll(): Promise<void> {
    return Promise.all([...this.clients.values()].map((c) => c.refresh())).then(() => undefined);
  }

  status(): PeerStatus[] {
    return [...this.clients.values()].map((c) => c.status());
  }

  apps(hidden: Set<string>): AppView[] {
    return this.collect((c) => mergeApps(c.name, c.snapshot!, hidden, c.health() !== "ok"));
  }

  agents(hidden: Set<string>): AgentView[] {
    return this.collect((c) => mergeAgents(c.name, c.snapshot!, hidden));
  }

  widgets(hidden: Set<string>): WidgetView[] {
    return this.collect((c) => mergeWidgets(c.name, c.snapshot!, hidden, c.health() !== "ok"));
  }

  services(hidden: Set<string>): ServiceView[] {
    return this.collect((c) => mergeServices(c.name, c.snapshot!, hidden, c.health() !== "ok"));
  }

  /** The peers' catalogues, each app under `<peer>/<app>` and marked with its peer. */
  capabilities(): (AppCapabilities & { peer: string })[] {
    return this.collect((c) => c.snapshot!.capabilities.map((a) => ({ ...a, app: `${c.name}/${a.app}`, peer: c.name })));
  }

  /** The peer whose snapshot lists the app as a provider (and of the capability, when given); several = ambiguous, none = undefined. */
  providerOf(app: string, capability?: string): { peer: PeerClient } | { ambiguous: string[] } | undefined {
    const found = [...this.clients.values()].filter((c) => c.provides(app, capability));
    if (!found.length) return undefined;
    if (found.length > 1) return { ambiguous: found.map((c) => c.name) };
    return { peer: found[0]! };
  }

  private collect<T>(fn: (c: PeerClient) => T[]): T[] {
    const out: T[] = [];
    for (const c of this.clients.values()) if (c.snapshot) out.push(...fn(c));
    return out;
  }
}
