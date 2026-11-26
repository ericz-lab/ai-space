/**
 * `bun desktop/linux/build.ts [--out <dir>]`: the Linux client as a directory that runs
 * where it lies (default desktop/linux/build/ai-space):
 *
 *   main.js                 the app (src/main.ts bundled for GJS; gi:// imports stay external)
 *   ball.js                 the floating ball's process (src/ball/ball.ts, GTK 3 on X11)
 *   pet.js                  the desk pet's process on the desktop (src/pet/pet.ts, GTK 3 on X11)
 *   pet-claude.webp         the desk pet's sprite sheet, the web panel's (src/web/public)
 *   hud.js                  the capsule of `ai-space --dictate` (src/hud/hud.ts, GTK 3 on X11)
 *   terminal/terminal.js    xterm.js and the session glue, loaded into the terminal's web view
 *   terminal/xterm.css
 *   data/icons/…            the app icon (hicolor), shared with the Mac app's
 *   data/builtin/…          the pictures of the panel's own tiles (App Store, Inbox, Shortcuts,
 *                           Terminal, Settings), the web panel's files (src/web/public)
 *   share/                  the desktop entry and AppStream metadata, for install.sh
 *   bin/ai-space            the launcher (desktop/linux/ai-space.sh): `gjs -m main.js`
 *   install.sh              installs it for this user (desktop/linux/install.sh)
 *   VERSION.json            version, commit
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SPACE_ROOT } from "../../src/space/config.ts";
import { readVersion } from "../../src/space/version.ts";
import { run } from "../../release/server.ts";
import { BUILTIN_ART } from "./src/core/screens.ts";

const HERE = join(SPACE_ROOT, "desktop", "linux");
export const APP_ID = "dev.ai_space.Desktop";

async function bundle(entry: string, outfile: string, opts: { format: "esm" | "iife"; target: "browser"; external?: string[]; minify?: boolean }): Promise<void> {
  const r = await Bun.build({ entrypoints: [entry], target: opts.target, format: opts.format, external: opts.external ?? [], minify: opts.minify ?? false, sourcemap: "none" });
  if (!r.success) throw new Error(`${entry}: ${r.logs.map((l) => l.message).join("\n")}`);
  await Bun.write(outfile, await r.outputs[0]!.text());
}

export async function buildLinux(opts: { out?: string; root?: string } = {}): Promise<{ dir: string; version: string; commit: string }> {
  const root = opts.root ?? SPACE_ROOT;
  const dir = resolve(opts.out ?? join(HERE, "build", "ai-space"));
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "terminal"), { recursive: true });

  // GJS has no fetch, URL or Node built-ins: the bundle keeps gi:// and `system` as its imports.
  await bundle(join(HERE, "src", "main.ts"), join(dir, "main.js"), { format: "esm", target: "browser", external: ["gi://*", "system"] });
  // The floating ball's own process: GTK 3 on X11 (src/ball/ball.ts).
  await bundle(join(HERE, "src", "ball", "ball.ts"), join(dir, "ball.js"), { format: "esm", target: "browser", external: ["gi://*", "system", "cairo"] });
  // The desk pet on the desktop, the same way (src/pet/pet.ts), and the web's Claude it draws.
  await bundle(join(HERE, "src", "pet", "pet.ts"), join(dir, "pet.js"), { format: "esm", target: "browser", external: ["gi://*", "system", "cairo"] });
  await cp(join(root, "src", "web", "public", "pet-claude.webp"), join(dir, "pet-claude.webp"));
  // The capsule voice input in any app shows its words in, the same way (src/hud/hud.ts).
  await bundle(join(HERE, "src", "hud", "hud.ts"), join(dir, "hud.js"), { format: "esm", target: "browser", external: ["gi://*", "system", "cairo"] });
  await bundle(join(HERE, "terminal", "terminal.ts"), join(dir, "terminal", "terminal.js"), { format: "iife", target: "browser", minify: true });
  await cp(join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css"), join(dir, "terminal", "xterm.css"));

  const icons = join(dir, "data", "icons", "hicolor", "scalable", "apps");
  await mkdir(icons, { recursive: true });
  await cp(join(root, "desktop", "macos", "AISpace", "Resources", "AppIcon.svg"), join(icons, `${APP_ID}.svg`));
  // The panel's own tiles are drawn with the panel's pictures (src/core/screens.ts BUILTIN_ART).
  await mkdir(join(dir, "data", "builtin"), { recursive: true });
  for (const file of Object.values(BUILTIN_ART)) await cp(join(root, "src", "web", "public", file), join(dir, "data", "builtin", file));
  await cp(join(HERE, "share"), join(dir, "share"), { recursive: true });
  await mkdir(join(dir, "bin"), { recursive: true });
  await cp(join(HERE, "ai-space.sh"), join(dir, "bin", "ai-space"));
  await chmod(join(dir, "bin", "ai-space"), 0o755);
  await cp(join(HERE, "install.sh"), join(dir, "install.sh"));
  await chmod(join(dir, "install.sh"), 0o755);

  const version = await readVersion(root);
  const commit = (process.env.GITHUB_SHA || (await run(["git", "rev-parse", "HEAD"], root).catch(() => ""))).trim();
  await Bun.write(join(dir, "VERSION.json"), `${JSON.stringify({ version, commit }, null, 2)}\n`);
  console.error(`[linux] ${version} → ${dir}`);
  return { dir, version, commit };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  console.log((await buildLinux(i >= 0 && argv[i + 1] ? { out: argv[i + 1] } : {})).dir);
}
