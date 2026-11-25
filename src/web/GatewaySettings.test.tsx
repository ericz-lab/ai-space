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
  // A preset with a note in the dictionaries shows it in the page's language; any other shows the note as sent.
  expect(html).toContain("OpenAI-style base for speech, transcription and pictures");
  expect(html).toContain("does not say this key works there too");
  expect(html).toContain('href="https://docs.z.ai/devpack/faq"');
  expect(html).toContain(">Use https://open.bigmodel.cn/api/paas/v4</button>");
  expect(html).not.toContain("openai https://open.bigmodel.cn/api/paas/v4");
});

test("a provider whose preset leaves that base out offers it on its own row, for its site, in one click", () => {
  const preset: GatewayPreset = {
    name: "minimax", label: "MiniMax", messages: "https://api.minimax.io/anthropic", auth: "bearer", hasList: true, defaults: [],
    sites: { intl: { messages: "https://api.minimax.io/anthropic" }, cn: { messages: "https://api.minimaxi.com/anthropic" } },
    openaiOffer: { intl: "https://api.minimax.io/v1", cn: "https://api.minimaxi.com/v1", note: "pictures only", source: "https://platform.minimax.io/docs" },
  };
  const mm: GatewayProviderInfo = { ...base, name: "minimax", preset: "minimax", label: "MiniMax", messages: "https://api.minimaxi.com/anthropic" };
  const row = renderToStaticMarkup(<ProviderRow p={mm} preset={preset} editable busy={false} run={run} lang="zh" t={zh} />);
  expect(row).toContain("可用于图片");
  expect(row).toContain(">使用 https://api.minimaxi.com/v1</button>");
  // Already added, or not the owner's to change: nothing is offered.
  expect(renderToStaticMarkup(<ProviderRow p={{ ...mm, openai: "https://api.minimaxi.com/v1" }} preset={preset} editable busy={false} run={run} lang="zh" t={zh} />)).not.toContain("使用 https://");
  expect(renderToStaticMarkup(<ProviderRow p={mm} preset={preset} editable={false} busy={false} run={run} lang="zh" t={zh} />)).not.toContain("使用 https://");
});

const gw = (over: Partial<GatewayInfo> = {}): GatewayInfo => ({ file: "/w/gateway.yaml", exists: true, answers: true, providers: [base], groups: {}, tiers: {}, models: [], imageModels: [], textModels: [], asrModels: [], ttsModels: [], presets: [], runtimes: [], offer: { claude: false }, ...over });
const oa = { name: "oa", label: "OpenAI", serves: { asr: true as const, tts: true as const, image: true as const }, asrModels: ["whisper-1"], ttsModels: ["tts-1"], imageModels: ["gpt-image-1"], voices: { "tts-1": ["alloy", "nova"] } };
const speechInfo = (over: Partial<GatewaySpeechInfo> = {}): GatewaySpeechInfo => ({ file: "/w/providers.yaml", exists: false, source: "builtin", custom: [], order: { asr: [], tts: [] }, providers: [oa], ...over });
const studio = { name: "voice-studio", kind: "voice-studio", serves: { asr: true, tts: true, live: true }, machine: "", located: true, testable: true };

test("the Pictures group adds a picture model to a provider that can draw: the documented ids, or one typed", () => {
  const mm: GatewayProviderInfo = { ...base, name: "minimax", preset: "minimax", openai: "https://api.minimaxi.com/v1", models: ["MiniMax-M3"], kinds: { "MiniMax-M3": "text" }, serves: { text: true, asr: "no", tts: "no", image: true }, imageOffer: ["MiniMax-H3-Image"] };
  const html = renderToStaticMarkup(<ImageCard g={gw({ providers: [mm, base] })} editable busy={false} onAddModel={noop} t={zh} />);
  expect(html).toContain("能画图（0 个图片模型）");
  expect(html).toContain(">+ MiniMax-H3-Image</button>");
  expect(html).toContain('placeholder="厂商控制台里的图片模型 ID"');
  // Only where it can draw, and only for the owner.
  expect(html.match(/gw-addmodel/g)?.length).toBe(1);
  expect(renderToStaticMarkup(<ImageCard g={gw({ providers: [mm] })} editable={false} busy={false} onAddModel={noop} t={zh} />)).not.toContain("gw-addmodel");
});

test("the Speech group, nothing of the space's own: the gateway's providers only, empty orders, no live, nothing named that is not there", () => {
  for (const tr of [t, zh]) {
    const html = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={speechInfo()} onAddProvider={noop} t={tr} />);
    expect(html).not.toMatch(/voice-studio/i);
    expect(html).not.toContain(tr("speechg.live"));
    expect(html).toContain("<b>oa</b>");
    expect(html).toContain(tr("speechg.viaGateway"));
    expect(html).toContain(tr("speechg.empty"));
    expect(html).toContain(`<option value="g:oa">oa · OpenAI · ${tr("speechg.viaGateway")}</option>`);
  }
  // No provider at all can: the plain empty state with a way to add one.
  const none = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={speechInfo({ providers: [{ ...oa, serves: { asr: "no openai base", tts: "no openai base", image: "no openai base" } }] })} onAddProvider={noop} t={zh} />);
  expect(none).toContain("还没有服务商负责语音。");
  expect(none).toContain("添加能做这件事的服务商");
  // No dictionary string names a provider.
  for (const tr of [t, zh]) for (const k of ["speechg.intro", "speechg.nothing", "speechg.liveNote", "speechg.empty", "imageg.intro", "imageg.none", "imageg.urlRule"] as const) expect(tr(k)).not.toMatch(/voice.?studio/i);
});

test("the Speech group with a custom provider: one list, each order first-to-last with its controls, live read-only, tests that cost", () => {
  const info = speechInfo({ source: "file", exists: true, custom: [studio], order: { asr: [{ provider: "voice-studio" }, { gateway: "oa", model: "whisper-1" }], tts: [{ gateway: "oa", model: "tts-1", voice: "nova" }, { provider: "voice-studio" }] }, live: ["voice-studio"] });
  const html = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={info} t={zh} />);
  expect(html).toContain("<b>voice-studio</b><span class=\"gw-chip\">自定义</span>");
  expect(html).toContain("在本机");
  expect(html).toContain("实时对话: voice-studio · 实时对话不走网关");
  expect(html).toMatch(/<b>voice-studio<\/b> <small class="cli-dim">首先负责 · 自定义<\/small>/);
  expect(html).toMatch(/<b>oa<\/b> <small class="cli-dim">首先负责 · 经网关<\/small>/);
  expect(html).toContain('<option value="nova" selected="">nova</option>');
  expect(html).toContain('aria-label="把 voice-studio 移出这个顺序"');
  expect(html).toContain(">测试 TTS</button>");
  expect(html).toContain("云端厂商会收少量费用");
  // Somewhere else, or nowhere: said so.
  const away = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={{ ...info, custom: [{ ...studio, machine: "gpu-box" }] }} t={t} />);
  expect(away).toContain("On gpu-box");
  const lost = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={{ ...info, custom: [{ ...studio, located: false }] }} t={t} />);
  expect(lost).toContain("Not found on this machine or its peers");
  // A file the page cannot edit: no controls.
  const ro = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={{ ...info, readOnly: "one line" }} t={t} />);
  expect(ro).not.toContain("aria-label=\"Move up\"");
});

test("the Speech group with a vendor whose voices are many: pick a documented one or type another", () => {
  const mm = { name: "minimax", label: "MiniMax", serves: { asr: true as const, tts: true as const, image: "no openai base" }, asrModels: ["asr-1.0"], ttsModels: ["speech-2.8-hd"], imageModels: [], voices: { "speech-2.8-hd": ["English_Graceful_Lady", "Chinese (Mandarin)_News_Anchor"] }, voicesOpen: true };
  const info = speechInfo({ providers: [oa, mm], order: { asr: [{ gateway: "minimax", model: "asr-1.0" }], tts: [{ gateway: "minimax", model: "speech-2.8-hd", voice: "my-cloned-voice" }, { gateway: "oa", model: "tts-1", voice: "nova" }] } });
  const html = renderToStaticMarkup(<SpeechCard g={gw()} editable initial={info} t={t} />);
  expect(html).toMatch(/<input class="setselect" list="gw-voices-minimax"[^>]*value="my-cloned-voice"\/>/);
  expect(html).toContain('<datalist id="gw-voices-minimax"><option value="English_Graceful_Lady"></option><option value="Chinese (Mandarin)_News_Anchor"></option></datalist>');
  // A fixed list stays a choice.
  expect(html).toContain('<option value="nova" selected="">nova</option>');
});

test("the Image group: who can draw and why not, the picture model to test with, no picture tier, the URL rule", () => {
  const p = { ...base, name: "oa", models: ["gpt-image-1", "dall-e-3"], kinds: { "gpt-image-1": "image" as const, "dall-e-3": "image" as const }, serves: { text: "no messages base", asr: true as const, tts: true as const, image: true as const } };
  const html = renderToStaticMarkup(<ImageCard g={gw({ providers: [base, p], imageModels: ["oa/gpt-image-1", "oa/dall-e-3"] })} editable busy={false} t={t} />);
  expect(html).toContain("<b>oa</b> can draw (2 picture models)");
  expect(html).toContain("the vendor documents none");
  // The select only picks the test's model: the first is picked, there is no empty choice and no Save.
  expect(html).toContain("Test with");
  expect(html).toContain('<option value="oa/gpt-image-1" selected="">oa/gpt-image-1</option><option value="oa/dall-e-3">oa/dall-e-3</option>');
  expect(html).not.toContain(">Save</button>");
  expect(html).not.toContain(`<span>${t("gateway.imageTier")}</span>`);
  expect(html).not.toContain("gw-warn");
  expect(html).toContain(">Make a test picture</button>");
  expect(html).toContain("only over https from a public address");
  const empty = renderToStaticMarkup(<ImageCard g={gw()} editable busy={false} onAddProvider={noop} t={zh} />);
  expect(empty).toContain("添加能做这件事的服务商");
  expect(empty).not.toContain("生成一张测试图");
  // An old tiers.image in gateway.yaml: said to be ignored, in both languages.
  for (const tr of [t, zh]) expect(renderToStaticMarkup(<ImageCard g={gw({ providers: [p], imageModels: ["oa/gpt-image-1"], tiers: { image: "oa/gpt-image-1" } })} editable busy={false} t={tr} />)).toContain(tr("imageg.tierIgnored", { model: "oa/gpt-image-1" }).replace(/'/g, "&#x27;"));
});
