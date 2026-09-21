import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importThreads, parseImportLine } from "./import.ts";
import { ChatStore } from "./store.ts";

let dir: string;
let store: ChatStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-chat-import-"));
  store = new ChatStore(join(dir, "space.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const line = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    scope: "note:12", title: "总结一下", createdAt: "2026-09-12T10:00:00.000Z", updatedAt: "2026-09-12T10:05:00.000Z",
    messages: [
      { role: "user", content: "总结一下", createdAt: "2026-09-12T10:00:00.000Z" },
      { role: "assistant", content: "要点：…", createdAt: "2026-09-12T10:00:30.000Z" },
      { role: "user", content: "再来", createdAt: "2026-09-12T10:04:00.000Z" },
      { role: "assistant", content: "", error: "timed out", createdAt: "2026-09-12T10:05:00.000Z" },
    ],
    ...over,
  });

describe("chat-import", () => {
  test("threads and messages round-trip; a second run skips what is present", () => {
    const text = [line(), line({ scope: "note:13", createdAt: "2026-09-13T00:00:00Z", messages: [] })].join("\n") + "\n";
    expect(importThreads(store, "notes", text)).toEqual({ read: 2, imported: 2, skipped: 0, messages: 4 });
    const [t] = store.listThreads("notes", "note:12");
    expect(t).toMatchObject({ title: "总结一下", createdAt: Date.parse("2026-09-12T10:00:00Z"), updatedAt: Date.parse("2026-09-12T10:05:00Z") });
    const msgs = store.listMessages(t!.id);
    expect(msgs.map((m) => [m.role, m.content, m.error])).toEqual([["user", "总结一下", undefined], ["assistant", "要点：…", undefined], ["user", "再来", undefined], ["assistant", "", "timed out"]]);
    expect(msgs[1]!.createdAt).toBe(Date.parse("2026-09-12T10:00:30Z"));
    expect(importThreads(store, "notes", text)).toEqual({ read: 2, imported: 0, skipped: 2, messages: 0 });
  });

  test("a bad line names itself and nothing is written", () => {
    expect(() => importThreads(store, "notes", line() + "\n{not json")).toThrow("line 2: not JSON");
    expect(() => parseImportLine({ scope: "s", createdAt: "x", messages: [] }, 3)).toThrow("line 3: createdAt must be an ISO time");
    expect(() => parseImportLine({ scope: "s", createdAt: "2026-01-01T00:00:00Z", messages: [{ role: "bot" }] }, 4)).toThrow("role must be user or assistant");
    expect(store.listThreads("notes", "note:12")).toEqual([]);
  });
});
