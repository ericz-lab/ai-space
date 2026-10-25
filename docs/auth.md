# Built-in sign-in

ai-space can sign its owner in by itself, so a space reachable from the network does not depend on an access layer such as Cloudflare Access for its panel. This is stage 1 of the plan in todo #181: one owner, a password set from the machine, revocable sessions, and an access policy on every route of the Space API. Cloudflare Access stays available as an outer layer.

## Modes

`SPACE_AUTH` in the workspace `.env` chooses who signs browsers in:

| Value | Who signs in | What ai-space checks |
| --- | --- | --- |
| `external` (default) | The access layer in front (Cloudflare Access), or nobody on loopback | Nothing new: the routes behave as before ([panel.md](panel.md#trust-boundary)) |
| `builtin` | ai-space, with the owner's password | Every route needs the caller its policy names (below) |

The default stays `external` until the installer and the migration path are done (stage 3), so an existing space keeps working after an upgrade. A new value other than these two stops the boot.

### Turning it on

On the server:

```bash
space auth init               # asks for the password twice, without echo
# or, from a script:  printf '%s\n' "$PASSWORD" | space auth init --password-stdin
```

Then set `SPACE_AUTH=builtin` in `~/.ai-space/.env` and restart ai-space. The order does not matter: under `builtin` with no owner yet, every management route answers 401 with `"auth": "uninitialized"` and the panel says to run `space auth init`. There is no route that sets the first password, so a visitor from the network cannot claim the space before its operator does.

With Cloudflare Access still in front, the owner signs in twice (Access, then ai-space). That is intended for now; trusting a verified Access identity instead is later work and is never done by reading an unverified header.

## The owner and sessions

- One owner per space. No registration, no other accounts yet.
- The password is stored as an Argon2id hash (`Bun.password`) in `auth_owner` in `space.db`. It is never passed as a command argument, logged, or written to `.env`. At least 8 characters.
- A sign-in creates a random 256-bit session token. The browser holds it in the `space_session` cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when the request came over HTTPS). `auth_sessions` stores only its SHA-256, with its creation, expiry (30 days after sign-in) and last-seen instants (Unix milliseconds, [time.md](time.md)) and the client's user agent.
- Failed sign-ins: 5 per client within 15 minutes, then that client waits; 50 across the whole space within 15 minutes, then everyone waits. The client is the connecting address plus `CF-Connecting-IP`/`X-Forwarded-For`, which a caller can vary, so the space-wide limit is the real bound. The answer to a wrong password is the same whatever was wrong. The limits live in memory and start over on a restart. A caller that keeps failing can lock the owner out of the web sign-in for a quarter of an hour; the CLI on the machine still works.
- Sign-in, sign-out and the password change are `POST`s and go through the same-origin check of the whole route table (`guardBrowserWrites`), so another site cannot sign the browser in or out.

| Action | Effect on sessions |
| --- | --- |
| `POST /api/auth/logout` | ends this session, clears the cookie |
| Change password in the panel (`POST /api/auth/password`) | keeps this session, ends every other one |
| `space auth reset-password` on the machine | ends every session |
| `space auth revoke-sessions` on the machine | ends every session |
| Revoke one in the panel (`DELETE /api/auth/sessions/:id`) | ends that one |

A session is checked when a request arrives, including the request that opens an SSE stream or a WebSocket (chat streams, events, the terminal). A stream that is already open is not cut when its session ends; it ends when it closes, and the next request needs a live session. Signing out or a session ending never stops work already started: chat turns and task runs are background runs ([panel.md](panel.md#chat)).

## Access policy

Each route table is composed with a policy in `src/index.ts`; a key overrides it where a table mixes callers. A route without a policy gets `owner`.

| Policy | Who passes | Routes |
| --- | --- | --- |
| `public` | anyone | `/api/auth/session`, `/api/auth/login`, `/api/auth/logout`, `/healthz`, `/api/space` (what the service is; its id and name only for the operator, [editions.md](editions.md#service-identity)), the page shell and its static files, `/api/chat/widget.js` and `.css`, `/_space/usage.js`, `/_space/usage/beat` |
| `self` | the route's own strict check | `/api/peer/*` (the hub's `SPACE_HUB_TOKEN`), `/api/connections/channel` (a package connection's token and space id) |
| `app` | the owner, the operator token, an app's `SPACE_APP_TOKEN`, an external consumer's key | tasks and events (`createRoutes`), the bus, notify, model, chat, voice, and `/api/peers/:peer/apps/:app/proxy/*` (an app's `/api/` paths on a peer, which an app here could reach on this machine's ports anyway); each route then decides what that caller may do, as before |
| `app-read` | as `app` for `GET`/`HEAD`; `owner` otherwise | `/api/apps`, `/api/apps/:app`, `/api/peers/:peer/apps/:app`, `/api/services`, `/api/peers`, `/api/agents`, `/api/checks`, `/api/panel/packages/apps/:app/checks/:check`: what apps such as space-ops, ai-usage, ai-spark and voice-chat read today |
| `owner` | the owner's session or the operator token | everything else: the panel, settings, chat with agents, the terminal, packages, storage, backups, logs, services, shortcuts, the router, usage |

Rules the gate (`src/space/auth/gate.ts`) holds:

- A bearer token that is not the operator's, nor an app's or consumer's where the policy allows those, is a 401, even when a valid session cookie comes with it. A forged `Authorization` header never reads as "no token".
- A request with no credential gets 401 JSON (`"auth": "signed-out"` or `"uninitialized"`); a page navigation (`Sec-Fetch-Mode: navigate`) is sent to `/?next=<path>`, and the panel returns there after signing in when the path is on the same origin.
- A request let through by the owner's session is marked, and `isOperator` and `identify` (`src/space/auth.ts`) count it as the operator. So a session can do what the operator token can, and an app token cannot reach an `owner` route.
- The operator token is never empty under `builtin`: with no `SPACE_API_TOKEN` in `.env`, ai-space writes one to `<workspace>/run/operator-token` (mode 0600). The CLI reads that file when it talks to a space on loopback and has no other token, so `space …` on the machine keeps working. Being able to read the file is the local permission; a request from loopback without a credential is refused like any other, because the tunnel's requests come from loopback too.
- A static route value (a page bundle, a fixed `Response`) has no handler to guard, so it must be `public`; anything else stops the boot.

## Host names

In both modes, the Space API answers only names it knows (`src/space/hosts.ts`). The same-origin check on writes compares `Origin` with `Host`, and under `external` with no `SPACE_API_TOKEN` a request without a token is the operator. A page on another site whose owner points its name at 127.0.0.1 (DNS rebinding) passes both, because its `Origin` and `Host` are its own name. So a request for an unknown name is refused with 421, unless it carries a credential this space issued (the operator, hub, device, app or consumer token).

Known names are: any IP address, `localhost` and `*.localhost`, `SPACE_PANEL_HOST`, `SPACE_DOMAIN` with its subdomains, and each entry of `SPACE_ALLOWED_HOSTS` (comma or space separated; `*.example.com` covers subdomains). Routes whose policy is `public` or `self` (`/healthz`, sign-in, `/api/peer/*`, package connections) are not checked: they need no secret, or check their own. A refused name is logged once, so a space reached through a tunnel hostname that is not set as `SPACE_PANEL_HOST` shows what to add.

## The panel

`src/web/Auth.tsx`. When `GET /api/auth/session` says `builtin` and not signed in, the panel shows only the sign-in card. When a session ends while the page is open, the next API call's 401 opens the card over the page: what was open stays open, and the page carries on after signing in. Settings has an Account section under `builtin`: change password, the live sessions with their last activity, sign out one, sign out.

## Device credentials

A client that is its own device, the Local edition's Mac app, holds a device credential instead of
the owner's password ([local.md](local.md#signing-in)). `space auth device-add <name>` on the
machine (or `space local install --device <name>`) makes one and prints the token (`spd_…`) once;
`auth_devices` keeps its SHA-256, a name, and when it was made and last seen. Under `builtin` a
bearer device token passes the gate as the owner, with or without an owner password set. `POST
/api/auth/device/session` with it opens an ordinary session for the device's web view and sets the
cookie. `space auth device-revoke <id>`, or `DELETE /api/auth/devices/:id`, ends it; the sessions it
opened live on until they are revoked or expire, like any other.

## Native clients

The Mac and iPhone clients send the cookies of their WebKit store with their own HTTP calls and treat a 401 or a redirect as "sign-in required", which opens the panel in the web view. The built-in sign-in sets an ordinary cookie there, so the same flow applies; verifying it on each client (API, SSE, WebSocket, app pages) is stage 2.

## API

| Route | Policy | Body / answer |
| --- | --- | --- |
| `GET /api/auth/session` | public | `{ mode, initialized, signedIn, session? }`; under `external` only `{ mode }` |
| `POST /api/auth/login` | public | `{ password }` → `{ session }` and the cookie; 401 wrong password, 429 with `Retry-After`, 409 no owner yet |
| `POST /api/auth/logout` | public | ends the cookie's session |
| `POST /api/auth/password` | owner (a session) | `{ current, next }` → `{ revoked }` |
| `GET /api/auth/sessions` | owner | `{ sessions: [{ id, createdAt, expiresAt, lastSeenAt, userAgent, current }] }` |
| `DELETE /api/auth/sessions/:id` | owner | ends one session |
| `POST /api/auth/sessions/revoke-others` | owner | ends every session but this one |
| `POST /api/auth/device/session` | self (a device credential) | `{ device, session }` and the cookie |
| `GET /api/auth/devices` | owner | `{ devices: [{ id, name, createdAt, lastSeenAt }] }` |
| `DELETE /api/auth/devices/:id` | owner | revokes one device credential |

Under `external` the routes other than `session` answer 404.

## CLI

`space auth` works on `space.db` directly, with or without ai-space running:

| Command | Does |
| --- | --- |
| `space auth status` | the mode, whether the owner is set, live sessions, the operator-token file |
| `space auth init [--password-stdin]` | sets the owner's password the first time; refused afterwards |
| `space auth reset-password [--password-stdin]` | a new password, every session ended |
| `space auth revoke-sessions` | every session ended |
| `space auth device-add <name>` | a device credential; the token is printed once |
| `space auth devices` | the live device credentials |
| `space auth device-revoke <id>` | ends one |

## Not done yet

- **App hostnames.** Under the router ([router.md](router.md)) an app's own hostname goes from the proxy straight to the app's port, without passing ai-space. The built-in sign-in does not protect those yet, so a space that publishes app hostnames still needs Access in front of them. Stage 2 adds a check route for the proxy (`forward_auth`) and a cookie the app hostnames share. Until then this document does not claim a space can go without an access layer.
- **Apps reading `app-read` routes** must send their `SPACE_APP_TOKEN`; an app that relied on loopback with no token gets a 401 under `builtin`.
- The installer's default (`builtin` for a new space), migration of existing spaces, device credentials for the Mac and iPhone clients connecting to a remote Space, more accounts and roles: stages 2 and 3 of #181. The Local edition's device credential is done (above).
