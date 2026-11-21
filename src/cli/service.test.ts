import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SERVER_LABEL, SERVER_UNIT } from "../space/service.ts";
import { newer, opener } from "./service.ts";
import { runCli } from "./testing.ts";
import { EXIT } from "./types.ts";

/**
 * `space service`, `upgrade`, `uninstall` and `open` as commands. The workspace and the unit
 * directory are temporary, and nothing here starts, stops or removes a real service: the verbs
 * that would are covered with a fake runner in src/space/service.test.ts.
 */

let root = "";
const unitFile = process.platform === "darwin" ? `${SERVER_LABEL}.plist` : process.platform === "win32" ? "ai-space.xml" : SERVER_UNIT;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "space-cli-service-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function env(): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(root, "m-"));
  await mkdir(join(dir, "units"));
  return { SPACE_HOME: join(dir, "ws"), SPACE_SERVICE_UNITS: join(dir, "units") };
}

describe("space service", () => {
  test("workspace prints where the service runs", async () => {
    const e = await env();
    const r = await runCli(["service", "workspace"], () => {}, { env: e });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toEqual([e.SPACE_HOME!]);
  });

  test("status of a machine without the unit", async () => {
    const e = await env();
    const r = await runCli(["service", "--json"], () => {}, { env: e });
    expect(r.code).toBe(EXIT.ok);
    expect(JSON.parse(r.out.join("\n"))).toMatchObject({ ok: true, kind: "server", installed: false, running: false, file: join(e.SPACE_SERVICE_UNITS!, unitFile), workspace: e.SPACE_HOME });
  });

  test("restart without the unit says how to install it", async () => {
    const r = await runCli(["service", "restart"], () => {}, { env: await env() });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err.join("\n")).toContain(process.platform === "win32" ? "space service install" : "bash deploy/install.sh");
  });
});

describe("space upgrade", () => {
  test("a checkout is updated with git, not with a release", async () => {
    const r = await runCli(["upgrade"], () => {}, { env: await env() });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err[0]).toContain("is a checkout, not a release");
    expect(r.calls).toEqual([]);
  });

  test("versions compare by number", () => {
    expect(newer("0.10.0", "0.9.9")).toBe(true);
    expect(newer("v1.0.0", "1.0.0")).toBe(false);
    expect(newer("0.2.0", "0.2.1")).toBe(false);
    expect(newer("1.2.3-dev.abc", "1.2.2")).toBe(true);
  });
});

describe("space uninstall", () => {
  test("--dry-run lists what would go and what stays, and removes nothing", async () => {
    const e = await env();
    await Bun.write(join(e.SPACE_SERVICE_UNITS!, unitFile), "unit");
    await mkdir(e.SPACE_HOME!);
    const r = await runCli(["uninstall", "--dry-run"], () => {}, { env: e });
    expect(r.code).toBe(EXIT.ok);
    const text = r.out.join("\n");
    expect(text).toContain("stop ai-space and remove");
    expect(text).toContain("a checkout, not a release");
    expect(text).toContain("--workspace deletes it too");
    expect(await Bun.file(join(e.SPACE_SERVICE_UNITS!, unitFile)).exists()).toBe(true);
  });

  test("without a terminal it needs --yes", async () => {
    const e = await env();
    await Bun.write(join(e.SPACE_SERVICE_UNITS!, unitFile), "unit");
    const r = await runCli(["uninstall"], () => {}, { env: e });
    expect(r.code).toBe(EXIT.usage);
    expect(r.err[0]).toContain("pass --yes");
    expect(await Bun.file(join(e.SPACE_SERVICE_UNITS!, unitFile)).exists()).toBe(true);
  });

  test("at a terminal, anything but yes removes nothing", async () => {
    const e = await env();
    await Bun.write(join(e.SPACE_SERVICE_UNITS!, unitFile), "unit");
    const r = await runCli(["uninstall"], () => {}, { env: e, isTTY: true, prompt: async () => "n" });
    expect(r.code).toBe(EXIT.failed);
    expect(r.err.at(-1)).toBe("nothing removed");
    expect(await Bun.file(join(e.SPACE_SERVICE_UNITS!, unitFile)).exists()).toBe(true);
  });
});

describe("space open", () => {
  test("--print gives the panel's address and opens nothing", async () => {
    const r = await runCli(["open", "--print"], () => {}, { env: { ...(await env()), SPACE_PORT: "18700" } });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out).toEqual(["http://127.0.0.1:18700/"]);
  });

  test("a browser only where this session has a screen", () => {
    expect(opener({}, "darwin")).toEqual(["open"]);
    expect(opener({ SSH_CONNECTION: "192.0.2.2 1 192.0.2.1 22" }, "darwin")).toBeUndefined();
    expect(opener({ DISPLAY: ":0" }, "linux", () => "/usr/bin/xdg-open")).toEqual(["xdg-open"]);
    expect(opener({ DISPLAY: ":0" }, "linux", () => null)).toBeUndefined();
    expect(opener({}, "linux", () => "/usr/bin/xdg-open")).toBeUndefined();
  });
});
