import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "../space/auth/service.ts";
import { AuthStore } from "../space/auth/store.ts";
import { runCli } from "./testing.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "space-cli-auth-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
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
});
