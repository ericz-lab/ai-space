import { expect, test } from "bun:test";
import { pollWhileVisible } from "./poll.ts";

const page = (hidden = false) => Object.assign(new EventTarget(), { hidden });
const flip = (doc: ReturnType<typeof page>, hidden: boolean) => {
  doc.hidden = hidden;
  doc.dispatchEvent(new Event("visibilitychange"));
};

test("polls while visible, pauses while hidden and refreshes on becoming visible", async () => {
  const doc = page();
  let n = 0;
  const stop = pollWhileVisible(() => n++, 10, doc as unknown as Document);
  await Bun.sleep(35);
  const visible = n;
  expect(visible).toBeGreaterThanOrEqual(2);
  flip(doc, true);
  await Bun.sleep(35);
  expect(n).toBe(visible);
  flip(doc, false);
  expect(n).toBe(visible + 1); // At once, not a period later.
  flip(doc, false); // A repeated event does not double the timer or the refresh.
  expect(n).toBe(visible + 1);
  stop();
  const stopped = n;
  await Bun.sleep(25);
  flip(doc, true);
  flip(doc, false);
  expect(n).toBe(stopped);
});

test("a page that starts hidden waits until it is shown", async () => {
  const doc = page(true);
  let n = 0;
  const stop = pollWhileVisible(() => n++, 5, doc as unknown as Document);
  await Bun.sleep(20);
  expect(n).toBe(0);
  flip(doc, false);
  expect(n).toBe(1);
  stop();
});
