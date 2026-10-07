import { expect, test } from "bun:test";
import { parseManifest } from "../scheduler/manifest.ts";
import { installCommands, parseDeploySpec } from "./spec.ts";

test("deploy: one command or a list, install only when declared", () => {
  expect(parseDeploySpec(undefined)).toBeUndefined();
  expect(parseDeploySpec({ check: "bun run typecheck" })).toEqual({ check: ["bun run typecheck"], build: [] });
  expect(parseDeploySpec({ install: [], check: ["bun run typecheck", "bun test"], build: " bun run build " })).toEqual({ install: [], check: ["bun run typecheck", "bun test"], build: ["bun run build"] });
});

test("deploy: strict like the rest of the manifest", () => {
  expect(() => parseDeploySpec("bun run build")).toThrow("deploy must be a mapping");
  expect(() => parseDeploySpec({ test: "bun test" })).toThrow('deploy has unknown key "test"');
  expect(() => parseDeploySpec({ check: [""] })).toThrow("deploy.check[0] must be a non-empty string");
  expect(() => parseDeploySpec({ build: 3 })).toThrow("deploy.build must be a command or a list of commands");
  expect(() => parseDeploySpec({ build: "a\nb" })).toThrow("deploy.build must be one line");
  expect(() => parseDeploySpec({ check: Array.from({ length: 11 }, () => "true") })).toThrow("more than 10 commands");
});

test("install: declared commands win, else bun's when the checkout has bun.lock", () => {
  expect(installCommands(undefined, true)).toEqual(["bun install --frozen-lockfile"]);
  expect(installCommands(undefined, false)).toEqual([]);
  expect(installCommands({ install: [], check: [], build: [] }, true)).toEqual([]);
  expect(installCommands({ install: ["npm ci"], check: [], build: [] }, false)).toEqual(["npm ci"]);
});

test("the manifest carries the section and rejects a bad one", () => {
  const m = parseManifest("name: a\nservice: { command: bun src/index.ts, port: 8710 }\ndeploy: { check: bun run typecheck }\n", "/apps/a");
  expect(m.deploy).toEqual({ check: ["bun run typecheck"], build: [] });
  expect(() => parseManifest("name: a\ndeploy: { prebuild: x }\n", "/apps/a")).toThrow('deploy has unknown key "prebuild"');
});
