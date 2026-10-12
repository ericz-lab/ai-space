import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { workspacePaths } from "../workspace.ts";
import { PackageInstaller } from "./install.ts";
import { PackageLifecycle } from "./lifecycle.ts";
import { inspectPackage, packApplication, readPackageFile } from "./pack.ts";
import { PackageRuntime } from "./runtime.ts";
import { PackageStore } from "./store.ts";

/** Repeatable migration evidence against a source checkout, always in a fresh temporary workspace. */
export async function keepPilot(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "space-keep-package-pilot-"));
  const ws = workspacePaths(join(root, "workspace"));
  await mkdir(ws.apps, { recursive: true }); await mkdir(ws.data);
  const legacyYaml = await Bun.file(join(source, "space.yaml")).text();
  const legacy = Bun.YAML.parse(legacyYaml) as Record<string, unknown>;
  if (legacy.name !== "keep" || legacy.spec !== 1) throw new Error("pilot requires the keep spec-1 source checkout");
  const { service: _service, url: _url, deploy: _deploy, spec: _spec, ...components } = legacy;
  const declaration = (version: string, mode: string, entry = "server.mjs") => Bun.YAML.stringify({
    ...components, spec: 2, version, requires: { spaceApi: 1, bun: "1.3.0" },
    offline: { features: ["Read existing collections", "Save and search text notes", "Edit highlights"], online: ["Worker collection and transcription", "AI summaries", "Remote media and archive retrieval"] },
    launch: { kind: "process", runtime: "bun", entry, health: "/healthz", mode },
  });
  const include = ["server.mjs", "lib.mjs", "archives.mjs", "bookmark-status.mjs", "ai.mjs", "blob.mjs", "env.mjs", "public"];
  const artifact = join(root, "keep-1.0.0.spaceapp");
  await packApplication({ dir: source, include, output: artifact, target: { os: "any", arch: "any" }, sourceIncluded: true, manifest: declaration("1.0.0", "on-demand") });
  const bytes = await readPackageFile(artifact), inspected = await inspectPackage(bytes);
  const oldDir = join(ws.apps, "keep"); await mkdir(oldDir);
  // Simulate the old deployment using exactly the selected code; never copy host config or user data.
  for (const file of inspected.files.values()) if (file.path !== "space.yaml") await Bun.write(join(oldDir, file.path), file.bytes);
  await Bun.write(join(oldDir, "space.yaml"), legacyYaml);
  const database = join(ws.data, "keep", "keep.db");
  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); const oldPort = listener.port; listener.stop(true);
  const oldProcess = Bun.spawn([process.execPath, "server.mjs"], { cwd: oldDir, env: { PATH: process.env.PATH, PORT: String(oldPort), DATABASE_URL_KEEP: `sqlite://${database}` }, stdout: "ignore", stderr: "pipe" });
  const db = new Database(join(ws.data, "space.db"));
  const store = new PackageStore(db), installer = new PackageInstaller(ws, store);
  const runtime = new PackageRuntime({ logDir: ws.logs, envFor: async () => ({ DATABASE_URL_KEEP: `sqlite://${database}` }) });
  const lifecycle = new PackageLifecycle(installer, { suspend: (app) => runtime.suspend(app), remove: (app) => runtime.remove(app), activate: async (app) => runtime.register(await installer.load(app)), verify: (app) => runtime.verify(app) });
  const cases: string[] = [];
  const request = async (path: string, body?: unknown) => {
    const lease = await runtime.acquire("keep");
    try {
      const r = await fetch(`http://127.0.0.1:${lease.port}${path}`, { ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
      const data = await r.json() as { ok: boolean; data: unknown[] };
      if (!r.ok || data.ok === false) throw new Error(`pilot request failed: ${path}`);
      return data;
    } finally { lease.release(); }
  };
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${oldPort}/healthz`)).ok) { ready = true; break; } } catch {}
      if (oldProcess.exitCode !== null) throw new Error("legacy pilot process exited");
      await Bun.sleep(25);
    }
    if (!ready) throw new Error("legacy pilot health timed out");
    const seeded = await fetch(`http://127.0.0.1:${oldPort}/api/collect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "package migration preserved note" }) });
    if (!seeded.ok) throw new Error("legacy seed request failed"); await seeded.body?.cancel();
    const before = await (await fetch(`http://127.0.0.1:${oldPort}/api/items`)).json();
    oldProcess.kill("SIGTERM"); await oldProcess.exited;
    await rename(oldDir, join(root, "legacy-retained"));
    const installed = await installer.install(bytes, { allowUnsigned: true });
    if (installed.state !== "installed") throw new Error(installed.error ?? "install failed");
    await runtime.register(await installer.load("keep"));
    if (runtime.status("keep")?.state !== "idle") throw new Error("on-demand app started before use");
    if (JSON.stringify(await request("/api/items")) !== JSON.stringify(before)) throw new Error("legacy data changed during migration");
    cases.push("legacy API-created data survives migration", "on-demand starts only on first use");
    await request("/api/bookmarks/sync-status"); cases.push("existing daily inspection endpoint works");
    const second = join(root, "keep-1.0.1.spaceapp");
    await packApplication({ dir: source, include, output: second, target: { os: "any", arch: "any" }, sourceIncluded: true, manifest: declaration("1.0.1", "background") });
    if ((await lifecycle.upgrade(await readPackageFile(second), { allowUnsigned: true })).state !== "done") throw new Error("background upgrade failed");
    if (runtime.status("keep")?.state !== "running") throw new Error("background launch did not start");
    await request("/api/collect", { text: "new note after package upgrade" });
    if ((await lifecycle.rollback("keep", installed.id)).state !== "done") throw new Error("pilot rollback failed");
    if ((await request("/api/items")).data.length !== 2) throw new Error("code rollback lost data");
    cases.push("background upgrade starts immediately", "code rollback preserves old and new notes");
    const compiled = join(root, "compiled"); await mkdir(compiled);
    const build = await Bun.build({ entrypoints: [join(source, "server.mjs")], target: "bun", outdir: compiled, naming: "server.js", minify: true });
    if (!build.success) throw new Error("prebuilt pilot failed to bundle");
    for (const f of inspected.files.values()) if (f.path.startsWith("public/")) await Bun.write(join(compiled, f.path), f.bytes);
    await Bun.write(join(compiled, "space.yaml"), declaration("1.0.2", "on-demand", "server.js"));
    const third = join(root, "keep-1.0.2-prebuilt.spaceapp");
    await packApplication({ dir: compiled, include: ["server.js", "public"], output: third, target: { os: "any", arch: "any" }, sourceIncluded: false });
    if ((await lifecycle.upgrade(await readPackageFile(third), { allowUnsigned: true })).state !== "done") throw new Error("prebuilt upgrade failed");
    if ((await request("/api/items")).data.length !== 2) throw new Error("prebuilt package lost data");
    cases.push("prebuilt bundle works without original source or dependency installation");
    const git = Bun.spawn(["git", "-C", source, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
    const sourceRevision = (await new Response(git.stdout).text()).trim(); await git.exited;
    await Bun.write(join(root, "evidence.json"), JSON.stringify({ source, sourceRevision, workspace: ws.home, artifacts: [artifact, second, third], cases, notes: "Isolated pilot data only. Worker, cloud AI and external archives require their own configured dependencies; production was not migrated." }, null, 2));
    return root;
  } finally {
    if (oldProcess.exitCode === null) { oldProcess.kill("SIGTERM"); await oldProcess.exited; }
    await lifecycle.drain(); await installer.drain(); await runtime.close(0); db.close();
  }
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) throw new Error("usage: bun run package-pilot /path/to/keep/source");
  console.log(await keepPilot(resolve(source)));
}
