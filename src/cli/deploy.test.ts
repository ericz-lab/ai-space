import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./testing.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-cli-deploy-"));
  await mkdir(join(home, "apps", "a"), { recursive: true });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const env = () => ({ env: { SPACE_HOME: home, SPACE_API_TOKEN: "op-token" } });
const write = (deploy: string) => Bun.write(join(home, "apps", "a", "space.yaml"), `name: a\nservice: { command: bun src/index.ts, port: 8710, health: /healthz }\n${deploy}\n`);
const svc = (action: string, supervisor = "space") => ({ status: 200, body: { service: { app: "a", supervisor, unit: "space-a.service", last: { action } } } });

test("app deploy: commands pass, sync, restart an unchanged unit, wait for health", async () => {
  await write("deploy: { check: 'true', build: echo built > out.txt }");
  const r = await runCli(["app", "deploy", "a"], (t) => t.scripted.reply({ status: 200, body: {} }, svc("unchanged"), { status: 200, body: {} }, { status: 200, body: "ok" }), env());
  expect(r.code).toBe(0);
  expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
    "POST http://127.0.0.1:8700/api/apps/a/sync",
    "GET http://127.0.0.1:8700/api/apps/a/service",
    "POST http://127.0.0.1:8700/api/apps/a/service",
    "GET http://127.0.0.1:8710/healthz",
  ]);
  expect(r.calls[2]!.body).toEqual({ action: "restart" });
  expect(r.err).toContain("check: true");
  expect(r.out).toEqual(["a: deployed, space-a.service restarted, healthy"]);
  expect((await Bun.file(join(home, "apps", "a", "out.txt")).text()).trim()).toBe("built");
});

test("app deploy: a unit the sync already restarted is not restarted twice", async () => {
  await write("");
  const r = await runCli(["app", "deploy", "a"], (t) => t.scripted.reply({ status: 200, body: {} }, svc("restarted"), { status: 200, body: "ok" }), env());
  expect(r.code).toBe(0);
  expect(r.calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8700/api/apps/a/sync", "http://127.0.0.1:8700/api/apps/a/service", "http://127.0.0.1:8710/healthz"]);
});

test("app deploy: a failing check never reaches ai-space", async () => {
  await write("deploy: { check: 'echo type error >&2; exit 2' }");
  const r = await runCli(["app", "deploy", "a"], () => {}, env());
  expect(r.code).toBe(1);
  expect(r.calls).toEqual([]);
  expect(r.err).toContain("  type error");
  expect(r.err.at(-1)).toBe("a: deploy stopped at check: echo type error >&2; exit 2 exited with 2; the service was not restarted");
});

test("app deploy: --no-restart prepares only; the operator's services are left to the operator", async () => {
  await write("");
  const prepared = await runCli(["app", "deploy", "a", "--no-restart"], () => {}, env());
  expect(prepared).toMatchObject({ code: 0, out: ["a: prepared, not restarted (--no-restart)"], calls: [] });
  const operator = await runCli(["app", "deploy", "a"], (t) => t.scripted.reply({ status: 200, body: {} }, svc("operator", "operator")), env());
  expect(operator.code).toBe(0);
  expect(operator.out).toEqual(["a: deployed; services here are the operator's: restart space-a.service yourself"]);
});
