import { parseManifest, type Manifest } from "../scheduler/manifest.ts";
import { parseStorageSpec } from "../storage/spec.ts";
import { parseBackupSpec } from "../storage/backup/spec.ts";
import { parseNotifySpec } from "../notify/spec.ts";
import { choice, integer, mapping, packagePath, PACKAGE_API, releaseVersion, text } from "./contract.ts";

export type AppLaunch =
  | { kind: "static"; root: string; index: string }
  | { kind: "process"; runtime: "bun" | "native"; entry: string; args: string[]; mode: "on-demand" | "background"; idleTimeoutMs: number; health: string };

/** Validated but not activated: legacy sync intentionally continues to reject spec 2. */
export type PackageManifest = Omit<Manifest, "spec" | "service" | "url" | "deploy"> & {
  spec: 2;
  version: string;
  requires: { spaceApi: number; bun?: string };
  offline: { features: string[]; online: string[] };
  launch?: AppLaunch;
};

const COMMON = ["name", "title", "description", "icon", "status", "repo", "i18n", "agents", "widgets", "skills", "tasks", "storage", "notify", "backup", "events", "provides", "model", "checks"];

export function parsePackageManifest(yaml: string): PackageManifest {
  const doc = mapping(Bun.YAML.parse(yaml), "manifest", ["spec", "version", "requires", "offline", "launch", ...COMMON]);
  if (doc.spec !== 2) throw new Error("package manifest must use spec: 2; legacy checkouts must be explicitly migrated");
  const name = text(doc.name, "name", 64);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name === "." || name === "..") throw new Error("invalid package app name");
  const version = releaseVersion(doc.version);
  const r = mapping(doc.requires, "requires", ["spaceApi", "bun"]);
  const requires = { spaceApi: integer(r.spaceApi, "requires.spaceApi", 1, Number.MAX_SAFE_INTEGER), ...(r.bun === undefined ? {} : { bun: releaseVersion(r.bun, "requires.bun") }) };
  const o = mapping(doc.offline, "offline", ["features", "online"]);
  const offline = { features: labels(o.features, "offline.features"), online: labels(o.online, "offline.online") };
  if (offline.features.some((f) => offline.online.includes(f))) throw new Error("a feature cannot be both offline and online");
  const launch = doc.launch === undefined ? undefined : parseLaunch(doc.launch);
  if (launch?.kind === "process" && launch.runtime === "bun" && !requires.bun) throw new Error("a bun launch requires requires.bun");
  if (launch?.kind !== "process" && doc.checks !== undefined) throw new Error("checks require a process launch");

  // Reuse the existing component validators without accepting v2 in the running registry.
  // The synthetic service only satisfies checks' validation; it never escapes this function.
  const common = Object.fromEntries(COMMON.filter((key) => Object.hasOwn(doc, key)).map((key) => [key, doc[key]]));
  const legacy = parseManifest(Bun.YAML.stringify({ ...common, spec: 1, ...(launch?.kind === "process" ? { service: { command: "package-validation-only", port: 1 } } : {}) }), `/packages/${name}`);
  parseStorageSpec(doc.storage);
  parseNotifySpec(doc.notify);
  const backup = parseBackupSpec(doc.backup);
  if (backup.schedule && !backup.timezone) throw new Error("backup.schedule requires an explicit timezone");
  const { spec: _spec, service: _service, url: _url, deploy: _deploy, ...rest } = legacy;
  for (const task of legacy.tasks) {
    if (task.schedule.kind === "cron" && !task.schedule.tz) throw new Error(`task ${task.name} requires an explicit timezone`);
    if (task.schedule.kind === "at" && !/(Z|[+-]\d{2}:\d{2})$/i.test(task.schedule.at)) throw new Error(`task ${task.name} requires an offset-bearing at timestamp`);
  }
  return { ...rest, spec: 2, version, requires, offline, ...(launch ? { launch } : {}) };
}

export function assertPackageCompatibility(manifest: PackageManifest, bunVersion?: string): void {
  if (manifest.requires.spaceApi > PACKAGE_API) throw new Error(`requires package API ${manifest.requires.spaceApi}; this host supports ${PACKAGE_API}`);
  if (manifest.requires.bun) {
    if (!bunVersion) throw new Error("package requires Bun on the host");
    const current = releaseVersion(bunVersion, "host Bun version").split(".").map(Number);
    const minimum = manifest.requires.bun.split(".").map(Number);
    const first = current.findIndex((n, i) => n !== minimum[i]);
    if (first >= 0 && current[first]! < minimum[first]!) throw new Error(`requires Bun >= ${manifest.requires.bun}`);
  }
}

function parseLaunch(raw: unknown): AppLaunch {
  const l = mapping(raw, "launch", ["kind", "root", "index", "runtime", "entry", "args", "mode", "idleTimeoutMs", "health"]);
  const kind = choice(l.kind, "launch.kind", ["static", "process"]);
  if (kind === "static") {
    mapping(raw, "static launch", ["kind", "root", "index"]);
    return { kind, root: packagePath(l.root, "launch.root"), index: packagePath(l.index ?? "index.html", "launch.index") };
  }
  mapping(raw, "process launch", ["kind", "runtime", "entry", "args", "mode", "idleTimeoutMs", "health"]);
  const runtime = choice(l.runtime, "launch.runtime", ["bun", "native"]);
  const entry = packagePath(l.entry, "launch.entry");
  const mode = choice(l.mode ?? "on-demand", "launch.mode", ["on-demand", "background"]);
  const idleTimeoutMs = integer(l.idleTimeoutMs ?? 300_000, "launch.idleTimeoutMs", 1000, 86_400_000);
  if (mode === "background" && l.idleTimeoutMs !== undefined) throw new Error("background launch cannot set idleTimeoutMs");
  const health = text(l.health, "launch.health", 1024);
  if (!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(health)) throw new Error("launch.health must be a local absolute path without query or fragment");
  if (l.args !== undefined && (!Array.isArray(l.args) || l.args.length > 100)) throw new Error("launch.args must be a list of at most 100 arguments");
  const args = ((l.args ?? []) as unknown[]).map((arg, i) => text(arg, `launch.args[${i}]`, 4096));
  return { kind, runtime, entry, args, mode, idleTimeoutMs, health };
}

function labels(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.length > 100) throw new Error(`${where} must be a list of at most 100 feature descriptions`);
  const list = raw.map((value, i) => text(value, `${where}[${i}]`));
  if (new Set(list).size !== list.length) throw new Error(`${where} contains duplicates`);
  return list;
}
