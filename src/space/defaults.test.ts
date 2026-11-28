import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_APPS, applyEnvOverrides, cloneDefaultApps, describeInstalls, installDefaultApps, loopbackUrl, newPackagePort, newWorkspaceEnv, parseDefaultApps, urlOverrideKey, withManifestQuery } from "./defaults.ts";
import { loadManifest } from "./scheduler/manifest.ts";
import { WINDOWS } from "./testing.ts";
import { workspacePaths } from "./workspace.ts";

describe("parseDefaultApps", () => {
  test("unset is the built-in list; none/off empty it; a list of URLs names apps after the repository", () => {
    expect(parseDefaultApps({})).toBe(DEFAULT_APPS);
    expect(parseDefaultApps({ SPACE_DEFAULT_APPS: "none" })).toEqual([]);
    expect(parseDefaultApps({ SPACE_DEFAULT_APPS: "  " })).toEqual([]);
    expect(parseDefaultApps({ SPACE_DEFAULT_APPS: "https://github.com/x/notes.git, usage=git@github.com:x/ai-usage.git" })).toEqual([
      { name: "notes", repo: "https://github.com/x/notes.git" },
      { name: "usage", repo: "git@github.com:x/ai-usage.git" },
    ]);
    expect(() => parseDefaultApps({ SPACE_DEFAULT_APPS: "Bad Name=https://x/y.git" })).toThrow(/not an app name/);
    expect(() => parseDefaultApps({ SPACE_DEFAULT_APPS: "notes=ftp://x" })).toThrow(/clone URL/);
  });
});

describe("a new workspace's .env", () => {
  test("no default apps, a package port, and a model only when Claude Code is missing", () => {
    const text = newWorkspaceEnv({}, { packagePort: 8702 });
    expect(text).toContain("\nSPACE_DEFAULT_APPS=none\n");
    expect(text).toContain("\nSPACE_PACKAGE_PORT=8702\n");
    expect(text).not.toContain("SPACE_MODEL_DEFAULT");
    expect(newWorkspaceEnv({ SPACE_DEFAULT_APPS: " notes=/srv/notes.git " }, { packagePort: 1 })).toContain("\nSPACE_DEFAULT_APPS=notes=/srv/notes.git\n");
    const codex = newWorkspaceEnv({}, { packagePort: 8702, modelDefault: "junior" });
    expect(codex).toEndWith("\nSPACE_MODEL_DEFAULT=junior\n");
  });

  test("the package port: the environment's, else two above the panel's when free, else any free one", () => {
    const free = (taken: number[]) => (p: number) => !taken.includes(p);
    expect(newPackagePort({}, free([]), () => 5)).toBe(8702);
    expect(newPackagePort({ SPACE_PORT: "18811" }, free([]), () => 5)).toBe(18813);
    expect(newPackagePort({ SPACE_PORT: "18811" }, free([18813]), () => 5)).toBe(5);
    expect(newPackagePort({ SPACE_PORT: "65535" }, free([]), () => 5)).toBe(5);
    expect(newPackagePort({ SPACE_PORT: "x" }, free([]), () => 5)).toBe(8702);
    expect(newPackagePort({ SPACE_PACKAGE_PORT: "9000" }, free([9000]), () => 5)).toBe(9000);
  });
});

describe("cloneDefaultApps and installDefaultApps", () => {
  test("clones what is missing from a local repository, skips what is present; installers run separately", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "space-defaults-")));
    const src = join(root, "src-app");
    await mkdir(join(src, "deploy"), { recursive: true });
    await writeFile(join(src, "space.yaml"), "name: demo\ntitle: Demo\n");
    // Git Bash's `pwd` is an MSYS path (/tmp/...); cygpath gives the Windows one the test compares against.
    await writeFile(join(src, "deploy", "install.sh"), `#!/bin/bash\necho installed in ${WINDOWS ? '"$(cygpath -w "$(pwd)")"' : "$(pwd)"}\n`);
    const git = async (...args: string[]) => {
      const p = Bun.spawn(["git", ...args], { cwd: src, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" } });
      if ((await p.exited) !== 0) throw new Error(await new Response(p.stderr).text());
    };
    await git("init", "-q", "-b", "main");
    await git("add", ".");
    await git("commit", "-qm", "init");

    const ws = workspacePaths(join(root, "ws"));
    await mkdir(join(ws.apps, "present"), { recursive: true });
    const log: string[] = [];
    const apps = [
      { name: "present", repo: src },
      { name: "demo", repo: src },
      { name: "broken", repo: join(root, "nowhere") },
    ];
    const cloned = await cloneDefaultApps(ws, apps, { log: (l) => log.push(l) });
    expect(cloned).toEqual([
      { name: "present", status: "present" },
      { name: "demo", status: "cloned" },
      { name: "broken", status: "failed", detail: expect.stringMatching(/^git clone: /) },
    ]);
    expect(await readFile(join(ws.apps, "demo", "space.yaml"), "utf8")).toContain("name: demo");
    expect(log.some((l) => l.includes("cloning"))).toBe(true);

    const installed = await installDefaultApps(ws, apps, { log: (l) => log.push(l) });
    expect(installed).toEqual([
      { name: "present", status: "no-installer" },
      { name: "demo", status: "installed", detail: `installed in ${join(ws.apps, "demo")}` },
      { name: "broken", status: "absent" },
    ]);
    expect(describeInstalls(installed)).toMatch(/^present no-installer, demo installed \(installed in .*\), broken absent$/);
    expect(describeInstalls([])).toBe("none");

    // A failing installer is reported with its last line.
    const failed = await installDefaultApps(ws, [{ name: "demo", repo: src }], { run: async () => ({ code: 1, output: "boom\nno bun here" }) });
    expect(failed[0]).toEqual({ name: "demo", status: "failed", detail: "deploy/install.sh: no bun here" });

    // The installer learns who runs the service, so under the space it leaves the unit alone.
    const envs: (Record<string, string> | undefined)[] = [];
    await installDefaultApps(ws, [{ name: "demo", repo: src }], { supervisor: "space", run: async (_c, _d, env) => (envs.push(env), { code: 0, output: "" }) });
    await installDefaultApps(ws, [{ name: "demo", repo: src }], { run: async (_c, _d, env) => (envs.push(env), { code: 0, output: "" }) });
    expect(envs).toEqual([{ SPACE_SUPERVISOR: "space" }, { SPACE_SUPERVISOR: "operator" }]);
  });
});

describe("applyEnvOverrides", () => {
  test("SPACE_APP_URL_<NAME> replaces the manifest url and must be http(s)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-app-"));
    await writeFile(join(dir, "space.yaml"), "name: ai-usage\nurl: http://127.0.0.1:8880/?lang={lang}\n");
    const m = await loadManifest(dir);
    expect(urlOverrideKey("ai-usage")).toBe("SPACE_APP_URL_AI_USAGE");
    expect(applyEnvOverrides(m, {})).toBe(m);
    expect(applyEnvOverrides(m, { SPACE_APP_URL_AI_USAGE: " https://usage.example.com/?lang={lang} " }).url).toBe("https://usage.example.com/?lang={lang}");
    expect(() => applyEnvOverrides(m, { SPACE_APP_URL_AI_USAGE: "usage.example.com" })).toThrow(/http/);
  });

  test("an override without a query keeps the manifest url's query and its placeholders", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-app-"));
    await writeFile(join(dir, "space.yaml"), "name: ai-usage\nurl: http://127.0.0.1:8880/?lang={lang}&accent={accent}\n");
    const m = await loadManifest(dir);
    const over = (url: string) => applyEnvOverrides(m, { SPACE_APP_URL_AI_USAGE: url }).url;
    expect(over("https://usage.example.com")).toBe("https://usage.example.com/?lang={lang}&accent={accent}");
    expect(over("https://usage.example.com/")).toBe("https://usage.example.com/?lang={lang}&accent={accent}");
    expect(over("https://usage.example.com/board#top")).toBe("https://usage.example.com/board?lang={lang}&accent={accent}#top");
    // An override with a query of its own, even an empty one, is used as written.
    expect(over("https://usage.example.com/?lang=zh")).toBe("https://usage.example.com/?lang=zh");
    expect(over("https://usage.example.com/?")).toBe("https://usage.example.com/?");
    // A manifest url without a query leaves the override alone.
    expect(withManifestQuery("https://usage.example.com", "http://127.0.0.1:8880/")).toBe("https://usage.example.com");
    expect(withManifestQuery("https://usage.example.com", undefined)).toBe("https://usage.example.com");
    expect(withManifestQuery("https://usage.example.com", "http://127.0.0.1:8880/?#x")).toBe("https://usage.example.com");
  });

  test("a path url resolves under the space's domain, or to the service's loopback address without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-app-"));
    await writeFile(join(dir, "space.yaml"), "name: notes\nurl: /docs?lang={lang}\nservice: { command: bun run, port: 8710 }\n");
    const m = await loadManifest(dir);
    expect(m.url).toBe("/docs?lang={lang}");
    expect(applyEnvOverrides(m, {}, { domain: "example.com" }).url).toBe("https://notes.example.com/docs?lang={lang}");
    expect(applyEnvOverrides(m, {}).url).toBe("http://127.0.0.1:8710/docs?lang={lang}");
    expect(applyEnvOverrides(m, { SPACE_APP_URL_NOTES: "https://n.example.org/" }, { domain: "example.com" }).url).toBe("https://n.example.org/?lang={lang}");
    await writeFile(join(dir, "space.yaml"), "name: notes\nurl: /\n");
    const bare = await loadManifest(dir);
    expect(() => applyEnvOverrides(bare, {}, { domain: "example.com" })).toThrow(/needs a service with a port/);
  });

  test("loopbackUrl keeps the loopback form of a path url a domain made public, and nothing else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "space-app-"));
    await writeFile(join(dir, "space.yaml"), "name: notes\nurl: /docs?lang={lang}\nservice: { command: bun run, port: 8710 }\n");
    const m = await loadManifest(dir);
    expect(loopbackUrl(m, {}, { domain: "example.com" })).toBe("http://127.0.0.1:8710/docs?lang={lang}");
    // Without a domain the url already is this; an override points somewhere on purpose.
    expect(loopbackUrl(m, {})).toBeUndefined();
    expect(loopbackUrl(m, { SPACE_APP_URL_NOTES: "https://n.example.org/" }, { domain: "example.com" })).toBeUndefined();
    expect(loopbackUrl(m, { SPACE_APP_URL_NOTES: " " }, { domain: "example.com" })).toBe("http://127.0.0.1:8710/docs?lang={lang}");
    await writeFile(join(dir, "space.yaml"), "name: notes\nurl: https://notes.example.org/\nservice: { command: bun run, port: 8710 }\n");
    expect(loopbackUrl(await loadManifest(dir), {}, { domain: "example.com" })).toBeUndefined();
    await writeFile(join(dir, "space.yaml"), "name: notes\nurl: /\n");
    expect(loopbackUrl(await loadManifest(dir), {}, { domain: "example.com" })).toBeUndefined();
  });
});
