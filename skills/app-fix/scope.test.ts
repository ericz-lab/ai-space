import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScope, forbiddenPath } from "./scope.ts";

let ws = "";
const sh = async (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(" ")}: ${await new Response(p.stderr).text()}`);
};

/** app-src/<name> as a repository with one commit and an upstream at that commit. */
async function app(name: string): Promise<string> {
  const dir = join(ws, "app-src", name);
  const origin = join(ws, "remotes", `${name}.git`);
  await mkdir(dir, { recursive: true });
  await mkdir(origin, { recursive: true });
  await sh(origin, "git", "init", "-q", "--bare", "-b", "main");
  await sh(dir, "git", "init", "-q", "-b", "main");
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>\n");
  await sh(dir, "git", "add", ".");
  await sh(dir, "git", "commit", "-q", "-m", "init");
  await sh(dir, "git", "remote", "add", "origin", origin);
  await sh(dir, "git", "push", "-q", "-u", "origin", "main");
  return dir;
}

beforeAll(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), "space-scope-")));
});
afterAll(() => rm(ws, { recursive: true, force: true }));

describe("forbiddenPath", () => {
  test("secret, data and dependency files", () => {
    for (const p of [".env", "web/.env.local", "space.env", "runtimes.yaml", "data/todo.db", "todo.sqlite-wal", "node_modules/x/index.js", "certs/server.key", ".git/config", "id_ed25519"]) expect(forbiddenPath(p)).toBe(true);
    for (const p of [".env.example", "web/index.html", "src/data/defaults.ts", "src/env.ts", "docs/keys.md"]) expect(forbiddenPath(p)).toBe(false);
  });
});

describe("checkScope", () => {
  test("a clean fix in an app's own checkout passes, committed or not", async () => {
    const dir = await app("ok-app");
    await writeFile(join(dir, "index.html"), "<h1>hello</h1>\n");
    await writeFile(join(dir, "style.css"), "h1 { color: red; }\n");
    expect(await checkScope(dir, ws)).toEqual({ problems: [], files: ["index.html", "style.css"] });
    await sh(dir, "git", "add", ".");
    await sh(dir, "git", "commit", "-q", "-m", "fix");
    expect(await checkScope(dir, ws)).toEqual({ problems: [], files: ["index.html", "style.css"] });
  });

  test("refuses secrets, data, links out of the repository and credential-looking lines", async () => {
    const dir = await app("bad-app");
    await writeFile(join(dir, ".env"), "X=1\n");
    await mkdir(join(dir, "data"));
    await writeFile(join(dir, "data", "todo.db"), "x");
    await symlink(join(ws, "secrets.txt"), join(dir, "link"));
    await writeFile(join(dir, "config.ts"), `export const key = "ghp_${"a".repeat(30)}";\n`);
    const r = await checkScope(dir, ws);
    expect(r.problems.join("\n")).toContain(".env: secret, data or dependency files");
    expect(r.problems.join("\n")).toContain("data/todo.db: secret");
    expect(r.problems.join("\n")).toContain("link: a link that leaves the repository");
    expect(r.problems.join("\n")).toContain("an added line looks like a credential");
  });

  test("a committed secret not yet pushed is still caught", async () => {
    const dir = await app("committed-app");
    await writeFile(join(dir, "keys.ts"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    await sh(dir, "git", "add", ".");
    await sh(dir, "git", "commit", "-q", "-m", "oops");
    expect((await checkScope(dir, ws)).problems).toEqual([expect.stringContaining("looks like a credential")]);
  });

  test("refuses a directory that is not an app checkout of this workspace", async () => {
    const dir = await app("outer");
    await mkdir(join(dir, "sub"));
    expect((await checkScope(join(dir, "sub"), ws)).problems.join("\n")).toContain("not a checkout directly under");
    const elsewhere = join(ws, "elsewhere");
    await mkdir(elsewhere);
    await sh(elsewhere, "git", "init", "-q");
    expect((await checkScope(elsewhere, ws)).problems).toEqual([expect.stringContaining("not a checkout directly under")]);
    expect((await checkScope(join(ws, "nope"), ws)).problems).toEqual([expect.stringContaining("no such directory")]);
    const plain = join(ws, "app-src", "not-git");
    await mkdir(plain);
    expect((await checkScope(plain, ws)).problems.join("\n")).toContain("is not a git checkout");
  });
});
