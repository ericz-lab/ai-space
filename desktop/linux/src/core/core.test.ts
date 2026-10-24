import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConnectionUrlError, escapeSegment, isLoopback, normalizeConnectionUrl, origin, queryParams, resolveUrl, sameOrigin } from "./url.ts";
import { ConnectionList, decodeConnections, encodeConnections } from "./connections.ts";
import { agentBase, allEntries, decodeCatalogue, NotASpaceError, opensFirst, pageUrl, panelScreens, pickText, search, widgetLines } from "./catalogue.ts";
import { checkResponse, classifyIdentity, classifyLayout, SpaceError } from "./check.ts";
import { LineSplitter, SSEParser } from "./sse.ts";
import { appForUrl, decodeInbox, InboxSeen, parseDeepLink, visibleTabs } from "./desktop.ts";
import { decodeLocal, hasSession, LocalFailure, needsDeviceCredential, newer, runtimeArgs, updateAvailable } from "./local.ts";
import { markdownBlocks, inlineMarkup } from "./markdown.ts";
import { decideNavigation, grantsMicrophone } from "./navigation.ts";
import { relativeTime } from "./format.ts";

describe("connection URLs", () => {
  test("loopback is plain HTTP; everything else needs HTTPS", () => {
    expect(normalizeConnectionUrl("127.0.0.1:8700")).toBe("http://127.0.0.1:8700/");
    expect(normalizeConnectionUrl("localhost:8700/x?y#z")).toBe("http://localhost:8700/x");
    expect(normalizeConnectionUrl("[::1]:8700")).toBe("http://[::1]:8700/");
    expect(normalizeConnectionUrl("Space.Example.com")).toBe("https://space.example.com/");
    expect(normalizeConnectionUrl("https://space.example.com:443/")).toBe("https://space.example.com/");
    const code = (s: string) => {
      try {
        normalizeConnectionUrl(s);
        return "ok";
      } catch (e) {
        return (e as ConnectionUrlError).code;
      }
    };
    expect(code(" ")).toBe("empty");
    expect(code("http://space.example.com")).toBe("insecure-remote");
    expect(code("ftp://x")).toBe("unsupported-scheme");
    expect(code("https://me:pw@space.example.com")).toBe("credentials");
    expect(isLoopback("127.1.2.3")).toBe(true);
    expect(isLoopback("128.0.0.1")).toBe(false);
    expect(isLoopback("127.0.0.256")).toBe(false);
  });

  test("origins, resolution and escaping without the URL class", () => {
    expect(origin("https://a.example.com:443/x")).toBe("https://a.example.com");
    expect(origin("http://127.0.0.1:8700/x")).toBe("http://127.0.0.1:8700");
    expect(sameOrigin("https://a.example.com/x", "https://A.example.com:443/y")).toBe(true);
    expect(sameOrigin("http://a.example.com/", "https://a.example.com/")).toBe(false);
    expect(resolveUrl("/apps/todo/", "https://s.example.com/panel")).toBe("https://s.example.com/apps/todo/");
    expect(resolveUrl("//cdn.example.com/i.png", "https://s.example.com/")).toBe("https://cdn.example.com/i.png");
    expect(resolveUrl("todo/", "https://s.example.com/apps/")).toBe("https://s.example.com/apps/todo/");
    expect(resolveUrl("https://x.example.com", "https://s.example.com/")).toBe("https://x.example.com");
    expect(escapeSegment("a b/c!")).toBe("a%20b%2Fc%21");
    expect(queryParams("aispace://chat?agent=space%2Fassistant&text=hello+world&text=again")).toEqual({ agent: "space/assistant", text: "hello world" });
  });
});

describe("saved connections", () => {
  test("one default while any exist; managed is kept; older files decode", () => {
    let n = 0;
    const list = new ConnectionList([], () => `id${++n}`);
    const a = list.add("", "https://a.example.com/");
    const b = list.add("Home", "http://127.0.0.1:8700/", { managed: true });
    expect(a).toMatchObject({ name: "a.example.com", isDefault: true });
    expect(list.managed?.id).toBe(b.id);
    list.setDefault(b.id);
    expect(list.default?.id).toBe(b.id);
    list.remove(b.id);
    expect(list.default?.id).toBe(a.id);
    const back = decodeConnections(encodeConnections(list.connections));
    expect(back).toEqual(list.connections);
    expect(decodeConnections('[{"id":"x","name":"n","url":"https://n/","isDefault":true}]')[0]!.managed).toBe(false);
    expect(() => decodeConnections('{"id":1}')).toThrow();
  });
});

const CATALOGUE = {
  apps: {
    ok: true,
    builtins: { inbox: "/inbox.svg" },
    apps: [
      { id: "todo", name: "todo", title: "Todo", description: "Tasks for today", i18n: { zh: { title: "待办" } }, icon: "✅", url: "/apps/todo/", service: { health: "ok" } },
      { id: "seoul/notes", name: "notes", peer: "seoul", title: "Notes", url: "https://notes.example.com/{lang}/", service: { health: "ok" } },
      { id: "hidden", name: "hidden", title: "Hidden", url: "/h/", hidden: true },
      { id: "nolink", name: "nolink", title: "No link" },
      { id: "paused", name: "paused", title: "Paused", url: "/p/", status: "paused" },
      "garbage",
    ],
  },
  agents: { agents: [{ id: "space/assistant", app: "space", name: "assistant", title: "Space Assistant" }, { id: "seoul/todo/helper", app: "todo", name: "helper", title: "Todo helper", peer: "seoul" }] },
  widgets: { widgets: [{ id: "todo/today", app: "todo", name: "today", title: "Today", blocks: [{ type: "metric", label: "Open", value: 1234.5, format: "number", decimals: 0 }, { type: "status", label: { en: "Sync", zh: "同步" }, value: "ok" }] }, { id: "todo/list", app: "todo", name: "list", title: "List", items: [{ text: "Buy milk" }] }] },
  peers: { peers: [{ name: "seoul", health: "down" }] },
  layout: { ok: true, layout: { screens: [{ id: "home", name: "Home", items: ["app:todo", "agent:space/assistant"] }] } },
  router: { domain: "Example.COM" },
};

describe("catalogue", () => {
  test("decodes as the phone does: hidden, archived and linkless apps left out, peers marked offline", () => {
    const c = decodeCatalogue(CATALOGUE);
    expect(c.apps.map((a) => [a.ref, a.reach])).toEqual([["todo", "up"], ["seoul/notes", "peer-offline"], ["paused", "paused"]]);
    expect(c.agents.map((a) => [a.ref, a.reach])).toEqual([["space/assistant", "unknown"], ["seoul/todo/helper", "peer-offline"]]);
    expect(c.domain).toBe("example.com");
    expect(c.builtinIcons).toEqual({ inbox: "/inbox.svg" });
    expect(panelScreens(c)[0]!.items).toEqual(["app:todo", "agent:space/assistant"]);
    expect(panelScreens({ ...c, screens: undefined })[0]!.items[0]).toBe("app:todo");
    expect(() => decodeCatalogue({ ...CATALOGUE, apps: { nope: 1 } })).toThrow(NotASpaceError);
  });

  test("search finds every language and ranks names first; Return opens a typed name", () => {
    const c = decodeCatalogue(CATALOGUE);
    const all = allEntries(c);
    expect(search("待办", all).map((e) => e.ref)).toEqual(["todo"]);
    expect(search("today", all).map((e) => e.ref)).toEqual(["todo/today", "todo"]);
    expect(opensFirst("todo", search("todo", all)[0])).toBe(true);
    expect(opensFirst("what is due today", search("what is due today", all)[0])).toBe(false);
    expect(pickText("Todo", { "zh-CN": { title: "待办" } }, "title", "zh")).toBe("待办");
  });

  test("pages, agent routes and widget lines", () => {
    const c = decodeCatalogue(CATALOGUE);
    expect(pageUrl(c.apps[0]!.link, "https://s.example.com/", "en")).toBe("https://s.example.com/apps/todo/");
    expect(pageUrl(c.apps[1]!.link, "https://s.example.com/", "zh")).toBe("https://notes.example.com/zh/");
    expect(pageUrl("javascript:alert(1)", "https://s.example.com/", "en")).toBeUndefined();
    expect(agentBase(c.agentInfo[1]!)).toBe("/api/peers/seoul/agents/todo/helper");
    expect(widgetLines(c.widgets[0]!, "zh")).toEqual(["Open: 1,235", "同步: ok"]);
    expect(widgetLines(c.widgets[1]!, "en")).toEqual(["Buy milk"]);
  });
});

describe("connection checks", () => {
  test("identity, layout and errors", () => {
    expect(classifyIdentity(200, JSON.stringify({ product: "ai-space", api: 1, version: "0.1.0", edition: "local" }))).toMatchObject({ identity: { edition: "local" } });
    expect(classifyIdentity(200, JSON.stringify({ product: "ai-space", api: 2 }))).toMatchObject({ state: { kind: "incompatible" } });
    expect(classifyIdentity(200, "<html>")).toMatchObject({ state: { kind: "incompatible" } });
    expect(classifyIdentity(302, "")).toEqual({ state: { kind: "signin" } });
    expect(classifyLayout(200, "application/json", '{"ok":true,"layout":{}}')).toEqual({ kind: "ready" });
    expect(classifyLayout(401, "", "")).toEqual({ kind: "signin" });
    expect(classifyLayout(200, "text/html", "<html>")).toMatchObject({ kind: "incompatible" });
    expect(() => checkResponse(403, "")).toThrow(SpaceError);
    try {
      checkResponse(409, '{"error":"busy"}');
    } catch (e) {
      expect(e).toMatchObject({ kind: "http", message: "busy", status: 409 });
    }
  });
});

describe("event streams", () => {
  test("ids pair with the data line after them; keep-alives are skipped", () => {
    const p = new SSEParser();
    const lines = new LineSplitter();
    const got = [...lines.push(": hi\nid: 3\ndata: {\"a\":1}\r\n\ndata: x"), ...lines.end()].map((l) => p.feed(l)).filter(Boolean);
    expect(got).toEqual([{ id: 3, data: '{"a":1}' }, { data: "x" }]);
  });
});

describe("desktop rules", () => {
  test("the first look at the inbox only records it", () => {
    const seen = new InboxSeen();
    const item = (thread: string, lastAt: string, unread = true) => ({ thread, app: "a", level: "info", text: "t", count: 1, lastAt, unread, done: false });
    expect(seen.fresh([item("1", "a")])).toEqual([]);
    expect(seen.fresh([item("1", "a"), item("2", "b")]).map((i) => i.thread)).toEqual(["2"]);
    expect(seen.fresh([item("1", "c"), item("2", "b", false)]).map((i) => i.thread)).toEqual(["1"]);
    expect(decodeInbox({ items: [item("x", "y"), { bad: 1 }] })).toMatchObject({ items: [{ thread: "x" }], summary: { unread: 1, open: 1 } });
  });

  test("links fill in a message but never send it", () => {
    expect(parseDeepLink("aispace://chat?agent=space/assistant&text=hi")).toEqual({ kind: "chat", agent: "space/assistant", text: "hi" });
    expect(parseDeepLink("aispace://open?app=todo")).toEqual({ kind: "open", app: "todo" });
    expect(parseDeepLink("aispace://open")).toBeUndefined();
    expect(parseDeepLink("aispace://")).toEqual({ kind: "show" });
    expect(parseDeepLink("aispace:inbox")).toEqual({ kind: "inbox" });
    expect(parseDeepLink("https://x")).toBeUndefined();
  });

  test("a link belongs to the app whose page owns its origin or path", () => {
    const c = decodeCatalogue(CATALOGUE);
    expect(appForUrl("https://s.example.com/apps/todo/item/1", c.apps, "https://s.example.com/", "en")?.ref).toBe("todo");
    expect(appForUrl("https://s.example.com/", c.apps, "https://s.example.com/", "en")).toBeUndefined();
    expect(appForUrl("https://notes.example.com/x", c.apps, "https://s.example.com/", "en")?.ref).toBe("seoul/notes");
    expect(visibleTabs(["a", "b", "c", "d", "e", "f", "g"], "g")).toEqual(["a", "b", "c", "d", "g"]);
  });

  test("navigation stays for the page and sign-in redirects; clicked links leave", () => {
    const home = "https://s.example.com/";
    const nav = (url: string, o: Partial<Parameters<typeof decideNavigation>[0]> = {}) => decideNavigation({ url, isMainFrame: true, isLinkActivation: false, opensNewWindow: false, fromHomePage: true, ...o }, home);
    expect(nav("https://s.example.com/x")).toBe("allow");
    expect(nav("https://login.example.org/")).toBe("allow");
    expect(nav("https://other.example.org/", { isLinkActivation: true })).toBe("external");
    expect(nav("https://s.example.com/x", { opensNewWindow: true })).toBe("external");
    expect(nav("mailto:a@b")).toBe("cancel");
    expect(nav("mailto:a@b", { isLinkActivation: true })).toBe("external");
    expect(grantsMicrophone("microphone", "https://s.example.com/x", "https://s.example.com/", home)).toBe(true);
    expect(grantsMicrophone("camera", "https://s.example.com/x", "https://s.example.com/", home)).toBe(false);
    expect(grantsMicrophone("microphone", "https://evil.example/", "https://s.example.com/", home)).toBe(false);
  });
});

describe("Local edition output", () => {
  test("envelopes, versions and the device credential", () => {
    expect(decodeLocal<{ ok: true; x: number }>('{"ok":true,"x":1}').x).toBe(1);
    expect(() => decodeLocal('{"ok":false,"code":"busy","error":"the Space is busy"}')).toThrow(LocalFailure);
    try {
      decodeLocal("bun: not found");
    } catch (e) {
      expect(e).toMatchObject({ code: "output", message: "bun: not found" });
    }
    expect(newer("0.2.0", "0.1.9")).toBe(true);
    expect(newer("0.2.0", "0.2.0-rc.1")).toBe(true);
    expect(newer("0.2.0-rc.1", "0.2.0")).toBe(false);
    expect(newer("0.1.0", "0.1.0")).toBe(false);
    const s = { state: "managed", workspace: { exists: true }, bundle: { version: "0.2.0" }, installed: { version: "0.1.0" } } as never;
    expect(updateAvailable(s)).toBe(true);
    expect(needsDeviceCredential(s, true)).toBe(false);
    expect(needsDeviceCredential(s, false)).toBe(true);
    expect(runtimeArgs({ claude: "/c", codex: undefined, dsh: "/d" })).toEqual(["--claude", "/c", "--dsh", "/d"]);
    expect(hasSession([{ name: "space_session", domain: "127.0.0.1" }], "127.0.0.1")).toBe(true);
    expect(hasSession([{ name: "space_session", domain: "127.0.0.1", expires: 1 }], "127.0.0.1", 2)).toBe(false);
  });
});

describe("reply markdown", () => {
  test("blocks and Pango markup, escaped", () => {
    expect(inlineMarkup("a <b> & **bold** *it* `x<y` [l](https://e.x/?a=1&b=2) javascript:x")).toBe('a &lt;b&gt; &amp; <b>bold</b> <i>it</i> <tt>x&lt;y</tt> <a href="https://e.x/?a=1&amp;b=2">l</a> javascript:x');
    const blocks = markdownBlocks("# Title\n\nPara one\nline two\n\n- a\n  wrapped\n  - b\n1. c\n\n> quote\n\n```ts\nconst a = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 22 |\n\n---");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "item", "item", "item", "quote", "code", "table", "rule"]);
    expect(blocks[2]).toEqual({ kind: "item", depth: 0, bullet: "•", markup: "a\nwrapped" });
    expect(blocks[3]).toMatchObject({ depth: 1 });
    expect(blocks[4]).toMatchObject({ bullet: "1." });
    expect(blocks[6]).toEqual({ kind: "code", text: "const a = 1;", lang: "ts" });
    expect(blocks[7]).toEqual({ kind: "table", text: "A  B\n─  ──\n1  22" });
  });

  test("relative times", () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    expect(relativeTime("2026-10-24T11:59:50Z", "en", now)).toBe("just now");
    expect(relativeTime("2026-10-24T11:55:00Z", "en", now)).toBe("5 minutes ago");
    expect(relativeTime(now - 86_400_000, "en", now)).toBe("yesterday");
  });
});

/** Globals GJS does not have: code under desktop/linux/src must not use them (the bundle would fail at run time). */
test("the client uses no global GJS lacks", () => {
  const root = join(import.meta.dir, "..");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(n) && !/\.test\.ts$/.test(n) && !n.endsWith(".d.ts")) files.push(p);
    }
  };
  walk(root);
  const banned = /\bnew URL\(|\bURLSearchParams\b|(?<![.\w])fetch\(|\bAbortController\b|\bAbortSignal\b|\bstructuredClone\(|\bqueueMicrotask\(|\bcrypto\.|(?<![.\w])atob\(|(?<![.\w])btoa\(|\bprocess\.|\bBun\.|\brequire\(/;
  const bad = files.flatMap((f) => readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l] as const)).filter(([, , l]) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && banned.test(l));
  expect(bad.map(([f, i, l]) => `${f}:${i}: ${l.trim()}`)).toEqual([]);
});
