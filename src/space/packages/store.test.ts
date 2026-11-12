import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PackageStore } from "./store.ts";

const uuid = () => crypto.randomUUID();

test("installed and installing read only those rows, by app or all", () => {
  const store = new PackageStore(new Database(":memory:"));
  const a = uuid(), b = uuid(), c = uuid();
  store.reserve(a, "alpha", "1.0.0", "d1"); store.finish(a, "installed");
  store.reserve(b, "beta", "1.0.0", "d2"); store.finish(b, "failed", "broken");
  store.reserve(c, "gamma", "1.0.0", "d3");
  expect(store.installed().map((o) => o.id)).toEqual([a]);
  expect(store.installed("alpha")?.id).toBe(a);
  expect(store.installed("beta")).toBeUndefined();
  expect(store.installing().map((o) => o.id)).toEqual([c]);
});

test("finished operations are pruned beyond the bound; live, retained and receipted rows stay", () => {
  const db = new Database(":memory:");
  const store = new PackageStore(db);
  const live = uuid();
  store.reserve(live, "keep", "1.0.0", "k"); store.finish(live, "installed");
  const retired = { ...store.get(live)!, id: uuid(), state: "retired" as const };
  store.retain(retired);
  const failed: string[] = [];
  for (let i = 0; i < 6; i++) {
    const id = uuid();
    store.reserve(id, `app${i}`, "1.0.0", `d${i}`);
    failed.push(id);
    store.finish(id, "failed", "broken");
    db.query("UPDATE package_operations SET updated_at=? WHERE id=?").run(i + 1, id); // Distinct ages within one millisecond.
  }
  // A change receipt names the oldest failed one, so it stays whatever its age.
  db.query("INSERT INTO package_changes(id,app,kind,old_id,new_id,state,created_at,updated_at) VALUES(?,?,?,?,?,'failed',0,0)").run(uuid(), "app0", "upgrade", live, failed[0]!);
  expect(store.prune(2)).toBe(3);
  const left = new Set(store.list().map((o) => o.id));
  expect(left).toEqual(new Set([live, retired.id, failed[0]!, failed[4]!, failed[5]!]));
  // The default bound applies on every failure and removal.
  expect(store.prune()).toBe(0);
});
