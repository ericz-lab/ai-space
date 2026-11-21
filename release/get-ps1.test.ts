import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseInstaller, userPathScript } from "../src/space/service.ts";
import { archiveName, releaseOs, runtimeBun } from "./server.ts";

/**
 * The Windows one-command installer (release/get.ps1). What it refuses is tested by running it,
 * on Windows only and never as far as the archive's own installer: that one registers a task and
 * belongs to a machine, not to a test run. The pieces shared with the CLI are tested on every system.
 */

const windows = process.platform === "win32";
const root = await mkdtemp(join(tmpdir(), "space-get-ps1-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function install(mirror: string, env: Record<string, string> = {}) {
  const prefix = join(await mkdtemp(join(root, "prefix-")), "ai-space");
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const proc = Bun.spawn([powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Get-Content -Raw '${join(import.meta.dir, "get.ps1")}' | Invoke-Expression`], {
    env: { ...process.env, AI_SPACE_DOWNLOAD: mirror, AI_SPACE_PREFIX: prefix, SPACE_HOME: join(prefix, "..", "ws"), AI_SPACE_NO_OPEN: "1", AI_SPACE_NO_PATH: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code, prefix };
}

describe("the release's names on Windows", () => {
  test("the archive is named for windows and carries bun.exe", () => {
    expect(releaseOs("win32")).toBe("windows");
    expect(releaseOs("darwin")).toBe("macos");
    expect(releaseOs("linux")).toBe("linux");
    expect(archiveName({ version: "1.2.3", os: releaseOs("win32"), arch: "x64" })).toBe("ai-space-server-1.2.3-windows-x64");
    expect(runtimeBun("win32")).toBe(join("runtime", "bun.exe"));
    expect(runtimeBun("linux")).toBe(join("runtime", "bun"));
  });

  test("space upgrade runs the installer its system can run", () => {
    expect(releaseInstaller("linux", {})).toMatchObject({ asset: "install.sh" });
    expect(releaseInstaller("darwin", {}).argv("/tmp/install.sh")).toEqual(["bash", "/tmp/install.sh"]);
    const w = releaseInstaller("win32", { SystemRoot: "C:\\Windows" });
    expect(w.asset).toBe("install.ps1");
    expect(w.argv("C:\\t\\install.ps1").slice(1)).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\t\\install.ps1"]);
    expect(w.argv("x")[0]).toEndWith("powershell.exe");
  });

  test("the user's Path is changed only when the directory is to be added or removed, in the registry's own form", () => {
    const add = userPathScript("add", "C:\\Users\\o'brien\\ai-space\\bin");
    expect(add).toContain("$dir = 'C:\\Users\\o''brien\\ai-space\\bin'");
    expect(add).toContain("'DoNotExpandEnvironmentNames'");
    expect(add).toContain("if (-not $has) { $key.SetValue('Path'");
    expect(add).not.toContain("GetEnvironmentVariable('Path'");
    const remove = userPathScript("remove", "C:\\p\\bin");
    expect(remove).toContain("if ($has) { $key.SetValue('Path', (@($parts | Where-Object { $_ -ne $dir }) -join ';'), $kind) }");
  });
});

describe.skipIf(!windows)("get.ps1", () => {
  test("an archive that does not match SHA256SUMS installs nothing", async () => {
    const mirror = await mkdtemp(join(root, "mirror-"));
    const name = "ai-space-server-9.9.9-windows-x64.tar.gz";
    await Bun.write(join(mirror, name), "not the archive the release built");
    await Bun.write(join(mirror, "SHA256SUMS"), `${sha256(new TextEncoder().encode("the archive the release built"))}  ${name}\n`);
    const r = await install(mirror);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("does not match the release's SHA256SUMS");
    expect(r.err).toContain("nothing was installed");
    expect(await readdir(join(r.prefix, "..")).catch(() => [])).toEqual([]);
  }, 60_000);

  test("a release without a windows archive says so", async () => {
    const mirror = await mkdtemp(join(root, "mirror-"));
    await Bun.write(join(mirror, "SHA256SUMS"), `${"a".repeat(64)}  ai-space-server-9.9.9-linux-x64.tar.gz\n`);
    const r = await install(mirror);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("the release has no Server archive for windows-x64");
  }, 60_000);

  test("the version asked for is the one looked for", async () => {
    const mirror = await mkdtemp(join(root, "mirror-"));
    await mkdir(mirror, { recursive: true });
    await Bun.write(join(mirror, "SHA256SUMS"), `${"a".repeat(64)}  ai-space-server-9.9.9-windows-x64.tar.gz\n`);
    const r = await install(mirror, { AI_SPACE_VERSION: "v1.0.0" });
    expect(r.out).toContain("looking for the release 1.0.0 for windows-x64");
    expect(r.err).toContain("the release has no Server archive for windows-x64");
  }, 60_000);

  test("a mirror that is not there fails before anything is unpacked", async () => {
    const r = await install(join(root, "no-such-mirror"));
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("could not download");
  }, 60_000);
});
