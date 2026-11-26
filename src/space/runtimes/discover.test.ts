import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRuntimes, isHarnessAppCli, renderRuntimesYaml } from "./discover.ts";
import { parseRuntimesYaml } from "./config.ts";
import { WINDOWS, removeTemp } from "../testing.ts";

// The stand-in CLIs are shell scripts, which Windows does not run.
const posixOnly = test.skipIf(WINDOWS);
const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeTemp(r);
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "space-discover-"));
  roots.push(root);
  return root;
}

describe("agent CLIs", () => {
  posixOnly("a chosen path must identify the expected agent; null leaves that one out", async () => {
    const root = await scratch();
    const exe = join(root, "my claude");
    await Bun.write(exe, "#!/bin/sh\necho '2.1.0 (Claude Code)'\n");
    await chmod(exe, 0o755);
    const plain = join(root, "codex.txt");
    await Bun.write(plain, "");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: exe, codex: null, dsh: null })).toEqual({ claude: exe, codex: null, dsh: null });
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: "claude", codex: plain, dsh: null })).toEqual({ claude: null, codex: null, dsh: null });
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: null, codex: exe, dsh: null })).toEqual({ claude: null, codex: null, dsh: null });
    await Bun.write(exe, "#!/bin/sh\necho 'codex-cli 0.100.0'\n");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: exe, codex: exe, dsh: null })).toEqual({ claude: null, codex: exe, dsh: null });
    await Bun.write(exe, "#!/bin/sh\necho 'codex-cli 0.100.0'\nexit 1\n");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: null, codex: exe, dsh: null })).toEqual({ claude: null, codex: null, dsh: null });
  });

  test("an unresponsive selected program times out", async () => {
    const root = await scratch();
    const exe = join(root, "hung-agent");
    await Bun.write(exe, "#!/bin/sh\nexec /bin/sleep 10\n");
    await chmod(exe, 0o755);
    expect(await findRuntimes({ PATH: "/usr/bin:/bin" }, root, { claude: exe, codex: null, dsh: null })).toEqual({ claude: null, codex: null, dsh: null });
  });

  posixOnly("a chosen DeepSeek Harness CLI must answer with a version and name the harness", async () => {
    const root = await scratch();
    const exe = join(root, "dsh");
    await Bun.write(exe, "#!/bin/sh\ncase \"$1\" in --version) echo '0.2.1-rc.2';; --help) echo 'Usage: dsh --profile <name> — DeepSeek Harness profile';; esac\n");
    await chmod(exe, 0o755);
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: null, codex: null, dsh: exe })).toEqual({ claude: null, codex: null, dsh: exe });
    // A semver alone is not enough: another `dsh` may use the name.
    await Bun.write(exe, "#!/bin/sh\ncase \"$1\" in --version) echo '1.2.3';; --help) echo 'a different tool';; esac\n");
    expect(await findRuntimes({ PATH: "/nowhere" }, root, { claude: null, codex: null, dsh: exe })).toEqual({ claude: null, codex: null, dsh: null });
    // The app's CLI is recognised through a symlink too, so its account route is written.
    const app = join(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh");
    await mkdir(join(app, ".."), { recursive: true });
    await Bun.write(app, "");
    const link = join(root, "linked-dsh");
    await symlink(app, link);
    expect(isHarnessAppCli(app)).toBe(true);
    expect(isHarnessAppCli(link)).toBe(true);
    expect(isHarnessAppCli("/Users/me/.local/bin/dsh")).toBe(false);
  });

  test("runtimes.yaml names each CLI by path under the caller's header", () => {
    const app = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";
    const text = renderRuntimesYaml({ claude: "/Users/me/.local/bin/claude", codex: "/Applications/Codex Tools/codex", dsh: app }, ["# by init"])!;
    expect(text).toStartWith("# by init\ndefault: claude\nruntimes:\n");
    const { config } = parseRuntimesYaml(text, {});
    expect(config.runtimes.map((r) => [r.name, r.kind, (r as { bin: string[] }).bin])).toEqual([
      ["claude", "claude-code", ["/Users/me/.local/bin/claude"]],
      ["codex", "codex-cli", ["/Applications/Codex Tools/codex"]],
      ["dsh", "deepseek-harness", [app]],
    ]);
    // The desktop app's CLI is signed in through the app; a standalone one follows its own route.
    expect(config.runtimes[2]).toMatchObject({ provider: "deepseek-account", liveProfile: "acp" });
    const standalone = parseRuntimesYaml(renderRuntimesYaml({ claude: null, codex: null, dsh: "/Users/me/.local/bin/dsh" }, [])!, {}).config;
    expect(standalone.runtimes[0]).toMatchObject({ provider: "deepseek-official" });
    expect(renderRuntimesYaml({ claude: null, codex: null, dsh: null }, [])).toBeUndefined();
  });

  test("the first CLI found takes bare model names", () => {
    const text = renderRuntimesYaml({ claude: null, codex: "/usr/bin/codex", dsh: "/usr/bin/dsh" }, [])!;
    expect(text).toStartWith("default: codex\nruntimes:\n");
    expect(parseRuntimesYaml(text, {}).config.default).toBe("codex");
  });
});
