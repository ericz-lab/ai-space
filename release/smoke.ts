/**
 * `bun release/smoke.ts <archive.tar.gz> [<next archive.tar.gz>]`: proves a Server release runs
 * from its own files on a machine with no Bun on PATH, and that an upgrade keeps the workspace
 * (docs/release.md).
 *
 * 1. Unpack the archive; `init` and start the service with its bundled Bun, PATH=/usr/bin:/bin, in
 *    a fresh workspace; wait for /healthz; check GET /api/space (product, version, edition) and
 *    that the panel page and the `space` command answer; stop it with SIGTERM.
 * 2. Start the next archive (the same one when none is given) against the same workspace: it must
 *    report its own version and the same Space id, which lives in the workspace database.
 *
 * No systemd: the unit and its health check are deploy/install.sh's, run on a real machine.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Identity = { product: string; version: string; edition: string; id: string };

const PATH = "/usr/bin:/bin";

async function unpack(archive: string, into: string): Promise<{ dir: string; version: string }> {
  const tar = Bun.spawn(["tar", "-xzf", resolve(archive), "-C", into], { stderr: "inherit" });
  if ((await tar.exited) !== 0) throw new Error(`tar -xzf ${archive} failed`);
  const [name] = (await readdir(into)).filter((n) => n.startsWith("ai-space-server-"));
  if (!name) throw new Error(`${archive}: no ai-space-server-* directory inside`);
  const dir = join(into, name);
  const info = (await Bun.file(join(dir, "RELEASE.json")).json()) as { version: string };
  return { dir, version: info.version };
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function waitFor(url: string, ms: number): Promise<Response> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res;
    } catch {}
    if (Date.now() > until) throw new Error(`${url} did not answer within ${ms / 1000}s`);
    await Bun.sleep(500);
  }
}

async function boot(dir: string, home: string, expect: { version: string; id?: string }): Promise<Identity> {
  const bun = join(dir, "runtime", "bun");
  const env = { PATH, HOME: home, SPACE_HOME: join(home, "ws"), SPACE_DEFAULT_APPS: "none" };
  const init = Bun.spawn([bun, "src/index.ts", "init"], { cwd: dir, env, stdout: "inherit", stderr: "inherit" });
  if ((await init.exited) !== 0) throw new Error("init failed");

  const port = await freePort();
  const server = Bun.spawn([bun, "src/index.ts"], { cwd: dir, env: { ...env, SPACE_PORT: String(port) }, stdout: "inherit", stderr: "inherit" });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/healthz`, 60_000);
    const id = (await (await waitFor(`${base}/api/space`, 5_000)).json()) as Identity;
    const fail = (what: string) => {
      throw new Error(`${what}: ${JSON.stringify(id)}`);
    };
    if (id.product !== "ai-space") fail("not an ai-space");
    if (id.version !== expect.version) fail(`version is not ${expect.version}`);
    if (id.edition !== "server") fail("edition is not server");
    if (expect.id && id.id !== expect.id) fail(`Space id changed from ${expect.id}`);
    const page = await waitFor(`${base}/`, 30_000);
    if (!(page.headers.get("content-type") ?? "").includes("text/html")) throw new Error("the panel page is not HTML");
    const cli = Bun.spawn(["bash", join(dir, "bin", "space"), "help"], { env, stdout: "pipe", stderr: "inherit" });
    if ((await cli.exited) !== 0) throw new Error("bin/space help failed");
    console.error(`[smoke] ${id.version} up on ${base}, Space ${id.id}`);
    return id;
  } finally {
    server.kill("SIGTERM");
    await server.exited;
  }
}

if (import.meta.main) {
  const [first, next] = process.argv.slice(2);
  if (!first) {
    console.error("usage: bun release/smoke.ts <archive.tar.gz> [<next archive.tar.gz>]");
    process.exit(2);
  }
  const root = await mkdtemp(join(tmpdir(), "space-smoke-"));
  try {
    const home = join(root, "home");
    const a = await unpack(first, await mkdtemp(join(root, "a-")));
    const before = await boot(a.dir, home, { version: a.version });
    const b = await unpack(next ?? first, await mkdtemp(join(root, "b-")));
    await boot(b.dir, home, { version: b.version, id: before.id });
    console.log(`smoke ok: ${a.version} → ${b.version}, workspace kept (Space ${before.id})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
