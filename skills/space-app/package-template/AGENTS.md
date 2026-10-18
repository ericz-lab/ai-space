# My App

An ai-space app made inside ai-space. This directory is its source; what runs is the installed
package, made from it by `space app build my-app`.

- `space.yaml` - the app's declaration (spec 2, docs/app-packages.md in ai-space). Raise nothing by
  hand: `space app build` raises the patch version each time.
- `server.ts` - the process ai-space starts on demand, with `PORT`. Loopback only. `/healthz` must
  answer.
- `public/` - the page, bundled by Bun's HTML import. Use relative URLs.

Rules: Bun and its built-in APIs only (`Bun.serve`, `bun:sqlite`, `fetch`), no `node_modules`; keep
data under the directory in `SPACE_APP_DATA_DIR` when the app needs to keep any. After a change, run
`space app build my-app` and open the app to check it.
