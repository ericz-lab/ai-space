import { describe, expect, test } from "bun:test";
import { USAGE_SCRIPT } from "./script.ts";

/** Runs the script against a stand-in browser with a clock the test moves. */
function browser(opts: { storage?: "ok" | "throws" } = {}) {
  let now = Date.parse("2026-10-01T10:00:00.000Z");
  const posts: { via: "fetch" | "beacon"; body: string }[] = [];
  const winListeners = new Map<string, (() => void)[]>();
  const docListeners = new Map<string, (() => void)[]>();
  const timers: { fn: () => void; every: number; next: number }[] = [];
  const store = new Map<string, string>();
  const document = {
    visibilityState: "visible",
    addEventListener: (t: string, fn: () => void) => docListeners.set(t, [...(docListeners.get(t) ?? []), fn]),
  };
  const window = { addEventListener: (t: string, fn: () => void) => winListeners.set(t, [...(winListeners.get(t) ?? []), fn]) };
  const sessionStorage = {
    getItem: (k: string) => {
      if (opts.storage === "throws") throw new Error("denied");
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.storage === "throws") throw new Error("denied");
      store.set(k, v);
    },
  };
  const navigator = {
    sendBeacon: (_url: string, blob: Blob) => {
      void blob.text().then((body) => posts.push({ via: "beacon", body }));
      return true;
    },
  };
  const fetch = (_url: string, init: { body: string }) => {
    posts.push({ via: "fetch", body: init.body });
    return Promise.reject(new Error("offline"));
  };
  const setInterval = (fn: () => void, every: number) => timers.push({ fn, every, next: now + every });
  const FakeDate = { now: () => now };
  new Function("window", "document", "navigator", "sessionStorage", "fetch", "setInterval", "Date", "Blob", USAGE_SCRIPT)(window, document, navigator, sessionStorage, fetch, setInterval, FakeDate, Blob);
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const t = timers.filter((x) => x.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!t) break;
      now = t.next;
      t.next += t.every;
      t.fn();
    }
    now = end;
  };
  const fire = (target: "window" | "document", type: string) => ((target === "window" ? winListeners : docListeners).get(type) ?? []).forEach((fn) => fn());
  return { posts, advance, fire, document, store };
}

describe("heartbeat script", () => {
  test("is small", () => {
    expect(new TextEncoder().encode(USAGE_SCRIPT).length).toBeLessThan(2048);
  });

  test("beats at once, then every 30 s while used; stops after 2 minutes idle and resumes on input", () => {
    const b = browser();
    expect(b.posts).toHaveLength(1);
    const tab = JSON.parse(b.posts[0]!.body).tab;
    expect(tab).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(b.store.get("space-usage-tab")).toBe(tab);
    b.advance(60_000);
    expect(b.posts).toHaveLength(3);
    // No input since the load (0 s): the beats at 0, 30, 60 and 90 s, none from 120 s on.
    b.advance(10 * 60_000);
    const idle = b.posts.length;
    expect(idle).toBe(4);
    b.advance(5 * 60_000);
    expect(b.posts).toHaveLength(idle);
    b.fire("window", "keydown");
    expect(b.posts).toHaveLength(idle + 1);
    expect(b.posts.every((p) => JSON.parse(p.body).tab === tab)).toBe(true);
  });

  test("a hidden page sends one last beacon and nothing more", async () => {
    const b = browser();
    b.advance(25_000);
    b.fire("window", "scroll");
    b.document.visibilityState = "hidden";
    b.fire("document", "visibilitychange");
    b.fire("window", "pagehide");
    await Bun.sleep(0);
    expect(b.posts.map((p) => p.via)).toEqual(["fetch", "beacon"]);
    b.fire("window", "pointerdown");
    b.advance(5 * 60_000);
    expect(b.posts).toHaveLength(2);
  });

  test("blocked storage still gets a tab id and nothing throws", () => {
    const b = browser({ storage: "throws" });
    expect(b.posts).toHaveLength(1);
  });
});
