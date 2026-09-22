import type { RouterConfig } from "./types.ts";

/**
 * `SPACE_ROUTER*` and `SPACE_DOMAIN` from the environment. A bad value turns
 * the router off with a warning instead of stopping the boot: `setup` runs
 * through the same loader and must still be able to fix the file.
 */

export const DEFAULT_ROUTER_PORT = 8080;

const LABEL = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

export function isHostname(s: string): boolean {
  return DOMAIN_RE.test(s);
}

export function loadRouterConfig(env: Record<string, string | undefined>): { config: RouterConfig; warnings: string[] } {
  const warnings: string[] = [];
  let backend = (env.SPACE_ROUTER?.trim().toLowerCase() || "none") as RouterConfig["backend"];
  if (backend !== "none" && backend !== "caddy") {
    warnings.push(`SPACE_ROUTER=${env.SPACE_ROUTER} is not none or caddy; the router is off`);
    backend = "none";
  }
  let domain = env.SPACE_DOMAIN?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  if (domain && !isHostname(domain)) {
    warnings.push(`SPACE_DOMAIN=${env.SPACE_DOMAIN} is not a domain name (letters, digits, dashes, dots; no scheme); ignored`);
    domain = "";
  }
  if (backend === "caddy" && !domain) {
    warnings.push("SPACE_ROUTER=caddy needs SPACE_DOMAIN (the wildcard's domain); the router is off");
    backend = "none";
  }
  const rawPort = env.SPACE_ROUTER_PORT?.trim();
  let port = rawPort ? Number(rawPort) : DEFAULT_ROUTER_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    warnings.push(`SPACE_ROUTER_PORT=${rawPort} is not a port; using ${DEFAULT_ROUTER_PORT}`);
    port = DEFAULT_ROUTER_PORT;
  }
  let panelHost = env.SPACE_PANEL_HOST?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  if (panelHost && !isHostname(panelHost)) {
    warnings.push(`SPACE_PANEL_HOST=${env.SPACE_PANEL_HOST} is not a hostname; ignored`);
    panelHost = "";
  }
  return { config: { backend, domain, port, panelHost, caddyBin: env.SPACE_ROUTER_CADDY?.trim() || "caddy" }, warnings };
}
