import { describe, expect, test } from "bun:test";
import { PerSpace } from "./per-space.ts";

type S = { id: string };

describe("what is kept per Space", () => {
  test("a Space shown again finds what it left; another Space has its own", () => {
    const dropped: string[] = [];
    const kept = new PerSpace<S, string>((v) => dropped.push(v));
    const a = { id: "a" };
    const b = { id: "b" };
    let made = 0;
    expect(kept.get("a", a, () => `tabs-a-${++made}`)).toBe("tabs-a-1");
    expect(kept.get("b", b, () => `tabs-b-${++made}`)).toBe("tabs-b-2");
    expect(kept.get("a", a, () => `tabs-a-${++made}`)).toBe("tabs-a-1");
    expect(kept.peek("b", b)).toBe("tabs-b-2");
    expect(dropped).toEqual([]);
  });

  test("a Space replaced by a new address starts again; its old value is dropped", () => {
    const dropped: string[] = [];
    const kept = new PerSpace<S, string>((v) => dropped.push(v));
    const old = { id: "a" };
    kept.get("a", old, () => "old");
    const moved = { id: "a" };
    expect(kept.peek("a", moved)).toBeUndefined();
    expect(kept.get("a", moved, () => "new")).toBe("new");
    expect(dropped).toEqual(["old"]);
  });

  test("prune drops removed and replaced Spaces and keeps the rest", () => {
    const dropped: string[] = [];
    const kept = new PerSpace<S, string>((v) => dropped.push(v));
    const a = { id: "a" };
    const b = { id: "b" };
    const c = { id: "c" };
    kept.get("a", a, () => "A");
    kept.get("b", b, () => "B");
    kept.get("c", c, () => "C");
    const saved = new Map<string, S>([["a", a], ["c", { id: "c" }]]);
    kept.prune((id) => saved.get(id));
    expect(dropped.sort()).toEqual(["B", "C"]);
    expect(kept.size).toBe(1);
    expect(kept.peek("a", a)).toBe("A");
  });
});
