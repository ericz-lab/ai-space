import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIMES_FILE, loadRuntimes, parseRuntimesYaml, runtimesFromEnv } from "./config.ts";
import { RuntimeRegistry, claudeOnly } from "./registry.ts";

describe("runtimesFromEnv", () => {
  test("no variables: one local claude runtime, the default", () => {
    expect(runtimesFromEnv({})).toEqual({ default: "claude", runtimes: [{ name: "claude", kind: "claude-code", bin: [], chatArgs: [] }] });
  });

  test("the model and chat variables describe that one runtime; a key adds the API as the default for answers", () => {
    expect(runtimesFromEnv({ SPACE_MODEL_SSH_HOST: " box ", SPACE_MODEL_BIN: "bun fake.ts", SPACE_CHAT_ARGS: "--a --b" })).toEqual({
      default: "claude",
      runtimes: [{ name: "claude", kind: "claude-code", bin: ["bun", "fake.ts"], sshHost: "box", chatArgs: ["--a", "--b"] }],
    });
    // The chat command stands in for the CLI when the model one is not set (one login, one binary).
    expect(runtimesFromEnv({ SPACE_CHAT_BIN: "/opt/claude" }).runtimes[0]).toMatchObject({ bin: ["/opt/claude"] });
    const withKey = runtimesFromEnv({ SPACE_MODEL_API_KEY: "sk" });
    expect(withKey.default).toBe("api");
    expect(withKey.runtimes.map((r) => r.name)).toEqual(["claude", "api"]);
  });
});

describe("parseRuntimesYaml", () => {
  test("reads runtimes with their options; keys come from the environment", () => {
    const { config, warnings } = parseRuntimesYaml(
      `default: claude
runtimes:
  claude: { kind: claude-code, ssh: box, bin: /usr/local/bin/claude, chatArgs: [--x] }
  api: { kind: anthropic-api, apiKeyEnv: MY_KEY, url: https://proxy.example/v1/messages }
`,
      { MY_KEY: "sk-1" },
    );
    expect(warnings).toEqual([]);
    expect(config).toEqual({
      default: "claude",
      runtimes: [
        { name: "claude", kind: "claude-code", bin: ["/usr/local/bin/claude"], sshHost: "box", chatArgs: ["--x"] },
        { name: "api", kind: "anthropic-api", apiKey: "sk-1", apiUrl: "https://proxy.example/v1/messages" },
      ],
    });
  });

  test("a runtime whose key is missing is skipped with a warning; the first runtime is the default when none is named", () => {
    const { config, warnings } = parseRuntimesYaml("runtimes:\n  claude: { kind: claude-code }\n  api: { kind: anthropic-api }\n", {});
    expect(config.default).toBe("claude");
    expect(config.runtimes.map((r) => r.name)).toEqual(["claude"]);
    expect(warnings).toEqual(["runtime api skipped: ANTHROPIC_API_KEY is not set"]);
  });

  test("rejects malformed files with the reason", () => {
    expect(() => parseRuntimesYaml("- a", {})).toThrow(/must be a mapping/);
    expect(() => parseRuntimesYaml("runtimes: {}", {})).toThrow(/non-empty/);
    expect(() => parseRuntimesYaml("runtimes:\n  Bad: { kind: claude-code }", {})).toThrow(/invalid runtime name/);
    expect(() => parseRuntimesYaml("runtimes:\n  x: { kind: gpt }", {})).toThrow(/kind must be one of/);
    expect(() => parseRuntimesYaml("runtimes:\n  x: { kind: claude-code, foo: 1 }", {})).toThrow(/unknown key "foo"/);
    expect(() => parseRuntimesYaml("runtimes:\n  x: { kind: claude-code, ssh: 'a b' }", {})).toThrow(/not a host name/);
    expect(() => parseRuntimesYaml("default: nope\nruntimes:\n  x: { kind: claude-code }", {})).toThrow(/default must name/);
    expect(() => parseRuntimesYaml("runtimes:\n  api: { kind: anthropic-api }", {})).toThrow(/no usable runtime/);
    expect(() => parseRuntimesYaml("runtimes: [", {})).toThrow(/invalid YAML/);
    expect(() => parseRuntimesYaml("runtimes:\n  d: { kind: deepseek-harness, profile: 'Bad Profile' }", {})).toThrow(/profile must be/);
  });

  test("a deepseek-harness runtime takes its command, home, profile and ssh host", () => {
    const { config } = parseRuntimesYaml("runtimes:\n  claude: { kind: claude-code }\n  dsh: { kind: deepseek-harness, ssh: box, bin: /opt/dsh, home: /home/me/.dsh }\n", {});
    expect(config.runtimes[1]).toEqual({ name: "dsh", kind: "deepseek-harness", bin: ["/opt/dsh"], profile: "headless", home: "/home/me/.dsh", sshHost: "box" });
    expect(parseRuntimesYaml("runtimes:\n  dsh: { kind: deepseek-harness }\n", {}).config.runtimes[0]).toEqual({ name: "dsh", kind: "deepseek-harness", bin: [], profile: "headless" });
  });
});

describe("loadRuntimes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "space-runtimes-"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  test("uses the file when present, else the environment", async () => {
    expect(await loadRuntimes(dir, { SPACE_MODEL_SSH_HOST: "box" })).toMatchObject({ source: "env", config: { runtimes: [{ sshHost: "box" }] } });
    await writeFile(join(dir, RUNTIMES_FILE), "runtimes:\n  local: { kind: claude-code }\n");
    expect(await loadRuntimes(dir, { SPACE_MODEL_SSH_HOST: "box" })).toMatchObject({ source: "file", config: { default: "local", runtimes: [{ name: "local", kind: "claude-code" }] } });
  });
});

describe("RuntimeRegistry", () => {
  test("resolves runtime/model strings and lists what it has", () => {
    const reg = new RuntimeRegistry({
      default: "claude",
      runtimes: [
        { name: "claude", kind: "claude-code", bin: [], sshHost: "box", chatArgs: [] },
        { name: "api", kind: "anthropic-api", apiKey: "k", apiUrl: "" },
      ],
    });
    expect(reg.resolve("haiku")).toMatchObject({ runtime: { name: "claude" }, model: "haiku" });
    expect(reg.resolve("api/claude-haiku-4-5")).toMatchObject({ runtime: { name: "api" }, model: "claude-haiku-4-5" });
    const withDsh = new RuntimeRegistry({ default: "claude", runtimes: [{ name: "claude", kind: "claude-code", bin: [], chatArgs: [] }, { name: "dsh", kind: "deepseek-harness", bin: [], profile: "headless", sshHost: "box" }] });
    expect(withDsh.resolve("dsh/deepseek-flash")).toMatchObject({ runtime: { name: "dsh", kind: "deepseek-harness", backend: "ssh:box" }, model: "deepseek-flash" });
    expect(() => reg.resolve("dsh/x")).toThrow(/unknown runtime: dsh/);
    expect(() => reg.resolve("api/")).toThrow(/invalid model/);
    expect(reg.get("nope")).toBeUndefined();
    expect(reg.list()).toEqual([
      { name: "claude", kind: "claude-code", backend: "ssh:box", capabilities: { complete: true, agent: true, chat: true }, default: true },
      { name: "api", kind: "anthropic-api", backend: "api", capabilities: { complete: true, agent: false, chat: false }, default: false },
    ]);
    expect(reg.describe()).toBe("claude (claude-code, ssh:box)*, api (anthropic-api, api)");
  });

  test("refuses duplicate names and a default that is not configured", () => {
    expect(() => new RuntimeRegistry({ default: "a", runtimes: [{ name: "a", kind: "claude-code", bin: [], chatArgs: [] }, { name: "a", kind: "claude-code", bin: [], chatArgs: [] }] })).toThrow(/duplicate/);
    expect(() => new RuntimeRegistry({ default: "b", runtimes: [{ name: "a", kind: "claude-code", bin: [], chatArgs: [] }] })).toThrow(/default runtime is not configured/);
    expect(claudeOnly().default.name).toBe("claude");
  });
});
