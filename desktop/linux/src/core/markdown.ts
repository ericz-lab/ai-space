/**
 * An agent's reply as blocks a GTK label can show: Pango markup for paragraphs, headings, list
 * items and quotes, and plain text for code and tables, which the view sets in a monospace,
 * horizontally scrolling box. The inline rules follow the web panel's `src/web/chat-markdown.ts`:
 * code spans, escapes, links (http and https only), bare URLs, bold and italics. Anything else
 * stays as text, escaped, so a reply can never inject markup.
 */

export type MdBlock =
  | { kind: "paragraph"; markup: string }
  | { kind: "heading"; level: number; markup: string }
  | { kind: "item"; depth: number; bullet: string; markup: string }
  | { kind: "quote"; markup: string }
  | { kind: "code"; text: string; lang: string }
  | { kind: "table"; text: string }
  | { kind: "rule" };

export const escapeMarkup = (s: string) => s.replace(/[&<>"'\x00]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\x00": "" })[c]!);

const BARE_URL = /https?:\/\/[^\s<>　-〿一-鿿＀-￯]+/g;
const trimUrl = (u: string) => u.replace(/[),.;:!?'"*]+$/, "");

export function inlineMarkup(source: string): string {
  const slots: string[] = [];
  const stash = (m: string) => `\x00${slots.push(m) - 1}\x00`;
  const link = (url: string, label: string) => `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`;
  return escapeMarkup(source)
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code: string) => stash(`<tt>${code}</tt>`))
    .replace(/\\([\\`*{}_\[\]()#+.!|>-])/g, (_, c: string) => stash(c))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label: string, url: string) => stash(link(url, label)))
    .replace(BARE_URL, (url) => {
      const clean = trimUrl(url);
      return stash(link(clean, clean)) + url.slice(clean.length);
    })
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__([^_]+)__/g, "<b>$1</b>")
    .replace(/\*([^*\s][^*]*)\*/g, "<i>$1</i>")
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,!?]|$)/g, "$1<i>$2</i>")
    .replace(/\x00(\d+)\x00/g, (_, i: string) => slots[Number(i)] ?? "");
}

const LIST_ITEM = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((s) => s.trim());
}

/** A table drawn in text columns, so it reads in a monospace box. */
function tableText(rows: string[][]): string {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  const line = (r: string[]) => r.map((c, i) => c + " ".repeat((widths[i] ?? 0) - [...c].length)).join("  ").trimEnd();
  const [head, ...body] = rows;
  return [line(head ?? []), widths.map((w) => "─".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

export function markdownBlocks(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: "paragraph", markup: inlineMarkup(para.join("\n")) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(t);
    if (fence) {
      flush();
      const marker = fence[1]!;
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(marker); i++) code.push(lines[i]!);
      out.push({ kind: "code", text: code.join("\n"), lang: fence[2]!.trim() });
      continue;
    }
    if (!t) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(t);
    if (heading) {
      flush();
      out.push({ kind: "heading", level: heading[1]!.length, markup: inlineMarkup(heading[2]!) });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(t)) {
      flush();
      out.push({ kind: "rule" });
      continue;
    }
    if (t.startsWith("|") && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!.trim())) {
      flush();
      const rows = [cells(t)];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith("|"); i++) rows.push(cells(lines[i]!));
      i--;
      out.push({ kind: "table", text: tableText(rows) });
      continue;
    }
    if (t.startsWith(">")) {
      flush();
      const quote = [t.replace(/^>\s?/, "")];
      while (i + 1 < lines.length && lines[i + 1]!.trim().startsWith(">")) quote.push(lines[++i]!.trim().replace(/^>\s?/, ""));
      out.push({ kind: "quote", markup: inlineMarkup(quote.join("\n")) });
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const depth = Math.floor(item[1]!.replace(/\t/g, "    ").length / 2);
      const bullet = /\d/.test(item[2]!) ? item[2]!.replace(")", ".") : "•";
      let text = item[3]!;
      // A wrapped item continues on indented lines that start no new item.
      while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]!) && !LIST_ITEM.test(lines[i + 1]!)) text += `\n${lines[++i]!.trim()}`;
      out.push({ kind: "item", depth, bullet, markup: inlineMarkup(text) });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}
