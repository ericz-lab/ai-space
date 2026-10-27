# Apps made inside ai-space

Status: implemented (`src/space/studio.ts`, `space app create` / `build`, the panel's New app,
the `app-studio` skill). Step 8 of [editions.md](editions.md#the-work-in-order): an app without
GitHub and without a coding tool outside the product.

## The loop

1. **Make.** The panel's Add app → New app (title, name, what it should do), or
   `space app create NAME [--title T] [--description D]`. The Space copies its package template
   (`skills/space-app/package-template/`) to `<workspace>/app-src/NAME/`, fills in the name, title
   and description, packs it and installs it: a working tile right away. With `git` on the machine
   the source gets a local history (one commit, no remote); without it, nothing is lost. The
   template starts with what apps used to fix one by one: the usage and feedback scripts, model calls without a
   fixed model (`model.ts`), long idle timeouts, phone-width CSS, the icon as favicon, and the three
   page rules of [app-spec.md](app-spec.md#app-pages): a full-bleed layout with no outer frame,
   Chinese and English with a 中 / EN switch, and a theme button (system, light, dark) applied
   before the first paint. Its `AGENTS.md` lists them so an agent keeps them.
2. **Build what was asked.** The panel then opens Space Assistant with the request: change the files
   in `app-src/NAME/` (its `AGENTS.md` says how), then run `space app build NAME`. The assistant
   runs in the workspace with the user's chosen permissions, through whichever agent runtime the
   Space has; the `app-studio` skill gives it the rules.
3. **Change it later.** Ask the assistant again, or edit the files any other way (the web terminal,
   an editor on the machine), then `space app build NAME`.

`build` packs the directory as it is (everything at the top level except `.git`, `node_modules`,
`.env`, `data`, earlier `.spaceapp` files) into `<workspace>/run/studio/NAME-<version>.spaceapp` with
the source included, and installs it through the package installer, or upgrades the installed app
through the package lifecycle ([app-packages.md](app-packages.md#upgrades-rollback-and-removal)):
the previous version is kept for a rollback, and an upgrade whose app does not start and answer its
health path puts the previous one back. When `space.yaml`'s version is not above the installed one,
the build raises the patch version and writes it back, so the source says what runs. One build runs
at a time.

## The template

A spec-2 package with a Bun process and no dependencies to install:

| File | What |
| --- | --- |
| `space.yaml` | `spec: 2`, `requires: { spaceApi: 1, bun: 1.3.0 }`, `launch: { kind: process, runtime: bun, entry: server.ts, mode: on-demand, health: /healthz }` |
| `server.ts` | `Bun.serve` on `PORT`, loopback only: the page, `/healthz`, `/api/hello` |
| `public/` | `index.html`, `app.ts`, `style.css`, bundled by Bun's HTML import at start: a full-bleed page with a top bar holding the 中 / EN switch and the theme button, a zh/en dictionary in `app.ts`, light and dark tokens in `style.css` |
| `AGENTS.md` | the rules for whoever changes it |
| `icon.svg` | the tile's icon |

The host's Bun runs it (in the Local edition, the one inside the app). An app opens through the
package gateway, so the Space needs `SPACE_PACKAGE_PORT`; the Local edition sets it at install.

## API

| Route | Policy | Body / answer |
| --- | --- | --- |
| `GET /api/studio/apps` | owner | `{ apps: [{ app, title, version, installed, changed, dir }] }`: the spec-2 sources in `app-src/`, the installed version, whether a file changed since the last build |
| `POST /api/studio/apps` | owner | `{ name, title?, description? }` → `{ dir, build: { app, version, action } }`; 409 when the name is taken |
| `POST /api/studio/apps/:app/build` | owner | `{ build: { app, version, action: "installed" \| "upgraded" } }`; 400 with the reason for an invalid source, 404 without one, 409 when the install or upgrade fails |

## Limits

- No dependencies from npm: a package carries no `node_modules` and installs nothing
  ([app-packages.md](app-packages.md#build-and-inspect-a-package)). Bun's built-ins go a long way.
- Making the app needs an agent runtime the Space can use (Claude Code, Codex, ...). Without one,
  the template is installed and the source can still be changed by hand.
- Apps from `space app new` (spec 1, a Git repository and a deploy channel) are the other way to
  make apps and stay as they are ([app-spec.md](app-spec.md)).
