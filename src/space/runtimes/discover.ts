import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathOf, whichUsable, withPath, withUserToolDirs } from "../host-tools.ts";
import { spawnCollect } from "./process.ts";

/**
 * The agent CLIs installed on this machine, found by their own `--version`, and the
 * `runtimes.yaml` that names them: what `init` writes for a new workspace (src/cli/lifecycle.ts)
 * and what the model status table looks for (src/space/model/health.ts).
 */

export type Runtimes = Record<"claude" | "codex" | "dsh", string | null>;
export type AgentName = keyof Runtimes;

/** Where the DeepSeek Harness desktop app keeps the `dsh` CLI it ships; it is not on PATH. */
const DSH_APP_CLI = "DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";

/** The desktop app's CLI, for the usual install locations. */
export function dshAppCandidates(home: string): string[] {
  return [`/Applications/${DSH_APP_CLI}`, join(home, "Applications", DSH_APP_CLI)];
}

/** Whether a path is the DeepSeek Harness app's own CLI, which is signed in through the app. */
export function isHarnessAppCli(path: string): boolean {
  if (path.endsWith(`/${DSH_APP_CLI}`)) return true;
  try {
    return realpathSync(path).endsWith(`/${DSH_APP_CLI}`);
  } catch {
    return false;
  }
}

/**
 * The agent CLIs on this machine, searched on PATH and the user tool directories. `chosen` names a
 * path for one (it wins over the search when its version identifies the expected agent); null
 * means "do not use this one". DeepSeek Harness is also looked for in the desktop app's bundle,
 * where its CLI lives off PATH.
 */
export async function findRuntimes(env: Record<string, string | undefined> = process.env, home = homedir(), chosen: Partial<Runtimes> = {}): Promise<Runtimes> {
  const PATH = withUserToolDirs(pathOf(env) ?? "/usr/bin:/bin", home);
  const candidatesFor = (name: AgentName): string[] => {
    const c = chosen[name];
    if (c === null) return [];
    if (c) return [c];
    if (name === "dsh") {
      const app = dshAppCandidates(home).filter(executableFile);
      const onPath = whichUsable("dsh", { PATH });
      return [...new Set([...app, ...(onPath ? [onPath] : [])])];
    }
    const found = whichUsable(name, { PATH });
    return found ? [found] : [];
  };
  const one = async (name: AgentName) => {
    for (const path of candidatesFor(name)) {
      if (!executableFile(path)) continue;
      try {
        const timeoutMs = name === "dsh" ? 5000 : 3000;
        const result = await spawnCollect([path, "--version"], { env: withPath({ ...env, HOME: home }, PATH), timeoutMs });
        const version = result.stdout.trim();
        if (result.code !== 0 || result.timedOut) continue;
        const matches = name === "claude" ? /^\d+\.\d+\.\d+[^\n]*\(Claude Code\)$/i.test(version)
          : name === "codex" ? /^codex-cli \d+\.\d+\.\d+[^\n]*$/i.test(version)
          : /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version);
        if (!matches) continue;
        // The app bundle's path already identifies the harness; another `dsh` must name it in help.
        if (name === "dsh" && !isHarnessAppCli(path)) {
          const help = await spawnCollect([path, "--help"], { env: withPath({ ...env, HOME: home }, PATH), timeoutMs });
          if (help.code !== 0 || help.timedOut || !/DeepSeek Harness/i.test(help.stdout + help.stderr)) continue;
        }
        return path;
      } catch {
        /* try the next candidate */
      }
    }
    return null;
  };
  const [claude, codex, dsh] = await Promise.all([one("claude"), one("codex"), one("dsh")]);
  return { claude, codex, dsh };
}

function executableFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Variables that already describe the space's runtime (runtimes/config.ts): then no file is written. */
export const RUNTIME_ENV = ["SPACE_MODEL_BIN", "SPACE_CHAT_BIN", "SPACE_MODEL_SSH_HOST", "SPACE_MODEL_API_KEY"];

/**
 * `runtimes.yaml` for the agent CLIs found: Claude Code, Codex and DeepSeek Harness, each by its
 * absolute path, so the service runs them whatever PATH its service manager gives it. `default:` is
 * the first runtime found, so a bare model name has a home. The desktop app's CLI is written with
 * `provider: deepseek-account`, the login that ships with it; a `dsh` installed elsewhere follows
 * the configured route (an API key). Undefined when no CLI was found.
 */
export function renderRuntimesYaml(r: Runtimes, header: string[]): string | undefined {
  const entries: string[] = [];
  if (r.claude) entries.push(`  claude:\n    kind: claude-code\n    bin: [${JSON.stringify(r.claude)}]`);
  if (r.codex) entries.push(`  codex:\n    kind: codex-cli\n    bin: [${JSON.stringify(r.codex)}]`);
  if (r.dsh) {
    const account = isHarnessAppCli(r.dsh) ? "\n    provider: deepseek-account" : "";
    entries.push(`  dsh:\n    kind: deepseek-harness\n    bin: [${JSON.stringify(r.dsh)}]${account}`);
  }
  const first = (["claude", "codex", "dsh"] as const).find((name) => r[name]);
  if (!first) return undefined;
  return [...header, `default: ${first}`, "runtimes:", ...entries, ""].join("\n");
}
