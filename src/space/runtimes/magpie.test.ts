import { describe, expect, test } from "bun:test";
import { probeRuntime } from "../model/health.ts";
import { createClaudeCode } from "./claude-code.ts";
import { parseRuntimesYaml } from "./config.ts";
import { MAGPIE_CALLER_KEY, findMagpie, loopbackUrl, magpieAddress, magpieClaudeEnv, magpieConfigDir, readModelList, validGatewayUrl } from "./magpie.ts";
import { RuntimeRegistry } from "./registry.ts";
import { fakeModelBin } from "./testing.ts";
import type { ClaudeCodeSpec, CompleteInput } from "./types.ts";

/** magpie's gateway as a stand-in: its model list, or nothing answering. */
function gateway(models: string[] | "down" | "junk", seen: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(url)} ${new Headers(init?.headers).get("authorization") ?? ""}`);
    if (models === "down") throw new TypeError("fetch failed");
    if (models === "junk") return new Response("<html>", { status: 200 });
    return Response.json({ object: "list", data: models.map((id) => ({ id, object: "model" })), has_more: false });
  }) as unknown as typeof fetch;
}

const none = () => undefined;

describe("finding magpie", () => {
  test("its address: MAGPIE_ADDR, then what the running gateway wrote, then the default port", () => {
    expect(loopbackUrl("0.0.0.0:10100")).toBe("http://127.0.0.1:10100");
    expect(loopbackUrl("[::]:3425")).toBe("http://127.0.0.1:3425");
    expect(loopbackUrl("127.0.0.1:3425")).toBe("http://127.0.0.1:3425");
    expect(loopbackUrl("nonsense")).toBeUndefined();
    expect(magpieConfigDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/magpie");
    expect(magpieConfigDir({}, "/h")).toBe("/h/.config/magpie");

    const file = (text: string | undefined) => (p: string) => (p === "/h/.config/magpie/gateway.json" ? text : undefined);
    expect(magpieAddress({ env: { MAGPIE_ADDR: "0.0.0.0:4000" }, home: "/h", readText: file('{"addr":"127.0.0.1:5000"}') })).toEqual({ url: "http://127.0.0.1:4000", from: "env" });
    expect(magpieAddress({ env: {}, home: "/h", readText: file('{"addr":"0.0.0.0:5000","pid":7,"version":"2.1.0"}') })).toEqual({ url: "http://127.0.0.1:5000", from: "gateway.json", version: "2.1.0" });
    expect(magpieAddress({ env: {}, home: "/h", readText: file("{half") })).toEqual({ url: "http://127.0.0.1:3425", from: "default" });
    expect(magpieAddress({ env: {}, home: "/h", readText: file(undefined) })).toEqual({ url: "http://127.0.0.1:3425", from: "default" });
  });

  test("running: its models, asked once with ai-space's caller key", async () => {
    const seen: string[] = [];
    const m = await findMagpie({ env: {}, home: "/h", readText: none, which: () => "/usr/local/bin/magpie", fetch: gateway(["zhipu/glm-4.6", "moonshot/kimi-k2.5", "zhipu/glm-4.6", "group/cheap"], seen) });
    expect(m).toEqual({ bin: "/usr/local/bin/magpie", url: "http://127.0.0.1:3425", from: "default", running: true, models: ["zhipu/glm-4.6", "moonshot/kimi-k2.5", "group/cheap"] });
    expect(seen).toEqual([`http://127.0.0.1:3425/v1/models Bearer ${MAGPIE_CALLER_KEY}`]);
  });

  test("installed but not answering, or something else on the port", async () => {
    const down = await findMagpie({ env: {}, home: "/h", readText: none, which: () => "/usr/local/bin/magpie", fetch: gateway("down") });
    expect(down.running).toBe(false);
    expect(down.error).toBe("nothing answers at http://127.0.0.1:3425");
    const junk = await findMagpie({ env: {}, home: "/h", readText: none, which: none, fetch: gateway("junk") });
    expect(junk).toMatchObject({ running: false, error: "http://127.0.0.1:3425/v1/models is not a model list" });
    expect(junk.bin).toBeUndefined();
    expect(readModelList({ data: [{ id: "a/b" }, { id: 3 }, { id: "-x" }, {}] })).toEqual(["a/b"]);
  });

  test("a gateway address in runtimes.yaml is a plain http(s) origin", () => {
    expect(validGatewayUrl("http://127.0.0.1:3425")).toBe(true);
    expect(validGatewayUrl("https://magpie.example.com")).toBe(true);
    expect(validGatewayUrl("http://127.0.0.1:3425/v1/messages")).toBe(false);
    expect(validGatewayUrl("ftp://x")).toBe(false);
    expect(validGatewayUrl("http://u:p@127.0.0.1:3425")).toBe(false);
  });
});

describe("Claude Code through magpie", () => {
  const yaml = (extra = "") => `runtimes:\n  claude:\n    kind: claude-code\n  glm:\n    kind: claude-code\n    magpie: http://127.0.0.1:3425/\n    models:\n      basic: zhipu/glm-4.5-air\n      intermediate: zhipu/glm-4.6\n${extra}`;

  test("runtimes.yaml: magpie: on a claude-code runtime, its pins may be magpie's provider/model ids", () => {
    const { config } = parseRuntimesYaml(yaml(), {});
    expect(config.runtimes.find((r) => r.name === "glm")).toEqual({ name: "glm", kind: "claude-code", bin: [], chatArgs: [], magpie: "http://127.0.0.1:3425", models: { basic: "zhipu/glm-4.5-air", intermediate: "zhipu/glm-4.6" } });
    expect(() => parseRuntimesYaml("runtimes:\n  c:\n    kind: claude-code\n    models: { basic: zhipu/glm-4.6 }\n", {})).toThrow("basic must name a concrete model");
    expect(() => parseRuntimesYaml("runtimes:\n  c:\n    kind: claude-code\n    magpie: http://127.0.0.1:3425/v1/messages\n", {})).toThrow("magpie must be the gateway's address");
    expect(() => parseRuntimesYaml("runtimes:\n  c:\n    kind: claude-code\n    ssh: box\n    magpie: http://127.0.0.1:3425\n", {})).toThrow("drop ssh");
  });

  test("its tiers are its pins only, and it never runs on another machine", () => {
    const { config } = parseRuntimesYaml(yaml("machines:\n  bare: { ssh: bare-alias }\n"), {});
    const reg = new RuntimeRegistry(config);
    expect(reg.resolve("glm/basic").model).toBe("zhipu/glm-4.5-air");
    expect(reg.resolve("glm/moonshot/kimi-k2.5").model).toBe("moonshot/kimi-k2.5");
    expect(() => reg.resolve("glm/junior")).toThrow("runtime glm has no model for tier junior");
    expect(reg.tierOptions().filter((o) => o.runtime === "glm").map((o) => o.value)).toEqual(["glm/basic", "glm/intermediate"]);
    expect(() => reg.resolve("bare:glm/basic")).toThrow("cannot run on another machine");
    expect(reg.machineTierOptions().some((o) => o.runtime === "glm")).toBe(false);
    expect(reg.machineTierOptions().some((o) => o.runtime === "claude")).toBe(true);
    expect(() => parseRuntimesYaml(yaml("machines:\n  bare: { ssh: bare-alias }\nfallback:\n  claude/basic: [bare:glm/basic]\n"), {})).toThrow("cannot run on another");
  });

  test("the process gets the gateway, the caller key and the pinned models, never the Anthropic key", async () => {
    const env = magpieClaudeEnv("http://127.0.0.1:3425", { basic: "zhipu/glm-4.5-air", intermediate: "zhipu/glm-4.6" }, { PATH: "/bin", ANTHROPIC_API_KEY: "sk-real" });
    expect(env).toEqual({
      PATH: "/bin",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:3425",
      ANTHROPIC_AUTH_TOKEN: MAGPIE_CALLER_KEY,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "zhipu/glm-4.5-air",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "zhipu/glm-4.6",
      ANTHROPIC_SMALL_FAST_MODEL: "zhipu/glm-4.5-air",
    });

    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-real";
    try {
      const adapter = createClaudeCode({ name: "glm", kind: "claude-code", bin: fakeModelBin(), chatArgs: [], magpie: "http://127.0.0.1:3425", models: { basic: "zhipu/glm-4.5-air", intermediate: "zhipu/glm-4.6" } });
      const input: CompleteInput = { prompt: "hi", system: "", model: "zhipu/glm-4.6", tag: "other", tools: [], timeoutMs: 30_000, maxTokens: 0 };
      const r = await adapter.complete!(input);
      if (!r.ok) throw new Error(r.error);
      expect(r.text).toContain("--model zhipu/glm-4.6");
      expect(r.text).toContain(`[gateway: http://127.0.0.1:3425 token=${MAGPIE_CALLER_KEY} haiku=zhipu/glm-4.5-air opus=zhipu/glm-4.6 apikey=unset]`);

      // Agent runs and chat turns get the same environment.
      const run = await adapter.runAgent!({ cwd: process.cwd(), prompt: "task", model: "zhipu/glm-4.6", env: { ...process.env } } as never);
      expect(run.text).toContain("[gateway: http://127.0.0.1:3425");
      const plain = await createClaudeCode({ name: "claude", kind: "claude-code", bin: fakeModelBin(), chatArgs: [] }).complete!(input);
      if (!plain.ok) throw new Error(plain.error);
      expect(plain.text).not.toContain("[gateway:");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  test("its status cell: signed in while the gateway answers with models, the CLI's own login not asked", async () => {
    const spec: ClaudeCodeSpec = { name: "glm", kind: "claude-code", bin: [process.execPath], chatArgs: [], magpie: "http://127.0.0.1:3425" };
    const spawned: string[][] = [];
    const spawn = (async (cmd: string[]) => (spawned.push(cmd), { code: 0, stdout: "1.3.0\n", stderr: "", timedOut: false, aborted: false })) as never;
    const up = await probeRuntime(spawn, { PATH: "/usr/bin:/bin" }, "/h", gateway(["zhipu/glm-4.6"]))({ machine: "", spec });
    expect(up).toMatchObject({ installed: true, signedIn: true });
    expect(spawned.some((c) => c.includes("auth"))).toBe(false);
    const empty = await probeRuntime(spawn, { PATH: "/usr/bin:/bin" }, "/h", gateway([]))({ machine: "", spec });
    expect(empty).toMatchObject({ installed: true, signedIn: false, detail: "magpie at http://127.0.0.1:3425 offers no model yet: add a provider in magpie" });
    const down = await probeRuntime(spawn, { PATH: "/usr/bin:/bin" }, "/h", gateway("down"))({ machine: "", spec });
    expect(down).toMatchObject({ installed: true, signedIn: false, detail: "magpie: nothing answers at http://127.0.0.1:3425" });
  });
});
