import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox } from "./inbox.ts";
import { NotifyStore } from "./store.ts";
import type { Level } from "./types.ts";

let dir: string;
let store: NotifyStore;
let inbox: Inbox;
let seq = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "space-inbox-"));
  store = new NotifyStore(join(dir, "space.db"));
  inbox = new Inbox(store.db);
  seq = 0;
});

afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const add = (app: string, at: number, opts: { level?: Level; key?: string; title?: string; text?: string; url?: string } = {}) => {
  const id = `n_${String(++seq).padStart(4, "0")}`;
  store.addNotification({ id, app, level: opts.level ?? "info", title: opts.title, text: opts.text ?? `text ${seq}`, url: opts.url, key: opts.key, createdAt: at }, [
    { name: "default", status: "skipped" },
  ]);
  return id;
};

describe("Inbox", () => {
  test("notifications with the same app and key are one thread; the latest is shown with a count", () => {
    add("thesis", 1000, { level: "alert", key: "task:1:error", title: "task distill failed" });
    add("thesis", 2000, { level: "alert", key: "task:1:error", title: "task distill still failing (2 in a row)" });
    add("pulse", 1500, { level: "alert", key: "task:1:error", title: "pulse failed" });
    const plain = add("news", 3000, { text: "digest ready", url: "https://news.example/d/1" });
    add("news", 3500, { text: "another digest" });

    const items = inbox.list();
    expect(items.map((i) => [i.thread, i.count])).toEqual([
      ["n_0005", 1],
      [plain, 1],
      ["k:thesis:task:1:error", 2],
      ["k:pulse:task:1:error", 1],
    ]);
    const thesis = items.find((i) => i.app === "thesis")!;
    expect(thesis).toMatchObject({ title: "task distill still failing (2 in a row)", firstAt: 1000, lastAt: 2000, action: true, unread: true, done: false, notificationId: "n_0002" });
    expect(items.find((i) => i.thread === plain)).toMatchObject({ url: "https://news.example/d/1", action: false });
    expect(inbox.summary()).toEqual({ unread: 4, open: 2 });
  });

  test("read and done hold until a newer notification arrives in the thread", () => {
    add("thesis", 1000, { level: "alert", key: "k1" });
    const info = add("news", 1100);
    expect(inbox.mark(["k:thesis:k1"], { done: true }, 2000)).toBe(1);
    expect(inbox.mark([info, "n_unknown"], { read: true }, 2000)).toBe(1);
    expect(inbox.summary()).toEqual({ unread: 0, open: 0 });
    expect(inbox.list({ filter: "done" }).map((i) => i.thread)).toEqual(["k:thesis:k1"]);

    add("thesis", 3000, { level: "alert", key: "k1" });
    const reopened = inbox.list({ app: "thesis" })[0]!;
    expect(reopened).toMatchObject({ count: 2, unread: true, done: false });
    expect(inbox.summary()).toEqual({ unread: 1, open: 1 });

    inbox.mark(["k:thesis:k1"], { read: true }, 4000);
    expect(inbox.list({ filter: "unread" })).toEqual([]);
    expect(inbox.list({ filter: "open", action: true }).map((i) => i.thread)).toEqual(["k:thesis:k1"]);
    inbox.mark(["k:thesis:k1"], { read: false }, 5000);
    expect(inbox.summary().unread).toBe(1);
  });

  test("filters by app and action; read-all marks every unread thread, optionally per app", () => {
    add("a", 1000, { level: "warn" });
    add("a", 1100, { level: "success" });
    add("b", 1200, { level: "report" });
    expect(inbox.list({ action: true }).map((i) => i.app)).toEqual(["a"]);
    expect(inbox.list({ app: "b" }).length).toBe(1);
    expect(inbox.readAll(2000, "a")).toBe(2);
    expect(inbox.summary()).toEqual({ unread: 1, open: 1 });
    expect(inbox.readAll(2000)).toBe(1);
    expect(inbox.summary().unread).toBe(0);
  });

  test("state of threads whose notifications were pruned is dropped on open", () => {
    const id = add("a", 1000);
    inbox.mark([id], { read: true }, 2000);
    store.db.exec("DELETE FROM notifications");
    new Inbox(store.db);
    expect(store.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox_state").get()!.n).toBe(0);
  });
});
