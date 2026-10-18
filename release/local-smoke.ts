/**
 * `bun release/local-smoke.ts "<AI Space.app>"`: proves the Local edition's service runs from the
 * resources packed inside the Mac app (release/local.ts), the prototype of
 * docs/editions.md#the-work-in-order step 5.
 *
 * The app is copied and its `Resources/space` made read-only, as a signed app must stay. The
 * service then starts with the bundled Bun, `PATH=/usr/bin:/bin`, a fresh home and workspace, and
 * `SPACE_EDITION=local`, as the app's background service would. Checked:
 *
 *   - /healthz, and GET /api/space says ai-space, the app's version, edition "local"
 *   - the panel: the HTML page, the script its HTML import bundled, a public file
 *   - the chat widget built at boot (/api/chat/widget.js)
 *   - the shared skills linked into the workspace, and SQLite (space.db) written there
 *   - a terminal session through the bundled forkpty helper: a command's output, a resize, job control
 *   - the runtime adapters list, whatever agent CLIs this machine has
 *   - nothing was written inside the app, and its signature still verifies
 */
import { cp, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PATH = "/usr/bin:/bin";
const TOKEN = "local-smoke-operator-token";

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: out + err };
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function waitFor(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
      if (res.ok) return res;
    } catch {}
    if (Date.now() > until) throw new Error(`${url} did not answer within ${ms / 1000}s`);
    await Bun.sleep(500);
  }
}

function check(ok: unknown, what: string, detail?: unknown): void {
  if (!ok) throw new Error(`${what}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  console.error(`[local-smoke] ok  ${what}`);
}

async function terminal(base: string): Promise<void> {
  const auth = { authorization: `Bearer ${TOKEN}`, origin: base, "content-type": "application/json" };
  const status = (await (await fetch(`${base}/api/terminal`, { headers: auth })).json()) as { enabled: boolean; backend?: string };
  check(status.enabled && status.backend === "helper", "terminal uses the bundled forkpty helper", status);
  const t = (await (await fetch(`${base}/api/terminal/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ cols: 90, rows: 25 }) })).json()) as { ticket: string };
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/terminal/ws?ticket=${encodeURIComponent(t.ticket)}`, { headers: { origin: base } } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  let out = "";
  const dec = new TextDecoder();
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") out += dec.decode(new Uint8Array(e.data as ArrayBuffer), { stream: true });
  };
  const wait = async (re: RegExp) => {
    const until = Date.now() + 10_000;
    while (!re.test(out)) {
      if (Date.now() > until) throw new Error(`terminal: no ${re} in ${JSON.stringify(out.slice(-400))}`);
      await Bun.sleep(50);
    }
  };
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)));
  const send = (s: string) => ws.send(new TextEncoder().encode(s));
  send("stty size; echo smoke-$((40+2))\n");
  await wait(/smoke-42/);
  check(/25 90/.test(out), "terminal runs a shell at the asked size");
  ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
  await Bun.sleep(150);
  send("stty size; sleep 30 & jobs; kill %1 && echo job-control-ok\n");
  await wait(/job-control-ok/);
  check(/43 132/.test(out), "terminal resizes and has job control");
  ws.close();
}

export async function smokeLocal(appPath: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "space-local-smoke-"));
  let server: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const app = join(root, "AI Space.app");
    await cp(resolve(appPath), app, { recursive: true, verbatimSymlinks: true });
    const payload = join(app, "Contents", "Resources", "space");
    const info = (await Bun.file(join(payload, "RELEASE.json")).json()) as { version: string; edition: string };
    check(info.edition === "local", "the app carries a Local release", info);
    const marker = join(root, "started");
    await Bun.write(marker, "");
    await sh(["chmod", "-R", "a-w", payload]);

    const home = join(root, "home");
    const ws = join(home, ".ai-space");
    const bun = join(payload, "runtime", "bun");
    const env = { PATH, HOME: home, SPACE_HOME: ws, SPACE_EDITION: "local", SPACE_DEFAULT_APPS: "none", SPACE_API_TOKEN: TOKEN, SPACE_TERMINAL_ENABLED: "1", SPACE_TERMINAL_SHELL: "/bin/sh", TMPDIR: join(root, "tmp") };
    await sh(["mkdir", "-p", env.TMPDIR]);
    const init = Bun.spawn([bun, join(payload, "src", "index.ts"), "init"], { cwd: home.replace(/\/home$/, ""), env, stdout: "inherit", stderr: "inherit" });
    check((await init.exited) === 0, "init creates the workspace from the bundle");

    const port = await freePort();
    server = Bun.spawn([bun, join(payload, "src", "index.ts")], { cwd: root, env: { ...env, SPACE_PORT: String(port) }, stdout: "inherit", stderr: "inherit" });
    const base = `http://127.0.0.1:${port}`;
    await waitFor(`${base}/healthz`, 60_000);
    const id = (await (await waitFor(`${base}/api/space`, 5_000)).json()) as { product: string; version: string; edition: string };
    check(id.product === "ai-space" && id.version === info.version && id.edition === "local", "the service says ai-space, the app's version, edition local", id);

    const page = await waitFor(`${base}/`, 30_000);
    const html = await page.text();
    check((page.headers.get("content-type") ?? "").includes("text/html"), "the panel page is HTML");
    const script = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
    check(script && !script.endsWith(".tsx"), "the HTML import bundled the panel's script", script);
    const js = await waitFor(new URL(script!, base).href, 10_000);
    check((await js.text()).length > 50_000, "the panel's script is served");
    const css = /<link[^>]+href="([^"]+\.css)"/.exec(html)?.[1];
    if (css) check((await fetch(new URL(css, base))).ok, "the panel's stylesheet is served");
    check((await fetch(`${base}/manifest.webmanifest`)).ok || (await fetch(`${base}/favicon.svg`)).ok || (await fetch(`${base}/icon.svg`)).ok, "a public file is served");

    const widget = await fetch(`${base}/api/chat/widget.js`);
    check(widget.ok && (await widget.text()).length > 1000, "the chat widget was built from the bundle");

    const skills = await readdir(join(ws, ".claude", "skills")).catch(() => [] as string[]);
    check(skills.length > 0, "the shared skills are linked into the workspace", skills);
    check((await stat(join(ws, "data", "space.db")).catch(() => stat(join(ws, "space.db")))).size > 0, "SQLite: space.db written in the workspace");

    await terminal(base);

    const agents = (await (await fetch(`${base}/api/agents`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as { agents?: { id: string }[] };
    check(Array.isArray(agents.agents), "the runtime adapters answer", agents);
    console.error(`[local-smoke] agents here: ${agents.agents!.map((a) => a.id).join(", ") || "none"}`);

    server.kill("SIGTERM");
    await server.exited;
    server = undefined;
    const written = (await sh(["find", payload, "-newer", marker, "-not", "-type", "d"])).out.trim();
    check(written === "", "nothing was written inside the app", written);
    await sh(["chmod", "-R", "u+w", payload]);
    const verify = await sh(["codesign", "--verify", "--strict", "--deep", app]);
    check(verify.code === 0, "the app's signature still verifies", verify.out);
    console.log(`local smoke ok: ${info.version}, service ran from the app bundle`);
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await server.exited;
    }
    await sh(["chmod", "-R", "u+w", root]);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const app = process.argv[2];
  if (!app) {
    console.error('usage: bun release/local-smoke.ts "<AI Space.app>"');
    process.exit(2);
  }
  await smokeLocal(app);
}
