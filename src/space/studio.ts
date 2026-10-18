import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isOperator } from "./auth.ts";
import { SPACE_ROOT } from "./config.ts";
import { whichUsable } from "./host-tools.ts";
import type { PackageInstaller } from "./packages/install.ts";
import type { PackageLifecycle } from "./packages/lifecycle.ts";
import { parsePackageManifest } from "./packages/manifest.ts";
import { packApplication } from "./packages/pack.ts";
import type { PackageStore } from "./packages/store.ts";
import type { Workspace } from "./workspace.ts";

/**
 * Apps made and changed inside ai-space (docs/app-studio.md): no GitHub, no coding tool outside
 * the product. An app's source is `<workspace>/app-src/<app>/`, made from the package template;
 * `build` packs it as it is into a `.spaceapp` (source included) and installs it through the
 * package installer, or upgrades the installed one, raising the patch version each time. Whoever
 * changes the source in between (the Space Assistant in a chat, the user in the web terminal, an
 * editor) does it on this machine; the package lifecycle keeps the previous version for a rollback.
 *
 *   GET  /api/studio/apps                    owner: the apps with a spec-2 source, installed version, changed since the last build
 *   POST /api/studio/apps        {name, title?, description?}   owner: make the source from the template, build and install it
 *   POST /api/studio/apps/:app/build                            owner: pack the source and install or upgrade
 */

export const PACKAGE_TEMPLATE = join(SPACE_ROOT, "skills", "space-app", "package-template");
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PLACEHOLDERS = { name: "my-app", title: "My App", description: "One sentence saying what the app does." };
/** Never packed: version control, dependencies installed in place, local secrets, earlier builds. */
const EXCLUDE = new Set([".git", "node_modules", ".env", ".DS_Store", "data", "dist-packages"]);

export class StudioError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type StudioDeps = {
  ws: Workspace;
  installer: PackageInstaller;
  lifecycle: PackageLifecycle;
  store: PackageStore;
  /** What `POST /api/packages` does after a first install: register the app with the Space. */
  activate: (app: string) => Promise<void>;
  templateDir?: string;
  log?: (line: string) => void;
};

export const sourceDir = (ws: Workspace, app: string) => join(ws.home, "app-src", app);

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function files(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await files(dir, p)));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** The source of a new app, from the package template. A local Git history when git is installed; never a remote. */
export async function createSource(d: StudioDeps, input: { name: string; title?: string; description?: string }): Promise<string> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) throw new StudioError("the name must be lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit");
  if (d.store.list().some((o) => o.app === name && o.state === "installed")) throw new StudioError(`an app named ${name} is already installed`, 409);
  const dir = sourceDir(d.ws, name);
  if (await exists(dir)) throw new StudioError(`${dir} already exists`, 409);
  const title = input.title?.trim() || name;
  const description = input.description?.trim().replace(/\s+/g, " ").slice(0, 300) || `${title}, made in ai-space.`;
  await mkdir(join(d.ws.home, "app-src"), { recursive: true });
  await cp(d.templateDir ?? PACKAGE_TEMPLATE, dir, { recursive: true });
  for (const f of await files(dir)) {
    const text = await Bun.file(join(dir, f)).text();
    // The description first: it contains the title's placeholder words in no template, but keep the order fixed.
    const filled = text.replaceAll(PLACEHOLDERS.description, description.replace(/"/g, "'")).replaceAll(PLACEHOLDERS.title, title).replaceAll(PLACEHOLDERS.name, name);
    if (filled !== text) await Bun.write(join(dir, f), filled);
  }
  const git = whichUsable("git");
  if (git) {
    const run = (args: string[]) => Bun.spawnSync([git, ...args], { cwd: dir, stdout: "ignore", stderr: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "ai-space", GIT_AUTHOR_EMAIL: "ai-space@localhost", GIT_COMMITTER_NAME: "ai-space", GIT_COMMITTER_EMAIL: "ai-space@localhost" } });
    if (run(["init", "-q"]).exitCode === 0) {
      run(["add", "-A"]);
      run(["commit", "-qm", "New app from the ai-space template"]);
    }
  }
  d.log?.(`created ${dir}`);
  return dir;
}

/** `major.minor.patch` with the patch raised. */
export function nextPatch(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new StudioError(`version ${version} is not major.minor.patch`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export type BuildResult = { app: string; version: string; action: "installed" | "upgraded"; package: string };

/**
 * Pack the source and install it, or upgrade the installed app. The version in `space.yaml` is
 * raised when it is not above the installed one, and written back, so the source says what runs.
 */
export async function buildSource(d: StudioDeps, app: string): Promise<BuildResult> {
  if (!NAME_RE.test(app)) throw new StudioError("bad app name");
  const dir = sourceDir(d.ws, app);
  const manifestPath = join(dir, "space.yaml");
  if (!(await exists(manifestPath))) throw new StudioError(`no source at ${dir}`, 404);
  let yaml = await Bun.file(manifestPath).text();
  let manifest;
  try {
    manifest = parsePackageManifest(yaml);
  } catch (e) {
    throw new StudioError(`space.yaml: ${(e as Error).message}`);
  }
  if (manifest.app !== app) throw new StudioError(`space.yaml names the app ${manifest.app}, not ${app}`);
  const installed = d.store.list().find((o) => o.app === app && o.state === "installed");
  if (installed && !newer(manifest.version, installed.version)) {
    const version = nextPatch(installed.version);
    yaml = yaml.replace(/^version:\s*\S+/m, `version: ${version}`);
    await Bun.write(manifestPath, yaml);
    manifest = parsePackageManifest(yaml);
  }

  const include = (await readdir(dir)).filter((n) => !EXCLUDE.has(n) && !n.endsWith(".spaceapp")).sort();
  const outDir = join(d.ws.run, "studio");
  await mkdir(outDir, { recursive: true });
  const output = join(outDir, `${app}-${manifest.version}.spaceapp`);
  await rm(output, { force: true });
  try {
    await packApplication({ dir, include, output, target: { os: "any", arch: "any" }, sourceIncluded: true });
  } catch (e) {
    throw new StudioError(`pack: ${(e as Error).message}`);
  }
  const bytes = new Uint8Array(await Bun.file(output).arrayBuffer());
  d.log?.(`${installed ? "upgrading" : "installing"} ${app} ${manifest.version}`);
  if (installed) {
    const change = await d.lifecycle.upgrade(bytes, { allowUnsigned: true });
    if (change.state !== "done") throw new StudioError(`upgrade failed: ${(change as { error?: string }).error ?? change.state}`, 409);
    return { app, version: manifest.version, action: "upgraded", package: output };
  }
  const op = await d.installer.install(bytes, { allowUnsigned: true });
  if (op.state !== "installed") throw new StudioError(`install failed: ${op.error ?? op.state}`, 409);
  await d.activate(app);
  return { app, version: manifest.version, action: "installed", package: output };
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export type StudioApp = { app: string; title: string; version: string; installed: string | null; changed: boolean; dir: string };

/** Spec-2 sources under app-src, with what is installed and whether the source moved on since. */
export async function listSources(d: StudioDeps): Promise<StudioApp[]> {
  const root = join(d.ws.home, "app-src");
  const names = await readdir(root).catch(() => [] as string[]);
  const out: StudioApp[] = [];
  for (const app of names.sort()) {
    const dir = join(root, app);
    let manifest;
    try {
      manifest = parsePackageManifest(await Bun.file(join(dir, "space.yaml")).text());
    } catch {
      continue; // a spec-1 checkout or not an app: not the studio's
    }
    const installed = d.store.list().find((o) => o.app === app && o.state === "installed");
    const built = installed ? await stat(join(d.ws.run, "studio", `${app}-${installed.version}.spaceapp`)).then((s) => s.mtimeMs, () => 0) : 0;
    let changed = !installed;
    if (installed) {
      for (const f of await files(dir)) {
        if (f.split("/").some((p) => EXCLUDE.has(p))) continue;
        if ((await stat(join(dir, f))).mtimeMs > built) {
          changed = true;
          break;
        }
      }
    }
    out.push({ app, title: manifest.title ?? app, version: manifest.version, installed: installed?.version ?? null, changed, dir });
  }
  return out;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

export function createStudioRoutes(d: StudioDeps & { token: string }) {
  const guard = async (req: Request, work: () => Promise<unknown>) => {
    if (!isOperator(req, d.token)) return json({ ok: false, error: "unauthorized" }, 401);
    try {
      return json({ ok: true, ...(await work() as object) });
    } catch (e) {
      if (e instanceof StudioError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  };
  // One build at a time: two would race on the same source and package lifecycle.
  let busy: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = busy.then(f, f);
    busy = next.catch(() => {});
    return next;
  };
  return {
    "/api/studio/apps": {
      GET: (req: Request) => guard(req, async () => ({ apps: await listSources(d) })),
      POST: (req: Request) =>
        guard(req, () =>
          serial(async () => {
            const b = (await req.json().catch(() => ({}))) as { name?: string; title?: string; description?: string };
            if (typeof b.name !== "string") throw new StudioError("name is required");
            const dir = await createSource(d, { name: b.name, ...(b.title ? { title: b.title } : {}), ...(b.description ? { description: b.description } : {}) });
            return { dir, build: await buildSource(d, b.name.trim()) };
          }),
        ),
    },
    "/api/studio/apps/:app/build": {
      POST: (req: Request & { params: Record<string, string> }) => guard(req, () => serial(async () => ({ build: await buildSource(d, req.params.app!) }))),
    },
  };
}

