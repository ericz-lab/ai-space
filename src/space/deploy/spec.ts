/**
 * The `deploy:` section of space.yaml: the commands `space app deploy` runs in the app directory
 * after a new revision is checked out and before the service restarts. A failing command stops the
 * deploy: the previous revision is put back and the running service is left alone.
 *
 * ```yaml
 * deploy:
 *   install: bun install --frozen-lockfile   # default when bun.lock exists; [] for none
 *   check: [bun run typecheck, bun test]      # must pass, nothing is built yet
 *   build: bun run build                      # the artifacts the service runs from
 * ```
 *
 * Each value is one command or a list of them, run by `/bin/sh -c` in order. Parsing is strict,
 * like the rest of the manifest: an unknown key or a bad value rejects the app. See
 * docs/app-spec.md#deploy.
 */

export type DeploySpec = {
  /** Absent: `bun install --frozen-lockfile` when the checkout has a `bun.lock`, else nothing. */
  install?: string[];
  check: string[];
  build: string[];
};

const KEYS = ["install", "check", "build"] as const;
const MAX_COMMANDS = 10;

export function parseDeploySpec(raw: unknown): DeploySpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("deploy must be a mapping with install / check / build");
  const doc = raw as Record<string, unknown>;
  for (const key of Object.keys(doc)) if (!(KEYS as readonly string[]).includes(key)) throw new Error(`deploy has unknown key "${key}"`);
  const install = doc.install === undefined ? undefined : commands(doc.install, "deploy.install");
  return {
    ...(install ? { install } : {}),
    check: doc.check === undefined ? [] : commands(doc.check, "deploy.check"),
    build: doc.build === undefined ? [] : commands(doc.build, "deploy.build"),
  };
}

/** The install commands for a checkout: the declared ones, else bun's when the checkout has a bun lockfile. */
export function installCommands(spec: DeploySpec | undefined, hasBunLock: boolean): string[] {
  if (spec?.install) return spec.install;
  return hasBunLock ? ["bun install --frozen-lockfile"] : [];
}

function commands(raw: unknown, where: string): string[] {
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list)) throw new Error(`${where} must be a command or a list of commands`);
  if (list.length > MAX_COMMANDS) throw new Error(`${where} has more than ${MAX_COMMANDS} commands`);
  return list.map((c, i) => {
    const at = Array.isArray(raw) ? `${where}[${i}]` : where;
    if (typeof c !== "string" || !c.trim()) throw new Error(`${at} must be a non-empty string`);
    if (/[\r\n]/.test(c)) throw new Error(`${at} must be one line: put several lines into a script`);
    return c.trim();
  });
}
