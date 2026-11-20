import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { BUILTIN_PUBLISHERS, keyIdOf, parsePublishers } from "./publishers.ts";

test("built-in publishers parse and every key ID matches its key", () => {
  for (const p of BUILTIN_PUBLISHERS) expect(keyIdOf(p.publicKey)).toBe(p.keyId);
});

test("a publisher whose key ID does not match its key is refused", () => {
  const pem = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  expect(parsePublishers([{ name: "someone", keyId: keyIdOf(pem), publicKey: pem }])).toHaveLength(1);
  expect(() => parsePublishers([{ name: "someone", keyId: "0".repeat(64), publicKey: pem }])).toThrow(/does not match/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  expect(() => parsePublishers([{ name: "someone", keyId: "0".repeat(64), publicKey: rsa }])).toThrow(/Ed25519/);
  expect(() => parsePublishers([{ name: "../x", keyId: keyIdOf(pem), publicKey: pem }])).toThrow(/name/);
});
