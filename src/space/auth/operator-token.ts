import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Under `SPACE_AUTH=builtin` the operator token is never empty: an empty one
 * would let any caller that passed the gate act as the operator. When the
 * workspace `.env` sets no `SPACE_API_TOKEN`, ai-space keeps one in
 * `<workspace>/run/operator-token` (mode 0600), and the CLI on the machine
 * reads it there: being able to read the file is the local permission.
 */

export const operatorTokenPath = (home: string) => join(home, "run", "operator-token");

export async function readOperatorToken(home: string): Promise<string> {
  const f = Bun.file(operatorTokenPath(home));
  return (await f.exists()) ? (await f.text()).trim() : "";
}

/** The configured token, else the one in the file, else a new one written there. */
export async function ensureOperatorToken(home: string, configured: string): Promise<string> {
  if (configured) return configured;
  const existing = await readOperatorToken(home);
  if (existing) return existing;
  const token = randomBytes(32).toString("base64url");
  const path = operatorTokenPath(home);
  await mkdir(join(home, "run"), { recursive: true });
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return token;
}
