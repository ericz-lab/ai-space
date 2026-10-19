import { afterEach, describe, expect, test } from "bun:test";
import { createClaudeCode } from "./claude-code.ts";
import { claudeLiveArgs } from "./claude-live.ts";
import { createCodexCli } from "./codex-cli.ts";
import { codexLivePolicy } from "./codex-live.ts";
import { fakeLiveBin } from "./testing-live.ts";
import type { ChatHandle, ChatTurn, RuntimeAdapter } from "./types.ts";

type Seen = { events: Record<string, unknown>[]; sid?: string; error?: string | null; done: Promise<void> };

/** One interactive turn: every event, the session it reported, how it ended; `onEvent` may act on the handle. */
function turn(rt: RuntimeAdapter, t: Partial<ChatTurn>, onEvent?: (ev: Record<string, unknown>, h: ChatHandle) => void): Seen & { handle: ChatHandle } {
  let finish!: () => void;
  const seen: Seen = { events: [], done: new Promise((r) => (finish = r)) };
  let handle!: ChatHandle;
  handle = rt.chat({ message: "hi", cwd: process.cwd(), env: process.env, interactive: true, ...t }, {
    onEvent: (line) => {
      const ev = JSON.parse(line);
      seen.events.push(ev);
      queueMicrotask(() => onEvent?.(ev, handle));
    },
    onSession: (sid) => (seen.sid = sid),
    onFinish: (error) => {
      seen.error = error;
      finish();
    },
  });
  return Object.assign(seen, { handle });
}

const texts = (s: Seen) => s.events.flatMap((e) => (e.type === "assistant" ? ((e.message as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === "text").map((c) => c.text)) : []));
const ofType = (s: Seen, type: string) => s.events.filter((e) => e.type === type);
const pidOf = (s: Seen) => /\[pid (\d+)\]/.exec(texts(s).join(" "))?.[1];

const runtimes = {
  claude: () => createClaudeCode({ name: "claude", kind: "claude-code", bin: fakeLiveBin("claude"), chatArgs: [] }),
  codex: () => createCodexCli({ name: "codex", kind: "codex-cli", bin: fakeLiveBin("codex") }),
};

let open: RuntimeAdapter[] = [];
afterEach(() => {
  for (const rt of open) rt.closeLive?.();
  open = [];
});
const make = (which: keyof typeof runtimes) => {
  const rt = runtimes[which]();
  open.push(rt);
  return rt;
};

for (const which of ["claude", "codex"] as const) {
  describe(`${which} live chat`, () => {
    test("an approval waits for the person's answer; allow runs it, deny refuses it", async () => {
      const rt = make(which);
      const allowed = turn(rt, { message: "approve:rm a.txt" }, (ev, h) => {
        if (ev.type === "approval_request") expect(h.respond!(String(ev.id), "allow")).toBe(true);
      });
      await allowed.done;
      expect(allowed.error).toBeNull();
      const [request] = ofType(allowed, "approval_request");
      expect(request).toMatchObject({ tool: "Bash", title: "rm a.txt", detail: "Run it" });
      expect(ofType(allowed, "approval_resolved")).toEqual([{ type: "approval_resolved", id: request!.id, decision: "allow" }]);
      expect(texts(allowed).at(-1)).toBe(which === "claude" ? "done allow" : "done accept");

      const denied = turn(rt, { message: "approve:rm b.txt", sessionId: allowed.sid }, (ev, h) => {
        if (ev.type === "approval_request") {
          h.respond!(String(ev.id), "deny");
          expect(h.respond!(String(ev.id), "allow")).toBe(false); // answered once only
        }
      });
      await denied.done;
      expect(texts(denied).at(-1)).toBe(which === "claude" ? "done deny" : "done decline");
    });

    test("a message added while the turn runs reaches the same turn", async () => {
      const rt = make(which);
      let steered: Promise<void> | undefined;
      const t = turn(rt, { message: "wait" }, (ev, h) => {
        if (ev.type === "assistant" && !steered) steered = h.steer!({ message: "also this" });
      });
      await t.done;
      await steered;
      expect(t.error).toBeNull();
      expect(ofType(t, "steer")).toEqual([{ type: "steer", text: "also this" }]);
      expect(texts(t).at(-1)).toBe("heard: also this");
      // The turn's own message is not reported as a steer, and a finished turn takes no more.
      await expect(t.handle.steer!({ message: "late" })).rejects.toThrow();
    });

    test("the next turn of the conversation reuses the process, with its own model and tier", async () => {
      const rt = make(which);
      const first = turn(rt, { message: "one", model: "m1" });
      await first.done;
      const second = turn(rt, { message: "two", model: "m2", permissionMode: "bypassPermissions", sessionId: first.sid });
      await second.done;
      expect(second.sid).toBe(first.sid!);
      expect(pidOf(second)).toBe(pidOf(first)!);
      const said = texts(second).join(" ");
      if (which === "claude") expect(said).toContain("[model m2] [mode bypassPermissions]");
      else expect(said).toContain("[model m2] [approval never] [sandbox dangerFullAccess]");
      // A new conversation gets a process of its own.
      const other = turn(rt, { message: "three" });
      await other.done;
      expect(pidOf(other)).not.toBe(pidOf(first)!);
    });

    test("a different agent identity never reuses the conversation's process", async () => {
      const rt = make(which);
      const first = turn(rt, { message: "one", systemPrompt: "agent A" });
      await first.done;
      const second = turn(rt, { message: "two", systemPrompt: "agent B", sessionId: first.sid });
      await second.done;
      expect(pidOf(second)).not.toBe(pidOf(first)!);
    });

    test("stop interrupts the turn, cancels its open approval, and keeps the process", async () => {
      const rt = make(which);
      const t = turn(rt, { message: "approve:rm a.txt" }, (ev, h) => {
        if (ev.type === "approval_request") h.kill();
      });
      await t.done;
      expect(t.error).toBe("stopped");
      expect(ofType(t, "approval_resolved")).toMatchObject([{ decision: "deny" }]);
      const waiting = turn(rt, { message: "wait", sessionId: t.sid }, (ev, h) => {
        if (ev.type === "assistant") h.kill();
      });
      await waiting.done;
      expect(waiting.error).toBe("stopped");
      const after = turn(rt, { message: "again", sessionId: t.sid });
      await after.done;
      expect(after.error).toBeNull();
    });
  });
}

test("Claude Code live arguments: approvals over stdio, the tier as permission mode, no question tool", () => {
  const args = claudeLiveArgs({ message: "x", cwd: "/", model: "opus", sessionId: "s1", systemPrompt: "be brief", allowedTools: ["Read"] }, ["--extra"]);
  expect(args).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--permission-prompt-tool", "stdio", "--replay-user-messages"]));
  expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "default"]);
  expect(args).toContain("--resume");
  expect(args.slice(-3)).toEqual(["--disallowedTools", "AskUserQuestion", "--extra"]);
  expect(claudeLiveArgs({ message: "x", cwd: "/", permissionMode: "acceptEdits" })).toContain("acceptEdits");
});

test("Codex live policy: the default asks in a read-only sandbox; all permissions never asks", () => {
  expect(codexLivePolicy(undefined)).toMatchObject({ approvalPolicy: "on-request", sandbox: { mode: "read-only" } });
  expect(codexLivePolicy("acceptEdits")).toMatchObject({ approvalPolicy: "on-request", sandbox: { mode: "workspace-write" } });
  expect(codexLivePolicy("bypassPermissions")).toMatchObject({ approvalPolicy: "never", sandbox: { mode: "danger-full-access" } });
  expect(codexLivePolicy("plan")).toMatchObject({ approvalPolicy: "never", sandbox: { mode: "read-only" } });
});

test("a turn that is not interactive keeps the one-shot path", () => {
  const rt = make("claude");
  let finished: string | null | undefined;
  const h = rt.chat({ message: "hi", cwd: process.cwd() }, { onEvent: () => {}, onFinish: (e) => (finished = e) });
  expect(h.steer).toBeUndefined();
  h.kill();
  expect(finished).toBeUndefined();
});
