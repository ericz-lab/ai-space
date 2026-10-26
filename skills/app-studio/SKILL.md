---
name: app-studio
description: Make a new app inside this ai-space, or change one made here, with no GitHub and no deploy channel - its source is app-src/<name>/ in the workspace and `space app build <name>` installs it as a package. Use when the user asks to make, build, create or change a small app or tool here, or when the panel's "New app" asked you to build one. 当用户说"做个应用""帮我做个小工具""新建应用""改一下这个应用"并且应用是在本 Space 里做的时触发。
argument-hint: "<name> [what it should do]"
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(space app *), Bash(bun *), Bash(ls *), Bash(cat *), Bash(mkdir *), Bash(curl *)
user-invocable: true
---

# Make and change apps inside ai-space

The contract is docs/app-studio.md of ai-space. In short:

- **Make one:** `space app create <name> --title "<Title>" --description "<one sentence>"`. The Space
  copies its package template to `app-src/<name>/` in the workspace, packs it and installs it. The
  panel's "New app" has already done this when it sent you here: do not create it again.
- **Change it:** edit the files in `app-src/<name>/`. Read its `AGENTS.md` first.
  - `space.yaml` is spec 2 (docs/app-packages.md): keep `name`, `requires`, `offline` and `launch`
    valid. Do not raise `version`: the build does.
  - `server.ts` is the app's process: `Bun.serve` on `process.env.PORT`, hostname `127.0.0.1`,
    `/healthz` answering. `public/` is the page (Bun HTML import); use relative URLs.
  - Every page keeps the three page rules (docs/app-spec.md#app-pages), which the template already
    has: **full-bleed** (the layout fills the window; no outer border, card, radius or padding
    around the app), **Chinese and English** (every visible string in `app.ts`'s `zh`/`en`
    dictionary, the 中 / EN switch, an `i18n: zh:` title and description in `space.yaml`), and a **theme button** (system → light
    → dark, saved, applied in `<head>` before the first paint). Check all of it at 1440 px and
    375 px, in both languages and both themes, before you report the app done.
  - Bun built-ins only (`bun:sqlite`, `fetch`, `Bun.file`): there is no `bun install` step and no
    `node_modules` in a package. Keep data in `process.env.SPACE_APP_DATA_DIR`.
  - Agents, widgets, tasks and storage go in `space.yaml` as docs/app-spec.md describes them;
    package rules (docs/app-packages.md#installed-tasks-and-agents): task URLs are paths like
    `/jobs/refresh`, cron tasks name their zone.
- **Install the change:** `space app build <name>`. It packs the directory as it is, upgrades the
  installed app (patch version + 1) and keeps the previous version for a rollback. A refusal names
  the reason (an invalid `space.yaml`, a symlink, an app that does not start or answer `/healthz`):
  fix it and build again.
- **Check it:** `space app open <name>` prints a one-use URL; or ask the user to open the tile.
  `space logs <name>` is not for packages: read `logs/<name>/package.log` in the workspace.

Tell the user what you built, what you could not do, and how to use it. Never push anything to
GitHub or another remote for these apps unless the user asks.
