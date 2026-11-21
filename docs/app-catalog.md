# The app catalog

Status: implemented in the Space (`src/space/packages/app-catalog.ts`, `release.ts`,
`publishers.ts`, `catalog-sources.ts`; `space app catalog|install|upgrade|release|keygen`; the
panel's Add app → App catalog and the home screen's first-use card). The catalog itself is the
[ai-space-apps](https://github.com/ericz-lab/ai-space-apps) repository. Which ai-space apps are in it
and released is tracked there, not here.

An app someone published for any Space is listed in a catalog and installs one of two ways:

| | Package (the default) | Source |
| --- | --- | --- |
| What arrives | the release's signed `.spaceapp`, built by its publisher | the app's repository, cloned to `<workspace>/app-src/<app>` |
| What runs on install | nothing: no clone, no dependency fetch, no script | the app's `build:` commands, in a scratch copy, then the same package install |
| Needs | the Space | `git`, and whatever the build needs (Bun, the network for `bun install`) |
| Version | the catalog's release | the release tag, or a branch such as `main` (a development version) |
| Change it | install from source instead | edit `app-src/<app>`, then `space app build <app>` |

Either way upgrades the other: a source install of a packaged app replaces it through the package
lifecycle (data kept, previous version kept for a rollback), and so does the reverse. The old way,
a Git checkout under `apps/` deployed by `git push` (spec 1, [app-spec.md](app-spec.md)), stays as it
is; the catalog does not touch such an app and says so ([package-migration.md](package-migration.md)
moves one to a package).

## Using it

In the panel: Add app (the `+` in the library, or long-press the background) opens on **App
catalog**: every listed app with its title and description in the panel's language, its release,
its publisher, what it needs and what only works online, and whether it is installed, has an
update, or was built from source (and from which branch). Tick several and **Install N chosen**, or
use a row's own buttons: **Install**, **Update to X**, **From source**, and **with source** (the
release's source package: the same app with its source files beside it, for reading).

A Space with no catalog app on it shows a first-use card on the home screen; **Choose apps** opens
the catalog with every installable app ticked. **Not now** hides the card in that browser.

From the command line, against the running Space:

```sh
space app catalog [--refresh]                 # catalogs, apps, release, installed, state, needs, publisher
space app install NAME                        # the signed package
space app install NAME --with-source          # the package that carries its source
space app install NAME --source               # cloned at the release tag, built here
space app install NAME --source --ref main    # the same, following main
space app upgrade NAME                        # the new release, or the checkout pulled and built again
space app upgrade NAME --package              # the next release's package, also over a source build
space app install ./notes-1.0.0.spaceapp      # a package file, as before
```

A name that ends in `.spaceapp`, holds a `/`, or names an existing file is a package file;
anything else is a catalog app.

## Trust

A catalog install takes a package only when all of these hold:

1. its SHA-256 equals the catalog's;
2. it is signed, and the signature verifies against the key of the publisher the catalog names for
   the app (a valid signature by any other key fails);
3. its `space.yaml` names the app and version the catalog names.

Publishers the Space trusts without asking: the ones ai-space ships in
`src/space/packages/publishers.json`, and the keys in `SPACE_PACKAGE_TRUST_KEYS`. Any other
publisher in a catalog needs the owner's yes once: the panel asks inline, the CLI asks on a
terminal and otherwise wants `--trust`. The Space then remembers that key (table
`app_catalog_trust`); `DELETE /api/app-catalog/publishers/<keyId>` forgets it. A source install
asks the same question before anything of the publisher's runs, since it runs their build
commands on this machine.

Building from source does not change what the installed app may do: the result is a package like
any other, checked by the same installer, under the same storage and network rules.

## Configuration

`SPACE_APP_CATALOG` in the workspace `.env`:

| Value | Catalogs |
| --- | --- |
| unset | the default, `https://raw.githubusercontent.com/ericz-lab/ai-space-apps/main/catalog.json` |
| `none` (or empty) | none: the panel's catalog tab says so, installs from files still work |
| a comma list | read in order; `default` stands for the default; an `https://` URL; `http://` only on loopback; a path (relative to the workspace) is a local file. The first catalog that lists an app wins. |

A catalog is read at most every 6 hours (`--refresh` / the panel's Refresh read it now). When it
cannot be read, the last copy is shown and marked; installs from it still check every package.
Package URLs in a catalog are https (or relative to a local catalog file).

`SPACE_DEFAULT_APPS` and the default apps of `init` are unchanged for now; they move to the catalog
once every default app is released there.

## The catalog format

`catalog.json`, format 1. A Space ignores keys it does not know, so a catalog can grow without
breaking older Spaces; it checks every key it knows.

```json
{
  "catalog": 1,
  "publishers": [{ "id": "acme", "name": "Acme", "url": "https://acme.example", "keyId": "<sha256 of the public key's DER>", "publicKey": "-----BEGIN PUBLIC KEY-----\n…" }],
  "apps": [{
    "name": "notes",
    "publisher": "acme",
    "title": { "en": "Notes", "zh": "笔记" },
    "description": { "en": "…", "zh": "…" },
    "icon": "icons/notes.png",
    "repo": "https://github.com/acme/notes",
    "license": "MIT",
    "recommended": true,
    "needs": ["model"],
    "online": [{ "en": "Summaries need a model", "zh": "摘要需要模型" }],
    "latest": {
      "version": "1.2.0",
      "tag": "v1.2.0",
      "package": { "url": "https://github.com/acme/notes/releases/download/v1.2.0/notes-1.2.0.spaceapp", "sha256": "…" },
      "sourcePackage": { "url": "…/notes-1.2.0-source.spaceapp", "sha256": "…" },
      "requires": { "spaceApi": 1, "bun": "1.3.0" }
    }
  }]
}
```

`icon` is relative to the catalog. An app without `latest` is listed and installs from source
only. `needs` names what the app wants from the Space: `model`, `agent-logs`, `operator`, `s3`,
`git`; an unknown need is shown as it is. The catalog repository keeps the JSON Schema, a
validator that also downloads every release and checks it, and the scripts that add a publisher
or point an app at a new release.

## Building from source

A checkout becomes packages with `space app release [DIR]` (CI) or, for a source install,
`space app build NAME`. The spec-2 declaration is `space.release.yaml` when the checkout has one,
so an app can keep its spec-1 `space.yaml` for Git deployments while it is released as a package;
otherwise `space.yaml`. Its `build:` section says how:

```yaml
build:
  install: bun install --frozen-lockfile    # a command, or a list of them
  run: bun run build
  include: [dist, icon.png]                 # what the package carries besides space.yaml
  source: [src, web, package.json, bun.lock] # optional: the source variant's files besides include (default: the whole checkout)
```

The checkout is copied to a scratch directory (without `.git`, `.github`, `node_modules`, `.env`,
`data`, `dist-packages`) and the commands run there, one after another, with a 10-minute limit
each and an environment that carries no credentials of the Space: `HOME`, locale, proxy and
certificate variables, Bun's install cache, `PATH` with the Space's Bun first, `CI=1`. The checkout
itself is never written to, except that `space app build` raises the declared patch version when it
is not above the installed one. The log is `logs/<app>/build.log`. Without a `build:` section the
checkout is packed as it is, source included (the template of `space app create`, [app-studio.md](app-studio.md)).

`space app release` makes the `bundle` package, the `source` package, or both (`--variant`), signs
them with `--sign-key`, and prints their SHA-256: what the catalog entry needs.

A bundled Bun server finds its HTML-import assets relative to the working directory; the package
runtime starts it in the app directory, so a bundle in `dist/` should `process.chdir` to its own
directory when it runs from a bundle.

## Publishing an app

1. Make a signing key once, kept out of every repository: `space app keygen --out ~/keys/<you>.pem`
   writes the private key (mode 600), `<you>.pem.pub` and prints the key ID.
2. Give the app a spec-2 declaration with a `build:` section; `space app release .` must build it
   from a clean checkout.
3. Copy `skills/space-app/package-template/.github/workflows/release.yml` into the app repository
   and set its secret `SPACE_SIGN_KEY` to the private key. A `v<version>` tag then builds, signs
   and publishes both packages as release assets, and (with `CATALOG_TOKEN`) proposes the catalog
   update.
4. Propose the publisher and the app to the catalog repository (its README says how).

## API

| Route | Policy | Body / answer |
| --- | --- | --- |
| `GET /api/app-catalog[?refresh=1]` | owner | `{ sources, apps, trusted, git }`: each app with `latest`, `installed` (`version`, `origin` package / source / local, `ref`, `dev`), `state` (available, installed, update, unreleased, legacy) and its publisher's `trusted` |
| `POST /api/app-catalog/:app/install` | owner | `{ from?: "package" \| "source", withSource?, ref?, trust? }` → `{ result: { app, version, action, from, ref, dir? } }` |
| `POST /api/app-catalog/:app/upgrade` | owner | `{ from?, ref?, trust? }`, same answer |
| `DELETE /api/app-catalog/publishers/:keyId` | owner | `{ removed }` |

A refusal is `{ ok: false, error, code }`; `code` is one of `trust-required` (with `publisher`:
ask, then repeat with `trust: true`), `not-found`, `legacy`, `not-installed`, `unreleased`,
`current`, `location`, `download`, `checksum`, `invalid-package`, `signature`, `mismatch`,
`upgrade-failed`, `install-failed`, `git-missing`, `git`, `dirty` (the checkout has changes of the
owner's: commit them, or build them as they are), `build`.

## Not yet

- The production publisher key in `publishers.json` and the first signed releases in the public
  catalog: until then the default catalog lists apps whose publisher each Space confirms once.
- Every ai-space app in the catalog, and `SPACE_DEFAULT_APPS` replaced by it.
- Removing a source checkout with the app: uninstall keeps `app-src/<app>`.
