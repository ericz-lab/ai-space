# Cloudflare: what a space uses and how it is managed

Status: in use. Every Cloudflare object a space depends on is listed here, with the tool that manages it. Changes to those objects go through the `cf` CLI; the tunnel's connector stays `cloudflared`, app traffic stays on Caddy, and blob data stays on Bun's `S3Client`. Why a tunnel at all is in [ingress.md](ingress.md); the install steps are in [install.md](install.md) steps 5 to 7.

## Inventory

ai-space itself never calls Cloudflare's API. It spawns no Cloudflare tool at runtime except the checks in `setup`, and it reads R2 only through the S3 protocol. Everything else is set up once, at install, by the operator.

| Operation | Where in ai-space | Before | Now | Decision |
| --- | --- | --- | --- | --- |
| Create a tunnel, get its token | install.md step 5, install-by-agent phase 6 | Zero Trust dashboard, or `cloudflared tunnel login/create` | `cf tunnels create --config-src cloudflare`, `cf tunnels token get` | migrated |
| Tunnel ingress (panel, wildcard to Caddy, per-app hostnames) | install.md step 5, [router.md](router.md) | dashboard Public Hostnames, or `config.yml` | `cf tunnels config update <id> --body …` | migrated |
| DNS: proxied CNAME to `<id>.cfargotunnel.com`, the wildcard `*` | install.md step 5 | dashboard (created by a hostname, by hand for the wildcard), or `cloudflared tunnel route dns` | `cf dns records create -z <zone-id> --body …` | migrated |
| Access application and allow policy on the panel and `*.<domain>` | install.md step 6 | dashboard | `cf zero-trust access applications create --body …` | migrated |
| Access service token for a hub (`SPACE_PEER_<NAME>_HEADERS`) | install.md steps 6 and 9, `setup` peers | dashboard | `cf zero-trust access service-tokens create` | migrated |
| R2 bucket | install.md step 7 | dashboard | `cf r2 buckets create --name …` | migrated |
| R2 S3 keys (`SPACE_S3_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`) | install.md step 7, `setup` blob store | dashboard, R2 API Tokens | dashboard, unchanged | kept: cf only offers short-lived `r2 temporary-credentials`; a space needs a long-lived bucket-scoped key |
| The tunnel's connector (the running process) | `cloudflared` unit, `setup` check | `cloudflared tunnel run` under systemd | the same | kept: `cf tunnels run` wraps a cf-managed `cloudflared` and needs Node 22 in the unit's path, with no gain |
| Reading and writing blobs, backups | `src/space/storage/`, `src/space/storage/backup/target.ts` | Bun `S3Client` against `https://<account>.r2.cloudflarestorage.com` | the same | kept |
| Routing a hostname to an app | `src/space/router/` | Caddy on loopback, config written by ai-space | the same | kept |
| Who is logged in (`X-Space-User` from `Cf-Access-Authenticated-User-Email`) | `src/space/router/caddyfile.ts` | header set by the edge | the same | kept |
| Workers, Pages, KV, D1 (Wrangler's domain) | nowhere | not used | not used | none: no app or script in ai-space or on the deployed machine uses Wrangler |

The single list of these objects in code is `src/space/cloudflare.ts`: the ingress, DNS and Access bodies, and the `cf` commands that create them, in order. `setup` prints them for the machine it runs on; this page and install.md show the same commands.

## The cf CLI

`cf` is Cloudflare's unified CLI, generated from its public OpenAPI (npm package `cf`, open beta, 1.0.0-beta.5 when this was written; the successor to Wrangler). The commands used here were checked against that release with `--help` and `--dry-run`; they create objects through the documented API endpoints (`/cfd_tunnel`, `/cfd_tunnel/<id>/configurations`, `/zones/<id>/dns_records`, `/access/apps`, `/access/service_tokens`, `/r2/buckets`).

- **Install**: `bun add -g cf` (or `npm install -g cf`). The binary's shebang is `node` and it requires Node.js 22 or newer; it also runs under Bun (`bunx --bun cf …`, checked with help, schema, dry-run and `auth whoami`).
- **Login**: `cf auth login` (OAuth in a browser, device flow by default) or `CLOUDFLARE_API_TOKEN`. `cf auth whoami` prints JSON and exits 0 either way; `setup` reads it.
- **Where to run it**: anywhere the operator is logged in, the laptop included. The server needs only the tunnel token. `setup` treats `cf` as optional for that reason.
- **Account and zone**: account-scoped commands read `CLOUDFLARE_ACCOUNT_ID`; zone-scoped commands take `-z <zone-id>` (a dry run shows the environment variable is not applied to zone paths, so the id is passed explicitly).
- **Output** is JSON on stdout; note the `id` from `tunnels create` and `zones list`.

## Bringing a machine's edge up

For `space.example.com` and a router on `*.example.com` (drop the wildcard lines without the router). `setup` prints the same list with this machine's values when `SPACE_DOMAIN` or `SPACE_PANEL_HOST` is set and no tunnel runs yet.

```bash
cf auth login
cf accounts list                                  # export CLOUDFLARE_ACCOUNT_ID=<id>
cf zones list --name example.com                  # export ZONE_ID=<id>
cf tunnels create --name box --config-src cloudflare   # export TUNNEL_ID=<id>

# Access first, so no hostname is ever reachable without a login
cf zero-trust access applications create --body '{"type":"self_hosted","name":"space.example.com","domain":"space.example.com","session_duration":"24h","policies":[{"name":"owner","decision":"allow","include":[{"email":{"email":"you@example.com"}}]}]}'
cf zero-trust access applications create --body '{"type":"self_hosted","name":"*.example.com","domain":"*.example.com","session_duration":"24h","policies":[{"name":"owner","decision":"allow","include":[{"email":{"email":"you@example.com"}}]}]}'

# the hostnames, then their DNS
cf tunnels config update $TUNNEL_ID --body '{"config":{"ingress":[{"hostname":"space.example.com","service":"http://127.0.0.1:8700"},{"hostname":"*.example.com","service":"http://127.0.0.1:8080"},{"service":"http_status:404"}]}}'
cf dns records create -z $ZONE_ID --body "{\"type\":\"CNAME\",\"name\":\"space.example.com\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}"
cf dns records create -z $ZONE_ID --body "{\"type\":\"CNAME\",\"name\":\"*.example.com\",\"content\":\"$TUNNEL_ID.cfargotunnel.com\",\"proxied\":true}"

# the connector's token: TUNNEL_TOKEN=<token> in ~/.cloudflared/env on the machine (mode 600)
cf tunnels token get $TUNNEL_ID
```

Then install `cloudflared` and its unit as in install.md step 5. Optional, later:

```bash
cf r2 buckets create --name space-box                                # step 7; the S3 keys still come from the dashboard
cf zero-trust access service-tokens create --name hub --duration forever   # step 9; client_id/secret into the hub's SPACE_PEER_<NAME>_HEADERS
```

`cf tunnels config update` replaces the whole ingress list: read it first with `cf tunnels config get $TUNNEL_ID`, add the rule, write it back. The same holds for any later change to a tunnel that already serves hostnames.

## Existing installs

Nothing has to change on a machine whose tunnel runs: the dashboard-made tunnel, its DNS and its Access applications are the same objects `cf` manages, and `cf tunnels list`, `cf tunnels config get`, `cf dns records list -z <zone-id>` and `cf zero-trust access applications list` read them. The Seoul machine at the time of writing:

- `cloudflared` 2026.9.3 at `/usr/local/bin`, run as a **system** unit made by `cloudflared service install` (with a daily `cloudflared-update` timer), not the user unit of install.md. `setup` accepts either.
- Caddy as the user unit `caddy.service` (the router).
- R2 through `SPACE_S3_*` in the workspace `.env`.
- No `wrangler`, no `cf`, no `~/.cloudflared` directory; nothing on the machine calls Wrangler.

A system unit made by `cloudflared service install` carries the token on its `ExecStart` line in `/etc/systemd/system/cloudflared.service`, which is world-readable. Moving the token into an `EnvironmentFile` with mode 600 (as the user unit of install.md does) closes that; it is an operator change on the machine and was not made from here.

## Feishu login

Feishu's legacy OAuth authorization and token endpoints are not a complete OIDC
provider. In particular, `/suite/passport/oauth/certs` returns 404. Pointing
Access's generic OIDC connector directly at these endpoints allows the login
page to open but cannot supply a verifiable identity token (issue #11).

`deploy/feishu-oidc/worker.ts` is a narrow bridge for Access's confidential
authorization-code flow. Its `/authorize` redirects to Feishu's current
`accounts.feishu.cn/open-apis/authen/v1/authorize` endpoint with the Access
callback and state unchanged. It translates OIDC scopes into the actual
`contact:user.base:readonly contact:user.email:readonly` permissions; the app
must have both user-token scopes published. `/token`
accepts client authentication by HTTP Basic or form fields, exchanges the code
at `/open-apis/authen/v2/oauth/token` using JSON, and reads the authenticated
`/open-apis/authen/v1/user_info` response's `data` object. The old Passport
`/userinfo` endpoint is deprecated and may omit the required email even when
the app has the user-token email scope. Only then does the bridge sign
an RS256 identity token, with the original client ID as audience and a five-minute
lifetime. `/jwks` exposes only the public signing key. JWT `iat` and `exp` use
the protocol's epoch seconds; internal clocks use epoch milliseconds.

Only one configured client ID and exact callback are accepted. The bridge does
not store identities, client secrets or upstream tokens. Feishu validates the
client secret and consumes the code; Access owns state/CSRF validation. Tokens
and user profiles are never logged. A missing or explicitly unverified email
fails closed: the bridge does not invent an email or relax Access policies.
There is no refresh flow or userinfo API for downstream clients. Nonce, PKCE,
implicit and other OIDC flows are rejected, not silently weakened. This bridge
is specifically for the observed Access flow, not a general-purpose OIDC IdP.

Deploy it separately from Space. No Space restart or new package dependency is
needed. Use an account with Workers deployment and Access identity-provider
permissions, with either `CLOUDFLARE_API_TOKEN` or `CF_AUTH_FILE` pointing to the
authenticated cf-cli profile (run `cf auth whoami` first to refresh its session).
Set these environment variables on the deploying machine:

```sh
export CLOUDFLARE_ACCOUNT_ID=<account-id>
export OIDC_WORKER_NAME=space-feishu-oidc
export OIDC_ISSUER=https://space-feishu-oidc.<account-subdomain>.workers.dev
export FEISHU_CLIENT_ID=<existing-feishu-app-id>
export FEISHU_REDIRECT_URI=https://<team>.cloudflareaccess.com/cdn-cgi/access/callback
export OIDC_PROVIDER_ID=<existing-feishu-provider-id>
export OIDC_KEY_FILE=<private-directory>/signing.jwk
export OIDC_BACKUP_FILE=<private-directory>/provider-before.json
```

Keep the issuer outside any Access-protected domain to avoid a login dependency
loop. The deployment creates the signing key once in a mode-0600 file, then
uploads it as a Worker secret. Preserve this file for subsequent deployments;
do not rotate keys on every deploy or commit it. Back it up through the
operator's secrets process. `OIDC_BUNDLE` can point to a Worker bundle made by
`bun build deploy/feishu-oidc/worker.ts --target browser --outfile <path>` when
the authenticated deployment machine differs from the source checkout.

```sh
bun test deploy/feishu-oidc/worker.test.ts
bun run typecheck
bun run feishu:deploy
bun run feishu:verify
bun run feishu:activate
```

Verify checks the public key and refusal of anonymous token requests. Activation
first saves the current provider to a new backup file, then changes only its
authorization, token and certificate URLs. The write-only client secret is
omitted, so Access retains its existing value. The Feishu-side callback and
application configuration remain unchanged. Keep email OTP and all existing
application policies. Complete a real Feishu login after activation; unit tests
and anonymous probes cannot validate the user's Feishu grants or email.

If login fails, run `bun run feishu:logs` to watch sanitized status and stage
diagnostics for 60 seconds while reproducing the login. It never prints request
headers, query strings or upstream response bodies. The Worker's fixed
`feishu_oidc_failure` stage `client_secret_required` identifies missing Access credentials,
`feishu_token_rejected` a rejected upstream exchange, and
`feishu_email_missing_or_unverified` an unusable identity email. Never print
authorization codes or provider response bodies. Restore the previous provider
URLs with `bun run feishu:rollback` using the same environment and backup file.
`bun run feishu:history` retrieves the last hour's sanitized diagnostics. Identity
diagnostics report only whether an email exists, has valid syntax, and is marked
verified; they never contain the address or the profile itself.

If the email remains empty after granting the published scopes, inspect the
member's **Work email** in Feishu's organization admin console. An empty member
field can produce an empty API email even after successful consent. Ask the
operator for the member's real login email before changing that field, then
repeat authorization and verify the Access result. Do not infer an address from
the member's name or substitute an address from the Access allowlist.
