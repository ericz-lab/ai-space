import { expect, test } from "bun:test";
import { GATEWAY_PRESETS, GATEWAY_SITES, parseGatewayYaml } from "./config.ts";
import { presetList } from "./vendors.ts";

test("vendors with a China and an international site: the preset's base is one of the two, and the page gets both", () => {
  for (const [name, sites] of Object.entries(GATEWAY_SITES)) {
    expect(GATEWAY_PRESETS[name]).toBeDefined();
    expect([sites.intl.messages, sites.cn.messages]).toContain(GATEWAY_PRESETS[name]!.messages);
    expect(sites.intl.messages).not.toBe(sites.cn.messages);
  }
  const list = presetList();
  expect(list.find((p) => p.name === "minimax")?.sites?.cn.messages).toBe("https://api.minimaxi.com/anthropic");
  expect(list.find((p) => p.name === "deepseek")?.sites).toBeUndefined();
});

test("the other site is a base override on the preset: the file keeps preset and base", () => {
  const { config } = parseGatewayYaml("providers:\n  minimax:\n    preset: minimax\n    messages: https://api.minimaxi.com/anthropic\n    apiKeyEnv: MM_KEY\n", { MM_KEY: "k" });
  const p = config.providers.find((x) => x.name === "minimax");
  expect(p?.preset).toBe("minimax");
  expect(p?.messages).toBe("https://api.minimaxi.com/anthropic");
});
