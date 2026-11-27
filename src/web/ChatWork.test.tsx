import { expect, test } from "bun:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DelegationView } from "../space/agents/delegation-view.ts";
import { DelegationResult, DelegationStep, RunSteps } from "./ChatWork.tsx";
import { LangContext } from "./i18n.ts";
import { liveWords, personWords } from "./Orders.tsx";

const view = (over: Partial<DelegationView> = {}): DelegationView => ({
  id: 3, label: "Delegation #3", from: { agent: "space/director", session: "s1" },
  to: { agent: "space/engineer", role: "engineer", title: "Engineer", machine: "", session: "sess-2", runId: "run-2" },
  state: "done", permission: "full", orderId: 1, continued: null, createdAt: "2026-11-26T10:00:00Z", endedAt: "2026-11-26T10:05:00Z",
  notes: [
    { seq: 1, at: "2026-11-26T10:00:00Z", kind: "brief", text: "Goal: fix the header.\nWhere: app-src/notes" },
    { seq: 2, at: "2026-11-26T10:01:00Z", kind: "say", text: "also the footer", taken: true, readAt: "2026-11-26T10:01:30Z" },
    { seq: 3, at: "2026-11-26T10:02:00Z", kind: "say", text: "and the logo", taken: false, reason: "ended" },
    { seq: 4, at: "2026-11-26T10:05:00Z", kind: "result", text: "Fixed **both**." },
  ],
  delivered: "turn", asking: [], unreachableSince: null, ...over,
});
const render = (el: ReturnType<typeof h>, lang: "en" | "zh" = "en") => renderToStaticMarkup(h(LangContext.Provider, { value: lang }, el));

test("a delegation shows who, its state, the brief, each added message's fate, the result, the link and the Full mark", () => {
  const html = render(h(DelegationStep, { delegation: view() }));
  expect(html).toContain("chat-delegation done");
  expect(html).toContain("To Engineer");
  expect(html).toContain("full-mark");
  expect(html).toContain("Goal: fix the header.");
  expect(html).toContain("also the footer");
  expect(html).toContain("chat-dlg-fate read");
  expect(html).toContain("not taken: the delegate&#x27;s turn had ended");
  expect(html).toContain("<strong>both</strong>");
  expect(html).toContain(`href="/?page=chat&amp;agent=space%2Fengineer&amp;session=sess-2"`);
  // Only a followed, running delegation offers Stop.
  expect(html).not.toContain("Stop the delegation");
  const running = render(h(DelegationStep, { delegation: view({ state: "waiting", permission: "edit", asking: ["Bash: rm -rf build"] }), follow: true }), "zh");
  expect(running).toContain("停止委派");
  expect(running).toContain("Bash: rm -rf build");
  expect(running).not.toContain("full-mark");
});

test("a delegation known only by id waits for its record", () => {
  expect(render(h(DelegationStep, { id: 9 }))).toContain("Delegation #9");
});

test("a delivered result is folded to its header", () => {
  const html = render(h(DelegationResult, { text: "〔Delegation #3 · engineer · done〕\nFixed the header." }));
  expect(html).toContain("Result of delegation #3 · engineer");
  expect(html).toContain("Done");
  expect(html).toContain("Fixed the header.");
  expect(html).not.toContain("〔");
});

test("a followed run's steps: text through the caller's filter, a waiting approval answerable only while live", () => {
  const steps = [
    { id: "text:1", kind: "text" as const, name: "", text: "On it.\n\n〔状态: needs-you〕", output: "", state: "completed" as const },
    { id: "approval:r1", kind: "approval" as const, name: "Bash", text: "rm a", output: "", state: "waiting" as const },
    { id: "steer:1", kind: "steer" as const, name: "", text: "〔Delegation #3 · engineer · done〕\nok", output: "", state: "completed" as const },
  ];
  const live = render(h(RunSteps, { steps, live: true, text: liveWords, onAnswer: async () => null }));
  expect(live).toContain("On it.");
  expect(live).not.toContain("状态");
  expect(live).toContain("chat-approval-actions");
  expect(live).toContain("chat-dlg-result");
  expect(render(h(RunSteps, { steps, live: false, onAnswer: async () => null }))).not.toContain("chat-approval-actions");
});

test("the Director's status line is hidden while it is still being written", () => {
  expect(liveWords("Done.\n\n〔状态: done〕")).toBe("Done.");
  expect(liveWords("Done.\n〔状态: ne")).toBe("Done.");
  expect(liveWords("Done.\n〔")).toBe("Done.");
  expect(liveWords("Done.\n[status: need")).toBe("Done.");
  expect(liveWords("See 〔this〕 and [that](x)")).toBe("See 〔this〕 and [that](x)");
  expect(personWords("〔Order #12 · spoken〕\nfix it")).toBe("fix it");
});
