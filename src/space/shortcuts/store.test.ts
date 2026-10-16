import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentIntent } from "./agent-intents.ts";
import { ShortcutStore } from "./store.ts";

test("custom patterns survive reopening and isolate local and peer actions", () => {
  const dir = mkdtempSync(join(tmpdir(), "shortcut-patterns-"));
  let store = new ShortcutStore(join(dir, "space.db"));
  try {
    const intent = parseAgentIntent({ id: "news-agent", title: "News", agent: "whymove/curator", skills: ["curate-news"], patterns: ["金融新闻"] });
    store.setAgentIntent(intent);
    store.setPatterns("feed/news", "", ["金融新闻"]);
    store.setPatterns("feed/news", "remote", ["远端新闻"]);
    store.close();
    store = new ShortcutStore(join(dir, "space.db"));
    expect(store.agentIntents()).toEqual([intent]);
    expect(store.patterns()).toEqual([
      { action: "feed/news", peer: "", patterns: ["金融新闻"] },
      { action: "feed/news", peer: "remote", patterns: ["远端新闻"] },
    ]);
    store.setPatterns("feed/news", "", ["本地新闻"]);
    expect(store.patterns().find((p) => !p.peer)?.patterns).toEqual(["本地新闻"]);
    store.setPatterns("feed/news", "", []);
    expect(store.patterns()).toEqual([{ action: "feed/news", peer: "remote", patterns: ["远端新闻"] }]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
