import { useState, type ReactNode } from "react";
import { allCommands, toolSummary, toolVariant, type ChatStep, type ToolVariant } from "./chat-steps.ts";
import { useLang } from "./i18n.ts";

/** Line glyphs on a 16px grid, drawn in the row's text color (after DeepSeek Harness's tool rows). */
const GLYPHS: Record<ToolVariant | "chevron" | "shield" | "question" | "history" | "compose" | "stop" | "send" | "down" | "attach", ReactNode> = {
  bash: <><path d="M3 4L7 8L3 12" /><path d="M9 12H13" /></>,
  read: <><path d="M4.9 5.9H11.1" /><path d="M4.9 9H8.3" /><rect x="2.5" y="1.8" width="11" height="12.4" rx="1.2" /></>,
  write: <><path d="M8.9 2.2H4.2C3.1 2.2 2.2 3.1 2.2 4.2V11.8C2.2 12.9 3.1 13.8 4.2 13.8H11.8C12.9 13.8 13.8 12.9 13.8 11.8V7.9" /><path d="M7.8 8.2L13.9 2.1" /></>,
  edit: <><path d="M8.9 2.2H4.2C3.1 2.2 2.2 3.1 2.2 4.2V11.8C2.2 12.9 3.1 13.8 4.2 13.8H11.8C12.9 13.8 13.8 12.9 13.8 11.8V7.9" /><path d="M7.8 8.2L13.9 2.1" /></>,
  search: <><circle cx="6.6" cy="6.5" r="5.2" /><path d="M10.3 10.4L14.8 14.9" /></>,
  web: <><circle cx="8" cy="8" r="6.3" /><path d="M1.7 8H14.3" /><path d="M8 1.7C9.8 3.5 10.6 5.7 10.6 8S9.8 12.5 8 14.3C6.2 12.5 5.4 10.3 5.4 8S6.2 3.5 8 1.7Z" /></>,
  code: <><path d="M6.3 1.5L4.5 14.5" /><path d="M11.5 1.5L9.7 14.5" /><path d="M2.4 5.5H14.1" /><path d="M1.9 10.5H13.6" /></>,
  task: <path d="M8 1.8L9.5 6.5L14.2 8L9.5 9.5L8 14.2L6.5 9.5L1.8 8L6.5 6.5Z" />,
  plan: <><path d="M5.5 4H13.5" /><path d="M5.5 8H13.5" /><path d="M5.5 12H13.5" /><circle cx="2.8" cy="4" r=".6" /><circle cx="2.8" cy="8" r=".6" /><circle cx="2.8" cy="12" r=".6" /></>,
  other: <><circle cx="8" cy="8" r="1.8" /><path d="M8 1.5V4.2M8 11.8V14.5M1.5 8H4.2M11.8 8H14.5M3.4 3.4L5.3 5.3M10.7 10.7L12.6 12.6M3.4 12.6L5.3 10.7M10.7 5.3L12.6 3.4" /></>,
  chevron: <path d="M4 6L7.3 9.3C7.7 9.7 8.3 9.7 8.7 9.3L12 6" />,
  history: <><path d="M2.6 8A5.4 5.4 0 1 0 4.2 4.2" /><path d="M2.4 2.4V4.6H4.6" /><path d="M8 5V8L10.2 9.4" /></>,
  compose: <><path d="M7.4 2.6H4.4C3.4 2.6 2.6 3.4 2.6 4.4V11.6C2.6 12.6 3.4 13.4 4.4 13.4H11.6C12.6 13.4 13.4 12.6 13.4 11.6V8.6" /><path d="M11.6 1.9L14.1 4.4L8.4 10.1L5.6 10.4L5.9 7.6Z" /></>,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.6" fill="currentColor" />,
  send: <><path d="M8 13.2V3.2" /><path d="M3.6 7.4L8 3L12.4 7.4" /></>,
  down: <><path d="M8 2.8V12.8" /><path d="M3.6 8.6L8 13L12.4 8.6" /></>,
  attach: <path d="M13.2 7.6L8.1 12.7C6.7 14.1 4.5 14.1 3.1 12.7C1.7 11.3 1.7 9.1 3.1 7.7L8.4 2.4C9.3 1.5 10.8 1.5 11.7 2.4C12.6 3.3 12.6 4.8 11.7 5.7L6.6 10.8C6.1 11.3 5.4 11.3 4.9 10.8C4.4 10.3 4.4 9.6 4.9 9.1L9.6 4.4" />,
  question: <><circle cx="8" cy="8" r="6.3" /><path d="M6.2 6.3C6.2 5.2 7 4.5 8 4.5S9.8 5.2 9.8 6.2C9.8 7.5 8 7.7 8 9.1" /><path d="M8 11.3V11.4" /></>,
  shield: <><path d="M6.8 2.1C7.7 1.8 8.7 1.8 9.6 2.1L14.1 3.8V7.1C14.1 11.6 10.8 13.6 8.2 14.6C5.6 13.6 2.3 11.6 2.3 7.1V3.8L6.8 2.1Z" /><path d="M8.2 5.5V8.6" /><path d="M8.2 10.6V10.7" /></>,
};
export const Glyph = ({ name, className, size = 14, weight = 1.1 }: { name: keyof typeof GLYPHS; className?: string; size?: number; weight?: number }) =>
  <svg className={className} width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{GLYPHS[name]}</svg>;

/**
 * One tool call as a quiet single line: glyph, title, the call's first line. A running call
 * shimmers; once it ends its dot says so, red for a failure and green for a success. A click opens
 * the full input and output.
 */
export function WorkStep({ step }: { step: ChatStep }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const variant = toolVariant(step.name);
  const title = variant === "other" ? step.name.replace(/^mcp__/, "").replace(/__/g, " · ") : t(`chat.tool.${variant}`);
  const summary = toolSummary(step.text);
  const expandable = !!step.output || step.text.trim() !== summary;
  const cue = step.state === "failed" || step.state === "incomplete" || step.state === "running" ? t(`chat.step.${step.state}`) : "";
  return <div className={`chat-tool ${step.state}${open ? " open" : ""}`} aria-label={step.name}>
    <button type="button" className="chat-tool-row" disabled={!expandable} aria-expanded={expandable ? open : undefined} onClick={() => setOpen(!open)} title={step.text || step.name}>
      <span className="chat-tool-lead"><Glyph name={variant} className="chat-tool-glyph" />{expandable && <Glyph name="chevron" className="chat-tool-chevron" />}</span>
      <span className="chat-tool-title">{title}</span>
      {summary && <><span className="chat-tool-sep" aria-hidden="true" /><span className="chat-tool-summary">{summary}</span></>}
      {cue && <span className="chat-tool-cue">{cue}</span>}
    </button>
    {open && <div className="chat-tool-io">
      {step.text && <div><span>{t("chat.step.in")}</span><pre>{step.text}</pre></div>}
      {step.output && <div className={step.state === "failed" ? "failed" : ""}><span>{t("chat.step.out")}</span><pre>{step.output}{step.output.length >= 12000 && <small>{"\n"}{t("chat.step.truncated")}</small>}</pre></div>}
    </div>}
  </div>;
}

/**
 * A run of tool calls from a past session, folded to one line: what kind of work ran and how many
 * calls, with the calls themselves one click away. Following DeepSeek Harness's process fold, a
 * transcript opens on its answers rather than on its commands.
 */
export function ToolGroup({ steps, folded }: { steps: ChatStep[]; folded: boolean }) {
  const { t } = useLang();
  const [open, setOpen] = useState(!folded);
  return <div className={`chat-tool-group${open ? " open" : ""}`}>
    <button type="button" className="chat-tool-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
      <span className="chat-tool-lead"><Glyph name="chevron" className="chat-tool-chevron" /></span>
      <span className="chat-tool-group-title">{allCommands(steps) ? t("chat.tools.commands") : t("chat.tools.called")}</span>
      <span className="chat-tool-group-count">{steps.length}</span>
    </button>
    {open && <div className="chat-tools">{steps.map((step) => <WorkStep key={step.id} step={step} />)}</div>}
  </div>;
}
