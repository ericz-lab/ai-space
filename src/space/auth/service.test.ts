import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { AuthService, PasswordRejected, SESSION_TTL_MS, hashToken } from "./service.ts";
import { AuthStore, OwnerExists } from "./store.ts";

const CHEAP = { memoryCost: 1024, timeCost: 1 };

function service(start = Date.UTC(2026, 9, 18)) {
  const clock = { now: start };
  const db = new Database(":memory:");
  const auth = new AuthService(new AuthStore(db), { now: () => clock.now, hashCost: CHEAP });
  return { auth, clock, db };
}

const login = async (auth: AuthService, password: string, client = "a") => auth.login(password, { client });

describe("owner", () => {
  test("init sets the password once, stored as a hash", async () => {
    const { auth, db } = service();
    expect(auth.initialized()).toBe(false);
    await auth.init("correct horse");
    expect(auth.initialized()).toBe(true);
    const row = db.query<{ password_hash: string }, []>("SELECT password_hash FROM auth_owner").get()!;
    expect(row.password_hash).not.toContain("correct horse");
    expect(row.password_hash.startsWith("$argon2id$")).toBe(true);
    await expect(auth.init("another one")).rejects.toBeInstanceOf(OwnerExists);
    expect((await login(auth, "correct horse")).ok).toBe(true);
    expect((await login(auth, "another one", "b")).ok).toBe(false);
  });

  test("a short password is refused", async () => {
    const { auth } = service();
    await expect(auth.init("short")).rejects.toBeInstanceOf(PasswordRejected);
    expect(auth.initialized()).toBe(false);
  });

  test("no sign-in before the owner exists", async () => {
    const { auth } = service();
    expect(await login(auth, "anything at all")).toEqual({ ok: false, reason: "uninitialized" });
  });
});

describe("sessions", () => {
  test("a token is stored only as its hash and verifies until it expires", async () => {
    const { auth, clock, db } = service();
    await auth.init("correct horse");
    const r = await login(auth, "correct horse");
    if (!r.ok) throw new Error("login failed");
    const stored = db.query<{ token_hash: string }, []>("SELECT token_hash FROM auth_sessions").get()!;
    expect(stored.token_hash).toBe(hashToken(r.token));
    expect(stored.token_hash).not.toBe(r.token);
    expect(auth.verify(r.token)?.id).toBe(r.session.id);
    expect(auth.verify(r.token + "x")).toBeUndefined();
    clock.now += SESSION_TTL_MS;
    expect(auth.verify(r.token)).toBeUndefined();
  });

  test("logout and revoke end a session", async () => {
    const { auth } = service();
    await auth.init("correct horse");
    const a = await login(auth, "correct horse");
    const b = await login(auth, "correct horse");
    if (!a.ok || !b.ok) throw new Error("login failed");
    auth.logout(a.token);
    expect(auth.verify(a.token)).toBeUndefined();
    expect(auth.verify(b.token)).toBeDefined();
    expect(auth.revoke(b.session.id)).toBe(true);
    expect(auth.verify(b.token)).toBeUndefined();
    expect(auth.revoke(b.session.id)).toBe(false);
  });

  test("a reset from the machine signs every session out", async () => {
    const { auth } = service();
    await auth.init("correct horse");
    const a = await login(auth, "correct horse");
    if (!a.ok) throw new Error("login failed");
    expect(await auth.resetPassword("battery staple")).toEqual({ revoked: 1 });
    expect(auth.verify(a.token)).toBeUndefined();
    expect((await login(auth, "correct horse", "b")).ok).toBe(false);
    expect((await login(auth, "battery staple", "c")).ok).toBe(true);
  });

  test("a change from a session keeps that session and signs the others out", async () => {
    const { auth } = service();
    await auth.init("correct horse");
    const mine = await login(auth, "correct horse");
    const other = await login(auth, "correct horse");
    if (!mine.ok || !other.ok) throw new Error("login failed");
    expect(await auth.changePassword("wrong", "battery staple", mine.session.id)).toEqual({ ok: false, reason: "invalid" });
    expect(await auth.changePassword("correct horse", "battery staple", mine.session.id)).toEqual({ ok: true, revoked: 1 });
    expect(auth.verify(mine.token)).toBeDefined();
    expect(auth.verify(other.token)).toBeUndefined();
  });
});

describe("failed sign-ins", () => {
  test("five failures lock that client for the window; others still sign in", async () => {
    const { auth, clock } = service();
    await auth.init("correct horse");
    for (let i = 0; i < 5; i++) expect((await login(auth, "wrong", "a")).ok).toBe(false);
    const locked = await login(auth, "correct horse", "a");
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.reason).toBe("limited");
    expect((await login(auth, "correct horse", "b")).ok).toBe(true);
    clock.now += 15 * 60_000;
    expect((await login(auth, "correct horse", "a")).ok).toBe(true);
  });

  test("a caller that varies its address is bounded by the space-wide count", async () => {
    const { auth } = service();
    await auth.init("correct horse");
    for (let i = 0; i < 50; i++) await login(auth, "wrong", `c${i}`);
    const r = await login(auth, "correct horse", "fresh");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("limited");
  });
});
