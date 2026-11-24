import { expect, test } from "bun:test";
import { GATEWAY_PRESETS, GATEWAY_SITES, parseGatewayYaml } from "./config.ts";
import { presetList, VENDORS } from "./vendors.ts";

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

test("Volcengine Ark: a preset per way of paying, each with its own base and the model names that base takes", () => {
  const list = presetList();
  const ark = ["ark", "ark-coding", "ark-plan"].map((n) => list.find((p) => p.name === n)!);
  expect(ark.map((p) => p.messages)).toEqual(["https://ark.cn-beijing.volces.com/api/compatible", "https://ark.cn-beijing.volces.com/api/coding", "https://ark.cn-beijing.volces.com/api/plan"]);
  for (const p of ark) {
    expect(p.auth).toBe("bearer");
    // No model list is documented, so the page offers the documented ids.
    expect(p.hasList).toBe(false);
    expect(p.defaults.length).toBeGreaterThan(0);
    expect(p.openai).toBeUndefined();
  }
  // Pay-as-you-go takes dated Model IDs; the plans take the plan's own names.
  expect(ark[0]!.defaults).toContain("doubao-seed-2-1-pro-260915");
  expect(ark[1]!.defaults).toContain("ark-code-latest");
  const { config } = parseGatewayYaml("providers:\n  ark-coding:\n    preset: ark-coding\n    apiKeyEnv: ARK_KEY\n    models: [ark-code-latest]\n", { ARK_KEY: "k" });
  expect(config.providers[0]?.messages).toBe("https://ark.cn-beijing.volces.com/api/coding");
});

test("OpenRouter: Messages and an OpenAI-style base on one key, its model list read from the OpenAI base", () => {
  const p = presetList().find((x) => x.name === "openrouter")!;
  expect(p.messages).toBe("https://openrouter.ai/api");
  expect(p.openai).toBe("https://openrouter.ai/api/v1");
  expect(p.hasList).toBe(true);
  expect(VENDORS.openrouter!.list({ messages: p.messages, openai: p.openai })).toEqual({ url: "https://openrouter.ai/api/v1/models", auth: "bearer" });
});
