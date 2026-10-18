/** Ordered work shared by Claude and Codex's normalized stream events. */
export type ChatStep = { id: string; kind: "text" | "tool"; name: string; text: string; output: string; state: "running" | "completed" | "failed" | "incomplete" };
type Block = { type: string; id?: string; name?: string; text?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
type Event = { type: string; message?: { content?: Block[] }; event?: { delta?: { type?: string; text?: string } } };
const detail = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.slice(0, 12000);
  if (Array.isArray(value)) {
    const texts = value.flatMap((v) => v?.type === "text" && typeof v.text === "string" ? [v.text] : []);
    if (texts.length) return texts.join("\n").slice(0, 12000);
  }
  return (JSON.stringify(value, null, 2) ?? "").slice(0, 12000);
};

export class ChatSteps {
  steps: ChatStep[] = [];
  private streaming: string | undefined;
  private serial = 0;

  private text(text: string, final: boolean) {
    const current = this.steps.find((s) => s.id === this.streaming);
    if (current) {
      current.text = final ? text : current.text + text;
      if (final) current.state = "completed";
    } else {
      const id = `text:${++this.serial}`;
      this.steps.push({ id, kind: "text", name: "", text, output: "", state: final ? "completed" : "running" });
      if (!final) this.streaming = id;
    }
    if (final) this.streaming = undefined;
  }

  apply(event: Event) {
    if (event.type === "stream_event" && event.event?.delta?.type === "text_delta") this.text(event.event.delta.text ?? "", false);
    for (const block of event.message?.content ?? []) {
      if (event.type === "assistant" && block.type === "text" && block.text) this.text(block.text, true);
      if (event.type === "assistant" && block.type === "tool_use" && block.id) {
        const id = `tool:${block.id}`;
        const input = block.input && typeof block.input === "object" ? block.input as Record<string, unknown> : {};
        const hint = detail(input.command ?? input.file_path ?? input.path ?? input.query ?? input.url ?? block.input);
        const current = this.steps.find((s) => s.id === id);
        if (current) { if (hint) current.text = hint; }
        else this.steps.push({ id, kind: "tool", name: block.name ?? "tool", text: hint, output: "", state: "running" });
      }
      if (event.type === "user" && block.type === "tool_result") {
        const current = this.steps.find((s) => s.id === `tool:${block.tool_use_id}`);
        if (current) { current.output = detail(block.content); current.state = block.is_error ? "failed" : "completed"; }
      }
    }
    if (event.type === "done") this.finish();
  }

  finish() {
    for (const step of this.steps) if (step.state === "running") step.state = step.kind === "tool" ? "incomplete" : "completed";
  }

  snapshot(): ChatStep[] { return this.steps.map((step) => ({ ...step })); }
}

/** Safari can report the IME confirmation key as keyCode 229 after compositionend. */
export const submitsChat = (key: string, shift: boolean, composing: boolean, keyCode: number) => key === "Enter" && !shift && !composing && keyCode !== 229;
