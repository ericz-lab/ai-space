/**
 * Server-sent events as src/space/agents/runtime.ts writes them: an optional `id: <seq>` line,
 * then one `data:` line per event; `:` lines are keep-alives (the Mac's `SSEParser`).
 */
export type SSEMessage = { id?: number; data: string };

export class SSEParser {
  private id: number | undefined;

  feed(rawLine: string): SSEMessage | undefined {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      this.id = undefined;
      return undefined;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id") {
      const n = Number(value);
      this.id = Number.isInteger(n) ? n : undefined;
      return undefined;
    }
    if (field === "data") {
      const msg: SSEMessage = this.id === undefined ? { data: value } : { id: this.id, data: value };
      this.id = undefined;
      return msg;
    }
    return undefined;
  }
}

/** Splits text that arrives in pieces into whole lines; the last, unfinished one waits for more. */
export class LineSplitter {
  private rest = "";

  push(chunk: string): string[] {
    const text = this.rest + chunk;
    const lines = text.split("\n");
    this.rest = lines.pop() ?? "";
    return lines;
  }

  end(): string[] {
    const last = this.rest;
    this.rest = "";
    return last ? [last] : [];
  }
}
