import { describe, expect, test } from "bun:test";
import { deployFromOrigin, type Runner } from "./deploy.ts";
import type { RunRegistry } from "../agents/runs.ts";
import { FIXER_ID, fixerPort, localFixer, peerFixer, sseData } from "./fixer.ts";

describe("local fixer", () => {
  test("starts through the agents' chat route and reads the run's end", async () => {
    let asked: { url: string; params: Record<string, string>; body: unknown } | undefined;
    const chat = async (req: Request & { params: Record<string, string> }) => {
      asked = { url: req.url, params: req.params, body: await req.json() };
      return new Response("data: {}\n\n", { headers: { "x-run-id": "run-7" } });
    };
    const runs = {
      subscribe: (_id: string, _after: number, l: { onEvent(e: { seq: number; line: string }): void; onEnd(r: { status: string; error: string | null }): void }) => {
        l.onEvent({ seq: 1, line: JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "RESULT: {}" }] } }) });
        setTimeout(() => l.onEnd({ status: "done", error: null }), 1);
        return () => {};
      },
      get: () => null,
    } as unknown as RunRegistry;
    const port = localFixer(chat, runs);
    expect(await port.start("", { message: "fix", effort: "max", permissionMode: "bypassPermissions" })).toBe("run-7");
    expect(asked).toMatchObject({ url: "http://space.local/api/agents/space/ui-fixer/chat", params: { app: "space", agent: "ui-fixer" }, body: { message: "fix", effort: "max" } });
    expect(await port.wait("", "run-7")).toEqual({ status: "done", error: null, text: "RESULT: {}" });
    const gone = localFixer(chat, { subscribe: () => null, get: () => null } as unknown as RunRegistry);
    expect(await gone.wait("", "x")).toMatchObject({ status: "error", error: "the run is gone" });
    const refused = localFixer(async () => Response.json({ error: "no runtime" }, { status: 501 }), runs);
    await expect(refused.start("", { message: "x", permissionMode: "bypassPermissions" })).rejects.toThrow("no runtime");
  });
});

describe("peer fixer", () => {
  const ev = (o: unknown) => `id: 1\ndata: ${JSON.stringify(o)}\n\n`;

  test("the SSE replay's data lines, without the stream's own end marker", () => {
    expect(sseData(`: keepalive\n\n${ev({ type: "assistant" })}data: {"type":"done"}\n\n`)).toEqual(['{"type":"assistant"}']);
  });

  test("starts on the peer, polls until the run ends, reads the answer", async () => {
    const seen: string[] = [];
    let polls = 0;
    const request = async (path: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/chat")) {
        expect(JSON.parse(String(init!.body))).toMatchObject({ message: "fix it", effort: "xhigh" });
        return new Response("data: {}\n\n", { headers: { "x-run-id": "r-9" } });
      }
      if (path.endsWith("/events?after=0")) return new Response(`${ev({ type: "result", result: 'ok\nRESULT: {"status":"fixed"}' })}data: {"type":"done"}\n\n`);
      polls++;
      if (polls === 1) throw new Error("link down");
      return Response.json({ run: { status: polls < 3 ? "running" : "done", error: null } });
    };
    const port = peerFixer((m) => (m === "hub" ? request : undefined), { pollMs: 0, sleep: async () => {} });
    const id = await port.start("hub", { message: "fix it", effort: "xhigh", permissionMode: "bypassPermissions" });
    expect(id).toBe("r-9");
    expect(await port.wait("hub", id)).toEqual({ status: "done", error: null, text: 'ok\nRESULT: {"status":"fixed"}' });
    expect(seen[0]).toBe(`POST /api/peer/agents/${FIXER_ID.app}/${FIXER_ID.agent}/chat`);
    await expect(port.start("elsewhere", { message: "x", permissionMode: "bypassPermissions" })).rejects.toThrow("not a peer");
  });

  test("an older peer without the engineer, a refused turn, a run that is gone", async () => {
    const older = peerFixer(() => async () => new Response("no", { status: 404 }), { sleep: async () => {} });
    await expect(older.start("hub", { message: "x", permissionMode: "bypassPermissions" })).rejects.toThrow("has no Fix Engineer yet");
    const refused = peerFixer(() => async () => Response.json({ error: "model unavailable" }, { status: 501 }), { sleep: async () => {} });
    await expect(refused.start("hub", { message: "x", permissionMode: "bypassPermissions" })).rejects.toThrow("model unavailable");
    expect(await older.wait("hub", "r")).toMatchObject({ status: "error", error: "the peer no longer has the run" });
    let t = 0;
    const slow = peerFixer(() => async () => Response.json({ run: { status: "running" } }), { pollMs: 0, maxMs: 5, sleep: async () => { t++; await Bun.sleep(2); } });
    expect((await slow.wait("hub", "r")).status).toBe("timeout");
    expect(t).toBeGreaterThan(0);
  });

  test("one port: this machine or a peer", async () => {
    const calls: string[] = [];
    const side = (name: string) => ({ start: async (m: string) => { calls.push(`${name}:${m}`); return name; }, wait: async () => ({ status: "done", error: null, text: name }) });
    const port = fixerPort(side("local"), side("remote"));
    expect(await port.start("", { message: "", permissionMode: "" })).toBe("local");
    expect(await port.start("hub", { message: "", permissionMode: "" })).toBe("remote");
    expect((await port.wait("hub", "x")).text).toBe("remote");
  });
});

describe("deploy from origin", () => {
  /** git as a script: each command's answer by its first words. */
  const fake = (answers: Record<string, { code: number; out: string }>) => {
    const ran: string[] = [];
    const run: Runner = async (args, opts) => {
      ran.push(args.join(" "));
      expect(opts.cwd).toBe("/w/app-src/ai-todo");
      const key = Object.keys(answers).find((k) => args.join(" ").startsWith(k));
      return key ? answers[key]! : { code: 0, out: "" };
    };
    return { run, ran };
  };

  test("fast-forwards from origin, then pushes to the deploy remote", async () => {
    const { run, ran } = fake({ "rev-parse --abbrev-ref": { code: 0, out: "main" } });
    const r = await deployFromOrigin("/w", "ai-todo", run);
    expect(r.ok).toBe(true);
    expect(ran).toEqual(["rev-parse --show-toplevel", "rev-parse --abbrev-ref HEAD", "status --porcelain", "remote get-url deploy", "pull --ff-only origin main", "push deploy HEAD:main"]);
  });

  test("stops on anything unexpected and says why", async () => {
    const cases: [Record<string, { code: number; out: string }>, string][] = [
      [{ "rev-parse --show-toplevel": { code: 128, out: "not a git repository" } }, "no source checkout"],
      [{ "rev-parse --abbrev-ref": { code: 0, out: "fix-branch" } }, "is on fix-branch"],
      [{ "rev-parse --abbrev-ref": { code: 0, out: "main" }, status: { code: 0, out: " M web/index.html" } }, "has local changes"],
      [{ "rev-parse --abbrev-ref": { code: 0, out: "main" }, remote: { code: 2, out: "" } }, "no deploy remote"],
      [{ "rev-parse --abbrev-ref": { code: 0, out: "main" }, pull: { code: 1, out: "not possible to fast-forward" } }, "does not fast-forward"],
      [{ "rev-parse --abbrev-ref": { code: 0, out: "main" }, push: { code: 1, out: "check failed" } }, "deploy push failed"],
    ];
    for (const [answers, why] of cases) {
      const r = await deployFromOrigin("/w", "ai-todo", fake(answers).run);
      expect(r.ok).toBe(false);
      expect(r.log.split("\n")[0]).toContain(why);
    }
  });
});
