/**
 * `bun release/manifest.ts <dir> --version V --commit SHA [--run URL]`: what the release job
 * publishes next to the artifacts in <dir> (docs/release.md):
 *
 *   SHA256SUMS      one `<sha256>  <file>` line per artifact, for `sha256sum -c`
 *   manifest.json   version, commit, the run that built it, every artifact with size and sha256
 *   NOTES.md        the draft release's text: what each file is, whether the Mac build is signed
 *
 * Before hashing it copies every AI Space Desktop file to a name without the version
 * (`ai-space-desktop-macos-arm64.dmg`, ...: stableName), so
 * `releases/latest/download/<name>` and the ai-space.me download links keep working across releases.
 */
import { copyFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type Artifact = { name: string; size: number; sha256: string };
export type Manifest = { product: "ai-space"; version: string; commit: string; run?: string; created: string; artifacts: Artifact[] };

const OWN = new Set(["SHA256SUMS", "manifest.json", "NOTES.md"]);

export async function artifacts(dir: string): Promise<Artifact[]> {
  const names = (await readdir(dir)).filter((n) => !OWN.has(n) && !n.startsWith(".")).sort();
  const out: Artifact[] = [];
  for (const name of names) {
    const bytes = await Bun.file(join(dir, name)).bytes();
    out.push({ name, size: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  return out;
}

const DESKTOP = /^ai-space-desktop-\d.*?-(macos|windows|linux)-(x64|arm64)(?:-unsigned)?(\.dmg|\.exe|\.tar\.gz)$/;

/** The name an AI Space Desktop file also gets, the same in every release; undefined for any other file. */
export function stableName(name: string): string | undefined {
  const m = DESKTOP.exec(name);
  return m ? `ai-space-desktop-${m[1]}-${m[2]}${m[3]}` : undefined;
}

/** Copies each AI Space Desktop file in <dir> to its stableName; returns the names written. */
export async function addStableNames(dir: string): Promise<string[]> {
  const written: string[] = [];
  for (const name of (await readdir(dir)).sort()) {
    const stable = stableName(name);
    if (!stable || stable === name) continue;
    if (written.includes(stable)) throw new Error(`${dir}: two files would be ${stable}`);
    await copyFile(join(dir, name), join(dir, stable));
    written.push(stable);
  }
  return written;
}

export function sums(list: Artifact[]): string {
  return list.map((a) => `${a.sha256}  ${a.name}\n`).join("");
}

export function notes(m: Manifest): string {
  const lines = [`AI Space ${m.version}, built from ${m.commit.slice(0, 12)}${m.run ? ` ([run](${m.run}))` : ""}.`, "", "| File | What it is |", "| --- | --- |"];
  for (const a of m.artifacts) {
    let what = "";
    const same = m.artifacts.find((b) => b.name !== a.name && stableName(b.name) === a.name);
    if (same) what = `The same file as \`${same.name}\`, under a name that stays the same in every release (\`releases/latest/download/${a.name}\`, the ai-space.me download page)`;
    else if (a.name === "install.sh") what = "The one-command installer: `curl -fsSL https://ai-space.me/install.sh | bash` sends curl here; it installs this release's AI Space for the machine it runs on (docs/release.md#one-command-install)";
    else if (a.name === "install.ps1") what = "The one-command installer for Windows: `irm https://ai-space.me/install.ps1 | iex` fetches this; it installs this release's AI Space on Windows itself, without WSL (docs/release.md#one-command-install)";
    else if (/^ai-space-desktop-.*-linux-/.test(a.name)) what = "AI Space Desktop for Linux (GNOME and other GTK desktops), the app that connects to an AI Space: unpack, then `<dir>/install.sh` (docs/linux-desktop.md)";
    else if (/^ai-space-desktop-.*-windows-/.test(a.name)) what = "AI Space Desktop for Windows 10 and 11, **not signed** (SmartScreen asks once): one program file, run it and it offers to install itself for the user (docs/windows-desktop.md)";
    else if (/^ai-space-desktop-.*-macos-.*-unsigned/.test(a.name)) what = "AI Space Desktop for Mac, **not signed**: for testing only, macOS blocks it for everyone else";
    else if (/^ai-space-desktop-.*-macos-/.test(a.name)) what = "AI Space Desktop for Mac: signed and notarized (docs/macos-desktop.md)";
    else if (/^ai-space-\d.*-windows-/.test(a.name)) what = "AI Space (the service and its web panel) for Windows 10 and 11 (x64), without WSL; the one-command installer fetches it. By hand: unpack, then `powershell -ExecutionPolicy Bypass -File <dir>\\install.ps1` (a Task Scheduler task; docs/release.md)";
    else if (/^ai-space-\d.*-macos-/.test(a.name)) what = "AI Space (the service and its web panel) for a Mac (Apple silicon); the one-command installer fetches it. By hand: unpack, then `bash <dir>/install.sh` (a LaunchAgent; docs/release.md)";
    else if (/^ai-space-\d.*-linux-/.test(a.name)) what = "AI Space (the service and its web panel) for Linux; the one-command installer fetches it. By hand: unpack, then `bash <dir>/install.sh` (a systemd user unit; docs/release.md)";
    lines.push(`| \`${a.name}\` | ${what} |`);
  }
  lines.push("", "Verify a download with `sha256sum -c SHA256SUMS --ignore-missing` (on a Mac: `shasum -a 256 -c`).");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const [dir] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const version = flag("version");
  const commit = flag("commit");
  if (!dir || !version || !commit) {
    console.error("usage: bun release/manifest.ts <dir> --version V --commit SHA [--run URL]");
    process.exit(2);
  }
  await addStableNames(dir);
  const list = await artifacts(dir);
  if (!list.length) throw new Error(`${dir}: no artifacts`);
  const run = flag("run");
  const m: Manifest = { product: "ai-space", version, commit, ...(run ? { run } : {}), created: new Date().toISOString(), artifacts: list };
  await Bun.write(join(dir, "SHA256SUMS"), sums(list));
  await Bun.write(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  await Bun.write(join(dir, "NOTES.md"), notes(m));
  console.log(`${list.length} artifacts, SHA256SUMS, manifest.json and NOTES.md in ${dir}`);
}
