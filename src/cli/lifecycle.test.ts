import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDefaultApps } from "../space/defaults.ts";
import { parseRuntimesYaml } from "../space/runtimes/config.ts";
import { readWorkspaceEnv, workspacePaths } from "../space/workspace.ts";
import { initDeps } from "./lifecycle.ts";
import { runCli } from "./testing.ts";
import type { Runtimes } from "../space/local.ts";

const original = initDeps.findRuntimes;
const roots: string[] = [];
afterEach(async () => {
  initDeps.findRuntimes = original;
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "space-init-"));
  roots.push(root);
  return join(root, "ws");
}

function found(r: Partial<Runtimes>): string[] {
  const asked: string[] = [];
  initDeps.findRuntimes = async (env) => (asked.push(env.SPACE_HOME ?? ""), { claude: null, codex: null, dsh: null, ...r });
  return asked;
}

const init = (home: string, env: Record<string, string> = {}) => runCli(["init"], () => {}, { env: { SPACE_HOME: home, PATH: "/usr/bin:/bin", ...env } });

describe("init on a new workspace", () => {
  test("writes the new defaults and runtimes.yaml from the CLIs found", async () => {
    const home = await workspace();
    found({ claude: "/opt/bin/claude", codex: "/opt/bin/codex" });
    const r = await init(home, { SPACE_PORT: "18811" });
    expect(r.code).toBe(0);
    const env = await readWorkspaceEnv(workspacePaths(home));
    expect(env).toMatchObject({ SPACE_PORT: "8700", SPACE_DEFAULT_APPS: "none" });
    // Two above the panel's port, or any free one when that is taken.
    expect(Number(env.SPACE_PACKAGE_PORT)).toBeGreaterThan(0);
    expect(env.SPACE_MODEL_DEFAULT).toBeUndefined();
    expect(parseDefaultApps(env)).toEqual([]);
    const yaml = await Bun.file(join(home, "runtimes.yaml")).text();
    const { config } = parseRuntimesYaml(yaml, {});
    expect(config.default).toBe("claude");
    expect(config.runtimes.map((x) => [x.name, x.kind])).toEqual([["claude", "claude-code"], ["codex", "codex-cli"]]);
    expect(r.err).toContain(`[space] runtimes: wrote ${join(home, "runtimes.yaml")} with claude, codex`);
    expect(r.err.join("\n")).toContain("[space] default apps: none");
  });

  test("the package port the environment gives is the one written", async () => {
    found({});
    const home = await workspace();
    await init(home, { SPACE_PACKAGE_PORT: "18999" });
    expect((await readWorkspaceEnv(workspacePaths(home))).SPACE_PACKAGE_PORT).toBe("18999");
  });

  test("without Claude Code the default model is the default runtime's tier", async () => {
    const home = await workspace();
    found({ codex: "/opt/bin/codex" });
    await init(home);
    const env = await readWorkspaceEnv(workspacePaths(home));
    expect(env).toMatchObject({ SPACE_MODEL_DEFAULT: "junior" });
    expect(env.SPACE_CHAT_MODEL).toBeUndefined();
    expect(parseRuntimesYaml(await Bun.file(join(home, "runtimes.yaml")).text(), {}).config.default).toBe("codex");
  });

  test("no CLI found: no runtimes.yaml, and init says so", async () => {
    const home = await workspace();
    found({});
    const r = await init(home);
    expect(await Bun.file(join(home, "runtimes.yaml")).exists()).toBe(false);
    expect(r.err).toContain("[space] runtimes: no agent CLI found (claude, codex, dsh); add one later in Settings, Models");
  });

  test("SPACE_DEFAULT_APPS given at the first init is kept in the .env", async () => {
    const home = await workspace();
    found({});
    await init(home, { SPACE_DEFAULT_APPS: "notes=/nonexistent/notes.git" });
    expect((await readWorkspaceEnv(workspacePaths(home))).SPACE_DEFAULT_APPS).toBe("notes=/nonexistent/notes.git");
  });

  test("a runtime in the environment, an existing runtimes.yaml or the Local edition: no search", async () => {
    const asked = found({ claude: "/opt/bin/claude" });
    const a = await workspace();
    await init(a, { SPACE_MODEL_BIN: "/opt/bin/wrapper" });
    const b = await workspace();
    await mkdir(b, { recursive: true });
    await writeFile(join(b, "runtimes.yaml"), "runtimes:\n  mine:\n    kind: claude-code\n");
    await init(b);
    const c = await workspace();
    await init(c, { SPACE_EDITION: "local" });
    expect(asked).toEqual([]);
    expect(await Bun.file(join(a, "runtimes.yaml")).exists()).toBe(false);
    expect(await Bun.file(join(b, "runtimes.yaml")).text()).toBe("runtimes:\n  mine:\n    kind: claude-code\n");
    expect(await Bun.file(join(c, "runtimes.yaml")).exists()).toBe(false);
    // The .env defaults do not depend on the search.
    expect((await readWorkspaceEnv(workspacePaths(c))).SPACE_DEFAULT_APPS).toBe("none");
  });
});

describe("init on an existing workspace", () => {
  test("an existing .env is not touched, nothing is searched, and the old default apps stay", async () => {
    const home = await workspace();
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".env"), "SPACE_PORT=8700\n");
    const asked = found({ claude: "/opt/bin/claude" });
    const r = await init(home, { SPACE_DEFAULT_APPS: "none" });
    expect(r.code).toBe(0);
    expect(await Bun.file(join(home, ".env")).text()).toBe("SPACE_PORT=8700\n");
    expect(await Bun.file(join(home, "runtimes.yaml")).exists()).toBe(false);
    expect(asked).toEqual([]);
    // Nothing set: the built-in list, as before.
    expect(parseDefaultApps(await readWorkspaceEnv(workspacePaths(home))).map((a) => a.name)).toEqual(["ai-usage"]);
  });

  test("a second init of a new workspace changes nothing", async () => {
    const home = await workspace();
    found({ claude: "/opt/bin/claude" });
    await init(home);
    const env = await Bun.file(join(home, ".env")).text();
    const yaml = await Bun.file(join(home, "runtimes.yaml")).text();
    const asked = found({ codex: "/opt/bin/codex" });
    await init(home);
    expect(asked).toEqual([]);
    expect(await Bun.file(join(home, ".env")).text()).toBe(env);
    expect(await Bun.file(join(home, "runtimes.yaml")).text()).toBe(yaml);
  });
});
