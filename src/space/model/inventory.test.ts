import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markOwner } from "../auth.ts";
import { parseGatewayYaml } from "../gateway/config.ts";
import { ModelGateway } from "../gateway/service.ts";
import { parseRuntimesYaml } from "../runtimes/config.ts";
import { RuntimeRegistry, type OptionAvailability } from "../runtimes/registry.ts";
import { WINDOWS } from "../testing.ts";
import { AGENT_CLIS, RuntimeHealth, availabilityOf, probeRuntime, readVersion, splitVersion, type ProbeResult, type ProbeTarget } from "./health.ts";
import type { MagpieInfo } from "../runtimes/magpie.ts";
import { addMagpieRuntimeText, addRuntimeText, createInventoryRoutes, inventory, machineRow, magpieTiers, peerRow, setTierPinsText } from "./inventory.ts";

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
      // Windows finds a program by its extension, not by a mode bit.
      const codex = join(home, ".local", "bin", WINDOWS ? "codex.cmd" : "codex");
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

describe("adding magpie to runtimes.yaml", () => {
  test("Claude Code through it, every tier pinned; a taken name gets a suffix; comments kept", () => {
    const current = "# mine\nruntimes:\n  magpie:\n    kind: codex-cli\n";
    const r = addMagpieRuntimeText(current, { url: "http://127.0.0.1:3425", models: { basic: "a/b", junior: "c/d", intermediate: "c/d", advanced: "c/d" }, claude: "/opt/claude" }, {});
    expect(r.name).toBe("magpie-2");
    expect(r.envUpdates).toEqual({});
    expect(r.text.startsWith("# mine\n")).toBe(true);
    const spec = parseRuntimesYaml(r.text, {}).config.runtimes.find((x) => x.name === "magpie-2");
    expect(spec).toMatchObject({ kind: "claude-code", bin: ["/opt/claude"], magpie: "http://127.0.0.1:3425", models: { basic: "a/b", advanced: "c/d" } });
  });

  test("no Claude Code: the Messages API, its caller key for .env unless already set", () => {
    const r = addMagpieRuntimeText(undefined, { url: "http://127.0.0.1:3425", models: { basic: "a/b" } }, {});
    expect(r.envUpdates).toEqual({ MAGPIE_API_KEY: "magpie-ai-space" });
    expect(parseRuntimesYaml(r.text, { MAGPIE_API_KEY: "magpie-ai-space" }).config.runtimes.map((x) => x.name)).toEqual(["magpie", "claude"]);
    expect(addMagpieRuntimeText(undefined, { url: "http://127.0.0.1:3425", models: { basic: "a/b" } }, { MAGPIE_API_KEY: "k" }).envUpdates).toEqual({});
  });

  test("a runtime's tier pins in runtimes.yaml: block or inline models replaced, removed when empty, comments kept", () => {
    const text = "# mine\nruntimes:\n  claude:\n    kind: claude-code\n  magpie:\n    # gateway\n    kind: claude-code\n    magpie: http://127.0.0.1:3425\n    models:\n      basic: a/b\n      junior: c/d\n  other:\n    kind: claude-code\n";
    const next = setTierPinsText(text, "magpie", { intermediate: "group/fast" }, {});
    expect(next).toContain("# mine");
    expect(next).toContain("    # gateway");
    const runtimes = parseRuntimesYaml(next, {}).config.runtimes;
    expect(runtimes.find((r) => r.name === "magpie")?.models).toEqual({ intermediate: "group/fast" });
    expect(runtimes.map((r) => r.name)).toEqual(["claude", "magpie", "other"]);
    const cleared = setTierPinsText(next, "magpie", {}, {});
    expect(cleared).not.toContain("models:");
    expect(parseRuntimesYaml(cleared, {}).config.runtimes.find((r) => r.name === "magpie")?.models).toBeUndefined();
    const inline = "runtimes:\n  magpie:\n    kind: claude-code\n    models: { basic: a/b }\n    magpie: http://127.0.0.1:3425\n";
    expect(parseRuntimesYaml(setTierPinsText(inline, "magpie", { basic: "x/y" }, {}), {}).config.runtimes[0]!.models).toEqual({ basic: "x/y" });
    // Added to a runtime that had none: at the end of its block.
    expect(parseRuntimesYaml(setTierPinsText("runtimes:\n  magpie:\n    kind: claude-code\n    magpie: http://127.0.0.1:3425\n", "magpie", { advanced: "x/y" }, {}), {}).config.runtimes[0]!.models).toEqual({ advanced: "x/y" });
    expect(() => setTierPinsText("runtimes:\n  magpie: { kind: claude-code }\n", "magpie", { basic: "x/y" }, {})).toThrow("by hand");
  });

  test("the tiers a request names, each one magpie offers", () => {
    const offered = ["zhipu/glm-4.6", "moonshot/kimi-k2.5"];
    expect(magpieTiers({ model: "zhipu/glm-4.6" }, offered)).toEqual({ basic: "zhipu/glm-4.6", junior: "zhipu/glm-4.6", intermediate: "zhipu/glm-4.6", advanced: "zhipu/glm-4.6" });
    expect(magpieTiers({ models: { basic: "moonshot/kimi-k2.5" } }, offered)).toEqual({ basic: "moonshot/kimi-k2.5" });
    expect(magpieTiers({ model: "x/y" }, offered)).toEqual({ error: "magpie does not offer x/y; check again and pick one of its models" });
    expect(magpieTiers({ models: { huge: "zhipu/glm-4.6" } }, offered)).toEqual({ error: "unknown tier huge" });
    expect("error" in magpieTiers({}, offered)).toBe(true);
    expect(magpieTiers({}, offered, true)).toEqual({});
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

  const magpieDown: MagpieInfo = { url: "http://127.0.0.1:3425", from: "default", running: false, models: [], groups: [], error: "nothing answers at http://127.0.0.1:3425" };
  const setup = async (answers: Record<string, ProbeResult>, yaml = "runtimes:\n  claude:\n    kind: claude-code\n", magpie: MagpieInfo = magpieDown) => {
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
      magpie: async () => magpie,
    });
    return { routes, runtimes, probes: () => probes };
  };
  const call = (h: { GET?: unknown; POST?: unknown; PUT?: unknown }, method: "GET" | "POST" | "PUT", body?: unknown, token = "op") =>
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

  test("magpie: shown with what adding it makes; added only when it answers, with models it offers", async () => {
    const up: MagpieInfo = { bin: "/usr/local/bin/magpie", url: "http://127.0.0.1:3425", from: "gateway.json", running: true, models: ["zhipu/glm-4.6", "moonshot/kimi-k2.5"], groups: [] };
    const down = await setup({});
    const shown = (await (await call(down.routes["/api/model/inventory"], "GET")).json()) as { magpie: { running: boolean; configured: boolean; adds: string } };
    expect(shown.magpie).toMatchObject({ running: false, configured: false, adds: "anthropic-api" });
    expect((await call(down.routes["/api/model/runtimes"], "POST", { kind: "magpie", model: "zhipu/glm-4.6" })).status).toBe(409);

    // Claude Code is found here: magpie is added as Claude Code through it.
    const { routes } = await setup({ "|claude": { installed: true, path: "/opt/claude", signedIn: false } }, "runtimes:\n  claude:\n    kind: claude-code\n", up);
    await call(routes["/api/model/status/probe"], "POST");
    expect(((await (await call(routes["/api/model/inventory"], "GET")).json()) as { magpie: { adds: string } }).magpie.adds).toBe("claude-code");
    const add = routes["/api/model/runtimes"];
    expect((await call(add, "POST", { kind: "magpie", model: "zhipu/glm-4.6" }, "wrong")).status).toBe(401);
    expect((await call(add, "POST", { kind: "magpie", model: "evil/model" })).status).toBe(400);
    const ok = await call(add, "POST", { kind: "magpie", model: "zhipu/glm-4.6", models: { basic: "moonshot/kimi-k2.5" } });
    expect(await ok.json()).toEqual({ ok: true, runtime: "magpie", kind: "claude-code", restart: true });
    const config = parseRuntimesYaml(await Bun.file(join(home, "runtimes.yaml")).text(), {}).config;
    expect(config.runtimes.find((r) => r.name === "magpie")).toEqual({ name: "magpie", kind: "claude-code", bin: ["/opt/claude"], chatArgs: [], magpie: "http://127.0.0.1:3425", models: { basic: "moonshot/kimi-k2.5", junior: "zhipu/glm-4.6", intermediate: "zhipu/glm-4.6", advanced: "zhipu/glm-4.6" } });
    expect(await Bun.file(join(home, ".env")).exists()).toBe(false);
    // Added and not running yet: a second add says to restart.
    const again = await call(add, "POST", { kind: "magpie", model: "zhipu/glm-4.6" });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("restart ai-space");
  });

  test("magpie without Claude Code here: its Messages API, with the caller key in .env", async () => {
    const up: MagpieInfo = { url: "http://127.0.0.1:3425", from: "default", running: true, models: ["zhipu/glm-4.6"], groups: [] };
    const { routes } = await setup({}, "runtimes:\n  codex:\n    kind: codex-cli\n", up);
    const ok = await call(routes["/api/model/runtimes"], "POST", { kind: "magpie", model: "zhipu/glm-4.6" });
    expect(await ok.json()).toEqual({ ok: true, runtime: "magpie", kind: "anthropic-api", restart: true });
    const env = await Bun.file(join(home, ".env")).text();
    expect(env).toContain("MAGPIE_API_KEY=magpie-ai-space");
    const config = parseRuntimesYaml(await Bun.file(join(home, "runtimes.yaml")).text(), { MAGPIE_API_KEY: "magpie-ai-space" }).config;
    expect(config.runtimes.find((r) => r.name === "magpie")).toMatchObject({ kind: "anthropic-api", apiUrl: "http://127.0.0.1:3425/v1/messages", models: { basic: "zhipu/glm-4.6" } });
  });

  test("magpie tier pins from Settings: operator only, magpie's ids, kept when it stops listing one or does not answer", async () => {
    const yaml = "runtimes:\n  claude:\n    kind: claude-code\n  # through the gateway\n  magpie:\n    kind: claude-code\n    magpie: http://127.0.0.1:3425\n    models:\n      basic: \"zhipu/glm-4.6\"\n";
    const m: MagpieInfo = { url: "http://127.0.0.1:3425", from: "default", running: true, models: ["zhipu/glm-4.6", "moonshot/kimi-k2.5", "group/fast"], groups: ["group/fast"] };
    const { routes, runtimes } = await setup({}, yaml, m);
    const shown = (await (await call(routes["/api/model/inventory"], "GET")).json()) as { magpie: { pins: unknown; groups: string[]; configured: boolean } };
    expect(shown.magpie.pins).toEqual([{ runtime: "magpie", kind: "claude-code", models: { basic: "zhipu/glm-4.6" }, loaded: true }]);
    expect(shown.magpie.groups).toEqual(["group/fast"]);
    const put = routes["/api/model/runtimes/models"];
    const pins = (models: Record<string, string>, runtime = "magpie", token = "op") => call(put, "PUT", { runtime, models }, token);
    expect((await pins({ basic: "group/fast" }, "magpie", "wrong")).status).toBe(401);
    expect((await pins({ huge: "group/fast" })).status).toBe(400);
    expect((await pins({ basic: "x/not-offered" })).status).toBe(400);
    expect((await pins({ basic: "group/fast" }, "claude")).status).toBe(409);
    expect((await pins({ basic: "group/fast" }, "ghost")).status).toBe(404);

    const ok = await pins({ basic: "", junior: "group/fast", advanced: "moonshot/kimi-k2.5" });
    expect(await ok.json()).toEqual({ ok: true, runtime: "magpie", models: { junior: "group/fast", advanced: "moonshot/kimi-k2.5" }, applied: true });
    const text = await Bun.file(join(home, "runtimes.yaml")).text();
    expect(text).toContain("# through the gateway");
    expect(parseRuntimesYaml(text, {}).config.runtimes.find((r) => r.name === "magpie")?.models).toEqual({ junior: "group/fast", advanced: "moonshot/kimi-k2.5" });
    // Applied without a restart: an unpinned tier is Claude Code's own.
    expect(runtimes.resolve("magpie/junior").model).toBe("group/fast");
    expect(runtimes.resolve("magpie/basic").model).toBe("haiku");

    // magpie stops listing one: the saved pin stays and can be kept, a new unlisted one cannot be picked.
    m.models = ["group/fast"];
    expect((await pins({ junior: "group/fast", advanced: "moonshot/kimi-k2.5" })).status).toBe(200);
    expect((await pins({ junior: "group/fast", intermediate: "zhipu/glm-4.6" })).status).toBe(400);

    // Down: the saved pins are still shown; keeping or clearing them works, a new one waits for magpie.
    Object.assign(m, { running: false, models: [], groups: [], error: "nothing answers" });
    const downView = (await (await call(routes["/api/model/inventory"], "GET")).json()) as { magpie: { running: boolean; pins: { models: unknown }[] } };
    expect(downView.magpie.running).toBe(false);
    expect(downView.magpie.pins[0]!.models).toEqual({ junior: "group/fast", advanced: "moonshot/kimi-k2.5" });
    expect((await pins({ junior: "group/fast" })).status).toBe(200);
    const wait = await pins({ junior: "group/fast", basic: "group/other" });
    expect(wait.status).toBe(409);
    expect(((await wait.json()) as { error: string }).error).toContain("does not answer");
  });

  test("magpie added from Settings: its pickers show before a restart, and saving says to restart", async () => {
    const m: MagpieInfo = { url: "http://127.0.0.1:3425", from: "default", running: true, models: ["zhipu/glm-4.6", "group/basic"], groups: ["group/basic"] };
    const { routes } = await setup({ "|claude": { installed: true, path: "/opt/claude", signedIn: true } }, "runtimes:\n  claude:\n    kind: claude-code\n", m);
    await call(routes["/api/model/status/probe"], "POST");
    const before = (await (await call(routes["/api/model/inventory"], "GET")).json()) as { magpie: { suggested: unknown; pins: unknown[] } };
    expect(before.magpie.suggested).toEqual({ basic: "group/basic" });
    expect(before.magpie.pins).toEqual([]);
    // Claude Code through magpie may leave every tier to the CLI.
    expect(((await (await call(routes["/api/model/runtimes"], "POST", { kind: "magpie", models: {} })).json()) as { ok: boolean }).ok).toBe(true);
    const after = (await (await call(routes["/api/model/inventory"], "GET")).json()) as { magpie: { configured: boolean; pins: unknown[] } };
    expect(after.magpie.configured).toBe(true);
    expect(after.magpie.pins).toEqual([{ runtime: "magpie", kind: "claude-code", models: {}, loaded: false }]);
    const saved = await call(routes["/api/model/runtimes/models"], "PUT", { runtime: "magpie", models: { basic: "group/basic" } });
    expect(await saved.json()).toEqual({ ok: true, runtime: "magpie", models: { basic: "group/basic" }, applied: false, restart: true });
  });

  test("the built-in model gateway: shown, its tiers saved to gateway.yaml with comments kept, operator only, bad ids refused, applied at once", async () => {
    const gatewayYaml = "# the gateway\nproviders:\n  ds:\n    preset: deepseek   # DeepSeek\n    apiKeyEnv: DS\n    models: [deepseek-chat]\n  openai: { preset: openai, apiKeyEnv: OA, models: [gpt-image-1] }\ngroups:\n  fast: [ds/deepseek-chat]\ntiers:\n  basic: fast   # the cheap one\n";
    const yaml = "runtimes:\n  gw:\n    kind: anthropic-api\n    gateway: space\n    models: { advanced: ds/deepseek-reasoner }\n";
    const env = { DS: "k", OA: "k" };
    const gateway = new ModelGateway({ config: parseGatewayYaml(gatewayYaml, env).config, log: () => {} });
    await writeFile(join(home, "gateway.yaml"), gatewayYaml);
    await writeFile(join(home, "runtimes.yaml"), yaml);
    const runtimes = new RuntimeRegistry(parseRuntimesYaml(yaml, {}).config, { gateway: gateway.link });
    const routes = createInventoryRoutes({ health: new RuntimeHealth({ prober: table({}) }), runtimes, peers: () => [], probe: async () => {}, home, token: "op", env, magpie: async () => magpieDown, gateway });
    const shown = (await (await call(routes["/api/model/inventory"], "GET")).json()) as { gateway: Record<string, unknown> };
    expect(shown.gateway).toMatchObject({ configured: true, exists: true, file: join(home, "gateway.yaml"), saved: { basic: "fast" }, models: ["fast", "ds/deepseek-chat", "openai/gpt-image-1"], imageModels: ["openai/gpt-image-1"] });
    expect(shown.gateway.pins).toEqual([{ runtime: "gw", kind: "anthropic-api", models: { advanced: "ds/deepseek-reasoner" }, loaded: true }]);
    expect((shown.gateway.providers as { name: string }[]).map((p) => p.name)).toEqual(["ds", "openai"]);

    const put = (tiers: unknown, token = "op") => call(routes["/api/model/gateway/tiers"], "PUT", { tiers }, token);
    expect((await put({ junior: "ds/deepseek-chat" }, "wrong")).status).toBe(401);
    expect((await put({ huge: "fast" })).status).toBe(400);
    expect((await put({ junior: "kimi/k2" })).status).toBe(400); // no such provider in gateway.yaml
    expect((await put({ junior: "ds/bad id" })).status).toBe(400); // not a model id
    expect((await put({ image: "ds/deepseek-chat" })).status).toBe(400); // no openai base: it cannot draw
    expect(await Bun.file(join(home, "gateway.yaml")).text()).toBe(gatewayYaml);

    // A model typed by hand that the provider does not list is fine: the provider is in the file.
    const ok = await put({ basic: "", junior: "fast", advanced: "ds/deepseek-v4-pro", image: "openai/gpt-image-1" });
    expect(await ok.json()).toEqual({ ok: true, tiers: { junior: "fast", advanced: "ds/deepseek-v4-pro", image: "openai/gpt-image-1" }, applied: true });
    const text = await Bun.file(join(home, "gateway.yaml")).text();
    expect(text).toStartWith("# the gateway\n");
    expect(text).toContain("preset: deepseek   # DeepSeek");
    expect(parseGatewayYaml(text, env).config.tiers).toEqual({ junior: "fast", advanced: "ds/deepseek-v4-pro", image: "openai/gpt-image-1" });
    // From the next call, no restart: the runtime's own pin still wins.
    expect(runtimes.resolve("gw/junior").model).toBe("fast");
    expect(runtimes.resolve("gw/advanced").model).toBe("ds/deepseek-reasoner");
    expect(runtimes.resolve("gw/basic", "image").model).toBe("openai/gpt-image-1");

    // A saved value whose provider left the file stays; it can be kept, not newly picked.
    const gone = text.replace("  openai: { preset: openai, apiKeyEnv: OA, models: [gpt-image-1] }\n", "");
    await writeFile(join(home, "gateway.yaml"), gone);
    expect((await put({ junior: "fast", image: "openai/gpt-image-1" })).status).toBe(200);
    expect((await put({ junior: "openai/gpt-5" })).status).toBe(400);
  });

  test("no gateway.yaml: the view says where to write it; saving says so too", async () => {
    const gateway = new ModelGateway({ log: () => {} });
    const runtimes = new RuntimeRegistry(parseRuntimesYaml("runtimes:\n  claude:\n    kind: claude-code\n", {}).config, { gateway: gateway.link });
    const routes = createInventoryRoutes({ health: new RuntimeHealth({ prober: table({}) }), runtimes, peers: () => [], probe: async () => {}, home, token: "op", env: {}, magpie: async () => magpieDown, gateway });
    const shown = (await (await call(routes["/api/model/inventory"], "GET")).json()) as { gateway: Record<string, unknown> };
    expect(shown.gateway).toMatchObject({ configured: false, exists: false, file: join(home, "gateway.yaml"), pins: [] });
    const r = await call(routes["/api/model/gateway/tiers"], "PUT", { tiers: { basic: "ds/x" } });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toContain("there is no gateway.yaml");
  });

  test("the owner's session counts as the operator", async () => {
    const { routes } = await setup({});
    const req = new Request("http://x/", { method: "POST" });
    markOwner(req);
    expect((await (routes["/api/model/status/probe"].POST as (r: Request) => Promise<Response>)(req)).status).toBe(200);
  });
});
