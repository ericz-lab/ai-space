import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRuntimesYaml } from "./config.ts";
import { codexUpgrade, intersectCatalogs, latestOfFamily, proposeTiers, setTierModels, type CatalogModel, type Run } from "./codex-upgrade.ts";

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
  });

  test("proposes only newer models and leaves custom ones", () => {
    expect(proposeTiers(catalog, { basic: "gpt-6-luna", junior: "gpt-5.6-terra", intermediate: "gpt-6-sol", advanced: "gpt-6-astra" })).toEqual({ intermediate: "gpt-6.1-sol" });
    expect(proposeTiers(catalog, { intermediate: "my-proxy-sol", advanced: "gpt-7-astra" })).toEqual({ basic: "gpt-6-luna", junior: "gpt-5.6-terra" });
  });

  test("a model counts only when every machine lists it", () => {
    expect(intersectCatalogs([catalog, catalog.filter((m) => m.slug !== "gpt-6.1-sol")]).map((m) => m.slug)).not.toContain("gpt-6.1-sol");
  });
});

const yaml = `# Runtimes of this space.
default: claude
runtimes:
  claude:
    kind: claude-code

  codex:
    kind: codex-cli
    ssh: ssh-david
    models:
      basic: gpt-6-luna   # cheap
      intermediate: gpt-6-sol

  other:
    kind: codex-cli
`;

describe("setTierModels", () => {
  test("replaces and adds tiers, keeping comments", () => {
    const out = setTierModels(yaml, "codex", { basic: "gpt-6.1-luna", intermediate: "gpt-6.1-sol", advanced: "gpt-7-astra" });
    expect(out).toContain("      basic: gpt-6.1-luna   # cheap\n      intermediate: gpt-6.1-sol\n      advanced: gpt-7-astra\n\n  other:");
    expect(out.startsWith("# Runtimes of this space.")).toBe(true);
    expect(parseRuntimesYaml(out).config.runtimes.find((r) => r.name === "codex")!.models).toEqual({ basic: "gpt-6.1-luna", intermediate: "gpt-6.1-sol", advanced: "gpt-7-astra" });
  });

  test("adds a models block to a runtime without one", () => {
    const out = setTierModels(yaml, "other", { intermediate: "gpt-6.1-sol" });
    expect(out.endsWith("  other:\n    kind: codex-cli\n    models:\n      intermediate: gpt-6.1-sol\n")).toBe(true);
    expect(parseRuntimesYaml(out).config.runtimes.find((r) => r.name === "other")!.models).toEqual({ intermediate: "gpt-6.1-sol" });
  });
});

describe("codexUpgrade", () => {
  const setup = async () => {
    const home = await mkdtemp(join(tmpdir(), "space-codex-upgrade-"));
    await Bun.write(join(home, "runtimes.yaml"), yaml.replace(/\n  other:\n    kind: codex-cli\n/, "\n"));
    return home;
  };
  const fake = (refuse: string[] = []) => {
    const calls: string[] = [];
    const run: Run = async (cmd) => {
      const line = cmd.join(" ");
      calls.push(line);
      if (line.includes("--version")) return { code: 0, stdout: "codex-cli 0.159.2\n", stderr: "" };
      if (line.includes("debug models")) return { code: 0, stdout: JSON.stringify({ models: catalog }), stderr: "" };
      if (line.includes(" exec ")) return refuse.some((m) => line.includes(m)) ? { code: 1, stdout: "", stderr: "ERROR: not supported" } : { code: 0, stdout: "ok", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    return { run, calls };
  };

  test("updates, probes on both machines, writes and restarts", async () => {
    const home = await setup();
    try {
      const { run, calls } = fake();
      const r = await codexUpgrade({ home, restart: true, log: () => {}, run });
      expect(r.changes).toEqual([{ runtime: "codex", tier: "intermediate", from: "gpt-6-sol", to: "gpt-6.1-sol" }]);
      expect(r.written && r.restarted).toBe(true);
      expect(calls.filter((c) => c.includes(" update")).length).toBe(2); // local and ssh-david
      expect(calls.filter((c) => c.includes(" exec ")).length).toBe(2);
      expect(await Bun.file(join(home, "runtimes.yaml")).text()).toContain("intermediate: gpt-6.1-sol");
      expect(await Bun.file(join(home, "runtimes.yaml.bak")).text()).toContain("intermediate: gpt-6-sol");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a model the account refuses is kept out; a dry run writes nothing", async () => {
    const home = await setup();
    try {
      const refused = await codexUpgrade({ home, log: () => {}, run: fake(["gpt-6.1-sol"]).run });
      expect(refused.changes).toEqual([]);
      expect(refused.failures[0]).toContain("gpt-6.1-sol did not answer");
      const { run, calls } = fake();
      const dry = await codexUpgrade({ home, dryRun: true, log: () => {}, run });
      expect(dry.changes.length).toBe(1);
      expect(dry.written).toBe(false);
      expect(calls.some((c) => c.includes(" update") || c.includes(" exec "))).toBe(false);
      expect(await Bun.file(join(home, "runtimes.yaml")).text()).toContain("intermediate: gpt-6-sol\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
