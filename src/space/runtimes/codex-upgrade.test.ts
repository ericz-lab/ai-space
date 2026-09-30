import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuntimesYaml } from "./config.ts";
import { catalogTiers, codexUpgrade, intersectCatalogs, latestOfFamily, refreshCodexTiers, stalePins, type CatalogModel, type Run } from "./codex-upgrade.ts";
import { RuntimeRegistry } from "./registry.ts";

const catalog: CatalogModel[] = [
  { slug: "gpt-6-astra", visibility: "list" },
  { slug: "gpt-6.1-sol", visibility: "list" },
  { slug: "gpt-6-sol", visibility: "list" },
  { slug: "gpt-6-luna", visibility: "list" },
  { slug: "gpt-5.6-sol", visibility: "list", upgrade: { model: "gpt-6-sol" } },
  { slug: "gpt-5.6-terra", visibility: "list", upgrade: { model: "gpt-6-sol" } },
  { slug: "gpt-7-sol", visibility: "hide" },
];

describe("catalogue", () => {
  test("the newest listed model of each family", () => {
    expect(latestOfFamily(catalog, "sol")).toBe("gpt-6.1-sol");
    expect(latestOfFamily(catalog, "terra")).toBe("gpt-5.6-terra"); // only a model marked for upgrade is left
    expect(latestOfFamily(catalog, "nova")).toBeUndefined();
    expect(catalogTiers(catalog)).toEqual({ basic: "gpt-6-luna", junior: "gpt-5.6-terra", intermediate: "gpt-6.1-sol", advanced: "gpt-6-astra" });
  });

  test("a model counts only when every machine lists it", () => {
    expect(catalogTiers(intersectCatalogs([catalog, catalog.filter((m) => m.slug !== "gpt-6.1-sol")])).intermediate).toBe("gpt-6-sol");
  });

  test("a pin older than the catalogue is reported; a custom one is not", () => {
    expect(stalePins({ intermediate: "gpt-6-sol", basic: "my-luna" }, catalogTiers(catalog))).toEqual([{ tier: "intermediate", pinned: "gpt-6-sol", latest: "gpt-6.1-sol" }]);
  });
});

const yaml = `default: claude
runtimes:
  claude:
    kind: claude-code
  codex:
    kind: codex-cli
    ssh: ssh-david
    models:
      basic: my-luna
`;

const fake = (opts: { refuse?: string[]; remote?: CatalogModel[] } = {}) => {
  const calls: string[] = [];
  const run: Run = async (cmd) => {
    const line = cmd.join(" ");
    calls.push(line);
    if (line.includes("--version")) return { code: 0, stdout: "codex-cli 0.159.2\n", stderr: "" };
    if (line.includes("debug models")) return { code: 0, stdout: JSON.stringify({ models: cmd[0] === "ssh" && opts.remote ? opts.remote : catalog }), stderr: "" };
    if (line.includes(" exec ")) return opts.refuse?.some((m) => line.includes(m)) ? { code: 1, stdout: "", stderr: "ERROR: not supported" } : { code: 0, stdout: "ok", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
};

test("boot takes the codex tiers from the catalogue of both machines, under the pins", async () => {
  const config = parseRuntimesYaml(yaml).config;
  const registry = new RuntimeRegistry(config);
  const logs: string[] = [];
  await refreshCodexTiers(registry, config.runtimes, (l) => logs.push(l), fake({ remote: catalog.filter((m) => m.slug !== "gpt-6-astra") }).run);
  expect(registry.resolve("codex/intermediate").model).toBe("gpt-6.1-sol");
  expect(registry.resolve("codex/basic").model).toBe("my-luna");
  expect(registry.resolve("codex/advanced").model).toBe("gpt-6-astra"); // not on ssh-david: the fallback name
  expect(registry.resolve("claude/intermediate").model).toBe("opus");
  expect(logs[0]).toContain("advanced=fallback");
});

describe("codexUpgrade", () => {
  const withHome = async (fn: (home: string) => Promise<void>) => {
    const home = await mkdtemp(join(tmpdir(), "space-codex-upgrade-"));
    try {
      await Bun.write(join(home, "runtimes.yaml"), yaml);
      await fn(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };

  test("updates both machines, probes every tier there, never touches runtimes.yaml, restarts", () => withHome(async (home) => {
    const { run, calls } = fake();
    const r = await codexUpgrade({ home, restart: true, log: () => {}, run });
    expect(r.failures).toEqual([]);
    expect(r.tiers.codex).toEqual({ basic: "my-luna", junior: "gpt-5.6-terra", intermediate: "gpt-6.1-sol", advanced: "gpt-6-astra" });
    expect(calls.filter((c) => c.includes(" update")).length).toBe(2);
    expect(calls.filter((c) => c.includes(" exec ")).length).toBe(8);
    expect(r.restarted).toBe(true);
    expect(await Bun.file(join(home, "runtimes.yaml")).text()).toBe(yaml);
  }));

  test("a model the account refuses is a failure; a dry run only reads", () => withHome(async (home) => {
    const refused = await codexUpgrade({ home, log: () => {}, run: fake({ refuse: ["gpt-6.1-sol"] }).run });
    expect(refused.failures.map((f) => f.split(":")[0])).toEqual(["codex/intermediate", "codex/intermediate"]);
    const { run, calls } = fake();
    await codexUpgrade({ home, dryRun: true, restart: true, log: () => {}, run });
    expect(calls.some((c) => c.includes(" update") || c.includes(" exec ") || c.includes("systemctl"))).toBe(false);
  }));
});
