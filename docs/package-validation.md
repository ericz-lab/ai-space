# Package release validation

This records the first package implementation's acceptance lanes. It is evidence for the implementation, not a claim that existing production apps or ingress have been migrated. Run `bun install`, `bun run typecheck` and `bun test` before pushing; `bun run check` combines the latter two.

Final full local validation, including the explicit Caddy lane: 863 tests passed across 103 files, with type checking and frozen dependency installation passing.

## Automated matrix

| Lane | Evidence |
| --- | --- |
| Artifact and installation | Contract validation, deterministic inventory, publisher trust, digest mismatch, extra/missing files, archive limits, traversal/link rejection, target/runtime compatibility, existing checkout protection, idempotent operations and restart recovery |
| Runtime | Static app without a process, concurrent on-demand startup, health failure cleanup, idle leases, background restart, private loopback listeners and stripped inherited operator secrets |
| Lifecycle | Upgrade, retained versions, code rollback and removal retain data; busy requests refuse replacement; failed activation, a new version whose process does not reach health, and interrupted publication restore verified previous code; an unrecoverable change blocks only its application |
| Local components | Stable scheduled task IDs/overrides; local HTTP/command execution; agent leases; dynamic check/widget/bus calls; old peer grants cannot invoke package apps |
| Connection and gateway | Peer-to-Hub HTTP/WS, default-off reverse sharing, explicit reverse enable/revoke, immediate stream/socket closure, reconnect, same-name origin separation, local use during Hub outage and no remote-to-local substitution |
| Operator controls | CLI routes and binary upload; same-origin panel writes; no management routes on app gateway; upload operation reconciliation; no tokens in connection listings |

On 2026-10-12 the package suite passed on macOS arm64/Bun 1.3.0 and in a temporary directory on the Seoul Linux x64/Bun 1.4.1 host (42 tests in each lane at that revision). The Linux lane ran bundled test files and real child processes; it did not deploy this branch or change live workspace data. Native application binaries for every OS/architecture are not covered by that result.

## Real application and offline lane

`bun run package-pilot /path/to/keep/source` creates a fresh temporary workspace and writes an `evidence.json` file. Against keep revision `86ae79e6b3c7e5a597d8dc45c34a1c47c6ae7b67`, the pilot preserved a legacy API-created note through installation, background upgrade, rollback and a prebuilt Bun bundle; a note added after upgrade also survived rollback. The original source checkout remained unchanged. Worker, cloud model and remote archive behavior were not represented as offline features.

On macOS, restrict only the test process and its children, leaving the host network untouched:

```sh
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))' \
  bun run package-pilot /path/to/keep/source
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))' \
  bun test src/space/packages
```

Both lanes passed with internet egress denied. A socket probe under the same profile returned `EPERM` for an external IP; loopback app requests still succeeded. This profile is a test fixture, not an application OS sandbox or a portable deployment feature. It does not establish offline availability of arbitrary third-party dependencies.

A real Chrome session also installed an unsigned static fixture through the Chinese panel, opened its isolated `.localhost` origin and saved/reloaded a localStorage note. This verified the ticket transition document and Strict-cookie first navigation. Browser persistence belongs to that browser origin; server-side data is a separate app store.

## Optional Caddy edge lane

Provision a reviewed Caddy executable outside the repository, then run:

```sh
SPACE_TEST_CADDY=/absolute/path/to/caddy bun run package-check-edge
```

This explicit lane creates a temporary self-signed certificate and a loopback HTTPS Caddy instance. It disables Caddy's admin and automatic HTTPS services, uses a temporary home/config directory, and never adds a certificate to the system trust store. Certificate verification is disabled only on fixture requests. The fixture checks Host preservation, Secure app-session cookies, deep-link entry, HTTP and WebSocket forwarding, then terminates Caddy.

The lane passed with Caddy 2.11.7 on macOS; the downloaded official artifact's SHA-512 matched its published checksum. It does not validate production wildcard DNS, CA issuance, Cloudflare configuration or an operator's existing Caddyfile. Those remain deployment checks for the selected host. Local and peer-forwarded paths pass without Caddy.

## Boundaries to retain in release notes

Code rollback does not reverse incompatible database migrations or external writes. Recovery tests simulate interrupted journal/rename boundaries; they do not prove every physical power-loss/storage failure. Apps remain trusted programs under the host user's account. Embedded iframe widgets, Windows, data replication, automatic fleet cutover and remote agent execution through page grants are outside this release. See [package-migration.md](package-migration.md) for the deliberate production cutover procedure.
