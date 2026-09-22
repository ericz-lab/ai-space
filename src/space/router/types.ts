/**
 * The router (docs/router.md): one wildcard rule on the tunnel sends every
 * hostname to a reverse proxy on loopback, and ai-space writes that proxy's
 * configuration from the registry. These are the shapes the module shares.
 */

export type RouterBackend = "none" | "caddy";

export type RouterConfig = {
  /** `SPACE_ROUTER`: `none` renders nothing (the default); `caddy` keeps `run/Caddyfile` in step with the registry. */
  backend: RouterBackend;
  /** `SPACE_DOMAIN`: the wildcard's domain; a path `url` in a manifest resolves under it. Empty = unset. */
  domain: string;
  /** `SPACE_ROUTER_PORT`: the loopback port the proxy binds; the wildcard tunnel rule's target. */
  port: number;
  /** `SPACE_PANEL_HOST`: route this hostname to the panel too. Empty = the panel keeps its own tunnel rule. */
  panelHost: string;
  /** `SPACE_ROUTER_CADDY`: the caddy binary. */
  caddyBin: string;
};

/**
 * `wildcard`: one label under the domain, reachable through the wildcard rule.
 * `explicit`: any other hostname; it needs its own tunnel rule to arrive here.
 * `conflict`: another app (earlier by name) already has this hostname; not rendered.
 */
export type RouteStatus = "wildcard" | "explicit" | "conflict";

export type Route = {
  /** App name, or `space` for the panel. */
  app: string;
  /** Lowercased hostname of the app's resolved `url`. */
  host: string;
  /** `127.0.0.1:<port>`. */
  target: string;
  status: RouteStatus;
};

export type SyncResult = {
  /** ISO time of the attempt. */
  at: string;
  ok: boolean;
  /** True when the file on disk was rewritten. */
  changed: boolean;
  error?: string;
};

export type RouterStatus = {
  router: RouterBackend;
  domain: string;
  port: number;
  /** Where the configuration is written. */
  file: string;
  routes: Route[];
  lastSync?: SyncResult;
};
