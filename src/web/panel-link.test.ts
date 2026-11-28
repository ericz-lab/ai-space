import { expect, test } from "bun:test";
import type { AgentInfo } from "./api.ts";
import { linkedAgent, MAX_DRAFT, chatHref, pageAgent, pageHref, pageSession, parsePanelLink, parsePanelPage, withDraft } from "./panel-link.ts";

const agent = (id: string, app: string, name: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({ id, app, name, title: name, avatar: "", appIcon: "", runtime: "claude", ...extra });

test("a fragment opens one of the panel's windows", () => {
  expect(parsePanelLink("#inbox")).toEqual({ open: "inbox" });
  expect(parsePanelLink("terminal")).toEqual({ open: "terminal" });
  expect(parsePanelLink("#settings")).toEqual({ open: "settings" });
  expect(parsePanelLink("#shortcuts")).toEqual({ open: "shortcuts" });
  expect(parsePanelLink("#orders")).toEqual({ open: "orders" });
});

test("an order's link opens the Orders window on that order; a bad id is left alone", () => {
  expect(parsePanelLink("#order=12")).toEqual({ open: "orders", order: 12 });
  expect(parsePanelLink("#order=0")).toBeNull();
  expect(parsePanelLink("#order=abc")).toBeNull();
  expect(parsePanelLink("#order=")).toBeNull();
});

test("any other fragment is left alone", () => {
  expect(parsePanelLink("")).toBeNull();
  expect(parsePanelLink("#")).toBeNull();
  expect(parsePanelLink("#top")).toBeNull();
  expect(parsePanelLink("#inbox=all")).toBeNull();
  expect(parsePanelLink("#text=hi&chat")).toBeNull();
});

test("a chat link names the agent and a draft, both decoded", () => {
  expect(parsePanelLink("#chat")).toEqual({ open: "chat", agent: null, text: "" });
  expect(parsePanelLink("#chat=space%2Fassistant")).toEqual({ open: "chat", agent: "space/assistant", text: "" });
  expect(parsePanelLink("#chat=notes%2Fwriter&text=%E4%BD%A0%E5%A5%BD%0Aline%202")).toEqual({ open: "chat", agent: "notes/writer", text: "你好\nline 2" });
  expect(parsePanelLink("#chat=&text=hi")).toEqual({ open: "chat", agent: null, text: "hi" });
});

test("a chat link's draft is capped", () => {
  const link = parsePanelLink(`#chat&text=${"a".repeat(MAX_DRAFT + 10)}`);
  expect(link?.open === "chat" && link.text.length).toBe(MAX_DRAFT);
});

test("a link's agent is found by id or by app and name, the local machine first", () => {
  const local = agent("notes/writer", "notes", "writer");
  const peer = agent("peer:box/notes/writer", "notes", "writer", { peer: "box" });
  const other = agent("space/assistant", "space", "assistant");
  expect(linkedAgent([peer, local, other], "notes/writer")).toBe(local);
  expect(linkedAgent([peer, local], "peer:box/notes/writer")).toBe(peer);
  expect(linkedAgent([peer, other], "notes/writer")).toBe(peer);
  expect(linkedAgent([other], "notes/writer")).toBeNull();
});

test("a draft joins what the field holds", () => {
  expect(withDraft("", "hi")).toBe("hi");
  expect(withDraft("  ", "hi")).toBe("hi");
  expect(withDraft("first", "hi")).toBe("first\n\nhi");
});

test("a page address names one built-in window, and nothing else", () => {
  for (const name of ["inbox", "terminal", "settings", "shortcuts", "store", "orders"] as const) expect(parsePanelPage(pageHref(name).slice(1))).toBe(name);
  expect(parsePanelPage("?lang=zh&page=terminal")).toBe("terminal");
  expect(parsePanelPage("")).toBeNull();
  expect(parsePanelPage("?page=tasks")).toBeNull();
  expect(parsePanelPage("?page=")).toBeNull();
});

test("a chat page names its agent", () => {
  const search = chatHref("david/notes/writer").slice(1);
  expect(parsePanelPage(search)).toBe("chat");
  expect(pageAgent(search)).toBe("david/notes/writer");
  expect(pageAgent("?page=chat")).toBeNull();
  expect(pageAgent("?page=inbox&agent=space/assistant")).toBeNull();
  expect(pageSession(search)).toBeNull();
  const resumed = chatHref("notes/writer", "s 1&x").slice(1);
  expect(pageAgent(resumed)).toBe("notes/writer");
  expect(pageSession(resumed)).toBe("s 1&x");
});
