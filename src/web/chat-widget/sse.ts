/** One event of a `text/event-stream` body. */
export type SseEvent = { event: string; data: string };

/** Read a `text/event-stream` body event by event; comment lines (the keepalive) are skipped, `data:` lines of one event are joined. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let rest = "";
  let event = "message";
  let data: string[] = [];
  const flush = (): SseEvent | null => {
    const out = data.length ? { event, data: data.join("\n") } : null;
    event = "message";
    data = [];
    return out;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += dec.decode(value, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line === "") {
        const ev = flush();
        if (ev) yield ev;
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  const last = flush();
  if (last) yield last;
}
