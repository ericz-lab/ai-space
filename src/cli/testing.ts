import { scriptedFetch } from "../space/notify/testing.ts";
import { run } from "./main.ts";
import type { Io } from "./types.ts";

/**
 * Test helper: run the CLI against a scripted `fetch`, collecting stdout and
 * stderr lines. `env` defaults to a bare environment with a workspace that
 * has no `.env`, so the URL and token come from what the test sets.
 */

export type TestRun = { code: number; out: string[]; err: string[]; calls: ReturnType<typeof scriptedFetch>["calls"] };

export function testIo(overrides: Partial<Io> = {}): { io: Io; out: string[]; err: string[]; scripted: ReturnType<typeof scriptedFetch> } {
  const out: string[] = [];
  const err: string[] = [];
  const scripted = scriptedFetch();
  let partial = "";
  const io: Io = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    write: (chunk) => {
      partial += chunk;
      let i: number;
      while ((i = partial.indexOf("\n")) >= 0) {
        out.push(partial.slice(0, i));
        partial = partial.slice(i + 1);
      }
    },
    fetch: scripted.fetch as unknown as typeof fetch,
    env: { SPACE_HOME: "/nonexistent/space-cli-test", SPACE_API_TOKEN: "op-token" },
    stdin: async () => "",
    isTTY: false,
    prompt: async () => "n",
    cwd: "/tmp",
    ...overrides,
  };
  return { io, out, err, scripted };
}

export async function runCli(argv: string[], setup: (t: ReturnType<typeof testIo>) => void = () => {}, overrides: Partial<Io> = {}): Promise<TestRun> {
  const t = testIo(overrides);
  setup(t);
  const code = await run(argv, { io: t.io });
  return { code, out: t.out, err: t.err, calls: t.scripted.calls };
}
