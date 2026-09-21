/**
 * A small Markdown renderer for the answers, with no dependency: headings,
 * lists, tables, quotes, rules, fenced code, bold, italics, inline code,
 * images and links. Everything is escaped first, so an answer cannot inject
 * markup. Images may point to the app's own origin (`/…`) or https.
 */
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function inline(s: string): string {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(((?:\/|https?:)[^)\s"]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\((https?:[^)\s"]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

function table(rows: string[][]): string {
  const [h, ...body] = rows;
  return `<div class="sc-tbl"><table><thead><tr>${(h ?? []).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

export function renderMd(src: string): string {
  let out = "";
  let list: "ul" | "ol" | null = null;
  let tbl: string[][] | null = null;
  let fence: string[] | null = null;
  let para: string[] = [];
  const closePara = () => { if (para.length) { out += `<p>${para.map(inline).join("<br>")}</p>`; para = []; } };
  const closeList = () => { if (list) { out += `</${list}>`; list = null; } };
  const closeTable = () => { if (tbl) { out += table(tbl); tbl = null; } };
  const openList = (tag: "ul" | "ol") => { if (list !== tag) { closeList(); out += `<${tag}>`; list = tag; } };

  for (const line of String(src ?? "").split("\n")) {
    const t = line.trim();
    if (t.startsWith("```")) {
      if (fence === null) { closePara(); closeList(); closeTable(); fence = []; }
      else { out += `<pre><code>${esc(fence.join("\n"))}</code></pre>`; fence = null; }
      continue;
    }
    if (fence !== null) { fence.push(line); continue; }
    if (t.startsWith("|") && t.endsWith("|") && t.length > 2) {
      closePara(); closeList();
      if (!tbl) tbl = [];
      if (!/^\|[\s:|-]+\|$/.test(t)) tbl.push(t.slice(1, -1).split("|").map((c) => inline(c.trim())));
      continue;
    }
    closeTable();
    if (!t) { closePara(); closeList(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { closePara(); closeList(); out += "<hr>"; continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(t);
    if (h) { closePara(); closeList(); const n = Math.min(4, h[1]!.length + 1); out += `<h${n}>${inline(h[2]!)}</h${n}>`; continue; }
    if (t.startsWith(">")) { closePara(); closeList(); out += `<blockquote>${inline(t.replace(/^>\s?/, ""))}</blockquote>`; continue; }
    if (/^[-*+] \[[ xX]\] /.test(t)) { closePara(); openList("ul"); out += `<li class="sc-task ${/\[[xX]\]/.test(t) ? "sc-done" : ""}">${inline(t.slice(6))}</li>`; continue; }
    if (/^[-*+] /.test(t)) { closePara(); openList("ul"); out += `<li>${inline(t.slice(2))}</li>`; continue; }
    if (/^\d+\. /.test(t)) { closePara(); openList("ol"); out += `<li>${inline(t.replace(/^\d+\. /, ""))}</li>`; continue; }
    if (/^!\[[^\]]*\]\([^)]+\)$/.test(t)) { closePara(); closeList(); out += `<figure>${inline(t)}</figure>`; continue; }
    closeList();
    para.push(t);
  }
  if (fence !== null) out += `<pre><code>${esc(fence.join("\n"))}</code></pre>`;
  closePara(); closeList(); closeTable();
  return out;
}
