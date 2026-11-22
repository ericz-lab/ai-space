import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WINDOWS } from "../src/space/testing.ts";

/**
 * release/get.sh, the one-command installer, against a release made up here: a Server archive whose
 * install.sh only leaves a mark, its SHA256SUMS, served as file:// URLs. Stand-ins answer for
 * `uname` (so both systems are tried on whichever runs the tests), for the systemd user manager and
 * for launchd. Nothing is installed and no service starts.
 */

const SCRIPT = join(import.meta.dir, "get.sh");

type Machine = { os: "Linux" | "Darwin"; cpu: "x86_64" | "arm64" | "aarch64" };
const LINUX: Machine = { os: "Linux", cpu: "x86_64" };
const MAC: Machine = { os: "Darwin", cpu: "arm64" };
const platOf = (m: Machine) => `${m.os === "Linux" ? "linux" : "macos"}-${m.cpu === "x86_64" ? "x64" : "arm64"}`;

let root = "";

/** get.sh and install.sh are the Linux and macOS installers; Windows has get.ps1 (get-ps1.test.ts). */
const posixOnly = test.skipIf(WINDOWS);

async function release(dir: string, opts: { version: string; badSum?: boolean; machine?: Machine }): Promise<string> {
  const name = `ai-space-server-${opts.version}-${platOf(opts.machine ?? LINUX)}`;
  const stage = join(dir, "stage", name);
  await mkdir(stage, { recursive: true });
  await Bun.write(join(stage, "RELEASE.json"), JSON.stringify({ product: "ai-space", version: opts.version }));
  await Bun.write(join(stage, "install.sh"), `#!/usr/bin/env bash\necho "installed ${opts.version}" > "$GET_TEST_MARK"\n`);
  await Bun.$`tar -czf ${join(dir, `${name}.tar.gz`)} -C ${join(dir, "stage")} ${name}`.quiet();
  const bytes = await Bun.file(join(dir, `${name}.tar.gz`)).bytes();
  const sum = opts.badSum ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  // Another system's archive of the same release sits beside it and must not be taken.
  await Bun.write(join(dir, "SHA256SUMS"), `${"1".repeat(64)}  ai-space-linux-client-${opts.version}-x64.tar.gz\n${"2".repeat(64)}  ai-space-server-${opts.version}-linux-arm64.tar.gz\n${sum}  ${name}.tar.gz\n`);
  return dir;
}

/** A directory of stand-in programs: `uname` as that machine, and service managers that answer (or not). */
async function bin(m: Machine, opts: { manager?: boolean } = {}): Promise<string> {
  const dir = await mkdtemp(join(root, "bin-"));
  const exit = opts.manager === false ? 1 : 0;
  const files: Record<string, string> = {
    uname: `#!/bin/sh\ncase "$1" in -m) echo ${m.cpu} ;; *) echo ${m.os} ;; esac\n`,
    systemctl: `#!/bin/sh\nexit ${exit}\n`,
    launchctl: `#!/bin/sh\nexit ${exit}\n`,
    open: `#!/bin/sh\necho "$1" > "$GET_TEST_MARK.opened"\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    await Bun.write(join(dir, name), text);
    await chmod(join(dir, name), 0o755);
  }
  return dir;
}

async function run(dir: string, env: Record<string, string> = {}, opts: { machine?: Machine; manager?: boolean; home?: string } = {}) {
  const home = opts.home ?? (await mkdtemp(join(root, "home-")));
  const mark = join(home, "mark");
  const p = Bun.spawn(["bash", SCRIPT], {
    env: { PATH: `${await bin(opts.machine ?? LINUX, opts)}:/usr/bin:/bin`, HOME: home, USER: "tester", TMPDIR: root, AI_SPACE_DOWNLOAD: `file://${dir}`, AI_SPACE_NO_OPEN: "1", GET_TEST_MARK: mark, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const installed = (await Bun.file(mark).exists()) ? (await Bun.file(mark).text()).trim() : undefined;
  const opened = (await Bun.file(`${mark}.opened`).exists()) ? (await Bun.file(`${mark}.opened`).text()).trim() : undefined;
  return { code, out, err, installed, opened };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "space-get-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the one-command installer", () => {
  test("is valid shell", async () => {
    expect(await Bun.spawn(["bash", "-n", SCRIPT]).exited).toBe(0);
  });

  posixOnly("finds this machine's archive in the latest release, checks it and runs its installer", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe("installed 9.9.9");
    expect(r.out).toContain("ai-space-server-9.9.9-linux-x64.tar.gz");
    expect(r.out).toContain("Open the panel: http://127.0.0.1:8700/");
    expect(r.out).toContain("No agent CLI found yet");
  });

  posixOnly("names the port the workspace uses, and the SSH forward when it runs over SSH", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir, { SPACE_PORT: "18765", SSH_CONNECTION: "192.0.2.2 50000 192.0.2.1 22" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Open the panel: http://127.0.0.1:18765/");
    expect(r.out).toContain("ssh -L 18765:127.0.0.1:18765 tester@<this machine>");
  });

  posixOnly("refuses an archive that does not match SHA256SUMS, before running anything", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9", badSum: true });
    const r = await run(dir);
    expect(r.code).not.toBe(0);
    expect(r.installed).toBeUndefined();
    expect(r.err).toContain("does not match the release's SHA256SUMS");
  });

  posixOnly("a pinned version must be the release's", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir, { AI_SPACE_VERSION: "v9.9.8" });
    expect(r.code).not.toBe(0);
    expect(r.installed).toBeUndefined();
    expect(r.err).toContain("no Server archive for linux-x64");
    expect((await run(dir, { AI_SPACE_VERSION: "9.9.9" })).installed).toBe("installed 9.9.9");
  });

  posixOnly("stops when no systemd user manager answers", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir, {}, { manager: false });
    expect(r.code).not.toBe(0);
    expect(r.installed).toBeUndefined();
    expect(r.err).toContain("no systemd user manager answers");
  });

  posixOnly("on a Mac: takes the macOS archive, runs its installer and opens the panel", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9", machine: MAC });
    const r = await run(dir, { AI_SPACE_NO_OPEN: "" }, { machine: MAC });
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe("installed 9.9.9");
    expect(r.out).toContain("ai-space-server-9.9.9-macos-arm64.tar.gz");
    expect(r.opened).toBe("http://127.0.0.1:8700/");
    expect(r.out).toContain("runs while you are logged in");
  });

  posixOnly("on a Mac over SSH: prints the forward and opens nothing", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9", machine: MAC });
    const r = await run(dir, { AI_SPACE_NO_OPEN: "", SSH_CONNECTION: "192.0.2.2 50000 192.0.2.1 22" }, { machine: MAC });
    expect(r.code).toBe(0);
    expect(r.opened).toBeUndefined();
    expect(r.out).toContain("ssh -L 8700:127.0.0.1:8700 tester@<this machine>");
  });

  posixOnly("an Intel Mac, and a Mac with nobody logged in, are told why", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9", machine: MAC });
    const intel = await run(dir, {}, { machine: { os: "Darwin", cpu: "x86_64" } });
    expect(intel.code).not.toBe(0);
    expect(intel.err).toContain("no archive for Intel Macs yet");
    const nobody = await run(dir, {}, { machine: MAC, manager: false });
    expect(nobody.code).not.toBe(0);
    expect(nobody.installed).toBeUndefined();
    expect(nobody.err).toContain("no login session on the Mac");
  });

  posixOnly("leaves a workspace of the AI Space app alone, on either system", async () => {
    for (const machine of [LINUX, MAC]) {
      const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9", machine });
      const home = await mkdtemp(join(root, "home-"));
      await mkdir(join(home, ".ai-space"));
      await Bun.write(join(home, ".ai-space", "installation.json"), JSON.stringify({ managedBy: "ai-space-local", version: "0.1.0" }, null, 2));
      const r = await run(dir, {}, { machine, home });
      expect(r.code).not.toBe(0);
      expect(r.installed).toBeUndefined();
      expect(r.err).toContain("belongs to the AI Space app");
      // Another workspace is not the app's.
      expect((await run(dir, { SPACE_HOME: join(home, "other") }, { machine, home })).installed).toBe("installed 9.9.9");
    }
  });
});
