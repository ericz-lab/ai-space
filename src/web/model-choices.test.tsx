import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CliCell, MagpieRow } from "./MachineClis.tsx";
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

test("magpie: a pointer when absent, a start hint when down, a model picker and add when it answers, its runtime once used", () => {
  const base = { url: "http://127.0.0.1:3425", running: false, models: [] as string[], configured: false, runtimes: [] as string[], adds: "claude-code" as const };
  const row = (m: Partial<typeof base> & { bin?: string }, pending = false) => renderToStaticMarkup(<MagpieRow m={{ ...base, ...m }} pending={pending} busy={false} onAdd={noop} t={t} />);
  expect(row({})).toContain("GLM, Kimi, MiniMax");
  expect(row({ bin: "/usr/local/bin/magpie" })).toContain("does not answer at http://127.0.0.1:3425");
  const up = row({ running: true, models: ["zhipu/glm-4.6", "moonshot/kimi-k2.5"] });
  expect(up).toContain("with 2 models");
  expect(up).toContain('<option value="moonshot/kimi-k2.5">moonshot/kimi-k2.5</option>');
  expect(up).toContain("Add as a runtime");
  expect(up).toContain("Claude Code runs through magpie");
  expect(row({ running: true, models: ["a/b"], adds: "anthropic-api" } as never)).toContain("answers apps&#x27; calls only");
  expect(row({ running: true })).toContain("no model yet");
  expect(row({ running: true, models: ["a/b"] }, true)).toContain("Restart ai-space");
  expect(row({ running: true, models: ["a/b"], configured: true, runtimes: ["magpie"] })).toContain("used by runtime magpie");
});
