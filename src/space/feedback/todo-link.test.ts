import { expect, test } from "bun:test";
import { todoSinkFor } from "./todo.ts";

const bus = { call: async () => ({ status: 200, body: new ArrayBuffer(0) }) };
const peer = (name: string, url: string) => ({ name, client: { provides: () => true, request: async () => new Response("{}"), snapshot: { apps: [{ name: "ai-todo", url }] } } });

test("a task on a peer links to this space's ai-todo on that machine's list, else to the peer's own page", () => {
  const peers = () => [peer("mac", "http://127.0.0.1:8970/?lang={lang}")];
  const hub = { name: "seoul", bus, local: () => ({ provides: true, url: "https://todo.example.com/?lang={lang}" }), peers };
  expect(todoSinkFor(hub, "mac")!.url(4)).toBe("https://todo.example.com/?m=mac&todo=4");
  expect(todoSinkFor(hub, "")!.url(4)).toBe("https://todo.example.com/?todo=4");
  // No ai-todo here: the peer's own page is all there is.
  expect(todoSinkFor({ ...hub, local: () => undefined }, "mac")!.url(4)).toBe("http://127.0.0.1:8970/?todo=4");
});
