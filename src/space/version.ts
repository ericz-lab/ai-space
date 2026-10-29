import { join } from "node:path";
import { SPACE_ROOT } from "./config.ts";

/**
 * The one version of ai-space (docs/editions.md): `package.json` holds it, and every edition is
 * built from it. The native projects cannot read `package.json`, so they carry a copy that
 * `bun run set-version <x.y.z>` rewrites and `version.test.ts` checks.
 */

export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The version in `package.json` under `root`. */
export async function readVersion(root = SPACE_ROOT): Promise<string> {
  const { version } = (await Bun.file(join(root, "package.json")).json()) as { version?: unknown };
  if (typeof version !== "string" || !VERSION_RE.test(version)) throw new Error(`package.json: "version" must be x.y.z, got ${JSON.stringify(version)}`);
  return version;
}

/** A copy of the version outside `package.json`: the file, and the pattern whose group 2 is the version. */
export type VersionCopy = { path: string; pattern: RegExp };

export const VERSION_COPIES: VersionCopy[] = [
  { path: "desktop/macos/AISpace/Info.plist", pattern: /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<$]+)(<\/string>)/ },
  { path: "desktop/macos/project.yml", pattern: /(MARKETING_VERSION: )(\S+)()/ },
  { path: "desktop/macos/AISpace.xcodeproj/project.pbxproj", pattern: /(MARKETING_VERSION = )([^;]+)(;)/g },
  { path: "mobile/ios/project.yml", pattern: /(MARKETING_VERSION: )(\S+)()/ },
  { path: "mobile/ios/AISpace.xcodeproj/project.pbxproj", pattern: /(MARKETING_VERSION = )([^;]+)(;)/g },
  { path: "mobile/ios/scripts/build.sh", pattern: /(s\/\$\(MARKETING_VERSION\)\/)([^/]+)(\/)/ },
  { path: "mobile/android/app/build.gradle.kts", pattern: /(versionName = ")([^"]+)(")/ },
  { path: "desktop/windows/Directory.Build.props", pattern: /(<Version>)([^<]+)(<\/Version>)/ },
];

/** Every version a copy holds; empty when the pattern no longer matches the file. */
export function versionsIn(text: string, pattern: RegExp): string[] {
  const all = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  return [...text.matchAll(all)].map((m) => m[2]!);
}

/** Write `version` into `package.json` and every copy under `root`; returns the files changed. */
export async function setVersion(version: string, root = SPACE_ROOT): Promise<string[]> {
  if (!VERSION_RE.test(version)) throw new Error(`not a version: ${version} (expected x.y.z)`);
  const changed: string[] = [];
  const pkgPath = join(root, "package.json");
  const pkg = await Bun.file(pkgPath).text();
  const next = pkg.replace(/("version":\s*")[^"]*(")/, `$1${version}$2`);
  if (next === pkg && !pkg.includes(`"version": "${version}"`)) throw new Error("package.json: no \"version\" field");
  if (next !== pkg) { await Bun.write(pkgPath, next); changed.push("package.json"); }
  for (const copy of VERSION_COPIES) {
    const file = join(root, copy.path);
    const text = await Bun.file(file).text();
    if (versionsIn(text, copy.pattern).length === 0) throw new Error(`${copy.path}: version not found`);
    const out = text.replace(copy.pattern, `$1${version}$3`);
    if (out !== text) { await Bun.write(file, out); changed.push(copy.path); }
  }
  return changed;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.log(await readVersion());
  } else {
    try {
      const changed = await setVersion(version);
      console.log(changed.length ? `set ${version} in:\n  ${changed.join("\n  ")}` : `already ${version}`);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  }
}
