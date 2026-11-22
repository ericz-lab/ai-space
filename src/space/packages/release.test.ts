import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { inspectPackage, readPackageFile } from "./pack.ts";
import { buildEnv, buildRelease, readSourceManifest, ReleaseError } from "./release.ts";
import { removeTemp } from "../testing.ts";

const roots: string[] = [];
afterAll(async () => { for (const r of roots) await removeTemp(r); });
async function scratch(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), "space-release-"));
  roots.push(r);
  return r;
}

const release = (extra: Record<string, unknown> = {}) => Bun.YAML.stringify({
  spec: 2, name: "shelf", version: "1.2.3", requires: { spaceApi: 1, bun: "1.3.0" },
  offline: { features: ["List jobs"], online: [] },
  launch: { kind: "process", runtime: "bun", entry: "dist/server.js", health: "/healthz" },
  build: { install: "true", run: "mkdir -p dist && cp src/server.ts dist/server.js", include: ["dist", "icon.svg"] },
  ...extra,
});

/** A spec-1 checkout with a release declaration beside it, as the open-source apps keep them. */
async function checkout(manifest = release()): Promise<string> {
  const dir = join(await scratch(), "shelf");
  await mkdir(join(dir, "src"), { recursive: true });
  await Bun.write(join(dir, "space.yaml"), "spec: 1\nname: shelf\nservice: { command: bun src/server.ts, port: 9145 }\n");
  await Bun.write(join(dir, "space.release.yaml"), manifest);
  await Bun.write(join(dir, "src", "server.ts"), "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n");
  await Bun.write(join(dir, "icon.svg"), "<svg/>");
  await Bun.write(join(dir, "package.json"), "{}");
  await Bun.write(join(dir, ".env"), "SECRET=1");
  await Bun.write(join(dir, "node_modules", "dep", "index.js"), "x");
  await Bun.write(join(dir, "src", "data", "local.db"), "x");
  return dir;
}

test("the release declaration wins over a spec-1 space.yaml", async () => {
  const dir = await checkout();
  const source = await readSourceManifest(dir);
  expect(source.file.endsWith("space.release.yaml")).toBe(true);
  expect(source.manifest.build?.include).toEqual(["dist", "icon.svg"]);
});

test("a build runs in a scratch copy and makes a bundle and a source package", async () => {
  const dir = await checkout();
  const out = join(await scratch(), "out");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const r = await buildRelease({ dir, outDir: out, variants: ["bundle", "source"], signingKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  expect(r).toMatchObject({ app: "shelf", version: "1.2.3" });
  expect(r.packages.map((p) => [p.variant, basename(p.path), p.sourceIncluded])).toEqual([["bundle", "shelf-1.2.3.spaceapp", false], ["source", "shelf-1.2.3-source.spaceapp", true]]);
  expect(r.log).toContain("$ mkdir -p dist");
  // The checkout is untouched: nothing was built in it.
  expect((await readdir(dir)).includes("dist")).toBe(false);
  const trusted = [publicKey.export({ type: "spki", format: "pem" }).toString()];
  const bundle = await inspectPackage(await readPackageFile(r.packages[0]!.path), trusted);
  expect(bundle.signature.status).toBe("verified");
  expect([...bundle.files.keys()].sort()).toEqual(["dist/server.js", "icon.svg", "space.yaml"]);
  expect(bundle.manifest.spec).toBe(2);
  const source = await inspectPackage(await readPackageFile(r.packages[1]!.path), trusted);
  const files = [...source.files.keys()];
  expect(files).toContain("src/server.ts");
  expect(files).toContain("space.release.yaml");
  expect(files.some((f) => f.startsWith("node_modules") || f.includes("data/") || f === ".env")).toBe(false);
  expect(source.index.sourceIncluded).toBe(true);
});

test("a failed build command packs nothing and returns its output", async () => {
  const dir = await checkout(release({ build: { run: "echo broken >&2; exit 3", include: ["dist"] } }));
  const out = join(await scratch(), "out");
  const e = await buildRelease({ dir, outDir: out, variants: ["bundle"] }).catch((x) => x);
  expect(e).toBeInstanceOf(ReleaseError);
  expect((e as ReleaseError).message).toContain("exit 3");
  expect((e as ReleaseError).log).toContain("broken");
  expect(await readdir(out)).toEqual([]);
});

test("an include the build did not make is an error", async () => {
  const dir = await checkout(release({ build: { run: "true", include: ["dist"] } }));
  const e = await buildRelease({ dir, outDir: join(await scratch(), "out"), variants: ["bundle"] }).catch((x) => x);
  expect((e as Error).message).toContain("did not produce");
});

test("without a build section the checkout is the package, source included", async () => {
  const dir = join(await scratch(), "notes");
  await mkdir(join(dir, "public"), { recursive: true });
  await Bun.write(join(dir, "space.yaml"), release({ name: "notes", build: undefined, launch: { kind: "process", runtime: "bun", entry: "server.ts", health: "/healthz" } }));
  await Bun.write(join(dir, "server.ts"), "");
  await Bun.write(join(dir, "public", "index.html"), "<p>hi</p>");
  const r = await buildRelease({ dir, outDir: join(await scratch(), "out"), variants: ["bundle", "source"] });
  expect(r.packages.map((p) => [p.variant, basename(p.path), p.sourceIncluded])).toEqual([["source", "notes-1.2.3.spaceapp", true]]);
});

test("a build script sees none of the Space's credentials", () => {
  const env = buildEnv({ PATH: "/usr/bin", HOME: "/home/x", SPACE_API_TOKEN: "t", AWS_SECRET_ACCESS_KEY: "s", SPACE_APP_TOKEN: "a" }, "/opt/bun/bin/bun");
  expect(env).toEqual({ PATH: ["/opt/bun/bin", "/usr/bin"].join(delimiter), HOME: "/home/x", CI: "1" });
});
