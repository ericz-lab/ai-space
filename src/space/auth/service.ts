import { createHash, randomBytes } from "node:crypto";
import { AuthStore, type Session } from "./store.ts";

/**
 * The owner's password and sessions (docs/auth.md). One owner per space, no
 * public registration: the password is set from the machine itself
 * (`space auth init`), and every browser or client then signs in with it.
 */

export const SESSION_TTL_MS = 30 * 86_400_000;
/** A session's `last_seen_at` is written at most this often. */
const TOUCH_EVERY_MS = 60_000;
export const PASSWORD_MIN = 8;
const PASSWORD_MAX = 1024;

/** Failed sign-ins: per client within the window, and for the whole space as a backstop. */
const FAIL_WINDOW_MS = 15 * 60_000;
const FAILS_PER_CLIENT = 5;
const FAILS_PER_SPACE = 50;

export class PasswordRejected extends Error {}

export function checkPassword(password: unknown): string {
  if (typeof password !== "string") throw new PasswordRejected("password is required");
  if (password.length < PASSWORD_MIN) throw new PasswordRejected(`password must be at least ${PASSWORD_MIN} characters`);
  if (new TextEncoder().encode(password).length > PASSWORD_MAX) throw new PasswordRejected(`password must be at most ${PASSWORD_MAX} bytes`);
  return password;
}

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export type LoginResult =
  | { ok: true; token: string; session: Session }
  | { ok: false; reason: "uninitialized" | "invalid" }
  | { ok: false; reason: "limited"; retryAfterMs: number };

export type AuthServiceOptions = {
  now?: () => number;
  sessionTtlMs?: number;
  /** Argon2id cost; tests lower it. */
  hashCost?: { memoryCost: number; timeCost: number };
};

export class AuthService {
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly cost: { memoryCost: number; timeCost: number } | undefined;
  private readonly failures = new Map<string, number[]>();
  private spaceFailures: number[] = [];

  constructor(
    readonly store: AuthStore,
    opts: AuthServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.ttl = opts.sessionTtlMs ?? SESSION_TTL_MS;
    this.cost = opts.hashCost;
  }

  initialized(): boolean {
    return this.store.owner() !== undefined;
  }

  private hash(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: "argon2id", ...(this.cost ?? {}) });
  }

  /** Sets the owner's password the first time; throws `OwnerExists` after that. */
  async init(password: string): Promise<void> {
    this.store.createOwner(await this.hash(checkPassword(password)), this.now());
  }

  /** From the machine: a new password, and every session signed out. */
  async resetPassword(password: string): Promise<{ revoked: number }> {
    const hash = await this.hash(checkPassword(password));
    const at = this.now();
    if (!this.store.setPassword(hash, at)) throw new Error("the owner is not initialized; run `space auth init` first");
    return { revoked: this.store.revokeAll(at) };
  }

  /** From a signed-in session: the current password must match. The session it came from stays; every other one is signed out. */
  async changePassword(current: string, next: string, keep: number): Promise<{ ok: true; revoked: number } | { ok: false; reason: "invalid" }> {
    const owner = this.store.owner();
    if (!owner || !(await Bun.password.verify(String(current ?? ""), owner.passwordHash))) return { ok: false, reason: "invalid" };
    const hash = await this.hash(checkPassword(next));
    const at = this.now();
    this.store.setPassword(hash, at);
    return { ok: true, revoked: this.store.revokeAll(at, keep) };
  }

  private recent(list: number[] | undefined, now: number): number[] {
    return (list ?? []).filter((t) => t > now - FAIL_WINDOW_MS);
  }

  /** How long the client must wait before another attempt; 0 = it may try now. */
  private wait(client: string, now: number): number {
    const mine = this.recent(this.failures.get(client), now);
    this.spaceFailures = this.recent(this.spaceFailures, now);
    // Once a list holds `limit` failures in the window, the next try waits until the oldest of them leaves it.
    const until = (list: number[], limit: number) => (list.length >= limit ? list[list.length - limit]! + FAIL_WINDOW_MS : 0);
    return Math.max(0, until(mine, FAILS_PER_CLIENT) - now, until(this.spaceFailures, FAILS_PER_SPACE) - now);
  }

  private fail(client: string, now: number): void {
    this.failures.set(client, [...this.recent(this.failures.get(client), now), now]);
    this.spaceFailures.push(now);
    if (this.failures.size > 10_000) for (const [k, v] of this.failures) if (!this.recent(v, now).length) this.failures.delete(k);
  }

  /**
   * Checks the password and opens a session. `client` only buckets failures (an address, which a
   * caller can vary); the space-wide count bounds a caller that does.
   */
  async login(password: unknown, meta: { client: string; userAgent?: string }): Promise<LoginResult> {
    const now = this.now();
    const owner = this.store.owner();
    if (!owner) return { ok: false, reason: "uninitialized" };
    const retryAfterMs = this.wait(meta.client, now);
    if (retryAfterMs > 0) return { ok: false, reason: "limited", retryAfterMs };
    if (typeof password !== "string" || !password || !(await Bun.password.verify(password, owner.passwordHash))) {
      this.fail(meta.client, now);
      return { ok: false, reason: "invalid" };
    }
    this.failures.delete(meta.client);
    const token = randomBytes(32).toString("base64url");
    const session = this.store.addSession(hashToken(token), now, now + this.ttl, meta.userAgent ?? "");
    if (Math.random() < 0.05) this.store.prune(now);
    return { ok: true, token, session };
  }

  /** The live session behind a token, or undefined. */
  verify(token: string): Session | undefined {
    if (!token || token.length > 200) return undefined;
    const now = this.now();
    const s = this.store.liveSession(hashToken(token), now);
    if (s && now - s.lastSeenAt >= TOUCH_EVERY_MS) {
      this.store.touch(s.id, now);
      s.lastSeenAt = now;
    }
    return s;
  }

  logout(token: string): void {
    const s = token ? this.store.liveSession(hashToken(token), this.now()) : undefined;
    if (s) this.store.revoke(s.id, this.now());
  }

  sessions(): Session[] {
    return this.store.liveSessions(this.now());
  }

  revoke(id: number): boolean {
    return this.store.revoke(id, this.now());
  }

  revokeAll(keep?: number): number {
    return this.store.revokeAll(this.now(), keep);
  }
}
