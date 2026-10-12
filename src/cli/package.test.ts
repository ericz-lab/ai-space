import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./testing.ts";

test("pack and inspect work without a running Space or network calls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "space-package-cli-"));
  try {
    await Bun.write(join(dir, "app/space.yaml"), "spec: 2\nname: task-app\nversion: 1.0.0\nrequires: { spaceApi: 1 }\noffline: { features: [], online: [] }\n");
    const packed = await runCli(["app", "pack", "app", "--output", "task.spaceapp", "--json"], undefined, { cwd: dir });
    expect(packed.code).toBe(0);
    expect(packed.calls).toHaveLength(0);
    expect(JSON.parse(packed.out.join("\n"))).toMatchObject({ app: "task-app", files: 1 });
    const inspected = await runCli(["app", "inspect-package", "task.spaceapp", "--check-host", "--json"], undefined, { cwd: dir });
    expect(inspected.code).toBe(0);
    expect(inspected.calls).toHaveLength(0);
    expect(JSON.parse(inspected.out.join("\n"))).toMatchObject({ app: "task-app", signature: { status: "unsigned" } });
    expect((await runCli(["app", "pack", "app"], undefined, { cwd: dir })).code).toBe(2);
    const installed = await runCli(["app", "install", "task.spaceapp", "--allow-unsigned", "--operation-id", "d620b707-7e26-42bc-86cd-aaeb32d47e6a"], undefined, { cwd: dir });
    expect(installed.code).toBe(0);
    expect(installed.calls[0]?.headers).toMatchObject({ "content-type": "application/octet-stream", "x-space-allow-unsigned": "true", "idempotency-key": "d620b707-7e26-42bc-86cd-aaeb32d47e6a", authorization: "Bearer op-token" });
    expect(installed.calls[0]?.body).toBeInstanceOf(Uint8Array);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("connection grants only share named local apps and package removal requires confirmation", async () => {
  const grant = await runCli(["connection", "grant", "connection-id", "--apps", ""]);
  expect(grant.code).toBe(0); expect(grant.calls[0]?.body).toEqual({ apps: [] });
  const denied = await runCli(["app", "remove-package", "demo"]);
  expect(denied.calls).toHaveLength(0); expect(denied.code).not.toBe(0);
  const remove = await runCli(["app", "remove-package", "demo", "--yes"]);
  expect(remove.calls[0]?.url).toEndWith("/api/packages/apps/demo");
  expect(remove.calls[0]?.method).toBe("DELETE");
  expect((await runCli(["connection", "rm", "connection-id"])).calls).toHaveLength(0);
  const gone = await runCli(["connection", "rm", "connection-id", "--yes"]);
  expect(gone.calls[0]).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/api\/connections\/connection-id$/) });
});
