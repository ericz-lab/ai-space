import { describe, expect, test } from "bun:test";
import { assertTarget, installationKey, MAX_UNPACKED_BYTES, packagePath, parsePackageIndex, releaseVersion } from "./contract.ts";
import { assertPackageCompatibility, parsePackageManifest } from "./manifest.ts";
import { parseManifest } from "../scheduler/manifest.ts";

const file = (path = "space.yaml", size = 1) => ({ path, size, sha256: "a".repeat(64), executable: false });
const index = () => ({ format: 1, target: { os: "any", arch: "any" }, sourceIncluded: false, files: [file()] });
const app = (extra: Record<string, unknown> = {}) => Bun.YAML.stringify({
  spec: 2, name: "notes", version: "1.0.0", requires: { spaceApi: 1 },
  offline: { features: ["Read and edit notes"], online: ["Cloud model summaries"] },
  launch: { kind: "static", root: "web" }, ...extra,
});

describe("package index", () => {
  test("portable and native targets are independent of source inclusion", () => {
    expect(parsePackageIndex(index()).sourceIncluded).toBe(false);
    const i = parsePackageIndex({ ...index(), sourceIncluded: true, target: { os: "linux", arch: "arm64" } });
    expect(() => assertTarget(i.target, { os: "darwin", arch: "arm64" })).toThrow(/targets/);
    assertTarget(i.target, { os: "linux", arch: "arm64" });
  });

  test("rejects unknown metadata, coerced fields, unsupported targets and unsafe sizes", () => {
    for (const patch of [{ format: 2 }, { name: "other-app" }, { sourceIncluded: "false" }, { target: { os: "linux", arch: "any" } }, { files: [] },
      { files: [file("space.yaml", -1)] }, { files: [file("space.yaml", NaN)] }, { files: [file("space.yaml", MAX_UNPACKED_BYTES), file("other", 1)] },
      { files: [{ ...file(), sha256: "bad" }] }, { files: [{ ...file(), executable: "false" }] }]) {
      expect(() => parsePackageIndex({ ...index(), ...patch })).toThrow();
    }
  });

  test("rejects missing manifest, aliases and file-directory collisions on every host", () => {
    for (const files of [[file("other")], [{ ...file(), executable: true }], [file(), file()], [file(), file("Space.yaml")], [file(), file("web"), file("web/a")], [file(), file("Web"), file("web/a")]]) {
      expect(() => parsePackageIndex({ ...index(), files })).toThrow();
    }
  });

  test("refuses path traversal, URL encodings and platform-specific path spellings", () => {
    for (const p of ["", ".", "..", "../x", "x/../a", "x/./a", "/tmp/x", "x//a", "x/", "x\\a", "C:/x", "a%2fb", "a\0b", "a\nb", "a ", "a./b"]) {
      expect(() => packagePath(p)).toThrow();
    }
    expect(packagePath("node_modules/@scope/lib/index.js")).toBe("node_modules/@scope/lib/index.js");
  });
});

describe("application contract", () => {
  test("static package needs no process or port and retains existing app components", () => {
    const m = parsePackageManifest(app({ agents: [{ name: "helper", prompt: "agents/helper.md" }] }));
    expect(m.launch).toEqual({ kind: "static", root: "web", index: "index.html" });
    expect(m.agents[0]?.name).toBe("helper");
    expect("service" in m).toBe(false);
    expect("url" in m).toBe(false);
    assertPackageCompatibility(m);
  });

  test("process uses an argument vector, explicit runtime and on-demand default", () => {
    const m = parsePackageManifest(app({ requires: { spaceApi: 1, bun: "1.3.0" }, launch: { kind: "process", runtime: "bun", entry: "dist/server.js", args: ["--label", "$(not-a-shell)"], health: "/healthz" } }));
    expect(m.launch).toMatchObject({ mode: "on-demand", idleTimeoutMs: 300_000, args: ["--label", "$(not-a-shell)"] });
    assertPackageCompatibility(m, "1.4.0");
    expect(() => assertPackageCompatibility(m, "1.2.99")).toThrow(/Bun/);
    expect(() => assertPackageCompatibility(m)).toThrow(/Bun/);
    expect(() => assertPackageCompatibility(parsePackageManifest(app({ requires: { spaceApi: 2 } })))).toThrow(/API 2/);
  });

  test("legacy sync does not accidentally activate the new contract", () => {
    expect(() => parseManifest(app(), "/apps/notes")).toThrow();
    expect(parseManifest("name: old\nservice: { command: bun app.ts, port: 8910 }", "/apps/old").service?.port).toBe(8910);
    expect(() => parsePackageManifest("spec: 1\nname: old")).toThrow(/spec: 2/);
  });

  test("declared launch and compatibility requirements cannot be silently ignored", () => {
    const process = { kind: "process", runtime: "native", entry: "bin/app", health: "/healthz" };
    for (const patch of [
      { name: ".." }, { name: "UPPER" }, { name: "a/b" }, { version: "latest" }, { version: 1 }, { requires: { spaceApi: "1" } },
      { service: { command: "bad", port: 1 } }, { url: "https://example.com" }, { deploy: { install: "curl something" } },
      { launch: { kind: "static", root: "../private" } }, { launch: { kind: "static", root: "web", entry: "a" } },
      { launch: { ...process, runtime: "bun" } }, { launch: { ...process, health: "//elsewhere" } }, { launch: { ...process, root: "web" } },
      { launch: { ...process, mode: "background", idleTimeoutMs: 1000 } }, { launch: { ...process, idleTimeoutMs: 0 } },
      { offline: { features: ["same"], online: ["same"] } }, { offline: { features: "yes", online: [] } },
      { storage: { database: "missing" } }, { notify: { channels: "ops" } }, { backup: { schedule: "0 0 * * *" } },
    ]) expect(() => parsePackageManifest(app(patch))).toThrow();
  });

  test("task-only apps do not need a service and calendar schedules require explicit intent", () => {
    const tasks = [{ name: "refresh", schedule: "0 9 * * *", timezone: "Asia/Seoul", run: { command: "bun jobs/refresh.ts" } }];
    const m = parsePackageManifest(app({ launch: undefined, tasks }));
    expect(m.launch).toBeUndefined();
    expect(m.tasks[0]?.schedule).toEqual({ kind: "cron", expr: "0 9 * * *", tz: "Asia/Seoul" });
    expect(() => parsePackageManifest(app({ tasks: [{ ...tasks[0], timezone: undefined }] }))).toThrow(/timezone/);
    expect(() => parsePackageManifest(app({ tasks: [{ name: "once", at: "2030-01-01T12:00:00", run: { command: "true" } }] }))).toThrow(/offset/);
  });
});

test("installation identity is stable across peer alias changes and distinguishes machines", () => {
  const first = "a12f6650-1111-4444-8888-111111111111";
  const second = "a12f6650-1111-4444-8888-222222222222";
  expect(installationKey(first, "notes")).not.toBe(installationKey(second, "notes"));
  expect(() => installationKey("seoul", "notes")).toThrow();
  expect(() => installationKey(first, "../notes")).toThrow();
  for (const version of ["1.2", "01.2.3", "1.2.3-beta", ">=1.2.3", "9007199254740992.0.0"]) expect(() => releaseVersion(version)).toThrow();
});
