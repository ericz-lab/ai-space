/**
 * `bun release/manifest.ts <dir> --version V --commit SHA [--run URL]`: what the release job
 * publishes next to the artifacts in <dir> (docs/release.md):
 *
 *   SHA256SUMS      one `<sha256>  <file>` line per artifact, for `sha256sum -c`
 *   manifest.json   version, commit, the run that built it, every artifact with size and sha256
 *   NOTES.md        the draft release's text: what each file is, whether the Mac build is signed
 */
import { readdir } from "node:fs/promises";
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

export function sums(list: Artifact[]): string {
  return list.map((a) => `${a.sha256}  ${a.name}\n`).join("");
}

export function notes(m: Manifest): string {
  const lines = [`AI Space ${m.version}, built from ${m.commit.slice(0, 12)}${m.run ? ` ([run](${m.run}))` : ""}.`, "", "| File | What it is |", "| --- | --- |"];
  for (const a of m.artifacts) {
    let what = "";
    if (a.name.startsWith("ai-space-server-")) what = "Server edition: unpack, then `bash <dir>/install.sh` (Linux, systemd user unit; docs/release.md)";
    else if (a.name.startsWith("ai-space-client-") && a.name.includes("-unsigned")) what = "Client edition for Mac, **not signed**: for testing only, macOS blocks it for everyone else";
    else if (a.name.startsWith("ai-space-client-")) what = "Client edition for Mac: signed and notarized";
    else if (a.name.startsWith("ai-space-local-") && a.name.includes("-unsigned")) what = "Local edition for Mac (the app with the service inside), **not signed**: for testing only";
    else if (a.name.startsWith("ai-space-local-")) what = "Local edition for Mac: the app with the service inside, signed and notarized (docs/local.md)";
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
  const list = await artifacts(dir);
  if (!list.length) throw new Error(`${dir}: no artifacts`);
  const run = flag("run");
  const m: Manifest = { product: "ai-space", version, commit, ...(run ? { run } : {}), created: new Date().toISOString(), artifacts: list };
  await Bun.write(join(dir, "SHA256SUMS"), sums(list));
  await Bun.write(join(dir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
  await Bun.write(join(dir, "NOTES.md"), notes(m));
  console.log(`${list.length} artifacts, SHA256SUMS, manifest.json and NOTES.md in ${dir}`);
}
