import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { GatewayPreset, GatewayProviderInfo } from "./api.ts";
import { AddProvider, GroupsEditor, ModelChooser, ProviderRow, RemoveForm } from "./GatewaySettings.tsx";
import { GatewayLink } from "./MachineClis.tsx";
import { translate } from "./messages.ts";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const zh = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("zh", key, vars);
const noop = () => {};
const run = async () => true;

const base: GatewayProviderInfo = { name: "ds", preset: "deepseek", label: "DeepSeek", messages: "https://api.deepseek.com/anthropic", auth: "bearer", key: { state: "workspace", last4: "abcd", page: true, variable: "SPACE_GATEWAY_DS_KEY" }, disabled: false, models: ["deepseek-v4-pro"], usedBy: { groups: [], tiers: [], emptied: [] } };

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
