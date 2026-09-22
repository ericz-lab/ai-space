import { loadConfig, type Config } from "../space/config.ts";
import { type Workspace, ensureWorkspace, loadWorkspaceEnv, readWorkspaceEnv, resolveHome, workspacePaths } from "../space/workspace.ts";
import { parseArgs } from "./args.ts";
import { Client, resolveTarget } from "./client.ts";
import { Printer } from "./output.ts";
import { ApiError, type Ctx, EXIT, type GlobalFlags, type Io, type Noun, Unreachable, UsageError } from "./types.ts";
import { apiNoun } from "./api.ts";
import { appNoun } from "./app.ts";
import { backupNoun } from "./backup.ts";
import { chatNoun } from "./chat.ts";
import { completionNoun } from "./completion.ts";
import { eventNoun } from "./event.ts";
import { lifecycleNouns } from "./lifecycle.ts";
import { logsNoun } from "./logs.ts";
import { modelNoun } from "./model.ts";
import { notifyNoun } from "./notify.ts";
import { peerNoun } from "./peer.ts";
import { routerNoun } from "./router.ts";
import { statusNoun } from "./status.ts";
import { taskNoun } from "./task.ts";

/**
 * The `space` command: nouns, then verbs (docs/cli.md).
 *
 *   space <noun> <verb> [args] [--json] [--url U] [--token T] [-q]
 *
 * `bin/space` and `bun src/index.ts` both end up in `run`. The older
 * single-word spellings of the entry point are aliases (`ALIASES`), so what
 * the docs and the scheduler's tasks spell keeps working.
 */

export const NOUNS: Noun[] = [statusNoun, appNoun, taskNoun, logsNoun, modelNoun, notifyNoun, backupNoun, chatNoun, eventNoun, peerNoun, routerNoun, apiNoun, ...lifecycleNouns, completionNoun];

/** Older spellings of `src/index.ts`: word → noun and verb. */
export const ALIASES: Record<string, string[]> = {
  env: ["app", "env"],
  "new-app": ["app", "new"],
  backup: ["backup", "run"],
  "backup-verify": ["backup", "verify"],
  backups: ["backup", "ls"],
  restore: ["backup", "restore"],
  "model-import": ["model", "import"],
  "chat-import": ["chat", "import"],
};

const GLOBAL = {
  json: { kind: "bool" },
  quiet: { kind: "bool", alias: "q" },
  url: { kind: "value" },
  token: { kind: "value" },
  help: { kind: "bool", alias: "h" },
} as const;

export type RunOptions = {
  io?: Partial<Io>;
  boot?: (ws: Workspace, config: Config) => Promise<unknown>;
};

export async function run(argv: string[], options: RunOptions = {}): Promise<number> {
  const io: Io = { ...realIo(), ...options.io };
  // Global flags may sit anywhere; everything else stays in order for the verb.
  const { global, rest } = splitGlobal(argv);
  let flags: GlobalFlags;
  try {
    const g = parseArgs(global, GLOBAL).flags;
    flags = { json: Boolean(g.json), quiet: Boolean(g.quiet), url: g.url, token: g.token };
    if (g.help) rest.unshift("help");
  } catch (e) {
    io.err(`space: ${(e as Error).message}`);
    return EXIT.usage;
  }
  const print = new Printer(io, flags.json, flags.quiet);

  let clientPromise: Promise<Client> | undefined;
  let wsPromise: Promise<{ ws: Workspace; config: Config }> | undefined;
  const ctx: Ctx = {
    io,
    flags,
    print,
    boot: options.boot,
    client: () =>
      (clientPromise ??= (async () => {
        const home = resolveHome(io.env);
        const target = await resolveTarget(flags, io.env, () => readWorkspaceEnv(workspacePaths(home)));
        return new Client(target, io.fetch);
      })()),
    workspace: () =>
      (wsPromise ??= (async () => {
        const { ws, created, updated } = await ensureWorkspace(resolveHome(io.env), io.env);
        for (const p of created) io.err(`[space] created ${p}`);
        for (const p of updated) io.err(`[space] regenerated ${p}`);
        await loadWorkspaceEnv(ws);
        return { ws, config: loadConfig(ws, io.env) };
      })()),
  };

  const words = expandAlias(rest);
  const first = words[0];
  if (!first || first === "help") {
    const nounName = words[1];
    const noun = nounName ? NOUNS.find((n) => n.name === nounName) : undefined;
    if (nounName && !noun) {
      io.err(`space: unknown command: ${nounName}`);
      return EXIT.usage;
    }
    for (const l of noun ? nounHelp(noun) : help()) io.out(l);
    return EXIT.ok;
  }
  const noun = NOUNS.find((n) => n.name === first);
  if (!noun) {
    io.err(`space: unknown command: ${first} (space help lists them)`);
    return EXIT.usage;
  }
  let verbName = words[1];
  let args = words.slice(2);
  // A noun alone prints its help, unless its default verb takes no argument at all (`space status`, `space init`).
  const bare = noun.defaultVerb ? noun.verbs[noun.defaultVerb] : undefined;
  if (verbName === "help" || (verbName === undefined && bare?.usage !== "")) {
    for (const l of nounHelp(noun)) io.out(l);
    return EXIT.ok;
  }
  if (verbName === undefined || (!noun.verbs[verbName] && noun.defaultVerb)) {
    args = verbName === undefined ? [] : words.slice(1);
    verbName = noun.defaultVerb!;
  }
  const verb = noun.verbs[verbName];
  if (!verb) {
    io.err(`space: unknown verb: ${noun.name} ${verbName} (space ${noun.name} help lists them)`);
    return EXIT.usage;
  }
  try {
    return await verb.run(ctx, args);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`space: ${e.message}`);
      io.err(`usage: space ${noun.name} ${verbName} ${verb.usage}`.trim());
      return EXIT.usage;
    }
    if (e instanceof Unreachable) {
      io.err(`space: ${e.message}`);
      return EXIT.unreachable;
    }
    if (e instanceof ApiError) {
      io.err(`space: ${noun.name} ${verbName}: ${e.message}`);
      return EXIT.failed;
    }
    io.err(`space: ${noun.name} ${verbName}: ${(e as Error).message ?? String(e)}`);
    return EXIT.failed;
  }
}

/** `backup x` → `backup run x`; a word that is already a noun is left alone. */
export function expandAlias(words: string[]): string[] {
  const first = words[0];
  if (!first) return words;
  const alias = ALIASES[first];
  if (!alias || NOUNS.some((n) => n.name === first && n.verbs[words[1] ?? ""])) return words;
  return [...alias, ...words.slice(1)];
}

const GLOBAL_WORDS = new Set(["--json", "--quiet", "-q", "--help", "-h"]);
const GLOBAL_VALUES = new Set(["--url", "--token"]);

function splitGlobal(argv: string[]): { global: string[]; rest: string[] } {
  const global: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    if (GLOBAL_WORDS.has(a)) global.push(a);
    else if (GLOBAL_VALUES.has(a)) global.push(a, argv[++i] ?? "");
    else if ([...GLOBAL_VALUES].some((g) => a.startsWith(`${g}=`))) global.push(a);
    else rest.push(a);
  }
  return { global, rest };
}

export function help(): string[] {
  const width = Math.max(...NOUNS.map((n) => n.name.length));
  return [
    "usage: space <command> [<verb>] [args] [--json] [--url <api url>] [--token <token>] [-q]",
    "",
    ...NOUNS.map((n) => `  ${n.name.padEnd(width)}  ${n.summary}`),
    "",
    "space <command> help lists its verbs; docs/cli.md is the design.",
  ];
}

export function nounHelp(noun: Noun): string[] {
  const entries = Object.entries(noun.verbs);
  if (entries.length === 1 && noun.defaultVerb) {
    const [name, v] = entries[0]!;
    return [`usage: space ${noun.name} ${v.usage}`.trim(), "", `  ${v.summary}`].concat(name === noun.defaultVerb ? [] : []);
  }
  // Long usages get their summary on the next line so the table stays readable.
  const MAX = 56;
  const width = Math.min(MAX, Math.max(...entries.map(([name, v]) => `${name} ${v.usage}`.trim().length)));
  const lines = entries.flatMap(([name, v]) => {
    const left = `${name} ${v.usage}`.trim();
    return left.length > MAX ? [`  ${left}`, `  ${"".padEnd(width)}  ${v.summary}`] : [`  ${left.padEnd(width)}  ${v.summary}`];
  });
  return [`usage: space ${noun.name} <verb> [args]`, "", `  ${noun.summary}`, "", ...lines];
}

function realIo(): Io {
  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    write: (chunk) => process.stdout.write(chunk),
    fetch: globalThis.fetch,
    env: process.env,
    stdin: () => Bun.stdin.text(),
    isTTY: Boolean(process.stdin.isTTY),
    prompt: async (question) => {
      process.stdout.write(question);
      for await (const line of console) return line;
      return "";
    },
    cwd: process.cwd(),
  };
}
