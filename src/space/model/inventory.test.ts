import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOwner } from "../auth.ts";
import { parseRuntimesYaml } from "../runtimes/config.ts";
import { RuntimeRegistry, type OptionAvailability } from "../runtimes/registry.ts";
import { AGENT_CLIS, RuntimeHealth, availabilityOf, probeRuntime, readVersion, splitVersion, type ProbeResult, type ProbeTarget } from "./health.ts";
import { addRuntimeText, createInventoryRoutes, inventory, machineRow, peerRow } from "./inventory.ts";

/** Which CLIs each machine has, and the choices that follow from it: docs/model-machines.md#inventory. */

const registry = () =>
  new RuntimeRegistry(
    parseRuntimesYaml(
      ["runtimes:", "  claude:", "    kind: claude-code", "  codex:", "    kind: codex-cli", "  dsh:", "    kind: deepseek-harness", "machines:", "  bare:", "    ssh: bare-alias"].join("\n"),
      {},
    ).config,
  );

/** A prober that answers from a table keyed `machine|runtime`; anything else is unknown. */
const table = (answers: Record<string, ProbeResult>) => async (t: ProbeTarget) => answers[`${t.machine}|${t.spec.name}`] ?? {};

describe("probing", () => {
  test("a CLI's version line becomes its number", () => {
    expect(readVersion("2.1.3 (Claude Code)\n")).toBe("2.1.3");
    expect(readVersion("codex-cli 0.50.0")).toBe("0.50.0");
    expect(readVersion("0.9.1-beta.2")).toBe("0.9.1-beta.2");
    expect(readVersion("{\"loggedIn\": true}")).toBeUndefined();
    expect(readVersion("")).toBeUndefined();
  });

  test("a remote probe's version marker is read and left out of the status output", () => {
    expect(splitVersion('@@space-version:codex-cli 0.50.0\n{"loggedIn": true}')).toEqual({ version: "0.50.0", rest: '{"loggedIn": true}' });
    expect(splitVersion("Logged in")).toEqual({ rest: "Logged in" });
  });

  test("over ssh, one round trip says installed, version and signed in", async () => {
    const calls: string[][] = [];
    const spawn = (async (cmd: string[]) => {
      calls.push(cmd);
      return { code: 0, stdout: "@@space-version:2.1.3 (Claude Code)\n{\"loggedIn\": true}", stderr: "", timedOut: false, aborted: false };
    }) as unknown as Parameters<typeof probeRuntime>[0];
    const r = await probeRuntime(spawn)({ machine: "bare", spec: { name: "claude", kind: "claude-code", bin: [], chatArgs: [] }, ssh: "bare-alias" });
    expect(r).toEqual({ installed: true, version: "2.1.3", signedIn: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at(-1)).toContain("--version");
  });

  test("discovery looks in the user's tool directories and reports where the CLI is", async () => {
    const home = await mkdtemp(join(tmpdir(), "space-inv-home-"));
    try {
      await mkdir(join(home, ".local", "bin"), { recursive: true });
      const codex = join(home, ".local", "bin", "codex");
      await writeFile(codex, "#!/bin/sh\nexit 0\n");
      await chmod(codex, 0o755);
      const spawn = (async (cmd: string[]) => ({ code: 0, stdout: cmd[1] === "--version" ? "codex-cli 0.50.0" : "Logged in", stderr: "", timedOut: false, aborted: false })) as unknown as Parameters<typeof probeRuntime>[0];
      const probe = probeRuntime(spawn, { PATH: "/nonexistent" }, home);
      const spec = { name: "codex", kind: "codex-cli" as const, bin: [] };
      // The runtime's own probe searches only the service's PATH; discovery finds it.
      expect(await probe({ machine: "", spec })).toMatchObject({ installed: false });
      expect(await probe({ machine: "", spec, discover: true })).toEqual({ installed: true, version: "0.50.0", path: codex, signedIn: true });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("availability: missing hidden, signed out or offline greyed, unknown kept", () => {
    expect(availabilityOf(undefined)).toEqual({ state: "ok" });
    expect(availabilityOf({})).toEqual({ state: "ok" });
    expect(availabilityOf({ installed: true, signedIn: true })).toEqual({ state: "ok" });
    expect(availabilityOf({ installed: false })).toEqual({ state: "missing" });
    expect(availabilityOf({ reachable: false })).toEqual({ state: "missing" });
    expect(availabilityOf({ installed: true, signedIn: false })).toEqual({ state: "disabled", reason: "signed-out" });
    expect(availabilityOf({ installed: true, signedIn: true }, true)).toEqual({ state: "disabled", reason: "offline" });
  });
});

describe("choices", () => {
  test("a missing CLI is left out, a signed-out one greyed, an unprobed one kept", () => {
    const r = registry();
    const states: Record<string, OptionAvailability> = { "|claude": { state: "missing" }, "|codex": { state: "disabled", reason: "signed-out" } };
    r.setAvailability((machine, runtime) => states[`${machine}|${runtime}`] ?? { state: "ok" });
    const opts = r.tierOptions();
    expect(opts.some((o) => o.runtime === "claude")).toBe(false);
    expect(opts.filter((o) => o.runtime === "codex").every((o) => o.unavailable === "signed-out")).toBe(true);
    expect(opts.filter((o) => o.runtime === "dsh").length).toBeGreaterThan(0);
    expect(opts.filter((o) => o.runtime === "dsh").some((o) => o.unavailable)).toBe(false);
    // Checking a value still sees every configured runtime.
    expect(r.tierOptions({ all: true }).some((o) => o.runtime === "claude")).toBe(true);
    // A saved choice still resolves: only the offer changes.
    expect(r.resolve("claude/basic").runtime.name).toBe("claude");
  });

  test("on other machines: a login without the CLI is left out; a peer's own probe and its link decide", () => {
    const r = registry();
    r.setAvailability((machine, runtime) => (machine === "bare" && runtime === "codex" ? { state: "missing" } : { state: "ok" }));
    r.attachRemote({
      names: () => ["david", "eric"],
      adapter: () => ({ error: "unused" }),
      offered: () => [
        { machine: "david", runtime: "claude", kind: "claude-code", image: false, tiers: { basic: "haiku" }, availability: { state: "disabled", reason: "offline" } },
        { machine: "eric", runtime: "codex", kind: "codex-cli", image: true, tiers: { basic: "luna" }, availability: { state: "missing" } },
      ],
    });
    const values = r.machineTierOptions();
    expect(values.some((o) => o.value.startsWith("bare:codex/"))).toBe(false);
    expect(values.some((o) => o.value.startsWith("bare:claude/"))).toBe(true);
    expect(values.find((o) => o.value === "david:claude/basic")).toMatchObject({ unavailable: "offline" });
    expect(values.some((o) => o.machine === "eric")).toBe(false);
  });
});

describe("inventory", () => {
  test("each machine lists every agent CLI, configured or not, with the runtime's own probe first", async () => {
    const r = registry();
    const health = new RuntimeHealth({
      prober: table({
        "|claude": { installed: true, signedIn: true, version: "2.1.3" },
        "|codex": { installed: false },
        "|dsh": { installed: true, signedIn: false },
        "bare|claude": { reachable: false },
      }),
    });
    await health.probe([{ machine: "", spec: r.spec("claude")! }, { machine: "", spec: r.spec("codex")! }, { machine: "", spec: r.spec("dsh")! }]);
    // Discovery: the CLI by its default name; codex is found here though the runtime's own command is not.
    const discover = new RuntimeHealth({ prober: table({ "|codex": { installed: true, version: "0.50.0", path: "/opt/codex" } }) });
    await discover.discover([{ machine: "" }]);
    (health as unknown as { found: Map<string, unknown> }).found = (discover as unknown as { found: Map<string, unknown> }).found;
    const row = machineRow(health, r, "", "local");
    expect(row.clis.map((c) => c.cli)).toEqual(AGENT_CLIS.map((c) => c.cli));
    expect(row.clis[0]).toMatchObject({ cli: "claude", installed: true, signedIn: true, version: "2.1.3", configured: true, runtimes: ["claude"] });
    expect(row.clis[1]).toMatchObject({ cli: "codex", installed: false, version: "0.50.0", path: "/opt/codex", configured: true });
    expect(row.clis[2]).toMatchObject({ cli: "dsh", installed: true, signedIn: false });
    // The peer's own row leaves out where things are.
    expect(peerRow(health, r).clis.every((c) => !("path" in c))).toBe(true);
  });

  test("rows for this space, each machines: login and each peer; an older peer shows as such", async () => {
    const r = registry();
    const health = new RuntimeHealth({ prober: table({}) });
    const rows = inventory({
      health,
      runtimes: r,
      peers: () => [
        { machine: "david", stale: true, inventory: { machine: "", via: "local", clis: [{ cli: "claude", kind: "claude-code", installed: true, configured: true, runtimes: ["claude"], path: "/secret" }] } },
        { machine: "old", stale: false },
      ],
    });
    expect(rows.map((x) => [x.machine, x.via])).toEqual([["", "local"], ["bare", "ssh"], ["david", "peer"], ["old", "peer"]]);
    expect(rows[2]).toMatchObject({ stale: true, clis: [{ cli: "claude", installed: true }] });
    expect(rows[2]!.clis[0]).not.toHaveProperty("path");
    expect(rows[3]).toMatchObject({ old: true, clis: [] });
  });
});

describe("adding a CLI to runtimes.yaml", () => {
  test("the text gains the runtime under the CLI's name, comments kept; a taken name gets a suffix", () => {
    const current = "# mine\nruntimes:\n  claude:\n    kind: claude-code # here\n";
    const { text, name } = addRuntimeText(current, { cli: "codex", kind: "codex-cli", path: "/opt/codex" }, {});
    expect(name).toBe("codex");
    expect(text).toContain("# mine");
    expect(text).toContain("# here");
    const parsed = parseRuntimesYaml(text, {}).config.runtimes;
    expect(parsed.find((x) => x.name === "codex")).toMatchObject({ kind: "codex-cli", bin: ["/opt/codex"] });
    // Added before, not running yet: not added twice.
    expect(() => addRuntimeText(text, { cli: "codex", kind: "codex-cli", path: "/opt/codex" }, {})).toThrow(/restart/);
    const again = addRuntimeText("runtimes:\n    codex:\n        kind: claude-code\n", { cli: "codex", kind: "codex-cli", path: "/opt/codex" }, {});
    expect(again.name).toBe("codex-2");
    expect(parseRuntimesYaml(again.text, {}).config.runtimes.map((x) => x.name).sort()).toEqual(["codex", "codex-2"]);
  });

  test("no file: the environment's runtime is kept, its key left in the environment", () => {
    const { text } = addRuntimeText(undefined, { cli: "codex", kind: "codex-cli", path: "/opt/codex" }, { SPACE_MODEL_API_KEY: "sk-test", SPACE_MODEL_BIN: "/bin/claude" });
    expect(text).not.toContain("sk-test");
    const cfg = parseRuntimesYaml(text, { SPACE_MODEL_API_KEY: "sk-test" }).config;
    expect(cfg.default).toBe("api");
    expect(cfg.runtimes.map((x) => x.name)).toEqual(["codex", "claude", "api"]);
  });

  test("a flow-style runtimes mapping is refused rather than rewritten", () => {
    expect(() => addRuntimeText("runtimes: { claude: { kind: claude-code } }\n", { cli: "codex", kind: "codex-cli", path: "/opt/codex" }, {})).toThrow(/by hand/);
  });
});

describe("routes", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "space-inv-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const setup = async (answers: Record<string, ProbeResult>, yaml = "runtimes:\n  claude:\n    kind: claude-code\n") => {
    await writeFile(join(home, "runtimes.yaml"), yaml);
    const runtimes = new RuntimeRegistry(parseRuntimesYaml(yaml, {}).config);
    const health = new RuntimeHealth({ prober: table(answers) });
    let probes = 0;
    const routes = createInventoryRoutes({
      health,
      runtimes,
      peers: () => [],
      probe: async () => {
        probes++;
        await health.discover([{ machine: "" }]);
      },
      home,
      token: "op",
      env: {},
    });
    return { routes, probes: () => probes };
  };
  const call = (h: { GET?: unknown; POST?: unknown }, method: "GET" | "POST", body?: unknown, token = "op") =>
    (h[method] as (r: Request) => Promise<Response>)(new Request("http://x/", { method, headers: token ? { authorization: `Bearer ${token}`, "content-type": "application/json" } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));

  test("probe again: operator only, then the fresh table", async () => {
    const { routes, probes } = await setup({ "|codex": { installed: true, path: "/opt/codex", version: "0.50.0" } });
    expect((await call(routes["/api/model/status/probe"], "POST", undefined, "wrong")).status).toBe(401);
    const r = await call(routes["/api/model/status/probe"], "POST");
    expect(probes()).toBe(1);
    const j = (await r.json()) as { machines: { clis: { cli: string; version?: string }[] }[] };
    expect(j.machines[0]!.clis.find((c) => c.cli === "codex")).toMatchObject({ version: "0.50.0" });
  });

  test("add to runtimes.yaml: operator only, a known kind, found here and not configured; the path is this side's own", async () => {
    const { routes } = await setup({ "|codex": { installed: true, path: "/opt/codex" }, "|dsh": { installed: false } });
    await call(routes["/api/model/status/probe"], "POST");
    const add = routes["/api/model/runtimes"];
    expect((await call(add, "POST", { kind: "codex-cli" }, "wrong")).status).toBe(401);
    expect((await call(add, "POST", { kind: "anthropic-api" })).status).toBe(400);
    expect((await call(add, "POST", { kind: "../etc" })).status).toBe(400);
    expect((await call(add, "POST", { kind: "claude-code" })).status).toBe(409); // already configured
    expect((await call(add, "POST", { kind: "deepseek-harness" })).status).toBe(409); // not found here
    const ok = await call(add, "POST", { kind: "codex-cli", path: "/tmp/evil" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, runtime: "codex", restart: true });
    const text = await Bun.file(join(home, "runtimes.yaml")).text();
    expect(text).toContain('"/opt/codex"');
    expect(text).not.toContain("evil");
    expect(parseRuntimesYaml(text, {}).config.runtimes.map((x) => x.name)).toEqual(["codex", "claude"]);
  });

  test("the owner's session counts as the operator", async () => {
    const { routes } = await setup({});
    const req = new Request("http://x/", { method: "POST" });
    markOwner(req);
    expect((await (routes["/api/model/status/probe"].POST as (r: Request) => Promise<Response>)(req)).status).toBe(200);
  });
});
