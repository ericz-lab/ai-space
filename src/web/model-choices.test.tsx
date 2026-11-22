import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { MagpieInfo, MagpiePins } from "./api.ts";
import { CliCell, MagpieRow, MagpieTierPickers } from "./MachineClis.tsx";
import { ChoiceOption, SavedChoice } from "./model-choices.tsx";
import { translate } from "./messages.ts";

const t = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const noop = () => {};

test("a choice that is not signed in, or on an offline machine, is shown greyed with the reason", () => {
  expect(renderToStaticMarkup(<ChoiceOption o={{ value: "codex/basic" }} label="Basic · luna" t={t} />)).toBe('<option value="codex/basic">Basic · luna</option>');
  expect(renderToStaticMarkup(<ChoiceOption o={{ value: "codex/basic", unavailable: "signed-out" }} label="Basic · luna" t={t} />)).toBe('<option value="codex/basic" disabled="">Basic · luna (not signed in)</option>');
  expect(renderToStaticMarkup(<ChoiceOption o={{ value: "david:codex/basic", unavailable: "offline" }} label="Basic · luna" t={t} />)).toContain("(offline)");
});

test("a saved choice no longer offered stays, marked and not pickable", () => {
  expect(renderToStaticMarkup(<SavedChoice value="claude/opus" t={t} />)).toBe('<option value="claude/opus" disabled="">claude/opus (not available)</option>');
});

test("the inventory cell: missing, signed out, a runtime, and an add button only on this machine", () => {
  const base = { cli: "codex", kind: "codex-cli", configured: false, runtimes: [] };
  expect(renderToStaticMarkup(<CliCell c={{ ...base, installed: false }} local busy={false} onAdd={noop} t={t} />)).toContain("Not installed");
  expect(renderToStaticMarkup(<CliCell c={base} local busy={false} onAdd={noop} t={t} />)).toContain("Not checked yet");
  const here = renderToStaticMarkup(<CliCell c={{ ...base, installed: true, signedIn: false, version: "0.50.0" }} local busy={false} onAdd={noop} t={t} />);
  expect(here).toContain("0.50.0");
  expect(here).toContain("Not signed in");
  expect(here).toContain("Add to runtimes.yaml");
  const peer = renderToStaticMarkup(<CliCell c={{ ...base, installed: true, signedIn: true }} local={false} busy={false} onAdd={noop} t={t} />);
  expect(peer).not.toContain("Add to runtimes.yaml");
  expect(peer).toContain("Not a runtime there");
  expect(renderToStaticMarkup(<CliCell c={{ ...base, installed: true, configured: true, runtimes: ["codex"] }} local busy={false} onAdd={noop} t={t} />)).toContain("Runtime: codex");
});

test("magpie: a pointer when absent, a start hint when down, tier pickers and add when it answers", () => {
  const base: MagpieInfo = { url: "http://127.0.0.1:3425", running: false, models: [], groups: [], configured: false, runtimes: [], pins: [], suggested: {}, adds: "claude-code" };
  const row = (m: Partial<MagpieInfo>) => renderToStaticMarkup(<MagpieRow m={{ ...base, ...m }} busy={false} onAdd={noop} onSave={noop} t={t} />);
  expect(row({})).toContain("GLM, Kimi, MiniMax");
  expect(row({ bin: "/usr/local/bin/magpie" })).toContain("does not answer at http://127.0.0.1:3425");
  const up = row({ running: true, models: ["zhipu/glm-4.6", "group/basic"], groups: ["group/basic"], suggested: { basic: "group/basic" } });
  expect(up).toContain("with 2 models");
  // Four pickers, routing groups apart and marked, the suggested group picked, the rest Claude Code's default.
  for (const tier of ["Basic", "Junior", "Intermediate", "Advanced"]) expect(up).toContain(`<span>${tier}</span>`);
  expect(up).toContain('<optgroup label="Routing groups"><option value="group/basic" selected="">group/basic (routing group)</option></optgroup>');
  expect(up).toContain('<optgroup label="Models"><option value="zhipu/glm-4.6">zhipu/glm-4.6</option></optgroup>');
  expect(up.match(/<option value="" selected="">Claude Code&#x27;s default<\/option>/g)).toHaveLength(3);
  expect(up).toContain("Add as a runtime");
  expect(row({ running: true, models: ["a/b"], adds: "anthropic-api" })).toContain("answers apps&#x27; calls only");
  expect(row({ running: true })).toContain("no model yet");
});

test("magpie tier pickers of a runtime: saved pins shown, a pin no longer listed warned, saved values kept while magpie is down", () => {
  const pins: MagpiePins = { runtime: "magpie", kind: "claude-code", models: { basic: "zhipu/glm-4.6", advanced: "gone/model" }, loaded: true };
  const m: MagpieInfo = { url: "http://127.0.0.1:3425", running: true, models: ["zhipu/glm-4.6", "group/fast"], groups: ["group/fast"], configured: true, runtimes: ["magpie"], pins: [pins], suggested: {}, adds: "claude-code" };
  const up = renderToStaticMarkup(<MagpieRow m={m} busy={false} onAdd={noop} onSave={noop} t={t} />);
  expect(up).toContain("used by runtime magpie");
  expect(up).toContain("Runtime magpie");
  expect(up).toContain('<option value="zhipu/glm-4.6" selected="">zhipu/glm-4.6</option>');
  expect(up).toContain('<option value="gone/model" selected="">gone/model (no longer listed)</option>');
  expect(up).toContain("magpie no longer lists this model");
  expect(up).toContain("Save");
  const pending = renderToStaticMarkup(<MagpieTierPickers m={m} pins={{ ...pins, loaded: false }} busy={false} onSave={noop} t={t} />);
  expect(pending).toContain("Restart ai-space");

  const down = renderToStaticMarkup(<MagpieRow m={{ ...m, running: false, models: [], groups: [] }} busy={false} onAdd={noop} onSave={noop} t={t} />);
  expect(down).toContain("The saved models are shown");
  expect(down).toContain('<option value="gone/model" selected="">gone/model</option>');
  expect(down).not.toContain("no longer lists");
  expect(down).toContain('disabled=""');
});
