import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../space/auth/service.ts";
import { AuthStore } from "../space/auth/store.ts";
import { runCli } from "./testing.ts";
import { removeTemp } from "../space/testing.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-cli-auth-"));
});
afterEach(async () => {
  await removeTemp(home);
});

const env = () => ({ SPACE_HOME: home, SPACE_AUTH: "builtin" });
const piped = (password: string) => ({ env: env(), stdin: async () => `${password}\n` });
const auth = () => new AuthService(new AuthStore(new Database(join(home, "data", "space.db"))));

describe("space auth", () => {
  test("init takes the password from stdin once; a second init is refused", async () => {
    const first = await runCli(["auth", "init", "--password-stdin"], () => {}, piped("correct horse"));
    expect(first.code).toBe(0);
    const second = await runCli(["auth", "init", "--password-stdin"], () => {}, piped("battery staple"));
    expect(second.code).toBe(1);
    expect(second.err.join("\n")).toContain("already initialized");
    expect((await auth().login("correct horse", { client: "t" })).ok).toBe(true);
  });

  test("without a terminal or --password-stdin it asks for the pipe instead", async () => {
    const r = await runCli(["auth", "init"], () => {}, { env: env() });
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("--password-stdin");
  });

  test("a hidden prompt asks twice and refuses a mismatch", async () => {
    const answers = ["correct horse", "correct hors"];
    const r = await runCli(["auth", "init"], () => {}, { env: env(), isTTY: true, secret: async () => answers.shift()! });
    expect(r.code).toBe(2);
    expect(r.err.join("\n")).toContain("differ");
  });

  test("reset-password signs every session out; status reports it", async () => {
    await runCli(["auth", "init", "--password-stdin"], () => {}, piped("correct horse"));
    const s = await auth().login("correct horse", { client: "t" });
    if (!s.ok) throw new Error("login failed");
    const r = await runCli(["auth", "reset-password", "--password-stdin"], () => {}, piped("battery staple"));
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("1 session(s) signed out");
    expect(auth().verify(s.token)).toBeUndefined();
    const st = await runCli(["--json", "auth", "status"], () => {}, { env: env() });
    expect(JSON.parse(st.out.join("\n"))).toMatchObject({ mode: "builtin", initialized: true, sessions: 0 });
  });

  test("revoke-sessions asks first, names how many, and --yes or -y skips the question", async () => {
    await runCli(["auth", "init", "--password-stdin"], () => {}, piped("correct horse"));
    const s = await auth().login("correct horse", { client: "t" });
    if (!s.ok) throw new Error("login failed");
    const piping = await runCli(["auth", "revoke-sessions"], () => {}, { env: env() });
    expect(piping.code).toBe(2);
    expect(piping.err[0]).toContain("--yes");
    let asked = "";
    const no = await runCli(["auth", "revoke-sessions"], () => {}, { env: env(), isTTY: true, prompt: async (q) => ((asked = q), "n") });
    expect(no.code).toBe(1);
    expect(no.err).toEqual(["nothing done"]);
    expect(asked).toStartWith("Sign all 1 session(s) out?");
    expect(auth().verify(s.token)).toBeDefined();
    const yes = await runCli(["auth", "revoke-sessions", "-y"], () => {}, { env: env() });
    expect(yes.code).toBe(0);
    expect(yes.out).toEqual(["1 session(s) signed out"]);
    expect(auth().verify(s.token)).toBeUndefined();
  });

  test("device-revoke asks, names the device, and honours --json", async () => {
    const added = await runCli(["--json", "auth", "device-add", "laptop"], () => {}, { env: env() });
    const { id } = JSON.parse(added.out.join("\n")) as { id: number };
    let asked = "";
    const no = await runCli(["auth", "device-revoke", String(id)], () => {}, { env: env(), isTTY: true, prompt: async (q) => ((asked = q), "n") });
    expect(no.code).toBe(1);
    expect(asked).toStartWith(`Revoke device ${id} "laptop"?`);
    const r = await runCli(["--json", "auth", "device-revoke", String(id), "--yes"], () => {}, { env: env() });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.join("\n"))).toEqual({ id, name: "laptop", revoked: true });
    expect((await runCli(["auth", "device-revoke", String(id), "--yes"], () => {}, { env: env() })).code).toBe(1);
  });

  test("a usage mistake prints the usage line once", async () => {
    const add = await runCli(["auth", "device-add"], () => {}, { env: env() });
    expect(add.code).toBe(2);
    expect(add.err).toEqual(["space: a device name is required", "usage: space auth device-add <name>"]);
    const revoke = await runCli(["auth", "device-revoke", "abc"], () => {}, { env: env() });
    expect(revoke.err.filter((l) => l.startsWith("usage:") || l.includes("usage:"))).toEqual(["usage: space auth device-revoke <id> [--yes]"]);
  });
});
