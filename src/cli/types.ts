import type { Config } from "../space/config.ts";
import type { Workspace } from "../space/workspace.ts";
import type { Client } from "./client.ts";
import type { Printer } from "./output.ts";

/**
 * What every command sees. `docs/cli.md` is the design; `main.ts` builds one
 * `Ctx` per invocation and the nouns (`app.ts`, `task.ts`, …) use it.
 */

/** Exit codes: done, the operation failed, usage, ai-space not reachable. */
export const EXIT = { ok: 0, failed: 1, usage: 2, unreachable: 3 } as const;

/** Where the command's text goes and what it may read. Tests pass a scripted one. */
export type Io = {
  /** One line on stdout. */
  out: (line: string) => void;
  /** One line on stderr. */
  err: (line: string) => void;
  /** Raw stdout, for streams (no newline added). */
  write: (chunk: string) => void;
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  /** All of stdin, once. */
  stdin: () => Promise<string>;
  /** True when stdin is a terminal (a question can be asked; a body is not piped). */
  isTTY: boolean;
  /** Ask one question on the terminal; the answer without its newline. */
  prompt: (question: string) => Promise<string>;
  /** The current directory (`app new` puts the app under it). */
  cwd: string;
};

export type GlobalFlags = {
  json: boolean;
  quiet: boolean;
  url?: string;
  token?: string;
};

export type Ctx = {
  io: Io;
  flags: GlobalFlags;
  print: Printer;
  /** The running ai-space: resolved once, from the flags, the environment, then the workspace `.env`. */
  client: () => Promise<Client>;
  /** The workspace on this machine, for the commands that work without a running ai-space. */
  workspace: () => Promise<{ ws: Workspace; config: Config }>;
  /** `space start`: the entry point's boot, injected so the CLI never imports it. */
  boot?: (ws: Workspace, config: Config) => Promise<unknown>;
};

export type Verb = {
  /** The arguments after the verb, for the help line: `APP [--all]`. */
  usage: string;
  summary: string;
  run: (ctx: Ctx, argv: string[]) => Promise<number>;
};

export type Noun = {
  name: string;
  summary: string;
  verbs: Record<string, Verb>;
  /** The verb used when none is typed (`space logs x`). */
  defaultVerb?: string;
};

/** The command line was wrong: exit 2, with the message and the usage. */
export class UsageError extends Error {}

/** ai-space answered, and said no. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/** ai-space did not answer at all. */
export class Unreachable extends Error {
  constructor(
    readonly url: string,
    cause: string,
  ) {
    super(`ai-space not reachable at ${url}: ${cause}`);
  }
}
