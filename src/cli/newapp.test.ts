import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_DIR, createApp, titleOf } from "./newapp.ts";
import { UsageError } from "./types.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "space-newapp-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Call = { cmd: string[]; cwd: string };
function fakeExec(fail: (cmd: string[]) => string | undefined = () => undefined) {
  const calls: Call[] = [];
  const exec = async (cmd: string[], cwd: string) => {
    calls.push({ cmd, cwd });
    const err = fail(cmd);
    if (err) return { code: 1, out: "", err };
    if (cmd[0] === "git" && cmd[1] === "remote") return { code: 0, out: "https://github.com/acme/demo-app.git\n", err: "" };
    return { code: 0, out: "", err: "" };
  };
  return { exec, calls };
}

test("copies the template, fills in the name, title and port, renames the dotfiles, commits", async () => {
  const { exec, calls } = fakeExec();
  const dir = join(root, "demo-app");
  const r = await createApp({ name: "demo-app", dir, title: "Demo App", port: 8123, github: false, exec });
  expect(r).toMatchObject({ dir, committed: true });
  expect(r.files).toContain("space.yaml");
  expect(r.files).toContain(".gitignore");
  expect(r.files).toContain(".env.example");
  expect(r.files).not.toContain("gitignore");
  const yaml = await Bun.file(join(dir, "space.yaml")).text();
  expect(yaml).toContain("name: demo-app");
  expect(yaml).toContain("title: Demo App");
  expect(yaml).toContain("port: 8123");
  expect(yaml).not.toContain("my-app");
  expect(await Bun.file(join(dir, "deploy.sh")).text()).toContain('APP="${SERVICE:-demo-app}"');
  expect(calls.map((c) => c.cmd.slice(0, 2).join(" "))).toEqual(["git init", "git add", "git commit"]);
  expect(calls.every((c) => c.cwd === dir)).toBe(true);
});

test("with GitHub configured: gh repo create, repo: recorded, pushed", async () => {
  const { exec, calls } = fakeExec();
  const dir = join(root, "demo-app");
  const r = await createApp({ name: "demo-app", dir, title: "Demo App", port: 8710, github: { owner: "acme", visibility: "private" }, exec });
  expect(r.repo).toBe("https://github.com/acme/demo-app.git");
  expect(calls.find((c) => c.cmd[0] === "gh")?.cmd).toEqual(["gh", "repo", "create", "acme/demo-app", "--private", "--source", ".", "--remote", "origin", "--push"]);
  expect(await Bun.file(join(dir, "space.yaml")).text()).toContain("\nrepo: https://github.com/acme/demo-app.git\n");
  expect(calls.at(-1)?.cmd).toEqual(["git", "push", "-q"]);
});

test("a failing gh leaves a complete local app and says what to do", async () => {
  const { exec } = fakeExec((cmd) => (cmd[0] === "gh" ? "HTTP 401" : undefined));
  const r = await createApp({ name: "demo-app", dir: join(root, "demo-app"), title: "D", port: 8710, github: { owner: "acme", visibility: "private" }, exec });
  expect(r.committed).toBe(true);
  expect(r.repo).toBeUndefined();
  expect(r.note).toContain("gh repo create acme/demo-app failed: HTTP 401");
});

test("refuses a bad name or an existing directory", async () => {
  const { exec } = fakeExec();
  await expect(createApp({ name: "Bad Name", dir: join(root, "x"), title: "X", port: 1, github: false, exec })).rejects.toThrow(UsageError);
  await expect(createApp({ name: "x", dir: root, title: "X", port: 1, github: false, exec })).rejects.toThrow(/already exists/);
});

test("the template ships with the checkout and titleOf makes a title", async () => {
  expect(await Bun.file(join(TEMPLATE_DIR, "space.yaml")).exists()).toBe(true);
  expect(titleOf("crypto-news_feed.v2")).toBe("Crypto News Feed V2");
});
