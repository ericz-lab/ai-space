#!/usr/bin/env bun
// Icon packs for the ai-space panel (docs/panel.md#icon-packs): list the tiles, preview a drawn set,
// upload it as a pack, switch packs. The drawing itself is the agent's, in the style the operator asked for.
//
//   bun icons.ts tiles   [--dir D]                 every tile on the panel → D/tiles.json (and a table)
//   bun icons.ts current --dir D                   download the manifests' icons into D/current/ (reference only)
//   bun icons.ts preview --dir D [--out F] [--only a,b]  contact sheet of D/app/*, D/agent/* → D/preview.png (or .html)
//   bun icons.ts install --dir D --pack P [--activate] [--only a,b]   upload D/app/*, D/agent/* into pack P
//   bun icons.ts use P|none                        make P the active pack, or go back to the manifests' icons
//   bun icons.ts packs                             the packs on this panel and the active one
//   bun icons.ts export --pack P --dir D           download pack P into D (to edit it later)
//   bun icons.ts remove --pack P [--app ID | --agent ID]   one icon, or the whole pack
//
// Files are named like the pack on the server: D/app/<id>.svg|png|webp and D/agent/<id>.svg|png|webp,
// with the tile id's "/" written as "~" (notes, david~media, notes~librarian, space~assistant, space~settings).
// The space: SPACE_API_URL, else SPACE_HOST/SPACE_PORT from the environment or <SPACE_HOME>/.env, else 127.0.0.1:8700.

import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

type Kind = "app" | "agent";
type Tile = { kind: Kind; id: string; file: string; title: string; description?: string; app?: string; peer?: string; icon: string; builtin?: boolean };

const TYPES: Record<string, string> = { svg: "image/svg+xml", png: "image/png", webp: "image/webp" };
const BUILTINS: { id: string; title: string; description: string }[] = [
  { id: "space/inbox", title: "Inbox · 收件箱", description: "The panel's inbox: every app's notifications as threads." },
  { id: "space/terminal", title: "Terminal · 终端", description: "A shell on the machine, in the browser." },
  { id: "space/settings", title: "Settings · 设置", description: "The panel's settings: appearance, services, backups, peers." },
];

// ------------------------------------------------------------------ the space

async function envFile(): Promise<Record<string, string>> {
  const home = process.env.SPACE_HOME?.replace(/^~(?=$|\/)/, homedir()) || join(homedir(), ".ai-space");
  const text = await Bun.file(join(home, ".env")).text().catch(() => "");
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const env = { ...(await envFile()), ...process.env } as Record<string, string | undefined>;
const BASE = (env.SPACE_API_URL || `http://${env.SPACE_HOST && env.SPACE_HOST !== "0.0.0.0" ? env.SPACE_HOST : "127.0.0.1"}:${env.SPACE_PORT || 8700}`).replace(/\/+$/, "");
const AUTH: Record<string, string> = env.SPACE_API_TOKEN ? { authorization: `Bearer ${env.SPACE_API_TOKEN}` } : {};

async function api<T>(method: string, path: string, body?: BodyInit, type?: string): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { ...AUTH, ...(type ? { "content-type": type } : {}) }, body });
  const text = await r.text();
  let json: { ok?: boolean; error?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${json.error ?? text.slice(0, 200)}`);
  return json as T;
}

// ------------------------------------------------------------------ helpers

function flags(argv: string[]) {
  const out: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) rest.push(a);
    else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) out[a.slice(2)] = argv[++i]!;
    else out[a.slice(2)] = true;
  }
  return { f: out, rest };
}
const str = (v: string | true | undefined, what: string) => {
  if (typeof v !== "string" || !v) throw new Error(`missing --${what}`);
  return v;
};
const fileOf = (id: string) => id.replaceAll("/", "~");
const zh = (x: { title: string; i18n?: Record<string, { title?: string; description?: string }> }) => {
  const t = Object.entries(x.i18n ?? {}).find(([k]) => k.startsWith("zh"))?.[1]?.title;
  return t && t !== x.title ? `${x.title} · ${t}` : x.title;
};

/** The drawn files in a work directory: kind, id, path. */
async function drawn(dir: string): Promise<{ kind: Kind; id: string; path: string; ext: string }[]> {
  const out: { kind: Kind; id: string; path: string; ext: string }[] = [];
  for (const kind of ["app", "agent"] as Kind[]) {
    for (const f of (await readdir(join(dir, kind)).catch(() => [] as string[])).sort()) {
      const m = f.match(/^(.+)\.(svg|png|webp)$/i);
      if (m) out.push({ kind, id: m[1]!.replaceAll("~", "/"), path: join(dir, kind, f), ext: m[2]!.toLowerCase() });
    }
  }
  return out;
}

// ------------------------------------------------------------------ commands

async function tiles(dir?: string) {
  const apps = await api<{ apps: { id: string; name: string; peer?: string; title: string; description?: string; icon: string; i18n?: Record<string, { title?: string; description?: string }> }[] }>("GET", "/api/apps?icons=manifest");
  const agents = await api<{ agents: { id: string; app: string; peer?: string; title: string; description?: string; avatar: string; appIcon: string; i18n?: Record<string, { title?: string; description?: string }> }[] }>("GET", "/api/agents?icons=manifest");
  const list: Tile[] = [
    ...apps.apps.map((a) => ({ kind: "app" as const, id: a.id, file: `app/${fileOf(a.id)}`, title: zh(a), description: a.description, ...(a.peer ? { peer: a.peer } : {}), icon: a.icon })),
    ...BUILTINS.map((b) => ({ kind: "app" as const, id: b.id, file: `app/${fileOf(b.id)}`, title: b.title, description: b.description, icon: `/${b.id.slice(6)}.svg`, builtin: true })),
    ...agents.agents.map((a) => ({ kind: "agent" as const, id: a.id, file: `agent/${fileOf(a.id)}`, title: zh(a), description: a.description, app: a.peer ? `${a.peer}/${a.app}` : a.app, ...(a.peer ? { peer: a.peer } : {}), icon: a.avatar })),
  ];
  if (dir) {
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "tiles.json"), JSON.stringify({ space: BASE, tiles: list }, null, 2) + "\n");
  }
  for (const t of list) console.log(`${t.kind.padEnd(6)} ${t.id.padEnd(34)} ${t.title}${t.app ? `  (of ${t.app})` : ""}`);
  console.log(`\n${list.filter((t) => t.kind === "app").length} app tiles, ${list.filter((t) => t.kind === "agent").length} agents${dir ? ` → ${join(dir, "tiles.json")}` : ""}`);
  return list;
}

async function current(dir: string) {
  const list = await tiles();
  const seen = new Set<string>();
  for (const t of list) {
    if (!t.icon.startsWith("/") || seen.has(t.icon)) continue;
    seen.add(t.icon);
    const r = await fetch(BASE + t.icon, { headers: AUTH });
    if (!r.ok) continue;
    const ext = Object.entries(TYPES).find(([, v]) => r.headers.get("content-type")?.startsWith(v))?.[0] ?? "svg";
    await Bun.write(join(dir, "current", t.kind, `${fileOf(t.id)}.${ext}`), await r.arrayBuffer());
  }
  console.log(`manifest icons → ${join(dir, "current")} (emoji icons have no file)`);
}

async function preview(dir: string, out?: string, only?: string[]) {
  const files = await drawn(dir);
  const meta = await Bun.file(join(dir, "tiles.json")).json().catch(() => ({ tiles: [] as Tile[] }));
  const byId = new Map<string, Tile>((meta.tiles as Tile[]).map((t) => [`${t.kind}:${t.id}`, t]));
  const pick = files.filter((f) => !only?.length || only.includes(f.id));
  const src = async (path: string, ext: string) => `data:${TYPES[ext]};base64,${Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64")}`;
  const appSrc = new Map<string, string>();
  for (const f of files.filter((x) => x.kind === "app")) appSrc.set(f.id, await src(f.path, f.ext));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const cell = async (f: (typeof files)[number]) => {
    const t = byId.get(`${f.kind}:${f.id}`);
    const corner = f.kind === "agent" ? (appSrc.get(t?.app ?? f.id.split("/").slice(0, -1).join("/")) ?? "") : "";
    const label = esc((t?.title ?? f.id).split(" · ").at(-1)!);
    return `<div class="t"><div class="i"><img src="${f.kind === "app" ? appSrc.get(f.id) : await src(f.path, f.ext)}">${corner ? `<span class="c"><img src="${corner}"></span>` : ""}</div><div class="n">${label}</div></div>`;
  };
  const section = async (kind: Kind, title: string) => {
    const list = pick.filter((f) => f.kind === kind);
    return list.length ? `<h2>${title} <small>${list.length}</small></h2><div class="g">${(await Promise.all(list.map(cell))).join("")}</div>` : "";
  };
  const body = `${await section("agent", "Agents · 智能体")}${await section("app", "Apps · 应用")}`;
  const small = (await Promise.all(pick.filter((f) => f.kind === "app").map(async (f) => `<img src="${appSrc.get(f.id)}">`))).join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:500 13px -apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif}
.th{padding:32px 48px}.dark{background:linear-gradient(135deg,#25265a,#1e2030 45%,#173040 75%,#3a1d40);color:#ececf4}.light{background:linear-gradient(135deg,#eef1f8,#e3e8f3 50%,#f4ecf1);color:#1d1f29}
h2{font-size:22px;margin:4px 0 18px}h2 small{font-size:13px;opacity:.6}.g{display:grid;grid-template-columns:repeat(8,112px);gap:24px 0;margin-bottom:28px}
.t{display:flex;flex-direction:column;align-items:center;gap:8px}.i{position:relative;width:64px;height:64px;border-radius:14px;border:1px solid rgba(255,255,255,.16);box-shadow:0 6px 18px rgba(0,0,0,.25)}
.light .i{border-color:rgba(0,0,0,.08);box-shadow:0 4px 14px rgba(30,40,80,.14)}
.i>img{width:100%;height:100%;border-radius:inherit;display:block;object-fit:cover}.c{position:absolute;right:-6px;bottom:-6px;width:26px;height:26px;border-radius:8px;border:2px solid #1d1f2a;overflow:hidden}
.light .c{border-color:#fff}.c img{width:100%;height:100%;display:block}.n{text-align:center;max-width:104px;overflow-wrap:anywhere}
.s{display:flex;gap:9px;flex-wrap:wrap;max-width:900px}.s img{width:22px;height:22px;border-radius:6px}
</style><div class="th dark">${body}<h2>22px</h2><div class="s">${small}</div></div><div class="th light"><h2>Light · 浅色</h2><div class="s" style="gap:14px">${small.replaceAll('<img ', '<img style="width:40px;height:40px;border-radius:9px" ')}</div></div>`;
  const htmlPath = join(dir, "preview.html");
  await Bun.write(htmlPath, html);
  const png = resolve(out ?? join(dir, "preview.png"));
  const chrome = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ...["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].map((b) => Bun.which(b) ?? ""),
  ].find((p) => p && Bun.file(p).size > 0);
  if (!chrome) {
    console.log(`no Chrome/Chromium found: open ${htmlPath} to look at the set`);
    return;
  }
  const rows = Math.ceil(pick.filter((f) => f.kind === "agent").length / 8) + Math.ceil(pick.filter((f) => f.kind === "app").length / 8);
  const height = 300 + rows * 118 + Math.ceil(pick.length / 28) * 34 + 200;
  await Bun.$`${chrome} --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size=1000,${height} --screenshot=${png} file://${resolve(htmlPath)}`.quiet().nothrow();
  console.log((await Bun.file(png).exists()) ? `preview → ${png}` : `the screenshot failed: open ${htmlPath}`);
}

async function install(dir: string, pack: string, activate: boolean, only?: string[]) {
  const files = (await drawn(dir)).filter((f) => !only?.length || only.includes(f.id));
  if (!files.length) throw new Error(`no icons in ${dir}/app or ${dir}/agent`);
  for (const f of files) {
    await api("PUT", `/api/panel/icons/${encodeURIComponent(pack)}/${f.kind}?id=${encodeURIComponent(f.id)}`, await Bun.file(f.path).arrayBuffer(), TYPES[f.ext]);
    console.log(`uploaded ${f.kind} ${f.id}`);
  }
  if (activate) await use(pack);
  else console.log(`pack "${pack}" has ${files.length} new icon(s); \`use ${pack}\` turns it on`);
}

async function use(pack: string) {
  const r = await api<{ active: string | null }>("PUT", "/api/panel/icons", JSON.stringify({ active: pack === "none" ? null : pack }), "application/json");
  console.log(r.active ? `active pack: ${r.active} (reload the panel)` : "no pack active: the manifests' icons are back");
}

async function packs() {
  const r = await api<{ active: string | null; packs: { name: string; icons: { kind: Kind; id: string }[] }[] }>("GET", "/api/panel/icons");
  if (!r.packs.length) console.log("no icon packs");
  for (const p of r.packs) console.log(`${p.name === r.active ? "*" : " "} ${p.name.padEnd(24)} ${p.icons.filter((i) => i.kind === "app").length} apps, ${p.icons.filter((i) => i.kind === "agent").length} agents`);
}

async function exportPack(pack: string, dir: string) {
  const r = await api<{ packs: { name: string; icons: { kind: Kind; id: string; url: string; type: string }[] }[] }>("GET", "/api/panel/icons");
  const p = r.packs.find((x) => x.name === pack);
  if (!p) throw new Error(`no pack "${pack}"`);
  for (const i of p.icons) {
    const ext = Object.entries(TYPES).find(([, v]) => v === i.type)?.[0] ?? "svg";
    const res = await fetch(BASE + i.url, { headers: AUTH });
    await Bun.write(join(dir, i.kind, `${fileOf(i.id)}.${ext}`), await res.arrayBuffer());
  }
  console.log(`${p.icons.length} icon(s) → ${dir}`);
}

async function remove(pack: string, kind?: Kind, id?: string) {
  if (kind && id) await api("DELETE", `/api/panel/icons/${encodeURIComponent(pack)}/${kind}?id=${encodeURIComponent(id)}`);
  else await api("DELETE", `/api/panel/icons/${encodeURIComponent(pack)}`);
  console.log(kind ? `removed ${kind} ${id} from "${pack}"` : `removed pack "${pack}"`);
}

const [cmd, ...argv] = Bun.argv.slice(2);
const { f, rest } = flags(argv);
const only = typeof f.only === "string" ? f.only.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
try {
  if (cmd === "tiles") await tiles(typeof f.dir === "string" ? f.dir : undefined);
  else if (cmd === "current") await current(str(f.dir, "dir"));
  else if (cmd === "preview") await preview(str(f.dir, "dir"), typeof f.out === "string" ? f.out : undefined, only);
  else if (cmd === "install") await install(str(f.dir, "dir"), str(f.pack, "pack"), f.activate === true, only);
  else if (cmd === "use") await use(rest[0] ?? str(f.pack, "pack"));
  else if (cmd === "packs") await packs();
  else if (cmd === "export") await exportPack(str(f.pack, "pack"), str(f.dir, "dir"));
  else if (cmd === "remove") await remove(str(f.pack, "pack"), f.app ? "app" : f.agent ? "agent" : undefined, typeof f.app === "string" ? f.app : typeof f.agent === "string" ? f.agent : undefined);
  else {
    console.log((await Bun.file(import.meta.path).text()).split("\n").slice(1, 18).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  console.error(`icons: ${(e as Error).message}`);
  process.exit(1);
}
