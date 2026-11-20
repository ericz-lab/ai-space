import { createHash, createPublicKey } from "node:crypto";
import builtin from "./publishers.json" with { type: "json" };

/**
 * Publishers whose signed packages every Space trusts without asking (docs/app-catalog.md#trust).
 * `publishers.json` ships with ai-space: `[{ name, keyId, publicKey }]`, the public half of each
 * publisher's Ed25519 key in PEM. More keys come from `SPACE_PACKAGE_TRUST_KEYS`; a catalog never
 * adds one by itself: a package signed by a key that is in neither needs the owner's confirmation.
 */

export type Publisher = { name: string; keyId: string; publicKey: string };

/** The lowercase SHA-256 of a public key's DER SPKI, as package signatures name it. */
export function keyIdOf(pem: string): string {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("publisher keys are Ed25519");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function parsePublishers(raw: unknown): Publisher[] {
  if (!Array.isArray(raw)) throw new Error("publishers must be a list");
  return raw.map((p, i) => {
    const e = p as Partial<Publisher>;
    if (typeof e?.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(e.name)) throw new Error(`publishers[${i}].name is invalid`);
    if (typeof e.publicKey !== "string" || typeof e.keyId !== "string") throw new Error(`publishers[${i}] needs keyId and publicKey`);
    if (keyIdOf(e.publicKey) !== e.keyId) throw new Error(`publishers[${i}].keyId does not match its public key`);
    return { name: e.name, keyId: e.keyId, publicKey: e.publicKey };
  });
}

export const BUILTIN_PUBLISHERS: Publisher[] = parsePublishers(builtin);
