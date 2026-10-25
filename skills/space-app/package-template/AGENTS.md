# My App

An ai-space app made inside ai-space. This directory is its source; what runs is the installed
package, made from it by `space app build my-app`.

- `space.yaml` - the app's declaration (spec 2, docs/app-packages.md in ai-space). Raise nothing by
  hand: `space app build` raises the patch version each time.
- `server.ts` - the process ai-space starts on demand, with `PORT`. Loopback only. `/healthz` must
  answer.
- `public/` - the page, bundled by Bun's HTML import. Use relative URLs.
- `model.ts` - `ask(prompt, { tag })` calls the Space's model service.

Rules: Bun and its built-in APIs only (`Bun.serve`, `bun:sqlite`, `fetch`), no `node_modules`; keep
data under the directory in `SPACE_APP_DATA_DIR` when the app needs to keep any. After a change, run
`space app build my-app` and open the app to check it.

Keep what the template already does. Each of these was once fixed by hand in many apps:

- **Usage.** `public/index.html` loads `/_space/usage.js`, so the panel shows the app's time in use.
  Keep the line in every page.
- **Models.** Call models through `model.ts` and give each call a `tag` (`translate`, `summary`).
  Never name a model: the Space chooses it, and the operator can change it per app and tag.
- **Timeouts.** `server.ts` sets `idleTimeout: 255` and `model.ts` turns off fetch's timeout. A
  stream or a long model call would otherwise be cut after 10 s or 5 minutes.
- **Phone width.** `style.css` keeps the page from growing wider than the screen. Check every page
  at 375 px wide; long words, URLs, tables and images must not widen it.
- **Theme.** Colors are the tokens at the top of `style.css`, with a dark set. Use the tokens, not
  fixed colors, so dark mode keeps working.
- **Icon.** `icon.svg` is the panel tile and the browser tab icon.
- **No fixed hosts.** Never write a host name, a machine name or a public URL into the code. Use
  relative URLs in the page and `SPACE_API_URL` on the server.
