import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayInfo, GatewayPreset, GatewayProviderInfo, GatewaySpeechInfo } from "./api.ts";
import { ImageCard, SpeechCard } from "./GatewayMedia.tsx";
import { AddProvider, PriceList, GroupsEditor, ModelChooser, ProviderRow, RemoveForm } from "./GatewaySettings.tsx";
import { GatewayLink } from "./MachineClis.tsx";
import { translate } from "./messages.ts";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const zh = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("zh", key, vars);
const noop = () => {};
const run = async () => true;

const base: GatewayProviderInfo = { name: "ds", preset: "deepseek", label: "DeepSeek", messages: "https://api.deepseek.com/anthropic", auth: "bearer", key: { state: "workspace", last4: "abcd", page: true, variable: "SPACE_GATEWAY_DS_KEY" }, disabled: false, models: ["deepseek-v4-pro"], kinds: { "deepseek-v4-pro": "text" }, kindSet: [], serves: { text: true, asr: "its transcription is /v1/tools/asr", tts: "its speech is /v1/tools/tts", image: "the vendor documents none" }, usedBy: { groups: [], tiers: [], emptied: [] } };

test("a provider row: its state, bases, models, and its key only as set and its last four characters", () => {
  const html = renderToStaticMarkup(<ProviderRow p={base} editable busy={false} run={run} lang="en" t={t} />);
  expect(html).toContain("<b>ds</b>");
  expect(html).toContain("DeepSeek");
  expect(html).toContain("On");
  expect(html).toContain("messages https://api.deepseek.com/anthropic");
  expect(html).toContain("Key set …abcd");
  expect(html).toContain("1 models: deepseek-v4-pro");
  for (const b of ["Test", "Edit", "Replace key", "Turn off", "Remove"]) expect(html).toContain(`>${b}</button>`);
  expect(html).toContain("a few tokens billed");
  // From the environment: said so, and its key is not replaced here.
  const env = renderToStaticMarkup(<ProviderRow p={{ ...base, key: { state: "environment", page: false, variable: "DEEPSEEK_API_KEY", last4: "wxyz" } }} editable busy={false} run={run} lang="en" t={t} />);
  expect(env).toContain("Key set by the environment (DEEPSEEK_API_KEY) …wxyz");
  expect(env).toMatch(/<button class="btn2" disabled="">Replace key<\/button>/);
  const off = renderToStaticMarkup(<ProviderRow p={{ ...base, disabled: true, off: "turned off" }} editable busy={false} run={run} lang="en" t={t} />);
  expect(off).toContain("Turned off");
  expect(off).toContain(">Turn on</button>");
  const resting = renderToStaticMarkup(<ProviderRow p={{ ...base, resting: { until: new Date(Date.now() + 600_000).toISOString(), kind: "quota" } }} editable busy={false} run={run} lang="en" t={t} />);
  expect(resting).toContain("Resting (quota used up), back in 10 min");
  // A file the page cannot edit: Test only.
  const ro = renderToStaticMarkup(<ProviderRow p={base} editable={false} busy={false} run={run} lang="en" t={t} />);
  expect(ro).not.toContain(">Edit</button>");
  expect(ro).toContain(">Test</button>");
});

test("removing: what names it is listed; the page's own key is deleted by default, one from the environment never", () => {
  const used = renderToStaticMarkup(<RemoveForm p={{ ...base, usedBy: { groups: ["fast"], tiers: ["advanced"], emptied: [] } }} busy={false} onRemove={noop} onCancel={noop} t={t} />);
  expect(used).toContain("used by groups fast and tiers advanced");
  expect(used).toContain('type="checkbox" checked=""');
  expect(used).toContain("SPACE_GATEWAY_DS_KEY");
  const hand = renderToStaticMarkup(<RemoveForm p={{ ...base, key: { state: "workspace", page: false, variable: "MY_KEY" } }} busy={false} onRemove={noop} onCancel={noop} t={t} />);
  expect(hand).toContain('type="checkbox"/>');
  expect(hand).not.toContain('checked=""');
  const env = renderToStaticMarkup(<RemoveForm p={{ ...base, key: { state: "environment", page: false, variable: "DEEPSEEK_API_KEY" } }} busy={false} onRemove={noop} onCancel={noop} t={t} />);
  expect(env).not.toContain("checkbox");
  expect(env).toContain("comes from the environment");
});

test("adding: the presets, Custom, a password field for the key, and the preset's documented models ticked", () => {
  const presets: GatewayPreset[] = [{ name: "zai", label: "Z.ai (GLM)", messages: "https://api.z.ai/api/anthropic", auth: "bearer", hasList: false, defaults: ["glm-5.4"] }, { name: "openai", label: "OpenAI", openai: "https://api.openai.com/v1", auth: "bearer", hasList: true, defaults: [] }];
  const html = renderToStaticMarkup(<AddProvider presets={presets} taken={["zai"]} busy={false} run={run} onDone={noop} t={t} />);
  expect(html).toContain('<option value="zai" selected="">Z.ai (GLM)</option>');
  expect(html).toContain('<option value="">Custom (any base URL)</option>');
  expect(html).toContain('value="zai-2"');
  expect(html).toContain('type="password"');
  expect(html).toContain("messages https://api.z.ai/api/anthropic");
  expect(html).toMatch(/type="checkbox" checked=""\/> glm-5.4/);
  expect(html).toContain("never shown again");
});

test("adding a vendor with two sites: the Site switch, its own site selected; vendors without one have no switch", () => {
  const sites = { intl: { messages: "https://api.minimax.io/anthropic" }, cn: { messages: "https://api.minimaxi.com/anthropic" } };
  const presets: GatewayPreset[] = [{ name: "minimax", label: "MiniMax", messages: "https://api.minimax.io/anthropic", auth: "bearer", hasList: true, defaults: ["MiniMax-M3"], sites }];
  const html = renderToStaticMarkup(<AddProvider presets={presets} taken={[]} busy={false} run={run} onDone={noop} t={t} />);
  expect(html).toContain(">Site<");
  expect(html).toMatch(/class="btn2 primary" aria-pressed="true" title="https:\/\/api.minimax.io\/anthropic">International</);
  expect(html).toMatch(/class="btn2" aria-pressed="false" title="https:\/\/api.minimaxi.com\/anthropic">China</);
  expect(html).toContain("A key works only on the site it was made on.");
  const plain = renderToStaticMarkup(<AddProvider presets={[{ ...presets[0]!, sites: undefined }]} taken={[]} busy={false} run={run} onDone={noop} t={t} />);
  expect(plain).not.toContain(">Site<");
});

test("prices: each model's input / output with its source on hover; models without one named", () => {
  const html = renderToStaticMarkup(<PriceList p={{ ...base, models: ["deepseek-v4-pro", "odd-one"], prices: { "deepseek-v4-pro": { input: 1.32, output: 3.96, cacheRead: 0.044, source: "models.dev deepseek" }, "odd-one": null } }} t={t} />);
  expect(html).toContain("deepseek-v4-pro $1.32 / $3.96");
  expect(html).toContain("from models.dev deepseek");
  expect(html).toContain("cache read $0.044");
  expect(html).toContain("No price: odd-one");
  const units = renderToStaticMarkup(<PriceList p={{ ...base, models: [], prices: { "whisper-1": { perMinute: 0.006, source: "price file" }, "gpt-image-2": { input: 5, output: 40, perImage: 0.04, source: "price file" } } }} t={t} />);
  expect(units).toContain("whisper-1 $0.0060 per minute");
  expect(units).toContain("gpt-image-2 $5 / $40, $0.04 per picture");
});

test("the model chooser: ticked models and a field for ids typed by hand; groups with their order and the controls to change it", () => {
  const chooser = renderToStaticMarkup(<ModelChooser selected={["a/b-1"]} onChange={noop} fetchList={async () => ({ source: "vendor", models: [], defaults: [] })} busy={false} t={t} />);
  expect(chooser).toContain("Load the vendor&#x27;s list");
  expect(chooser).toMatch(/checked=""\/> a\/b-1/);
  expect(chooser).toContain('placeholder="Model ids, typed by hand"');
  const groups = renderToStaticMarkup(<GroupsEditor groups={{ fast: ["ds/a", "glm/b"] }} models={["ds/a", "glm/b", "glm/c"]} tiers={{ basic: "fast" }} editable busy={false} onSave={noop} t={t} />);
  expect(groups).toContain("<b>fast</b>");
  expect(groups.indexOf("ds/a")).toBeLessThan(groups.indexOf("glm/b"));
  expect(groups).toContain('aria-label="Move up" disabled=""');
  // A tier uses it: it cannot be removed here.
  expect(groups).toMatch(/<button class="btn2 danger" disabled="" title="A tier uses this group/);
  expect(groups).toContain('<option value="glm/c">glm/c</option>');
});

test("Models links to Gateway; the section is in both languages", () => {
  expect(renderToStaticMarkup(<GatewayLink names={["gw", "magpie"]} onOpen={noop} t={t} />)).toContain("gw, magpie take their tiers from a model gateway");
  expect(renderToStaticMarkup(<GatewayLink names={[]} onOpen={noop} t={zh} />)).toContain("设置 → 网关");
  expect(zh("settings.section.gateway")).toBe("网关");
});

test("kinds: a provider says what it serves and why not; the chooser marks each ticked model's kind, one click to change", () => {
  const row = renderToStaticMarkup(<ProviderRow p={{ ...base, models: ["deepseek-v4-pro", "x-tts"], kinds: { "deepseek-v4-pro": "text", "x-tts": "tts" } }} editable busy={false} run={run} lang="en" t={t} />);
  expect(row).toContain("x-tts (text to speech)");
  expect(row).toContain('class="gw-chip on"');
  expect(row).toMatch(/class="gw-chip no" title="its speech is \/v1\/tools\/tts">✕ text to speech/);
  const chooser = renderToStaticMarkup(<ModelChooser selected={["whisper-1", "chat"]} kinds={{ "whisper-1": "asr" }} onKinds={noop} onChange={noop} fetchList={async () => ({ source: "vendor", models: [], defaults: [] })} busy={false} t={t} />);
  expect(chooser).toContain('aria-label="whisper-1 is speech to text; click to make it text to speech"');
  expect(chooser).toContain('aria-label="chat is text; click to make it speech to text"');
  expect(zh("gateway.kind.image")).toBe("图片");
});

test("a vendor's OpenAI-style base is offered, with the key caveat and its page, never added by itself", () => {
  const presets: GatewayPreset[] = [{ name: "zhipu", label: "Zhipu", messages: "https://open.bigmodel.cn/api/anthropic", auth: "bearer", hasList: false, defaults: [], openaiOffer: { cn: "https://open.bigmodel.cn/api/paas/v4", note: "speech and pictures", source: "https://docs.z.ai/devpack/faq" } }];
  const html = renderToStaticMarkup(<AddProvider presets={presets} taken={[]} busy={false} run={run} onDone={noop} t={t} />);
  expect(html).toContain("OpenAI-style base for speech and pictures");
  expect(html).toContain("does not say this key works there too");
  expect(html).toContain('href="https://docs.z.ai/devpack/faq"');
  expect(html).toContain(">Use https://open.bigmodel.cn/api/paas/v4</button>");
  expect(html).not.toContain("openai https://open.bigmodel.cn/api/paas/v4");
});

const gw = (over: Partial<GatewayInfo> = {}): GatewayInfo => ({ file: "/w/gateway.yaml", exists: true, answers: true, providers: [base], groups: {}, tiers: {}, models: [], imageModels: [], textModels: [], asrModels: [], ttsModels: [], presets: [], runtimes: [], offer: { claude: false }, ...over });
const oa = { name: "oa", label: "OpenAI", serves: { asr: true as const, tts: true as const, image: true as const }, asrModels: ["whisper-1"], ttsModels: ["tts-1"], imageModels: ["gpt-image-1"], voices: { "tts-1": ["alloy", "nova"] } };
const speechInfo = (over: Partial<GatewaySpeechInfo> = {}): GatewaySpeechInfo => ({ file: "/w/providers.yaml", exists: false, source: "builtin", now: { asr: ["voice-studio"], tts: ["voice-studio"], live: ["voice-studio"] }, kinds: {}, choice: { asr: { place: "off" }, tts: { place: "off" } }, handWritten: [], providers: [oa], ...over });

test("the Speech group: what answers now, the three places with the safe one named, live not through the gateway, tests that cost", () => {
  const html = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={speechInfo()} t={t} />);
  expect(html).toContain("Answers now");
  expect(html).toContain("<b>voice-studio</b>");
  expect(html).toContain("Live conversation does not go through the gateway");
  expect(html).toContain("After the current default (safe: the default keeps answering)");
  expect(html).toMatch(/type="radio" name="speech-asr" checked=""\/>Not through the gateway/);
  expect(html).toContain("cost a little");
  expect(html).toMatch(/<button class="btn2" disabled="">Test TTS<\/button>/);
  // As default: the warning, the provider, model and voice from the vendor's documentation.
  const chosen = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={speechInfo({ choice: { asr: { place: "fallback", provider: "oa", model: "whisper-1" }, tts: { place: "default", provider: "oa", model: "tts-1", voice: "nova" } } })} t={t} />);
  expect(chosen).toContain("Apps&#x27; calls then go to this vendor first");
  expect(chosen).toContain('<option value="nova" selected="">nova</option>');
  expect(chosen).toContain(">Test TTS</button>");
  // No provider can: said so, with a way to add one.
  const none = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={speechInfo({ providers: [{ ...oa, serves: { asr: "no openai base", tts: "no openai base", image: "no openai base" } }] })} onAddProvider={noop} t={t} />);
  expect(none).toContain("No provider here can do this through the gateway yet.");
  expect(none).toContain("Add a provider that can do this");
  expect(renderToStaticMarkup(<SpeechCard g={gw()} editable initial={speechInfo()} t={zh} />)).toContain("实时对话不走网关");
});

test("the Image group: who can draw and why not, the picture model, a test that costs, the URL rule", () => {
  const p = { ...base, name: "oa", models: ["gpt-image-1"], kinds: { "gpt-image-1": "image" as const }, serves: { text: "no messages base", asr: true as const, tts: true as const, image: true as const } };
  const html = renderToStaticMarkup(<ImageCard g={gw({ providers: [base, p], imageModels: ["oa/gpt-image-1"], tiers: { image: "oa/gpt-image-1" } })} editable busy={false} onSave={noop} t={t} />);
  expect(html).toContain("<b>oa</b> can draw (1 picture models)");
  expect(html).toContain("the vendor documents none");
  expect(html).toContain('<option value="oa/gpt-image-1" selected="">oa/gpt-image-1</option>');
  expect(html).toContain(">Make a test picture</button>");
  expect(html).toContain("only over https from a public address");
  const empty = renderToStaticMarkup(<ImageCard g={gw()} editable busy={false} onSave={noop} onAddProvider={noop} t={zh} />);
  expect(empty).toContain("添加能做这件事的服务商");
});
