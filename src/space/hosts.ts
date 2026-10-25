import type { Policy } from "./auth/gate.ts";

/**
 * Which `Host` names the Space API answers (docs/auth.md#host-names).
 *
 * The same-origin check (src/space/auth.ts) compares `Origin` with `Host`, and with no
 * `SPACE_API_TOKEN` a request without a token is the operator. A page on another site whose
 * name its owner points at 127.0.0.1 (DNS rebinding) passes both: its `Origin` and `Host` are
 * its own name. So a request for a name this space does not know is refused unless it carries
 * a credential this space issued. Known names:
 *
 * - an IP address, `localhost` and `*.localhost` (a rebinding page always sends its own name);
 * - the panel's hostname (`SPACE_PANEL_HOST`), the router's domain and its subdomains (`SPACE_DOMAIN`);
 * - each entry of `SPACE_ALLOWED_HOSTS` (comma or space separated; `*.example.com` covers subdomains).
 *
 * Routes whose policy is `public` or `self` are not checked: they need no secret, or check their own.
 */

export type HostRules = { exact: Set<string>; suffixes: string[] };

/** The rules from the panel host, the router's domain and `SPACE_ALLOWED_HOSTS`. */
export function hostRules(opts: { panelHost?: string; domain?: string; allowed?: string }): HostRules {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
  if (opts.panelHost) exact.add(norm(opts.panelHost));
  if (opts.domain) {
    exact.add(norm(opts.domain));
    suffixes.push(`.${norm(opts.domain)}`);
  }
  for (const raw of (opts.allowed ?? "").split(/[\s,]+/)) {
    const entry = norm(raw);
    if (!entry) continue;
    if (entry.startsWith("*.")) suffixes.push(entry.slice(1));
    else exact.add(entry);
  }
  return { exact, suffixes };
}

/** The name in a `Host` header, without the port, lowercased; IPv6 keeps its brackets. */
export function hostName(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d*$/, "").replace(/\.$/, "");
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** True for a known name; a request with no `Host` (not a browser) passes. */
export function hostAllowed(header: string | null, rules: HostRules): boolean {
  if (!header) return true;
  const name = hostName(header);
  if (!name) return true;
  if (IPV4.test(name) || name.startsWith("[")) return true;
  if (name === "localhost" || name.endsWith(".localhost")) return true;
  return rules.exact.has(name) || rules.suffixes.some((s) => name.endsWith(s));
}

export type HostGuardOptions = {
  rules: HostRules;
  /** True when the request carries a credential this space issued (operator, hub, app, device, consumer). */
  hasCredential: (req: Request) => Promise<boolean>;
  log?: (line: string) => void;
};

type AnyHandler = (req: any, server: any) => unknown;

/** Wraps every handler whose policy is not `public` or `self` with the host check; static routes pass through. */
export function guardHosts<T extends Record<string, unknown>>(routes: T, policies: Map<string, Policy>, opts: HostGuardOptions): T {
  const logged = new Set<string>();
  const refuse = (name: string) => {
    if (!logged.has(name)) {
      logged.add(name);
      opts.log?.(`[auth] refused a request for host "${name}" without a credential; add it to SPACE_ALLOWED_HOSTS if it is this space's name`);
    }
    return new Response(JSON.stringify({ ok: false, error: `host "${name}" is not one of this space's names (SPACE_ALLOWED_HOSTS)` }), { status: 421, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  };
  const guard = (h: AnyHandler): AnyHandler => async (req: Request, server: unknown) => {
    const host = req.headers.get("host");
    if (hostAllowed(host, opts.rules) || (await opts.hasCredential(req))) return h(req, server);
    return refuse(hostName(host ?? ""));
  };
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(routes)) {
    const policy = policies.get(path) ?? "owner";
    if (policy === "public" || policy === "self") out[path] = value;
    else if (typeof value === "function") out[path] = guard(value as AnyHandler);
    else if (value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every((k) => /^[A-Z]+$/.test(k))) {
      out[path] = Object.fromEntries(Object.entries(value).map(([m, h]) => [m, typeof h === "function" ? guard(h as AnyHandler) : h]));
    } else out[path] = value;
  }
  return out as T;
}
