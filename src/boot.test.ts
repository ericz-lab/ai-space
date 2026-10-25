import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The whole boot, as the service unit runs it: `bun src/index.ts` on an empty workspace, then a
// few requests that show the route table is wired with its guards, then SIGTERM and a clean exit.
// boot() wires every module in one function and is otherwise only reached by hand.

setDefaultTimeout(60_000);

type Booted = { base: string; home: string; proc: Bun.Subprocess<"ignore", "pipe", "pipe">; output: () => string };

const started: Booted[] = [];

async function boot(extra: Record<string, string> = {}): Promise<Booted> {
  const home = await mkdtemp(join(tmpdir(), "space-boot-"));
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    SPACE_HOME: join(home, "ws"),
    SPACE_HOST: "127.0.0.1",
    SPACE_PORT: "0",
    SPACE_NAME: "boot-test",
    SPACE_DEFAULT_APPS: "none",
    SPACE_ROUTER: "none",
    SPACE_DRAIN_SECONDS: "1",
    ...extra,
  };
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    for await (const chunk of stream) out += dec.decode(chunk, { stream: true });
  };
  void read(proc.stdout);
  void read(proc.stderr);
  const b: Booted = { base: "", home, proc, output: () => out };
  started.push(b);
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const m = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
    if (m) {
      b.base = m[1]!;
      return b;
    }
    if (proc.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new Error(`boot did not listen; output:\n${out}`);
}

async function stop(b: Booted): Promise<number> {
  b.proc.kill("SIGTERM");
  return await b.proc.exited;
}

afterEach(async () => {
  for (const b of started.splice(0)) {
    if (b.proc.exitCode === null) b.proc.kill("SIGKILL");
    await b.proc.exited;
    await rm(b.home, { recursive: true, force: true });
  }
});

describe("boot, external sign-in (the default)", () => {
  test("serves the API with its guards and exits 0 on SIGTERM after the drain", async () => {
    const b = await boot();
    const get = (path: string, headers: Record<string, string> = {}) => fetch(`${b.base}${path}`, { headers });

    expect((await get("/healthz")).status).toBe(200);
    expect(await (await get("/api/auth/session")).json()).toEqual({ ok: true, mode: "external" });
    // No SPACE_API_TOKEN: a loopback caller is the operator.
    expect((await get("/api/services")).status).toBe(200);
    // An unknown path is the JSON 404, not Bun's default page.
    const missing = await get("/api/no-such-route");
    expect([missing.status, await missing.json()]).toEqual([404, { ok: false, error: "not found" }]);
    // guardBrowserWrites is on the table: a tokenless write from another site is refused.
    const cross = await fetch(`${b.base}/api/auth/logout`, { method: "POST", headers: { origin: "http://elsewhere.test" } });
    expect(cross.status).toBe(403);

    expect(await stop(b)).toBe(0);
    expect(b.output()).toContain("[space] shutting down");
    expect(b.output()).toMatch(/\[space\] drained in \d+ms/);
  });
});

describe("boot, built-in sign-in", () => {
  test("writes an operator token, gates owner routes, and keeps public ones open", async () => {
    const b = await boot({ SPACE_AUTH: "builtin" });
    const tokenFile = join(b.home, "ws", "run", "operator-token");
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
    const token = (await Bun.file(tokenFile).text()).trim();
    expect(token.length).toBeGreaterThanOrEqual(40);

    expect((await fetch(`${b.base}/healthz`)).status).toBe(200);
    expect(await (await fetch(`${b.base}/api/auth/session`)).json()).toMatchObject({ mode: "builtin", initialized: false, signedIn: false });
    const anon = await fetch(`${b.base}/api/services`);
    expect([anon.status, await anon.json()]).toEqual([401, { ok: false, error: "sign-in required", auth: "uninitialized" }]);
    expect((await fetch(`${b.base}/api/services`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(`${b.base}/api/services`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(b.output()).toContain("no owner yet");

    expect(await stop(b)).toBe(0);
  });
});
