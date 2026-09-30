import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_DIR } from "./newapp.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "space-deploy-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function executable(path: string, body: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, `#!/bin/bash\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
}

// The stubs are written once per file: macOS takes about a second to run a newly
// written executable for the first time, which pushed every test here past 5 s.
// What differs between tests reaches them through the environment.
let stubs: string;
let bin: string;
beforeAll(async () => {
  stubs = await mkdtemp(join(tmpdir(), "space-deploy-stubs-"));
  bin = join(stubs, "bin");
  await executable(join(bin, "ssh"), 'export HOME="$TEST_REMOTE_HOME"\nexec bash -c "$2"');
  await executable(join(bin, "rsync"), 'if [ "$1" = --help ]; then if [ "$TEST_RSYNC_PROTECT" = 1 ]; then echo --protect-args; fi; exit 0; fi\nprintf "%s\\n" "$@" > "$TEST_RSYNC_LOG"');
  await executable(join(bin, "systemctl"), 'printf "%s\\n" "$*" >> "$TEST_SERVICE_LOG"');
  for (const name of ["sleep", "loginctl"]) await executable(join(bin, name), "exit 0");
  await executable(join(bin, "curl"), "printf 200");
  await executable(join(stubs, "bun"), 'test "$1" = install');
  // Pay that first run here, all at once, instead of inside the first test.
  const names = ["ssh", "rsync", "systemctl", "sleep", "loginctl", "curl"].map((n) => join(bin, n));
  await Promise.all([...names, join(stubs, "bun")].map((p) => Bun.spawn([p, "--help", "true"], { env: { ...process.env, TEST_REMOTE_HOME: stubs, TEST_SERVICE_LOG: "/dev/null" }, stdout: "ignore", stderr: "ignore" }).exited));
});
afterAll(async () => { await rm(stubs, { recursive: true, force: true }); });

// Run the actual template script against a fake SSH host. Only network, package
// installation and service management are stubbed; path resolution and unit
// rendering run in real shells, with distinct local and remote home directories.
async function deploy(opts: { installed?: string; workspace?: string; checkout?: string; protectedArgs?: boolean; expectedWorkspace: string; expectedCheckout?: string }) {
  const remote = join(root, "remote");
  const local = join(root, "local");
  const workspace = join(remote, opts.expectedWorkspace);
  const checkout = opts.expectedCheckout ? join(remote, opts.expectedCheckout) : join(workspace, "apps/demo-app");
  await mkdir(join(remote, ".config/systemd/user"), { recursive: true });
  await mkdir(join(local, "deploy"), { recursive: true });
  await mkdir(checkout, { recursive: true });
  await Bun.write(join(checkout, ".env"), "PORT=8710\n");
  if (opts.installed) await Bun.write(join(remote, ".config/systemd/user/ai-space.service"), `Environment=SPACE_HOME=${opts.installed.replaceAll("REMOTE", remote)}\n`);
  for (const file of ["deploy.sh", "deploy/app.service"]) {
    await Bun.write(join(local, file), (await Bun.file(join(TEMPLATE_DIR, file)).text()).replaceAll("my-app", "demo-app"));
  }
  await mkdir(join(remote, ".bun/bin"), { recursive: true });
  await symlink(join(stubs, "bun"), join(remote, ".bun/bin/bun"));
  const proc = Bun.spawn(["bash", "deploy.sh"], {
    cwd: local,
    env: { ...process.env, HOME: local, PATH: `${bin}:${process.env.PATH}`, DEPLOY_HOST: "test-host", SERVICE: "demo-app", SPACE_HOME: opts.workspace ?? "", DEPLOY_PATH: opts.checkout ?? "", TEST_REMOTE_HOME: remote, TEST_RSYNC_LOG: join(root, "rsync.log"), TEST_SERVICE_LOG: join(root, "services.log"), TEST_RSYNC_PROTECT: opts.protectedArgs ? "1" : "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect({ code, err, success: out.includes("OK: /healthz") }).toEqual({ code: 0, err: "", success: true });
  const unit = await Bun.file(join(remote, ".config/systemd/user/demo-app.service")).text();
  expect(unit).toContain(`WorkingDirectory="${checkout.replaceAll("%", "%%")}"`);
  expect(unit).toContain(`EnvironmentFile=-"${workspace.replaceAll("%", "%%")}/data/demo-app/space.env"`);
  expect(unit).not.toContain("@SPACE_HOME@");
  expect(unit).not.toContain(local);
  expect(await Bun.file(join(root, "services.log")).text()).toContain("restart demo-app");
  const syncArgs = (await Bun.file(join(root, "rsync.log")).text()).trim().split("\n");
  expect(syncArgs.includes("--protect-args")).toBe(opts.protectedArgs ?? false);
  if (opts.protectedArgs) expect(syncArgs.at(-1)).toBe(`test-host:${checkout}/`);
  else {
    const shell = Bun.spawn(["bash", "-c", `printf '%s' ${syncArgs.at(-1)}`], { stdout: "pipe" });
    expect(await new Response(shell.stdout).text()).toBe(`test-host:${checkout}/`);
    expect(await shell.exited).toBe(0);
  }
  expect(await Bun.file(join(checkout, ".env")).text()).toBe("PORT=8710\n");
}

test("deployment defaults to the remote home, not the developer home", () => deploy({ expectedWorkspace: ".ai-space" }));
test("deployment follows the installed unit workspace", () => deploy({ installed: "REMOTE/custom-space", expectedWorkspace: "custom-space" }));
test("deployment expands legacy systemd home paths", () => deploy({ installed: "%h/custom-space", expectedWorkspace: "custom-space" }));
test("explicit workspace wins and a separate checkout does not change the data path", () => deploy({ installed: "REMOTE/old-space", workspace: "~/chosen space & 50%|", checkout: "code/demo-app", expectedWorkspace: "chosen space & 50%|", expectedCheckout: "code/demo-app" }));
test("relative workspace paths resolve under the remote home", () => deploy({ workspace: "custom-space", expectedWorkspace: "custom-space" }));
test("modern rsync receives literal paths with protected arguments", () => deploy({ workspace: "~/space with spaces", protectedArgs: true, expectedWorkspace: "space with spaces" }));
