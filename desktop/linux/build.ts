/**
 * `bun desktop/linux/build.ts [--out <dir>] [--local]`: the Linux client as a directory that runs
 * where it lies (default desktop/linux/build/ai-space):
 *
 *   main.js                 the app (src/main.ts bundled for GJS; gi:// imports stay external)
 *   ball.js                 the floating ball's process (src/ball/ball.ts, GTK 3 on X11)
 *   terminal/terminal.js    xterm.js and the session glue, loaded into the terminal's web view
 *   terminal/xterm.css
 *   data/icons/…            the app icon (hicolor), shared with the Mac app's
 *   share/                  the desktop entry and AppStream metadata, for install.sh
 *   bin/ai-space            the launcher (desktop/linux/ai-space.sh): `gjs -m main.js`
 *   install.sh              installs it for this user (desktop/linux/install.sh)
 *   VERSION.json            version, commit, edition
 *   space/                  --local only: the Local edition's release tree (release/server.ts
 *                           stageRelease) with runtime/bun and runtime/space-pty
 */
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SPACE_ROOT } from "../../src/space/config.ts";
import { readVersion } from "../../src/space/version.ts";
import { run, stageRelease } from "../../release/server.ts";

const HERE = join(SPACE_ROOT, "desktop", "linux");
export const APP_ID = "dev.ai_space.Desktop";

async function bundle(entry: string, outfile: string, opts: { format: "esm" | "iife"; target: "browser"; external?: string[]; minify?: boolean }): Promise<void> {
  const r = await Bun.build({ entrypoints: [entry], target: opts.target, format: opts.format, external: opts.external ?? [], minify: opts.minify ?? false, sourcemap: "none" });
  if (!r.success) throw new Error(`${entry}: ${r.logs.map((l) => l.message).join("\n")}`);
  await Bun.write(outfile, await r.outputs[0]!.text());
}

export async function buildLinux(opts: { out?: string; local?: boolean; root?: string } = {}): Promise<{ dir: string; version: string; commit: string; edition: "client" | "local" }> {
  const root = opts.root ?? SPACE_ROOT;
  const dir = resolve(opts.out ?? join(HERE, "build", "ai-space"));
  const edition = opts.local ? "local" : "client";
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, "terminal"), { recursive: true });

  // GJS has no fetch, URL or Node built-ins: the bundle keeps gi:// and `system` as its imports.
  await bundle(join(HERE, "src", "main.ts"), join(dir, "main.js"), { format: "esm", target: "browser", external: ["gi://*", "system"] });
  // The floating ball's own process: GTK 3 on X11 (src/ball/ball.ts).
  await bundle(join(HERE, "src", "ball", "ball.ts"), join(dir, "ball.js"), { format: "esm", target: "browser", external: ["gi://*", "system", "cairo"] });
  await bundle(join(HERE, "terminal", "terminal.ts"), join(dir, "terminal", "terminal.js"), { format: "iife", target: "browser", minify: true });
  await cp(join(root, "node_modules", "@xterm", "xterm", "css", "xterm.css"), join(dir, "terminal", "xterm.css"));

  const icons = join(dir, "data", "icons", "hicolor", "scalable", "apps");
  await mkdir(icons, { recursive: true });
  await cp(join(root, "desktop", "macos", "AISpace", "Resources", "AppIcon.svg"), join(icons, `${APP_ID}.svg`));
  await cp(join(HERE, "share"), join(dir, "share"), { recursive: true });
  await mkdir(join(dir, "bin"), { recursive: true });
  await cp(join(HERE, "ai-space.sh"), join(dir, "bin", "ai-space"));
  await chmod(join(dir, "bin", "ai-space"), 0o755);
  await cp(join(HERE, "install.sh"), join(dir, "install.sh"));
  await chmod(join(dir, "install.sh"), 0o755);

  const version = await readVersion(root);
  const commit = (process.env.GITHUB_SHA || (await run(["git", "rev-parse", "HEAD"], root).catch(() => ""))).trim();
  await Bun.write(join(dir, "VERSION.json"), `${JSON.stringify({ version, commit, edition }, null, 2)}\n`);

  if (opts.local) {
    const space = join(dir, "space");
    await stageRelease({ root, stage: space, edition: "local" });
    await run(["cc", "-O2", "-Wall", "-o", join(space, "runtime", "space-pty"), join(root, "src", "space", "terminal", "pty_helper.c")], root);
  }
  console.error(`[linux] ${edition} ${version} → ${dir}`);
  return { dir, version, commit, edition };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--out");
  console.log((await buildLinux({ ...(i >= 0 && argv[i + 1] ? { out: argv[i + 1] } : {}), local: argv.includes("--local") })).dir);
}
