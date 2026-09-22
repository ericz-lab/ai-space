import type { Manifest } from "../scheduler/manifest.ts";
import type { Route, RouteStatus } from "./types.ts";

/**
 * The routing table: which hostname goes to which loopback port. Pure; the
 * registry's manifests in, routes out, sorted by app name with the panel
 * first. What produces no route: an app without a service port, without a
 * `url`, with a loopback `url` (nothing to publish), or archived. A paused
 * app keeps its route.
 */

export type TableOptions = {
  /** The wildcard's domain; empty = every route is `explicit`. */
  domain: string;
  /** Route this hostname to the panel; empty = no panel route. */
  panelHost: string;
  /** The panel's own port. */
  panelPort: number;
};

/** The panel's entry in the table. */
export const PANEL_ROUTE = "space";

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$/;

/** `wildcard` when `host` is exactly one label under `domain`; `explicit` otherwise. */
export function hostStatus(host: string, domain: string): RouteStatus {
  if (!domain || !host.endsWith(`.${domain}`)) return "explicit";
  const label = host.slice(0, -(domain.length + 1));
  return label && !label.includes(".") ? "wildcard" : "explicit";
}

/** The hostname of an app's `url`, lowercased; undefined when there is nothing to route. */
export function routableHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  return !host || LOOPBACK.test(host) ? undefined : host;
}

export function routeTable(manifests: Manifest[], opts: TableOptions): Route[] {
  const routes: Route[] = [];
  const taken = new Set<string>();
  const add = (app: string, host: string, port: number) => {
    const target = `127.0.0.1:${port}`;
    if (taken.has(host)) {
      routes.push({ app, host, target, status: "conflict" });
      return;
    }
    taken.add(host);
    routes.push({ app, host, target, status: hostStatus(host, opts.domain) });
  };
  if (opts.panelHost) add(PANEL_ROUTE, opts.panelHost, opts.panelPort);
  for (const m of [...manifests].sort((a, b) => a.app.localeCompare(b.app))) {
    if (!m.service?.port || m.status === "archived") continue;
    const host = routableHost(m.url);
    if (!host) continue;
    add(m.app, host, m.service.port);
  }
  return routes;
}
