/**
 * The Cloudflare side of a space, in one place (docs/cloudflare.md).
 *
 * ai-space never calls Cloudflare's API while it runs. The edge objects a space
 * needs (a remotely managed tunnel, its ingress, the proxied DNS records, the
 * Access applications in front, an R2 bucket, a service token for a hub) are
 * created once, at install, by the operator. This module is the single list of
 * those objects and of the `cf` CLI commands that create them, so `setup`, the
 * install docs and an installing agent all use the same commands.
 *
 * Only `cf` commands verified against the published CLI (npm `cf`, 1.0.0-beta)
 * appear here. The tunnel's connector stays `cloudflared` under systemd; the
 * blob store stays Bun's `S3Client` against R2's S3 endpoint.
 */

/** What the edge should look like for one machine. */
export type EdgePlan = {
  /** Tunnel name; one tunnel per machine. */
  machine: string;
  /** The zone the hostnames live in, e.g. `example.com`. */
  zone: string;
  /** The panel's hostname, e.g. `space.example.com`. */
  panelHost: string;
  panelPort: number;
  /** With the router on: `*.<zone>` goes to Caddy on this port (docs/router.md). */
  routerPort?: number;
  /** Who the Access applications allow. */
  email: string;
  /** An R2 bucket to create for blobs and backups. */
  bucket?: string;
  /** Name of an Access service token for a hub that reaches this space (docs/peers.md). */
  peerToken?: string;
};

export type CfCommand = {
  /** What the command does, one line. */
  step: string;
  argv: string[];
  /** What to do with the output, when anything. */
  note?: string;
};

/** Placeholder for the id `cf tunnels create` answers; the rendered script uses the shell variable. */
export const TUNNEL_ID = "$TUNNEL_ID";
/** Placeholder for the zone id `cf zones list` answers. cf's generated commands take it from `-z`. */
export const ZONE_ID = "$ZONE_ID";
const VARS = [TUNNEL_ID, ZONE_ID];

/** The hostnames the tunnel serves, in rule order (the panel first, so it wins over the wildcard). */
export function edgeHosts(plan: EdgePlan): { host: string; service: string }[] {
  const hosts = [{ host: plan.panelHost, service: `http://127.0.0.1:${plan.panelPort}` }];
  if (plan.routerPort) hosts.push({ host: `*.${plan.zone}`, service: `http://127.0.0.1:${plan.routerPort}` });
  return hosts;
}

/** Body of `cf tunnels config update`: one rule per hostname and the catch-all the API requires last. */
export function tunnelIngress(plan: EdgePlan): { config: { ingress: ({ hostname: string; service: string } | { service: string })[] } } {
  return { config: { ingress: [...edgeHosts(plan).map((h) => ({ hostname: h.host, service: h.service })), { service: "http_status:404" }] } };
}

/** Body of `cf zero-trust access applications create`: self-hosted, one allow policy on the operator's email. */
export function accessApplication(host: string, email: string) {
  return {
    type: "self_hosted",
    name: host,
    domain: host,
    session_duration: "24h",
    policies: [{ name: "owner", decision: "allow", include: [{ email: { email } }] }],
  };
}

/** Body of `cf dns records create`: the proxied CNAME a hostname needs to reach the tunnel. */
export function tunnelRecord(host: string, tunnelId: string = TUNNEL_ID) {
  return { type: "CNAME", name: host, content: `${tunnelId}.cfargotunnel.com`, proxied: true };
}

/**
 * Every command that brings a machine's edge up, in order. Access comes before
 * the hostnames exist, so the panel is never reachable without a login.
 */
export function cfCommands(plan: EdgePlan): CfCommand[] {
  const hosts = edgeHosts(plan);
  const out: CfCommand[] = [
    { step: "log in (browser; or export CLOUDFLARE_API_TOKEN)", argv: ["cf", "auth", "login"] },
    { step: "find the account id", argv: ["cf", "accounts", "list"], note: "export CLOUDFLARE_ACCOUNT_ID=<id>" },
    { step: "find the zone id", argv: ["cf", "zones", "list", "--name", plan.zone], note: "export ZONE_ID=<id>" },
    { step: "create the tunnel, managed from Cloudflare", argv: ["cf", "tunnels", "create", "--name", plan.machine, "--config-src", "cloudflare"], note: "export TUNNEL_ID=<id>" },
  ];
  for (const h of hosts) {
    out.push({ step: `Access in front of ${h.host}`, argv: ["cf", "zero-trust", "access", "applications", "create", "--body", JSON.stringify(accessApplication(h.host, plan.email))] });
  }
  out.push({ step: "the tunnel's hostnames", argv: ["cf", "tunnels", "config", "update", TUNNEL_ID, "--body", JSON.stringify(tunnelIngress(plan))] });
  for (const h of hosts) {
    out.push({ step: `DNS for ${h.host}`, argv: ["cf", "dns", "records", "create", "-z", ZONE_ID, "--body", JSON.stringify(tunnelRecord(h.host))] });
  }
  out.push({
    step: "the connector's token",
    argv: ["cf", "tunnels", "token", "get", TUNNEL_ID],
    note: "TUNNEL_TOKEN=<token> in ~/.cloudflared/env (mode 600) on the machine; cloudflared's unit reads it",
  });
  if (plan.bucket) {
    out.push({
      step: "the R2 bucket",
      argv: ["cf", "r2", "buckets", "create", "--name", plan.bucket],
      note: `S3 keys: dashboard, R2 → Manage R2 API Tokens (Object Read & Write on ${plan.bucket}); endpoint https://$CLOUDFLARE_ACCOUNT_ID.r2.cloudflarestorage.com`,
    });
  }
  if (plan.peerToken) {
    out.push({
      step: "a service token for the hub",
      argv: ["cf", "zero-trust", "access", "service-tokens", "create", "--name", plan.peerToken, "--duration", "forever"],
      note: "client_id and client_secret go into the hub's SPACE_PEER_<NAME>_HEADERS; add a Service Auth policy for it on the panel's Access application",
    });
  }
  return out;
}

/** One argument for a POSIX shell; `$TUNNEL_ID` and `$ZONE_ID` stay expandable. */
export function shellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(VARS.reduce((a, v) => a.replaceAll(v, "x"), arg))) return arg;
  if (VARS.some((v) => arg.includes(v))) return `"${arg.replace(/(["\\`])/g, "\\$1")}"`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The commands as a commented shell script, one command per step. */
export function renderCfScript(cmds: CfCommand[]): string[] {
  const lines: string[] = [];
  for (const c of cmds) {
    lines.push(`# ${c.step}`);
    lines.push(c.argv.map(shellArg).join(" "));
    if (c.note) lines.push(`#   → ${c.note}`);
  }
  return lines;
}

/** `cf auth whoami` prints JSON and exits 0 either way; this reads whether the login works. */
export function parseWhoami(stdout: string): { ok: boolean; detail: string } {
  try {
    const j = JSON.parse(stdout) as { authenticated?: boolean; tokenValid?: boolean; authSource?: string; error?: string };
    if (!j.authenticated) return { ok: false, detail: j.error ?? "not logged in" };
    if (j.tokenValid === false) return { ok: false, detail: "credentials rejected" };
    return { ok: true, detail: j.authSource ? `logged in (${j.authSource})` : "logged in" };
  } catch {
    return { ok: false, detail: "unreadable `cf auth whoami` output" };
  }
}
