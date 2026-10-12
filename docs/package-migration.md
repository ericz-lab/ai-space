# Migrate a source application to an installation package

Package installation is opt-in. Existing spec-1 defaults, `init`, source templates and source deployment remain supported; they do not silently convert a running application. Follow [app-packages.md](app-packages.md) for the release contract and [cli.md](cli.md) for commands. The first release supports macOS/Linux, static pages, Bun/native processes, tasks and agents. Windows and embedded iframe widgets are not supported; item widgets are supported.

## Prepare a release in the source checkout

Work in `<workspace>/app-src/<app>`, following its AGENTS.md. Inventory runtime imports, native libraries, external commands, CDN assets, remote APIs, configuration, databases, task working directories and hardcoded service ports. A package is offline only for features whose dependencies are available on that host. An online model, remote worker or external archive remains online.

Build dependencies before packing. Use Bun to bundle a Bun service and include its static assets, or include the reviewed source and its complete runtime dependencies. Native artifacts must declare their actual OS/architecture. `sourceIncluded: false` describes release contents; minification is not source confidentiality. ai-space and the declared Bun/system runtime remain host prerequisites, not automatically embedded runtimes.

Keep the development `space.yaml` while authoring a separate spec-2 release manifest. Remove legacy `service`, `url` and `deploy`; declare `version`, `requires`, offline capabilities and `launch`. Select `static`, `on-demand`, `background`, or omit `launch` for task/agent-only apps. Process health paths are required. Use relative application URLs and local task paths, not fixed loopback ports. Cron requires an IANA timezone. Declare skills, storage, checks, item widgets and bus capabilities in the same manifest.

```sh
space app pack ./release --manifest ./space.release.yaml \
  --output ../notes-1.0.0.spaceapp --include dist,public --target any/any
space app inspect-package ../notes-1.0.0.spaceapp --check-host
```

`--manifest` replaces only the manifest inside the artifact; it does not change the source tree. `--include` is an explicit file/directory inventory. Packing never runs an install/build hook or fetches dependencies. Use `--source-included` for source releases and `--sign-key` for signed releases; independently provision publisher public keys on the destination. Unsigned development packages require an explicit install opt-in.

Do not include environment files or user data. Put app configuration in `<workspace>/data/<app>/.env`; it is loaded for package processes, tasks and agents. Provisioned Space storage/token values take precedence. Apps must read their supplied environment and write mutable files to the data directory, not the installed program tree. Named files such as `config.env` are excluded from releases. Review the final inventory anyway: filename filtering cannot recognize arbitrary secrets embedded in code.

## Rehearse the cutover

Use a fresh workspace and copied/synthetic data first. Compare APIs, UI, checks, task history/overrides and data before and after install; exercise upgrade and rollback. The existing scheduler retains stable task IDs and overrides for the same app/task names. HTTP tasks, checks, item widgets and bus calls acquire the current private service port and can start an on-demand process. Command/agent tasks lease code without starting a web service.

`bun run package-pilot /path/to/keep/source` performs a reproducible isolated keep migration: legacy API-created data, on-demand source package, background update, code rollback and a bundled release without the original source tree. It saves artifacts and `evidence.json` in a fresh temporary directory, never changes the source checkout, and never migrates production data. Its worker and AI features still need their configured online dependencies.

## Cut over one installed application

1. Take and verify an application backup. Record old service units, deployment hooks, URLs and data paths. Ensure the new version and any rollback version can read the same database schema.
2. Stop the old service and its external scheduler. Disable the old post-receive/rsync/deploy channel before moving files. Only one mechanism may own the app directory. `space app deploy` refuses a directory containing a package receipt before running git or commands, but an arbitrary external shell hook cannot be intercepted by ai-space.
3. Move the old program tree outside `<workspace>/apps` to retain it for recovery. Preserve/provision the app data directory and configuration separately. The installer deliberately refuses an existing unmanaged directory.
4. Install the reviewed artifact, then verify the app's storage, local page, check results, scheduled runs and skills. Do not edit installed files; build the next release from `app-src` and upgrade it.
5. Switch entry links to `/_space/apps/<app>` on the protected Space panel. Local browsers use the loopback package gateway; remote browsers need its dedicated wildcard HTTPS app domain, or a peer Space forwarding over its outbound connection. A package install does not configure public ingress. Old browser-origin data such as localStorage must be exported/imported by the app when the origin changes.
6. Enable sharing explicitly. On the Hub choose the Hub apps the peer can use. On the peer leave its local grant empty unless Hub access is intended. Verify revoke and reconnect. Remote app listings never install a second scheduler copy.

Keep the old source deployment disabled after cutover. If abandoning the package, remove it through its lifecycle API, restore the old tree/configuration and deliberately re-enable the old deployment owner. Package rollback changes program files only; incompatible database changes require the verified backup and an explicit data restoration procedure. Retained program versions and data are not automatically deleted.

## Routing and remaining boundaries

Caddy is optional for local and peer-forwarded access. For a directly accessed server such as Seoul, an existing edge can route `*.apps.example.com` to `127.0.0.1:$SPACE_PACKAGE_PORT`, preserving Host and supporting WebSockets. Configure `SPACE_PACKAGE_BASE_URL=https://apps.example.com` and keep its domain separate from the operator panel. Provision wildcard DNS/TLS using your existing ingress process. Do not expose each process's transient port.

The package runtime runs trusted app code under the Space user's OS account, not in an Android-style process sandbox. Agent runtimes and credentials are host services. Remote page grants do not grant agent execution, deployment, operator APIs or terminal access. Embedded widgets need a separate iframe session design and are rejected rather than mounted in the operator origin. Fleet migration and production edge changes remain deliberate operations after the isolated pilot.
