import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore } from "./store.ts";

let dir: string;
let store: ChatStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-chat-store-"));
  store = new ChatStore(join(dir, "space.db"));
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

describe("threads and messages", () => {
  test("threads list per app and scope, newest updated first; another app sees nothing", () => {
    const a = store.createThread("notes", "note:1", "", 100);
    const b = store.createThread("notes", "note:1", "second", 200);
    store.createThread("notes", "note:2", "", 300);
    expect(store.listThreads("notes", "note:1").map((t) => t.id)).toEqual([b.id, a.id]);
    store.touchThread(a.id, 400, "first");
    expect(store.listThreads("notes", "note:1").map((t) => [t.id, t.title])).toEqual([[a.id, "first"], [b.id, "second"]]);
    expect(store.getThread("other", a.id)).toBeUndefined();
    expect(store.listThreads("other", "note:1")).toEqual([]);
    expect(store.findThread("notes", "note:1", 200)?.id).toBe(b.id);
  });

  test("messages keep their order, error and call id", () => {
    const t = store.createThread("notes", "s");
    const u = store.addMessage(t.id, { role: "user", content: "q" });
    const a = store.addMessage(t.id, { role: "assistant", content: "partial", error: "timed out", callId: 7 });
    expect(store.listMessages(t.id)).toEqual([u, a]);
    expect(a).toMatchObject({ error: "timed out", callId: 7 });
    expect(u.error).toBeUndefined();
    expect(store.countMessages(t.id)).toBe(2);
  });

  test("deleting a thread or a scope returns the attachment paths and removes everything", () => {
    const t = store.createThread("notes", "note:1");
    const other = store.createThread("notes", "note:1");
    store.addMessage(t.id, { role: "user", content: "q" });
    const a = store.addAttachment({ app: "notes", threadId: t.id, name: "p.png", type: "image/png", size: 3 });
    store.setAttachmentPath(a.id, "/tmp/p.png");
    expect(store.deleteThread("other", t.id)).toBeUndefined();
    expect(store.deleteThread("notes", t.id)).toEqual(["/tmp/p.png"]);
    expect(store.getThread("notes", t.id)).toBeUndefined();
    expect(store.listMessages(t.id)).toEqual([]);
    expect(store.getAttachment("notes", a.id)).toBeUndefined();
    expect(store.deleteScope("notes", "note:1")).toEqual([]);
    expect(store.getThread("notes", other.id)).toBeUndefined();
  });
});

describe("attachments", () => {
  test("bind only unsent attachments of the same thread, all or nothing", () => {
    const t = store.createThread("notes", "s");
    const t2 = store.createThread("notes", "s");
    const a = store.addAttachment({ app: "notes", threadId: t.id, name: "a", type: "image/png", size: 1 });
    const b = store.addAttachment({ app: "notes", threadId: t2.id, name: "b", type: "image/png", size: 1 });
    const m = store.addMessage(t.id, { role: "user", content: "q" });
    expect(store.bindAttachments([a.id, b.id], t.id, m.id)).toBe(false);
    expect(store.getAttachment("notes", a.id)?.messageId).toBeUndefined();
    expect(store.bindAttachments([a.id], t.id, m.id)).toBe(true);
    expect(store.getAttachment("notes", a.id)?.messageId).toBe(m.id);
    expect(store.bindAttachments([a.id], t.id, m.id)).toBe(false);
    expect(store.countAttachments(t.id)).toBe(1);
  });

  test("orphans older than the cut are pruned and their paths returned", () => {
    const t = store.createThread("notes", "s");
    const old = store.addAttachment({ app: "notes", threadId: t.id, name: "o", type: "image/png", size: 1 }, 1000);
    store.setAttachmentPath(old.id, "/tmp/o.png");
    const fresh = store.addAttachment({ app: "notes", threadId: t.id, name: "f", type: "image/png", size: 1 }, 5000);
    const m = store.addMessage(t.id, { role: "user", content: "q" });
    const sent = store.addAttachment({ app: "notes", threadId: t.id, name: "s", type: "image/png", size: 1 }, 1000);
    store.bindAttachments([sent.id], t.id, m.id);
    expect(store.pruneOrphans(3000)).toEqual(["/tmp/o.png"]);
    expect(store.listAttachments(t.id).map((a) => a.id)).toEqual([fresh.id, sent.id]);
  });
});
