import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBusy, acquireWorkspaceLock, readHolder, workspaceLocked } from "./instance.ts";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "space-lock-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("one holder per workspace; the second is refused with who holds it", async () => {
  const run = join(await tmp(), "run");
  expect(workspaceLocked(run)).toBe(false);
  const lock = await acquireWorkspaceLock(run, "/ws", { port: 8700, edition: "local", version: "0.1.0" });
  expect(workspaceLocked(run)).toBe(true);
  expect(await readHolder(run)).toMatchObject({ pid: process.pid, port: 8700, edition: "local" });
  expect(await acquireWorkspaceLock(run, "/ws", {})).toBe(lock); // bun --hot re-running start
  lock.release();
  expect(workspaceLocked(run)).toBe(false);
  (await acquireWorkspaceLock(run, "/ws", {})).release();
});

test("another process holding the lock blocks this one with who holds it, and its end frees it", async () => {
  const run = join(await tmp(), "run");
  const script = `import { acquireWorkspaceLock } from ${JSON.stringify(join(import.meta.dir, "instance.ts"))}; await acquireWorkspaceLock(${JSON.stringify(run)}, "/ws", { port: 1 }); console.log("held"); await Bun.sleep(60000);`;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
  const second = acquireWorkspaceLock(run, "/ws", {});
  await expect(second).rejects.toBeInstanceOf(WorkspaceBusy);
  await expect(second).rejects.toThrow(`pid ${child.pid}, port 1`);
  child.kill("SIGKILL");
  await child.exited;
  const lock = await acquireWorkspaceLock(run, "/ws", {});
  lock.release();
});
