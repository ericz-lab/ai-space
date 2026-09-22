import type { Route } from "./types.ts";

/**
 * The routing table as a Caddyfile. Pure and deterministic, so the file is
 * rewritten only when a route changed. Tabs, as `caddy fmt` writes them.
 *
 * TLS is the edge's job: every site is `http://` on the loopback port, so
 * Caddy never touches 80 or 443 and needs no root on any OS. The admin
 * endpoint is a unix socket in the workspace, which is how `caddy reload`
 * reaches it on Linux and macOS alike. `X-Space-User` hands the app the
 * login the access layer verified; an app should trust it only behind the
 * edge. The hostless site answers whatever arrives through the wildcard
 * and belongs to no app.
 */

export type CaddyfileOptions = {
  /** The loopback port every site listens on. */
  port: number;
  /** The admin unix socket. */
  socket: string;
  /** Directory of the per-app access logs. */
  logDir: string;
};

export const CADDYFILE_HEADER = "# Written by ai-space from its registry; edits are overwritten. See docs/router.md.";

export function renderCaddyfile(routes: Route[], opts: CaddyfileOptions): string {
  const lines: string[] = [
    CADDYFILE_HEADER,
    "{",
    `\tadmin unix/${opts.socket}`,
    "\tauto_https off",
    "\tdefault_bind 127.0.0.1",
    "}",
    "",
  ];
  const active = routes.filter((r) => r.status !== "conflict").sort((a, b) => a.host.localeCompare(b.host));
  for (const r of active) {
    lines.push(
      `# ${r.app}`,
      `http://${r.host}:${opts.port} {`,
      `\treverse_proxy ${r.target} {`,
      "\t\theader_up X-Space-User {header.Cf-Access-Authenticated-User-Email}",
      "\t}",
      "\tlog {",
      `\t\toutput file ${opts.logDir}/${r.app}.log {`,
      "\t\t\troll_size 10MiB",
      "\t\t\troll_keep 3",
      "\t\t}",
      "\t}",
      "}",
      "",
    );
  }
  lines.push(`http://:${opts.port} {`, '\trespond "no such app" 404', "}", "");
  return lines.join("\n");
}
