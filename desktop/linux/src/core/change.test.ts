import { expect, test } from "bun:test";
import { decodeCatalogue } from "./catalogue.ts";
import { ChangeGate, signature } from "./change.ts";

test("a signature ignores the order of keys but not of lists", () => {
  expect(signature({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(signature({ b: { d: [1, 2], c: 2 }, a: 1 }));
  expect(signature({ list: [1, 2] })).not.toBe(signature({ list: [2, 1] }));
  expect(signature({ a: 1, gone: undefined })).toBe(signature({ a: 1 }));
  expect(signature(undefined)).toBe("undefined");
  expect(signature(null)).toBe("null");
  expect(signature("x")).not.toBe(signature(["x"]));
});

test("the gate lets the first value and each different one through", () => {
  const gate = new ChangeGate();
  expect(gate.changed("inbox", { unread: 1 })).toBe(true);
  expect(gate.changed("inbox", { unread: 1 })).toBe(false);
  expect(gate.changed("other", { unread: 1 })).toBe(true);
  expect(gate.changed("inbox", { unread: 2 })).toBe(true);
  expect(gate.changed("inbox", { unread: 2 })).toBe(false);
  gate.forget("inbox");
  expect(gate.changed("inbox", { unread: 2 })).toBe(true);
  gate.keepOnly((k) => k !== "other");
  expect(gate.changed("other", { unread: 1 })).toBe(true);
  expect(gate.changed("inbox", { unread: 2 })).toBe(false);
});

test("the same catalogue fetched twice is no change; a changed widget is", () => {
  const raw = () => ({
    apps: { apps: [{ id: "notes", title: "Notes", url: "https://notes.example/" }] },
    agents: { agents: [] },
    widgets: { ok: true, asOf: new Date().toISOString(), widgets: [{ id: "notes/next", app: "notes", name: "next", title: "Next", kind: "items", items: [{ text: "Buy milk", time: "" }] }] },
  });
  const gate = new ChangeGate();
  expect(gate.changed("c", decodeCatalogue(raw()))).toBe(true);
  // The feed's own timestamp is not part of what is drawn.
  expect(gate.changed("c", decodeCatalogue(raw()))).toBe(false);
  const changed = raw();
  changed.widgets.widgets[0]!.items[0]!.text = "Buy bread";
  expect(gate.changed("c", decodeCatalogue(changed))).toBe(true);
});
