import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_DIR, createApp, newApp, titleOf } from "./newapp.ts";
import { testIo } from "./testing.ts";
import { type Ctx, UsageError } from "./types.ts";

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

describe("space app new and the GitHub extension", () => {
  function ctxWith(env: Record<string, string>) {
    const t = testIo({ env: { SPACE_HOME: join(root, "ws"), ...env }, cwd: root });
    const lines: string[] = [];
    const ctx = { io: t.io, flags: { json: false }, print: { line: (l: string) => lines.push(l), data: () => {} } } as unknown as Ctx;
    return { ctx, lines, err: t.err };
  }

  test("GitHub not set up: a local app, and gh is never looked for or run", async () => {
    const { exec, calls } = fakeExec();
    const looked: string[] = [];
    const { ctx, lines } = ctxWith({});
    const code = await newApp(ctx, ["demo-app"], { exec, which: (c) => void looked.push(c) as undefined });
    expect(code).toBe(0);
    expect(looked).toEqual([]);
    expect(calls.some((c) => c.cmd[0] === "gh")).toBe(false);
    expect(lines[0]).toContain("space setup github");
  });

  test("owner set but no gh: the app is made locally, with a warning and exit 0", async () => {
    const { exec, calls } = fakeExec();
    const { ctx, err } = ctxWith({ SPACE_GITHUB_OWNER: "acme" });
    const code = await newApp(ctx, ["demo-app"], { exec, which: () => undefined });
    expect(code).toBe(0);
    expect(calls.some((c) => c.cmd[0] === "gh")).toBe(false);
    expect(calls.map((c) => c.cmd.slice(0, 2).join(" "))).toContain("git commit");
    expect(err.join("\n")).toContain("gh is not on PATH");
  });

  test("owner set and gh present: the repository is created as before", async () => {
    const { exec, calls } = fakeExec();
    const { ctx } = ctxWith({ SPACE_GITHUB_OWNER: "acme" });
    const code = await newApp(ctx, ["demo-app"], { exec, which: () => "/usr/bin/gh" });
    expect(code).toBe(0);
    expect(calls.find((c) => c.cmd[0] === "gh")?.cmd.slice(0, 4)).toEqual(["gh", "repo", "create", "acme/demo-app"]);
  });
});
