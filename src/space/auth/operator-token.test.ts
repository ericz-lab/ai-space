import { expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureOperatorToken, operatorTokenPath, readOperatorToken } from "./operator-token.ts";

async function withHome(fn: (home: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "space-optoken-"));
  try {
    await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a configured token wins and nothing is written", () =>
  withHome(async (home) => {
    expect(await ensureOperatorToken(home, "configured")).toBe("configured");
    expect(await Bun.file(operatorTokenPath(home)).exists()).toBe(false);
  }));

test("with none, a new token is written with mode 0600 and kept across calls", () =>
  withHome(async (home) => {
    expect(await readOperatorToken(home)).toBe("");
    const token = await ensureOperatorToken(home, "");
    expect(token.length).toBeGreaterThanOrEqual(40);
    expect((await stat(operatorTokenPath(home))).mode & 0o777).toBe(0o600);
    expect(await readOperatorToken(home)).toBe(token);
    expect(await ensureOperatorToken(home, "")).toBe(token);
  }));

test("an existing file is read trimmed; an empty one is replaced", () =>
  withHome(async (home) => {
    await mkdir(join(home, "run"));
    await writeFile(operatorTokenPath(home), "  kept \n");
    expect(await ensureOperatorToken(home, "")).toBe("kept");
    await writeFile(operatorTokenPath(home), "\n");
    const fresh = await ensureOperatorToken(home, "");
    expect(fresh).not.toBe("");
    expect(await readOperatorToken(home)).toBe(fresh);
  }));
