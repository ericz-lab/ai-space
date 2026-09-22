# Router: a hostname for every app without a registration

Status: implemented (`src/space/router/`). Ingress itself (why a tunnel) is decided in [ingress.md](ingress.md); this document decides what runs behind the tunnel.

## Problem

Today every app with a page needs a rule on the tunnel provider's side: hostname, target port, and an Access application in front ([install.md](install.md) steps 5, 6 and 10). Installing an app is therefore never just "clone and sync": it ends with a login to a third party and a form. A space should depend on the provider once, at install, and never again per app. The same problem exists on the second machine: its peer apps need the same forms.

Two more things follow from the per-app rule. The manifest of a public app has to name a hostname it cannot know (`url: https://my-app.example.com`), which is why `SPACE_APP_URL_<NAME>` exists; and the machine's table of "which hostname goes to which port" lives in a dashboard, where nothing in the workspace can read or rebuild it.

## Shape

One wildcard rule on the tunnel, created once: `*.example.com` to a **router** on loopback. The router is Caddy, run as a user unit next to `cloudflared`, with a configuration file that **ai-space renders** from its registry: one host block per app, `host` to `127.0.0.1:<service.port>`. Installing an app means the registry changes; the registry changing means the file is rewritten and Caddy reloads. Nothing outside the machine is touched.

```
browser ── edge (TLS, Access) ── tunnel ── 127.0.0.1:8080 Caddy ──┬── 127.0.0.1:8710  app a
                                            ▲                     ├── 127.0.0.1:8720  app b
                                            │                     └── 127.0.0.1:8700  panel (optional)
                                 ai-space renders run/Caddyfile
                                 on every registry change
```

ai-space is the controller, not the proxy: it never carries app traffic (the same rule as for services and backups). The router is a program the operator installs once, like `cloudflared`, and ai-space only writes its configuration.

Rules:

- **Off by default.** `SPACE_ROUTER=none` keeps today's behaviour exactly: nothing is rendered, no unit is expected, the tile URLs are what the manifest says. A laptop never needs the router.
- **The manifest's URL decides the hostname, not the app name.** An app that names its own hostname keeps it. The app name is only the default.
- **Explicit rules keep winning.** A hostname registered on the tunnel by hand goes straight to its port and never reaches Caddy; the block Caddy holds for it is idle and harmless. Existing installs migrate app by app, or never.
- **Rendering never breaks a sync.** A failed write or reload is logged and shown on `/api/router`; the app is still registered, its tasks still run.
- **No traffic through ai-space.** The router talks to app ports directly; ai-space's own port is just another target.

## The manifest's `url`

`url` accepts one more form: a **path** (`/`, `/docs`). A path means "my page, at this path, on whatever hostname the space gives me". ai-space resolves it when the manifest is loaded, after `SPACE_APP_URL_<NAME>` (which still wins, and must be absolute):

| Space has | `url: /docs` resolves to |
| --- | --- |
| `SPACE_DOMAIN=example.com` | `https://<app>.example.com/docs` |
| no domain | `http://127.0.0.1:<service.port>/docs` |

A path `url` requires a `service` with a `port`; the manifest is rejected otherwise. Everything downstream (tiles, widget links, `{lang}`, the peer snapshot) sees the resolved absolute URL and does not change. An absolute `url` behaves as today. A public app can now write `url: /` and be correct on every machine.

## Routing table

From the registry, for every app that has a `service.port` and a `url` whose host is not a loopback address, one route:

| Field | Value |
| --- | --- |
| `app` | app name |
| `host` | hostname of the resolved `url`, lowercased |
| `target` | `127.0.0.1:<service.port>` |
| `status` | `wildcard` when `host` is exactly one label under `SPACE_DOMAIN` (`a.example.com`, not `a.b.example.com`, which the free wildcard certificate does not cover); `explicit` otherwise, meaning the hostname needs its own tunnel rule to arrive here |

Two apps resolving to the same host is a conflict: the first by app name gets the route, the other is listed with `status: conflict` and logged. Apps without a service, manifest-only link apps, `archived` apps, and apps whose URL is on loopback produce no route. `paused` apps keep their route (the page may still be useful). The panel's own hostname is added as a route to `127.0.0.1:<SPACE_PORT>` when `SPACE_PANEL_HOST` is set, so an install can put everything behind the one wildcard rule; leaving it unset keeps the panel on its own tunnel rule, which also keeps the panel reachable while Caddy is down.

## Caddyfile

Rendered from the table by a pure function (`caddyfile.ts`), deterministic, so the file is rewritten only when its content changes. Shape:

```
# Written by ai-space from its registry; edits are overwritten. See docs/router.md.
{
	admin unix//home/u/.ai-space/run/caddy.sock
	auto_https off
	default_bind 127.0.0.1
}

# a
http://a.example.com:8080 {
	reverse_proxy 127.0.0.1:8710 {
		header_up X-Space-User {header.Cf-Access-Authenticated-User-Email}
	}
	log {
		output file /home/u/.ai-space/logs/router/a.log {
			roll_size 10MiB
			roll_keep 3
		}
	}
}

http://:8080 {
	respond "no such app" 404
}
```

- `auto_https off` and `http://` addresses: TLS is the edge's job; Caddy never touches 80 or 443 and needs no root on any OS.
- `default_bind 127.0.0.1`: every site listens on loopback only, reachable from the tunnel and nothing else. Conflicting apps are left out of the file.
- The admin endpoint is a unix socket in the workspace `run/` directory, so `caddy reload` works the same way on Linux and macOS and nothing listens on a TCP port for it.
- `X-Space-User` hands the app the login that Access verified, without the app parsing a JWT. The header is set by the edge and an app should trust it only behind the edge.
- The last block answers hostnames that arrive through the wildcard but belong to no app.
- Tabs, not spaces: the Caddyfile formatter's convention.

## Rendering and reload

`router.ts` owns a `Router` with `sync()`: build the table, render, compare with the file on disk, write if different, then `caddy reload --config <file> --adapter caddyfile --address unix/<sock>`. `sync()` is called on boot after discovery, and after every `provision` and every removal (panel uninstall, `onGone`); calls are coalesced with a short debounce so a boot with thirty apps reloads once. The result of the last attempt (`at`, `ok`, `error`) is kept in memory for the API. When `SPACE_ROUTER=none`, `Router` is a no-op whose table still exists (the API can show what would be routed).

A reload is also retried on the next sync after a failure, even when the file did not change, so a Caddy that was not up yet is caught up by the next app. `caddy.ts` is the backend: `write(text)`, `reload()`, `installed()`. It takes its shell runner as a dependency so tests use a fake. The binary is `caddy` on `PATH` (the ai-space unit's `PATH` includes `~/.local/bin`), overridable with `SPACE_ROUTER_CADDY=/path/to/caddy`.

## Configuration

Workspace `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPACE_ROUTER` | `none` | `caddy` turns the router on |
| `SPACE_DOMAIN` | unset | the wildcard's domain; a path `url` resolves under it; required when the router is on |
| `SPACE_ROUTER_PORT` | `8080` | the loopback port Caddy binds; the wildcard tunnel rule's target |
| `SPACE_PANEL_HOST` | unset | route this hostname to the panel too |
| `SPACE_ROUTER_CADDY` | `caddy` | the binary |

`run/` joins the workspace layout (`workspace.ts`): `run/Caddyfile`, `run/caddy.sock`. `logs/router/` holds the per-app access logs.

## API

`GET /api/router` (panel route, no token; the panel sits behind the access layer like the rest); `POST /api/router/sync` writes and reloads now and answers the result:

```json
{
  "router": "caddy",
  "domain": "example.com",
  "port": 8080,
  "file": "/home/u/.ai-space/run/Caddyfile",
  "routes": [
    { "app": "a", "host": "a.example.com", "target": "127.0.0.1:8710", "status": "wildcard" },
    { "app": "old", "host": "old.example.com", "target": "127.0.0.1:8720", "status": "explicit" }
  ],
  "lastSync": { "at": "2026-09-22T08:00:00Z", "ok": true, "changed": false }
}
```

`status: explicit` is the operator's list of hostnames that still depend on a hand-made rule.

## Install

Once per machine, next to the tunnel ([install.md](install.md) step 5):

1. Caddy's static binary into `~/.local/bin`, like `cloudflared`.
2. A user unit (`caddy.service` on Linux; a LaunchAgent on macOS) running `caddy run --config ~/.ai-space/run/Caddyfile --adapter caddyfile`. ai-space writes an empty but valid Caddyfile at `init` so the unit starts before any app exists.
3. On the tunnel: one public hostname `*.example.com` to `http://127.0.0.1:8080`, plus the wildcard CNAME the dashboard does not create by itself. One Access application on `*.example.com`. The panel keeps its own rule and Access application, or sets `SPACE_PANEL_HOST` and joins the wildcard.
4. `.env`: `SPACE_ROUTER=caddy`, `SPACE_DOMAIN=example.com`. `setup` asks for both and checks that `caddy` is on `PATH` and its unit is active.

Installing an app afterwards is: clone, sync. Step 10's "add the hostname on the dashboard" goes away for apps under the wildcard.

## Cross-platform

Caddy is one binary on Linux and macOS; `bind 127.0.0.1` and `auto_https off` keep it root-free on both. The reload goes through the admin socket, so `router/` has no OS branch; only "how the unit is kept running" differs and lives in the install document. On a laptop with no domain the router stays `none` and a path `url` resolves to loopback, which is the correct tile there.

## Speed

The request path is the same as with per-app tunnel rules except for one loopback hop inside the machine (edge to `cloudflared` to Caddy to the app instead of edge to `cloudflared` to the app): tenths of a millisecond next to the tens of milliseconds between the browser and the edge. WebSockets and event streams pass through Caddy's `reverse_proxy` unchanged. Caddy's reload is graceful: open connections finish on the old configuration.

## Later

- **Peers under the wildcard.** A peer machine has its own tunnel and its own router; whether its apps get their own domain, a subdomain or explicit records is the naming decision left open in [ingress.md](ingress.md).
- **Per-app error page** (a 503 with the app's name while its service restarts) once services are supervised.
- **Public apps.** Everything under the wildcard is behind the one Access application; an app meant to be public still needs its own hostname outside the wildcard, or an Access bypass policy for its host.
