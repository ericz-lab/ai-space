import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "./api.ts";

// The chat's phone layout (styles.css, at 640 px and below): the agent's icon shows in the avatar
// bar on the left only, never again in the head or in an empty conversation's greeting.
const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
const phoneBlocks = css
  .split("@media (max-width: 640px) {")
  .slice(1)
  .map((rest) => rest.slice(0, rest.indexOf("\n}")));
const phoneChat = phoneBlocks.find((body) => body.includes(".chat-name")) ?? "";

test("on a phone the chat's head and greeting leave the agent's icon to the avatar bar", () => {
  expect(phoneChat).toContain(".chat .chat-ava, .chat .hello-ava { display: none; }");
  // Wider screens keep the head's icon: the rule lives in the phone block only.
  expect(css.split("\n").filter((line) => line.includes("display: none") && line.includes(".chat-ava"))).toHaveLength(1);
  expect(css).toMatch(/^\.chat-ava \{[^}]*display: inline-flex/m);
});

test("a phone shows the avatar bar with one conversation, the agent's icon in it", async () => {
  const { default: Chat } = await import("./Chat.tsx");
  const agent = (id: string, title: string, avatar: string): AgentInfo => {
    const [app, name] = id.split("/") as [string, string];
    return { id, app, name, title, avatar, appIcon: "📦", runtime: "claude" };
  };
  const assistant = agent("space/assistant", "Space Assistant", "/assistant.png");
  const librarian = agent("notes/librarian", "Librarian", "📚");
  // A new session, the only conversation open, as when the chat is opened on one agent. The chat
  // reads its saved choices while it renders.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => {} } });
  let html: string;
  try {
    html = renderToStaticMarkup(createElement(Chat, { open: true, agent: assistant, agents: [assistant, librarian], onClose: () => {} }));
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
  const bar = html.slice(html.indexOf('<div class="chat-tabs">'), html.indexOf('<nav class="chat-side"'));
  expect(bar).toStartWith('<div class="chat-tabs">');
  expect(bar.match(/class="chat-tab /g)).toHaveLength(1);
  expect(bar).toContain('class="chat-tab on" title="Space Assistant" aria-current="true"><img src="/assistant.png" alt=""/>');
  // The bar shows on a phone only; wider screens keep the sidebar and never show the bar.
  expect(css).toContain(".chat-tabs, .chat-narrow { display: none !important; }");
  expect(phoneBlocks.find((body) => body.includes(".chat-side { display: none; }"))).toContain(".chat-tabs { display: flex !important; }");
});
