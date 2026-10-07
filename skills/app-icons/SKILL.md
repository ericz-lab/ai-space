---
name: app-icons
description: Redraw the ai-space panel's app and agent icons in a style the operator describes, and install them as an icon pack (the panel's own icons over the apps' manifests; no app repository is changed). Use when the operator wants the panel's icons restyled, unified, redrawn, or one tile's icon changed, or wants to switch or remove an icon pack. 当用户说"重做图标""统一图标风格""换一套图标""改一下某个应用的图标""图标包"时触发。
argument-hint: "[style description] [--pack name]"
allowed-tools: Bash(bun *), Read, Write, Edit
user-invocable: true
---

# app-icons

The panel shows each tile's icon from the app's `space.yaml` (`icon`, an agent's `avatar`). An **icon pack** puts the panel's own icons over those: files under `<workspace>/icons/<pack>/` on the machine whose panel you are restyling, one active pack at a time, no app repository touched, removable in one call. The contract is in ai-space's `docs/panel.md#icon-packs`.

This skill has **no built-in style**. The style is the operator's: you turn their description into a short style sheet, draw every tile to it, show them, and install what they approve.

Everything goes through `scripts/icons.ts` in this skill's directory (run it with `bun`; `bun scripts/icons.ts` alone prints its usage). It talks to the space on this machine (`SPACE_API_URL`, else the port in the workspace `.env`, else `127.0.0.1:8700`). Run it on the machine whose panel the operator looks at: a hub's panel also lists its peers' tiles, and its pack covers them; a peer's own pack never shows on a hub.

## Procedure

1. **Get the style.** Take it from the operator's words. If they gave none, or only a vague one ("nicer", "more modern"), ask one question with two or three concrete directions to pick from (for example: flat plate + line glyph; glossy glass; monochrome outline; duotone), and ask whether the colours should stay calm or be vivid. Do not choose for them, and do not reuse a style from an earlier pack unless they say so. Also ask for a pack name if they care; default to a short slug of the style (`glass`, `mono-line`).

2. **List the tiles.** `bun scripts/icons.ts tiles --dir <work>` writes `<work>/tiles.json`: every app tile (local and peers', in panel order), the three built-in tiles (`space/inbox`, `space/terminal`, `space/settings`), and every agent, with titles, descriptions and the owning app. `<work>` is a scratch directory of your session. `bun scripts/icons.ts current --dir <work>` downloads the present icons into `<work>/current/` when you want to see them (an emoji icon has no file).

3. **Write the style sheet** to `<work>/style.md` before drawing anything, in a dozen lines: canvas and plate (shape, fill, effects), the palette with named colours, how colours are assigned, glyph rules (stroke width, caps, fill vs line, the live area, how many detail levels), and how agents differ from apps. Every icon follows this sheet; when the operator changes the style, change the sheet first.

4. **Assign a glyph to every tile** in one table in `style.md` (tile id → glyph → colour) before drawing. Read each tile's title and description; pick what the app *does*, and make every silhouette unique across the whole panel. Then check the table for the collisions below and fix them in the table, not later.

5. **Draw a sample first**: six to eight tiles that cover the hard cases (a dense glyph, a thin one, one agent with its app, one dark plate, one light plate if the palette has one). Write them as SVG to `<work>/app/<id>.svg` and `<work>/agent/<id>.svg`, the id's `/` written as `~` (`david~media.svg`, `notes~librarian.svg`). `bun scripts/icons.ts preview --dir <work>` renders `<work>/preview.png` (dark and light panel backgrounds, agents with their corner, a 22px row). Read the PNG yourself and fix what is off, then show it to the operator and wait for their word.

6. **Draw the rest**, preview the whole set, look at it again with the checks below, and show the operator the PNG. Change only the tiles they name; re-preview.

7. **Install** once the operator approves: `bun scripts/icons.ts install --dir <work> --pack <name> --activate`. Tell them to reload the panel, that `bun scripts/icons.ts use none` brings the manifest icons back, and that the pack stays on this machine (`packs` lists them, `export --pack <name> --dir <d>` downloads one for later edits, `remove --pack <name> [--app ID | --agent ID]` deletes).

To change one or a few icons in an existing pack: `export` it, redraw those files to the same sheet (ask for the sheet's style if the pack has none on record), `preview --only <ids>`, then `install --pack <name> --only <ids>`.

## Rules that hold in every style

- **Canvas.** `viewBox="0 0 64 64"`, the plate filling the whole canvas as a rounded square (`rx` about 14). The panel clips the tile to its own rounded square and draws a 1px border around it: do not add an outer frame, inner ring or second border of your own; a style that wants an edge highlight draws one thin one, not a frame.
- **One language.** One plate treatment, one glyph construction (the same stroke width, caps, corner radius, fill rules) and one palette for the whole pack. No emoji, no photos or raster crops, no text or letters as glyphs (a currency sign is a symbol, not text), unless the operator's style explicitly asks for them.
- **Unique silhouettes.** No two tiles share a main glyph. The usual collisions: several finance apps as a rising line, documents with bar charts, several video apps as a play button, several search agents as a magnifier. Give each its own shape first (a funnel for a screener, a gauge for indicators, a dice for a simulator, an archive box for a filing app, a quote mark for opinions) and let the meaning follow.
- **Optical balance.** Keep glyphs inside the central live area (about 32 of 64 units); enlarge thin, open glyphs and shrink dense, filled ones until they weigh the same. Judge it on the preview, not by coordinates.
- **Legible at 22px.** An app icon also appears as the 26px corner of its agents' tiles. Check the preview's 22px row: a glyph that turns to mush there has too many details.
- **Colour has a job.** Neighbouring tiles should not look alike; spread hues across the grid, and keep a single hue from dominating unless the style is monochrome. White glyphs need enough contrast on light plates.
- **Agents.** The main icon shows the agent's *role* (planner, archivist, analyst, transcriber), never a copy of its app's icon; the panel adds the app's icon in the corner by itself, so do not draw a corner badge into the avatar. Make agents recognisable as a family (for example the app's hue, darkened), as the style sheet says.
- **The space agent and the built-in tiles** are tiles too: `agent/space~assistant` (the workspace assistant, "Base"), `app/space` (its corner, optional), `app/space~inbox`, `app/space~terminal`, `app/space~settings`.
- **Files.** SVG preferred (PNG or WebP accepted, at most 512 KB each). Self-contained: no external references, no scripts, no `<foreignObject>`; gradient and filter ids may repeat across files (each file is its own image).

## Answering

End with the preview PNG's path, the pack name and whether it is active, and the one command that undoes it. Do not paste SVG source into the reply.
