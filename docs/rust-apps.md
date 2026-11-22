# Apps in Rust

An app does not have to be TypeScript ([app-spec.md](app-spec.md), rule 5): ai-space reads `space.yaml`, starts `service.command`, and talks HTTP. This page is how an app written in Rust meets that contract, what is different from the Bun template, and the traps that were hit on the way. The worked example is the **whiteboard** app (`<workspace>/app-src/whiteboard`, deployed on david): an infinite canvas whose editor is egui compiled to WebAssembly and whose server is axum with SQLite.

The Bun stack stays the default ([space-app skill](../skills/space-app/SKILL.md)). Reach for Rust when the app has work Bun is poor at: CPU-heavy loops, one core of logic that must run the same in the browser and on the server, a native library, or a long-lived process where memory matters. A page of forms over a database is not such an app.

## The contract in Rust terms

| app-spec asks | In Rust |
| --- | --- |
| Bind `127.0.0.1:${PORT}` only | `SocketAddr::from((Ipv4Addr::LOCALHOST, port))`, `port` from `PORT` with the manifest's port as fallback |
| `GET <health>` answers 200 | a route returning `"ok"`; keep it free of database calls |
| Exit within 10 s of `SIGTERM` | `axum::serve(..).with_graceful_shutdown(..)` on `tokio::signal::unix::SignalKind::terminate()` and Ctrl-C |
| Log to stdout and stderr | `println!` / `eprintln!` (or `tracing` to stdout); the journal keeps it |
| Storage from `space.env` | `DATABASE_URL=sqlite:///abs/path.db`: strip `sqlite://`, open the path with `rusqlite` (`bundled` feature, no system SQLite needed); fall back to `data/main.db` for a standalone run |
| Other variables | `SPACE_APP`, `SPACE_APP_DIR`, `SPACE_APP_DATA_DIR`, `SPACE_API_URL`, `SPACE_APP_TOKEN`, `SPACE_NAME`, read with `std::env::var`; nothing to load, the unit's environment file sets them |
| Widget | `GET <source>` → `{ "ok": true, "items": [{ "text", "url", "time" }] }`; `text` may be `{ "en": …, "zh": … }` |
| Times | UTC RFC 3339 with `Z` on the wire ([time.md](time.md)), e.g. `chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)`; the page shows them in the viewer's zone |
| Page rules | full-bleed, 中 / EN, system → light → dark theme, accent, `/_space/usage.js` and `/_space/feedback.js`: see [Pages](#pages) |

The skeleton of `main`, as the whiteboard has it (`crates/server/src/main.rs`): read `PORT` and `DATABASE_URL`, open the store, bind loopback, serve with graceful shutdown, return `ExitCode::FAILURE` with a message on any start-up error. No `unwrap`: a service that panics at start leaves only a backtrace in the journal.

SQLite calls are synchronous. Keep the `Connection` behind a `Mutex` and run each call in `tokio::task::spawn_blocking`; set `journal_mode=WAL` and a `busy_timeout`, because the space's backup opens the file read-only while the app runs ([backup.md](backup.md)).

## Repository layout

A Cargo workspace with the logic in a crate that has no UI and no I/O:

```
Cargo.toml              workspace, shared lints, release profiles
rust-toolchain.toml     the exact toolchain, with the wasm target and rustfmt/clippy
crates/core/            the domain: data model, every edit, validation, export; tests/golden/
crates/server/          the service binary (axum, rusqlite); depends on core
crates/web/             the page, if it is Rust (egui → wasm); depends on core
web/index.html          the page shell (head script, canvas, loader); fonts and static files
scripts/build.sh        release build, swapped into bin/ and dist/
scripts/gate.sh         the gate
space.yaml, AGENTS.md, README.md, .env.example, icon.svg, deploy/post-receive
```

The point of the core crate: the server validates what the browser sends with the code that produced it, an export rendered on the server matches the screen, and the rules are tested without a browser. In the whiteboard, arrow binding, resizing, deleting a bound shape and undo are all core functions; the editor only decides what a pointer gesture means.

Workspace lints worth copying:

```toml
[workspace.lints.rust]
unsafe_code = "forbid"

[workspace.lints.clippy]
unwrap_used = "deny"
expect_used = "deny"
panic = "deny"
```

with `#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]` at each crate root, so tests stay readable.

## The manifest

```yaml
spec: 1
name: whiteboard
url: /?lang={lang}&accent={accent}
service:
  command: bin/whiteboard-server     # run by /bin/sh -c in the app directory
  port: 9160
  health: /healthz
storage:
  database: sqlite
deploy:
  install: []                        # no bun.lock, nothing to install
  check: [scripts/gate.sh deploy]    # tests, in the profile the build reuses
  build: [scripts/build.sh]          # writes bin/ and dist/
```

`service.command` points at the built binary, not at `cargo run`: the unit must start in milliseconds and must not compile on a restart. `bin/`, `dist/` and `target/` are git-ignored; a deploy's checkout leaves ignored files in place, so the previous build keeps serving while the new one compiles.

## Build and deploy

`space app deploy` runs the `deploy` commands with the hook's `PATH`, which does not include `~/.cargo/bin`. The scripts add it themselves:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
```

`scripts/build.sh` builds everything aside and swaps it in last (`dist.new` → `dist`, `bin/x.new` → `bin/x`), so a failed build never leaves a half-written page or binary next to the running service. A deploy that fails puts the previous tree back and does not restart; the first whiteboard deploy failed exactly that way and nothing broke.

**Pin the toolchain.** The first deploy stopped at the build: egui 0.37 needs rustc 1.95, david had 1.93. A `rust-toolchain.toml` makes every machine use the same compiler, and rustup installs it, the wasm target and the gate's components on first use:

```toml
[toolchain]
channel = "1.95.0"
targets = ["wasm32-unknown-unknown"]
components = ["rustfmt", "clippy"]
profile = "minimal"
```

Set `rust-version` in `Cargo.toml` to the same version so `cargo` says what is wrong on an older one.

**One-time host setup** for a wasm page: `cargo install wasm-bindgen-cli --version <the wasm-bindgen version in Cargo.lock> --locked`. The CLI must equal the crate's version exactly; `build.sh` compares them and prints the install command when they differ.

**Disk.** A release build of an egui + axum workspace takes about 1.2 GB in `target/`. Hosts watched by space-ops (david warns at 88 %) should build only the release profiles: the deploy check runs `cargo test --release`, which shares the build's dependencies, and fmt and clippy run on the development machine (`scripts/gate.sh` before every push) rather than on the host.

**First deploy of a new app.** The hook builds and then reports `404: unknown app`: a new directory is registered by the workspace-wide sync. Run `space app sync` once on the host; later deploys restart the service themselves.

The channel is the usual one ([app-spec.md](app-spec.md#deploy)): the bare repository `<workspace>/repos/<app>.git` with the template hook, and a `deploy` remote in `<workspace>/app-src/<app>`.

## Testing: the gate

Borrowed from [rust-anything](https://github.com/erkamyaman/rust-anything), which rewrites apps into Rust by recording what the original does and replaying it against the port. A new app has no original to record, but the two halves of the idea carry over:

- **Recorded behaviour.** Expected outputs live in files (`crates/core/tests/golden/`: a stored document and its SVG exports in both themes). Tests compare byte for byte. `UPDATE_GOLDEN=1 cargo test` re-records; the diff is reviewed (render it, look at it) and committed with the change that caused it. A golden file for the stored document format catches an accidental format change before a saved board stops loading.
- **A gate that defines done.** `scripts/gate.sh`: `cargo fmt --check`, `cargo clippy -- -D warnings` for the host and for `wasm32-unknown-unknown`, `cargo test`, and `git diff --exit-code` over the golden files. Nothing is pushed that has not passed it.

HTTP routes are tested in-process with `tower::ServiceExt::oneshot` against the router and an in-memory database: create, save, the `409` on a stale revision, the `400` on a document the core rejects, delete.

To **port an existing app** with rust-anything itself: `app record` / `app replay` treat the app as a black box (a CLI or an HTTP server), so they can record any app; per-unit recording runs the original's own runtime, and for TypeScript that is Node, not Bun, so a unit that imports `bun:sqlite` or `Bun.serve` cannot be recorded that way. Not tried on an ai-space app yet.

## Pages

Two ways to give a Rust app a page:

1. **An HTML page and a Rust server.** The page is written like any other app's (the package template's `public/`, the Space Tiles kit at `/_space/ui.css`), and Rust serves it and the API. Everything in [App pages](app-spec.md#app-pages) applies unchanged. Choose this unless the page itself needs Rust.
2. **The whole page in Rust** (egui via eframe, compiled to wasm), as the whiteboard does. One language and one core end to end, a canvas that draws thousands of shapes at 60 fps; at the price of a larger first load and a UI that only approximates the HTML apps' look.

For the second, `web/index.html` is a thin shell: the page-rule `<head>` script (theme from `?theme` or `localStorage`, language from `?lang`, the saved choice or the browser, `?accent=` saved as `space.accent`), the two `/_space/*.js` scripts added at runtime, a full-window `<canvas>`, and a module script that loads the wasm and calls `start("board")`. The Rust side then:

- reads `<html lang>` at start and keeps it, `localStorage` and the title in step with its 中 / EN switch; every string goes through one function, `t(en, zh)`, so a string without a translation does not compile;
- maps the theme button to `ctx.set_theme(ThemePreference::System | Light | Dark)` and writes `data-theme` on `<html>`, so the page behind the canvas and the Fix this button follow;
- takes the accent from `space.accent` (`<light>.<dark>`) for selection and active states;
- styles egui flat: panel fill, 1 px rules, accent only for what is selected.

### Traps in the browser

- **No system fonts.** egui in the browser draws only fonts it is given; every CJK character is a box otherwise. The whiteboard ships a subset of LXGW WenKai (OFL) cut to GB2312 with `pyftsubset` (26 MB → 3.6 MB, 2.1 MB over brotli), adds it with `ctx.add_font` once fetched, and holds a spinner for at most 8 s while the language is Chinese. Characters outside the subset still show as boxes.
- **ehttp sends no cookies.** Its default is `credentials: omit`, unlike the browser's `fetch`. Behind Cloudflare Access every API call then lands on the login page, and the page spins forever while it works locally. Set `Credentials::SameOrigin` on every request (the field exists on wasm only, so the call sits behind `#[cfg(target_arch = "wasm32")]`), and show an error with a retry instead of an endless spinner when the first load fails.
- **Load in parallel, cache for good.** The wasm and the font are each over a megabyte compressed. `<link rel="modulepreload">` for the JS and `<link rel="preload" as="fetch" crossorigin>` for the wasm and the font start all three at once; the URLs, query included, must equal what the code requests or the file downloads twice. `build.sh` writes a content stamp into the URLs (`?v=<cksum>`), and the server sends `Cache-Control: public, max-age=31536000, immutable` for any `?v=` URL and `no-cache` for the rest. A repeat visit then transfers none of the three.
- **wasm size.** Measured on egui 0.37: `opt-level = 3`, `lto = "fat"`, `codegen-units = 1` in a separate `wasm-release` profile gave the smallest file (4.8 MB, 1.28 MB brotli); `"s"` and `"z"` were larger. Serve with `tower-http`'s `CompressionLayer` (brotli and gzip).
- **eframe 0.37 changed its API.** `App::ui(&mut self, ui, frame)` replaces `update(ctx, frame)`; panels are `egui::Panel::top/left/bottom(id).show(ui, ..)`; `Id::new` is deprecated for `Id::unique`; `TextEdit::align(Align2)` replaces `horizontal_align`. Read the crate source in `~/.cargo/registry/src` rather than trusting memory.
- **Screenshots under emulation.** `Emulation.setDeviceMetricsOverride` with a lower device scale than the window halves egui's UI in automated screenshots; it is the emulation, not the app.

## Checklist

- [ ] `rust-toolchain.toml` and `rust-version` set; `Cargo.lock` committed; builds use `--locked`
- [ ] Server binds loopback on `PORT`, answers the health path, exits on `SIGTERM`, reads `DATABASE_URL`
- [ ] Logic in a core crate; golden files for stored formats and exports; `scripts/gate.sh` passes
- [ ] `service.command` runs a built binary; `deploy.install: []`, `check` and `build` scripts that add `~/.cargo/bin` to `PATH`
- [ ] `build.sh` builds aside and swaps in last; artifacts git-ignored
- [ ] Host prepared once (wasm-bindgen CLI of the locked version); release profile only on hosts short of disk
- [ ] Page keeps the three page rules and loads `/_space/usage.js` and `/_space/feedback.js`; checked at 1440 px and 390 px, both languages, both themes
- [ ] Behind the access proxy: API calls carry the session cookie; versioned assets cached; first load fails visibly
- [ ] `AGENTS.md` names the deploy channel, the gate and the traps, for the Fix Engineer
