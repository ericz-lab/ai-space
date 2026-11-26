import { expect, test } from "bun:test";
import type { WidgetView } from "../panel/widgets.ts";
import type { PeerSnapshot } from "./client.ts";
import { mergeWidgets } from "./merge.ts";

test("a peer's widget loses its actions, in blocks and in views; views and copy pass", () => {
  const w = {
    id: "todo/list", app: "todo", name: "list", title: "Todo", icon: "/api/apps/todo/icon", link: "", kind: "items", size: "1x1", refreshMs: 60_000,
    ok: true, items: [],
    blocks: [{ type: "status", label: "Milk", value: "today", copy: "milk", action: { id: "done:1", kind: "check", label: "Done" } }],
    views: [
      { id: "today", label: "Today", blocks: [{ type: "metric", label: "Open", value: 2, action: { id: "run", kind: "button", label: "Run" } }] },
      { id: "all", label: "All", blocks: [{ type: "metric", label: "All", value: 5, copy: "5" }] },
    ],
    actions: [{ id: "add", kind: "input", label: "Add" }],
  } as unknown as WidgetView;
  const failed = { ...w, ok: false, error: "down" } as unknown as WidgetView;
  const snap = { widgets: [w, failed] } as unknown as PeerSnapshot;
  const [out, err] = mergeWidgets("david", snap, new Set(), false);
  expect(out).toMatchObject({ id: "david/todo/list", peer: "david", icon: "/api/peers/david/apps/todo/icon" });
  if (!out?.ok) throw new Error("not ok");
  expect(out).not.toHaveProperty("actions");
  expect(out.blocks).toEqual([{ type: "status", label: "Milk", value: "today", copy: "milk" }]);
  expect(out.views).toEqual([
    { id: "today", label: "Today", blocks: [{ type: "metric", label: "Open", value: 2 }] },
    { id: "all", label: "All", blocks: [{ type: "metric", label: "All", value: 5, copy: "5" }] },
  ]);
  expect(err).toMatchObject({ ok: false, error: "down" });
  // The snapshot itself is not changed.
  expect((w as { actions?: unknown }).actions).toBeDefined();
});
