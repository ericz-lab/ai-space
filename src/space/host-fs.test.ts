import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executableAgrees, renameToAbsent, syncDirectory } from "./host-fs.ts";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "space-host-fs-"));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("a staged directory moves to a destination that is absent, with its files", async () => {
  const root = await tmp();
  const stage = join(root, "stage");
  await Bun.write(join(stage, "space.yaml"), "app: demo\n");
  await Bun.write(join(stage, "dist", "index.js"), "1");
  await renameToAbsent(stage, join(root, "apps-demo"));
  expect((await readdir(join(root, "apps-demo"))).sort()).toEqual(["dist", "space.yaml"]);
  expect((await readdir(root)).sort()).toEqual(["apps-demo"]);
  await syncDirectory(root); // durable where the host can say so; never an error
});

test("a destination that exists is never replaced, empty or not, and the stage is kept", async () => {
  const root = await tmp();
  for (const name of ["empty", "full"]) {
    const stage = join(root, `stage-${name}`);
    const destination = join(root, name);
    await Bun.write(join(stage, "new.txt"), "new");
    await mkdir(destination);
    if (name === "full") await Bun.write(join(destination, "theirs.txt"), "theirs");
    await expect(renameToAbsent(stage, destination)).rejects.toThrow();
    expect(await readdir(destination)).toEqual(name === "full" ? ["theirs.txt"] : []);
    expect(await readdir(stage)).toEqual(["new.txt"]);
  }
});

test("the executable flag is checked against the mode only where the host keeps one", () => {
  const windows = process.platform === "win32";
  expect(executableAgrees(0o755, true)).toBe(true);
  expect(executableAgrees(0o644, false)).toBe(true);
  expect(executableAgrees(0o644, true)).toBe(windows);
  expect(executableAgrees(0o755, false)).toBe(windows);
});
