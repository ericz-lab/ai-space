import { expect, test } from "bun:test";
import { parseAgentIntent, matchAgentIntents } from "./agent-intents.ts";

const news = parseAgentIntent({ id: "financial-news", title: "金融新闻", agent: "whymove/curator", skills: ["curate-news"], patterns: ["[帮我][查|查询|看看|看一下][{period}](金融新闻|财经新闻|新闻)[ {topic}]"] });

test("agent patterns classify sentences while leaving their original text to the agent", () => {
  for (const text of ["查今天金融新闻", "金融新闻", "帮我看看今天的金融新闻", "查本周财经新闻 美联储"]) {
    expect(matchAgentIntents(text, [{ ...news, available: true }])).toEqual([{ ...news, available: true }]);
  }
  expect(matchAgentIntents("不要查金融新闻", [{ ...news, available: true }])).toEqual([]);
  expect(matchAgentIntents("查天气", [{ ...news, available: true }])).toEqual([]);
  expect(matchAgentIntents("金融新闻", [{ ...news, enabled: false, available: true }])).toEqual([]);
});

test("multiple intents remain distinct; an unavailable matching agent is not silently replaced", () => {
  const unavailable = { ...news, available: false, reason: "missing skill" };
  expect(matchAgentIntents("金融新闻", [unavailable])).toEqual([unavailable]);
  expect(matchAgentIntents("金融新闻", [{ ...news, available: true }, { ...news, id: "other", available: true }])).toHaveLength(2);
});

test("backend intent validation rejects unsafe names and malformed patterns", () => {
  for (const patch of [{ agent: "peer/app/agent" }, { skills: ["../secret"] }, { skills: [] }, { patterns: ["{anything}"] }, { patterns: [] }, { enabled: "true" }, { permissionMode: "bypassPermissions" }]) {
    expect(() => parseAgentIntent({ ...news, ...patch })).toThrow();
  }
});
