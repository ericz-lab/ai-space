import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// An app made and changed inside ai-space, against a real service: create from the template,
// open it through the package gateway, change the source, build, see the new version answer.

const REPO = resolve(import.meta.dir, "..", "..");
const TOKEN = "studio-test-token";
let root = "";
let base = "";
let gatewayPort = 0;
let proc: ReturnType<typeof Bun.spawn> | undefined;

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const p = s.port!;
  s.stop(true);
  return p;
}

const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) } });

/** Follows /_space/apps/<app> into the gateway as a browser would, by Host header on 127.0.0.1. */
async function openApp(app: string, path = "/"): Promise<(p: string) => Promise<Response>> {
  const entry = await fetch(`${base}/_space/apps/${app}?path=${encodeURIComponent(path)}`, { redirect: "manual", headers: { authorization: `Bearer ${TOKEN}` } });
  expect(entry.status).toBe(303);
  const ticketUrl = new URL(entry.headers.get("location")!);
  const host = ticketUrl.host;
  const viaLoopback = (u: URL) => `http://127.0.0.1:${gatewayPort}${u.pathname}${u.search}`;
  const first = await fetch(viaLoopback(ticketUrl), { redirect: "manual", headers: { host } });
  const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
  expect(cookie).toContain("=");
  return (p: string) => fetch(`http://127.0.0.1:${gatewayPort}${p}`, { headers: { host, cookie } });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "space-studio-"));
  const port = await freePort();
  gatewayPort = await freePort();
  const env = { PATH: process.env.PATH!, HOME: root, SPACE_HOME: join(root, "ws"), SPACE_PORT: String(port), SPACE_PACKAGE_PORT: String(gatewayPort), SPACE_API_TOKEN: TOKEN, SPACE_DEFAULT_APPS: "none" };
  const init = Bun.spawn([process.execPath, join(REPO, "src", "index.ts"), "init"], { env, stdout: "ignore", stderr: "ignore" });
  expect(await init.exited).toBe(0);
  proc = Bun.spawn([process.execPath, join(REPO, "src", "index.ts")], { env, stdout: "ignore", stderr: "ignore" });
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if ((await fetch(`${base}/healthz`).catch(() => undefined))?.ok) break;
    await Bun.sleep(100);
  }
});

afterAll(async () => {
  proc?.kill("SIGTERM");
  await proc?.exited;
  await rm(root, { recursive: true, force: true });
});

test("make an app, open it, change it, build it again", async () => {
  const made = await api("/api/studio/apps", { method: "POST", body: JSON.stringify({ name: "notes", title: "Notes", description: "Keep short notes." }) });
  const body = (await made.json()) as { ok: boolean; dir: string; build: { version: string; action: string } };
  expect(body).toMatchObject({ ok: true, build: { version: "0.1.0", action: "installed" } });
  const yaml = await Bun.file(join(body.dir, "space.yaml")).text();
  expect(yaml).toContain("name: notes");
  expect(yaml).toContain("title: Notes");
  expect(yaml).toContain("description: Keep short notes.");

  const open = await openApp("notes");
  const page = await open("/");
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("<title>Notes</title>");
  expect(await (await open("/api/hello")).json()).toMatchObject({ ok: true, message: "Hello from Notes" });

  // The app is listed with nothing changed since the build, and refuses a duplicate name.
  let list = (await (await api("/api/studio/apps")).json()) as { apps: { app: string; installed: string; changed: boolean }[] };
  expect(list.apps).toEqual([expect.objectContaining({ app: "notes", installed: "0.1.0", changed: false })]);
  expect((await api("/api/studio/apps", { method: "POST", body: JSON.stringify({ name: "notes" }) })).status).toBe(409);

  // A change in the source, as the assistant would make it, then a build: 0.1.1 answers.
  await Bun.sleep(20);
  const server = join(body.dir, "server.ts");
  await Bun.write(server, (await Bun.file(server).text()).replace("Hello from Notes", "Notes, changed"));
  list = (await (await api("/api/studio/apps")).json()) as typeof list;
  expect(list.apps[0]!.changed).toBe(true);
  const rebuilt = (await (await api("/api/studio/apps/notes/build", { method: "POST" })).json()) as { build: { version: string; action: string } };
  expect(rebuilt.build).toMatchObject({ version: "0.1.1", action: "upgraded" });
  expect(await Bun.file(join(body.dir, "space.yaml")).text()).toContain("version: 0.1.1");
  const again = await openApp("notes");
  expect(await (await again("/api/hello")).json()).toMatchObject({ message: "Notes, changed" });
}, 60_000);

test("a broken source is refused with the reason, and nothing installed changes", async () => {
  const made = (await (await api("/api/studio/apps", { method: "POST", body: JSON.stringify({ name: "broken" }) })).json()) as { dir: string };
  await Bun.write(join(made.dir, "space.yaml"), "spec: 2\nname: broken\n");
  const r = await api("/api/studio/apps/broken/build", { method: "POST" });
  expect(r.status).toBe(400);
  expect(((await r.json()) as { error: string }).error).toContain("space.yaml");
  expect((await api("/api/studio/apps/nope/build", { method: "POST" })).status).toBe(404);
  expect((await fetch(`${base}/api/studio/apps`)).status).toBe(401);
}, 60_000);
