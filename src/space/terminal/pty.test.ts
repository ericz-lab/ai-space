import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectPtyBackend, ptyHelper, spawnPty } from "./pty.ts";

// The C forkpty helper the Local edition ships as runtime/space-pty, built here with the host's C
// compiler; skipped where there is none.

const cc = Bun.which("cc");
let dir = "";
let helper = "";

beforeAll(async () => {
  if (!cc) return;
  dir = await mkdtemp(join(tmpdir(), "space-pty-"));
  helper = join(dir, "space-pty");
  const proc = Bun.spawn([cc, "-O2", "-o", helper, join(import.meta.dir, "pty_helper.c"), ...(process.platform === "linux" ? ["-lutil"] : [])], { stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`cc failed (exit ${code}): ${stderr}`);
  // A cold CI runner can take longer than the default 5 s hook timeout to start the compiler.
}, 60_000);

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function run(cmd: string[], input?: (h: ReturnType<typeof spawnPty>) => void): Promise<{ out: string; code: number | null }> {
  return new Promise((done) => {
    let out = "";
    const dec = new TextDecoder();
    const h = spawnPty("helper", {
      cmd,
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
      cols: 100,
      rows: 30,
      onData: (d) => (out += dec.decode(d, { stream: true })),
      onExit: (code) => done({ out, code }),
    });
    input?.(h);
  });
}

describe.skipIf(!cc)("space-pty", () => {
  test("is found through SPACE_PTY_HELPER and chosen first", () => {
    expect(ptyHelper({ SPACE_PTY_HELPER: helper })).toBe(helper);
    expect(detectPtyBackend({ SPACE_PTY_HELPER: helper })).toBe("helper");
    expect(ptyHelper({ SPACE_PTY_HELPER: join(dir, "missing") })).toBeUndefined();
  });

  test("runs a command in a terminal of the asked size and returns its status", async () => {
    process.env.SPACE_PTY_HELPER = helper;
    try {
      const r = await run(["/bin/sh", "-c", "test -t 0 && stty size; exit 3"]);
      expect(r.out).toContain("30 100");
      expect(r.code).toBe(3);
    } finally {
      delete process.env.SPACE_PTY_HELPER;
    }
  });

  test("takes keystrokes and resizes, gives the shell a controlling terminal, hangs up on kill", async () => {
    process.env.SPACE_PTY_HELPER = helper;
    try {
      const enc = new TextEncoder();
      const r = await run(["/bin/sh"], (h) => {
        h.resize(120, 40);
        setTimeout(() => h.write(enc.encode("stty size; tty >/dev/null && echo has-tty; ps -o stat= -p $$\n")), 200);
        setTimeout(() => h.kill(), 1200);
      });
      expect(r.out).toContain("40 120");
      expect(r.out).toContain("has-tty");
      expect(r.out).toMatch(/S\S*s/); // session leader
      expect(r.code).toBeNull();
    } finally {
      delete process.env.SPACE_PTY_HELPER;
    }
  });
});
