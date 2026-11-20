import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * release/get.sh, the one-command installer, against a release made up here: a Server archive whose
 * install.sh only leaves a mark, its SHA256SUMS, served as file:// URLs; a stand-in `systemctl`
 * answers for the user manager. Nothing is installed and no service starts.
 */

const SCRIPT = join(import.meta.dir, "get.sh");
const ARCH = process.arch === "arm64" ? "arm64" : "x64";
const linux = process.platform === "linux";

let root = "";
let bin = "";

async function release(dir: string, opts: { version: string; badSum?: boolean }): Promise<string> {
  const name = `ai-space-server-${opts.version}-linux-${ARCH}`;
  const stage = join(dir, "stage", name);
  await mkdir(stage, { recursive: true });
  await Bun.write(join(stage, "RELEASE.json"), JSON.stringify({ product: "ai-space", version: opts.version }));
  await Bun.write(join(stage, "install.sh"), `#!/usr/bin/env bash\necho "installed ${opts.version}" > "$GET_TEST_MARK"\n`);
  await Bun.$`tar -czf ${join(dir, `${name}.tar.gz`)} -C ${join(dir, "stage")} ${name}`.quiet();
  const bytes = await Bun.file(join(dir, `${name}.tar.gz`)).bytes();
  const sum = opts.badSum ? "0".repeat(64) : new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  await Bun.write(join(dir, "SHA256SUMS"), `${"1".repeat(64)}  ai-space-linux-client-${opts.version}-${ARCH}.tar.gz\n${sum}  ${name}.tar.gz\n`);
  return dir;
}

async function run(dir: string, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(root, "home-"));
  const mark = join(home, "mark");
  const p = Bun.spawn(["bash", SCRIPT], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, USER: "tester", TMPDIR: root, AI_SPACE_DOWNLOAD: `file://${dir}`, AI_SPACE_NO_OPEN: "1", GET_TEST_MARK: mark, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const installed = (await Bun.file(mark).exists()) ? (await Bun.file(mark).text()).trim() : undefined;
  return { code, out, err, installed };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "space-get-"));
  bin = join(root, "bin");
  await mkdir(bin);
  // The user manager answers; nothing else of systemd is used by get.sh itself.
  await Bun.write(join(bin, "systemctl"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "systemctl"), 0o755);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!linux)("the one-command installer", () => {
  test("is valid shell", async () => {
    expect(await Bun.spawn(["bash", "-n", SCRIPT]).exited).toBe(0);
  });

  test("finds this machine's archive in the latest release, checks it and runs its installer", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.installed).toBe("installed 9.9.9");
    expect(r.out).toContain(`ai-space-server-9.9.9-linux-${ARCH}.tar.gz`);
    expect(r.out).toContain("Open the panel: http://127.0.0.1:8700/");
    expect(r.out).toContain("No agent CLI found yet");
  });

  test("names the port the workspace uses, and the SSH forward when it runs over SSH", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir, { SPACE_PORT: "18765", SSH_CONNECTION: "192.0.2.2 50000 192.0.2.1 22" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("Open the panel: http://127.0.0.1:18765/");
    expect(r.out).toContain("ssh -L 18765:127.0.0.1:18765 tester@<this machine>");
  });

  test("refuses an archive that does not match SHA256SUMS, before running anything", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9", badSum: true });
    const r = await run(dir);
    expect(r.code).not.toBe(0);
    expect(r.installed).toBeUndefined();
    expect(r.err).toContain("does not match the release's SHA256SUMS");
  });

  test("a pinned version must be the release's", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const r = await run(dir, { AI_SPACE_VERSION: "v9.9.8" });
    expect(r.code).not.toBe(0);
    expect(r.installed).toBeUndefined();
    expect(r.err).toContain(`no Server archive for linux-${ARCH}`);
    expect((await run(dir, { AI_SPACE_VERSION: "9.9.9" })).installed).toBe("installed 9.9.9");
  });

  test("stops when no systemd user manager answers", async () => {
    const dir = await release(await mkdtemp(join(root, "rel-")), { version: "9.9.9" });
    const nobin = join(root, "nobin");
    await mkdir(nobin, { recursive: true });
    await Bun.write(join(nobin, "systemctl"), "#!/bin/sh\nexit 1\n");
    await chmod(join(nobin, "systemctl"), 0o755);
    const r = await run(dir, { PATH: `${nobin}:/usr/bin:/bin` });
    expect(r.code).not.toBe(0);
    expect(r.installed).toBeUndefined();
    expect(r.err).toContain("no systemd user manager answers");
  });
});
