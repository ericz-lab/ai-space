import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv, commandEnv, prepareDeploy } from "./deploy.ts";

// Real git in temporary repositories; the manifest's commands run in real shells.
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "space-deploy-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: cleanEnv() });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

const manifest = (deploy: string) => `name: a\nservice: { command: bun src/index.ts, port: 8710, health: /healthz }\n${deploy}\n`;

/** A source repository with two commits, the second carrying `second`; returns both shas. */
async function source(second: { manifest: string; files?: Record<string, string> }): Promise<{ src: string; one: string; two: string }> {
  const src = join(root, "src");
  await mkdir(src);
  await git(src, "init", "-q");
  await Bun.write(join(src, "space.yaml"), manifest("deploy: { check: test -f ok, build: echo built > out.txt }"));
  await Bun.write(join(src, "ok"), "");
  await Bun.write(join(src, "v"), "1");
  await git(src, "add", "-A");
  await git(src, "commit", "-q", "-m", "one");
  const one = await git(src, "rev-parse", "HEAD");
  await Bun.write(join(src, "space.yaml"), second.manifest);
  await Bun.write(join(src, "v"), "2");
  for (const [name, body] of Object.entries(second.files ?? {})) await Bun.write(join(src, name), body);
  await git(src, "add", "-A");
  await git(src, "commit", "-q", "-m", "two");
  const two = await git(src, "rev-parse", "HEAD");
  return { src, one, two };
}

/** The bare repository and its work tree, deployed at `one` the way the old hooks did. */
async function bareAt(src: string, one: string): Promise<{ bare: string; dir: string }> {
  const bare = join(root, "a.git");
  const dir = join(root, "apps", "a");
  await git(root, "clone", "-q", "--bare", src, bare);
  await mkdir(dir, { recursive: true });
  await git(root, `--git-dir=${bare}`, `--work-tree=${dir}`, "read-tree", "-u", "--reset", one);
  return { bare, dir };
}

test("bare work tree: checks and build run on the new tree, HEAD of the bare repository stays put", async () => {
  const { src, one, two } = await source({ manifest: manifest("deploy: { check: test -f ok, build: echo built > out.txt }") });
  const { bare, dir } = await bareAt(src, one);
  const log: string[] = [];
  const r = await prepareDeploy({ app: "a", dir, rev: "main", gitDir: bare, log: (l) => log.push(l) });
  expect(r).toMatchObject({ ok: true, rev: two });
  expect(await Bun.file(join(dir, "v")).text()).toBe("2");
  expect((await Bun.file(join(dir, "out.txt")).text()).trim()).toBe("built");
  expect(await git(root, `--git-dir=${bare}`, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(log).toContain("check: test -f ok");
});

test("bare work tree: a failing check puts the previous tree back and says so", async () => {
  const { src, one } = await source({ manifest: manifest("deploy: { check: test -f missing }"), files: { added: "x" } });
  const { bare, dir } = await bareAt(src, one);
  const r = await prepareDeploy({ app: "a", dir, rev: "main", gitDir: bare });
  expect(r).toMatchObject({ ok: false, step: "check", error: "test -f missing exited with 1", restored: true });
  expect(await Bun.file(join(dir, "v")).text()).toBe("1");
  expect(await Bun.file(join(dir, "added")).exists()).toBe(false);
});

test("clone: an invalid manifest is a failure before any command runs, HEAD goes back", async () => {
  const { src, one } = await source({ manifest: "name: a\ndeploy: { prebuild: x }\n" });
  const dir = join(root, "apps", "a");
  await git(root, "clone", "-q", src, dir);
  await git(dir, "reset", "-q", "--hard", one);
  const ran: string[] = [];
  const r = await prepareDeploy({ app: "a", dir, rev: "origin/main", shell: async (c) => (ran.push(c), 0) });
  expect(r).toMatchObject({ ok: false, step: "manifest", previous: one, restored: true });
  expect((r as { error: string }).error).toContain('deploy has unknown key "prebuild"');
  expect(await git(dir, "rev-parse", "HEAD")).toBe(one);
  // The restore reinstalls the old tree; it has no bun.lock and declares no install.
  expect(ran).toEqual([]);
});

test("without a revision the commands run on what is there; a failure has nothing to restore", async () => {
  const dir = join(root, "apps", "a");
  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "space.yaml"), manifest("deploy: { build: exit 3 }"));
  await Bun.write(join(dir, "bun.lock"), "");
  const ran: string[] = [];
  const r = await prepareDeploy({ app: "a", dir, shell: async (c) => (ran.push(c), c === "exit 3" ? 3 : 0) });
  expect(r).toMatchObject({ ok: false, step: "build", error: "exit 3 exited with 3" });
  expect((r as { restored?: boolean }).restored).toBeUndefined();
  expect(ran).toEqual(["bun install --frozen-lockfile", "exit 3"]);
});

test("a revision needs a git source, and the manifest must name the app", async () => {
  const dir = join(root, "apps", "a");
  await mkdir(dir, { recursive: true });
  expect(await prepareDeploy({ app: "a", dir, rev: "main" })).toMatchObject({ ok: false, step: "checkout" });
  await Bun.write(join(dir, "space.yaml"), "name: b\n");
  expect(await prepareDeploy({ app: "a", dir, shell: async () => 0 })).toMatchObject({ ok: false, step: "manifest", error: 'space.yaml names the app "b", not "a"' });
});

test("cleanEnv drops the hook's repository variables", () => {
  expect(cleanEnv({ GIT_DIR: ".", GIT_QUARANTINE_PATH: "/q", GIT_SSH_COMMAND: "ssh", PATH: "/bin" })).toEqual({ GIT_SSH_COMMAND: "ssh", PATH: "/bin" });
});

test("commandEnv puts the running Bun's directory first on PATH, once", () => {
  expect(commandEnv({ PATH: "/usr/bin:/home/u/.bun/bin", GIT_DIR: "." }, "/home/u/.bun/bin/bun")).toEqual({ PATH: "/home/u/.bun/bin:/usr/bin" });
  expect(commandEnv({}, "/opt/bun/bin/bun").PATH).toBe("/opt/bun/bin");
});
