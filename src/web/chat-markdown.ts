// Escape before emitting markup. User-supplied HTML and non-HTTP links stay inert.
const escape = (s: string) => s.replace(/[&<>"\x00]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "\x00": "" })[c]!);
export const BARE_URL = /https?:\/\/[^\s<>　-〿一-鿿＀-￯]+/g;
export const trimUrl = (u: string) => u.replace(/[),.;:!?'"*]+$/, "");
function inline(source: string): string {
  const slots: string[] = [];
  const stash = (html: string) => `\x00${slots.push(html) - 1}\x00`;
  const link = (url: string, label: string) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  return escape(source)
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks, code: string) => stash(`<code>${code}</code>`))
    .replace(/\\([\\`*{}_\[\]()#+.!|>-])/g, (_, c: string) => stash(c))
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_, label: string, url: string) => stash(link(url, label)))
    .replace(BARE_URL, (url) => { const clean = trimUrl(url); return stash(link(clean, clean)) + url.slice(clean.length); })
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,!?]|$)/g, "$1<em>$2</em>")
    .replace(/\x00(\d+)\x00/g, (_, index: string) => slots[Number(index)] ?? "");
}
function cells(line: string): string[] {
  const parts = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/);
  return parts.map((s) => s.trim());
}
const listItem = /^(\s*)([-+*]|\d+[.)])\s+(.*)$/;

/** Small streaming-friendly renderer, shared by final replies and individual work messages. */
export function mdHtml(source: string): string {
  const lines = source.split("\n");
  let out = "";
  const lists: { indent: number; tag: "ol" | "ul" }[] = [];
  const closeList = () => { const list = lists.pop()!; out += `</li></${list.tag}>`; };
  const closeLists = () => { while (lists.length) closeList(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    const fence = /^(`{3,}|~{3,})(.*)$/.exec(t);
    if (fence) {
      closeLists();
      const code: string[] = [];
      const marker = fence[1]!;
      while (++i < lines.length) {
        if (new RegExp(`^${marker[0]}{${marker.length},}\\s*$`).test(lines[i]!.trim())) break;
        code.push(lines[i]!);
      }
      out += `<pre>${escape(code.join("\n"))}</pre>`;
      continue;
    }
    const separators = cells(lines[i + 1] ?? "");
    if (line.includes("|") && separators.length && separators.every((c) => /^:?-{3,}:?$/.test(c))) {
      closeLists();
      const headers = cells(line);
      if (headers.length === separators.length) {
        const cell = (value: string, index: number, tag: string) => {
          const sep = separators[index]!;
          const align = sep.startsWith(":") && sep.endsWith(":") ? "center" : sep.endsWith(":") ? "right" : "left";
          return `<${tag} style="text-align:${align}">${inline(value)}</${tag}>`;
        };
        out += `<div class="tblwrap"><table><thead><tr>${headers.map((c, j) => cell(c, j, "th")).join("")}</tr></thead><tbody>`;
        i++;
        while (i + 1 < lines.length && lines[i + 1]!.includes("|") && lines[i + 1]!.trim()) {
          const row = cells(lines[++i]!);
          out += `<tr>${headers.map((_, j) => cell(row[j] ?? "", j, "td")).join("")}</tr>`;
        }
        out += "</tbody></table></div>";
        continue;
      }
    }
    if (!t) continue;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closeLists(); out += "<hr>"; continue; }
    const item = listItem.exec(line);
    if (item) {
      const indent = item[1]!.replace(/\t/g, "    ").length;
      const tag = /^\d/.test(item[2]!) ? "ol" : "ul";
      while (lists.length && lists.at(-1)!.indent > indent) closeList();
      if (lists.length && lists.at(-1)!.indent === indent && lists.at(-1)!.tag !== tag) closeList();
      if (lists.at(-1)?.indent === indent) out += "</li><li>";
      else {
        out += `<${tag}${tag === "ol" ? ` start="${parseInt(item[2]!, 10)}"` : ""}><li>`;
        lists.push({ indent, tag });
      }
      out += inline(item[3]!);
      continue;
    }
    closeLists();
    const heading = /^(#{1,6})\s+(.+)$/.exec(t);
    if (heading) out += `<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`;
    else if (t.startsWith("> ")) out += `<blockquote>${inline(t.slice(2))}</blockquote>`;
    else out += `<p>${inline(t)}</p>`;
  }
  closeLists();
  return out;
}
