import { mkdir } from "node:fs/promises";

/**
 * The archive step: one `tar` stream compressed by `zstd`, both spawned as
 * the system binaries (GNU or BSD tar, any zstd). Nothing is buffered in
 * memory; the hash is computed by streaming the finished file.
 */

export const ARCHIVE_TOOLS = ["tar", "zstd"] as const;

export function missingArchiveTools(): string[] {
  return ARCHIVE_TOOLS.filter((t) => !Bun.which(t));
}

export function requireArchiveTools(): void {
  const missing = missingArchiveTools();
  if (missing.length) throw new Error(`backup needs ${missing.join(" and ")} on PATH (apt-get install ${missing.join(" ")})`);
}

export async function createArchive(stageDir: string, outPath: string): Promise<{ bytes: number; sha256: string }> {
  await pipe(["tar", "-cf", "-", "-C", stageDir, "."], ["zstd", "-q", "-T0", "-o", outPath]);
  return hashFile(outPath);
}

export async function extractArchive(archivePath: string, toDir: string): Promise<void> {
  await mkdir(toDir, { recursive: true });
  await pipe(["zstd", "-dc", archivePath], ["tar", "-xf", "-", "-C", toDir]);
}

/** File paths inside the archive, relative, directories left out. */
export async function listArchive(archivePath: string): Promise<string[]> {
  const text = await pipe(["zstd", "-dc", archivePath], ["tar", "-tf", "-"]);
  return text
    .split("\n")
    .map((l) => l.trim().replace(/^\.\//, ""))
    .filter((l) => l && l !== "." && !l.endsWith("/"))
    .sort();
}

export async function hashFile(path: string): Promise<{ bytes: number; sha256: string }> {
  const hasher = new Bun.CryptoHasher("sha256");
  let bytes = 0;
  const reader = Bun.file(path).stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hasher.update(value);
    bytes += value.byteLength;
  }
  return { bytes, sha256: hasher.digest("hex") };
}

/**
 * `first | second`, failing when either side fails (a shell pipeline reports only the second, so a
 * tar that stopped halfway would leave a short archive that looks fine). Returns the second's stdout.
 */
async function pipe(first: string[], second: string[]): Promise<string> {
  const a = Bun.spawn(first, { stdout: "pipe", stderr: "pipe" });
  const b = Bun.spawn(second, { stdin: a.stdout, stdout: "pipe", stderr: "pipe" });
  const [out, errA, errB, codeA, codeB] = await Promise.all([
    new Response(b.stdout).text(),
    new Response(a.stderr).text(),
    new Response(b.stderr).text(),
    a.exited,
    b.exited,
  ]);
  // When both fail, the cause is usually upstream (GNU tar fails on the empty stream a dead zstd
  // leaves), unless upstream only died of SIGPIPE because downstream had already gone.
  const brokenPipe = a.signalCode === "SIGPIPE" || codeA === 141;
  if (codeA !== 0 && !brokenPipe) throw new Error(`${first[0]} exited with ${codeA}: ${errA.trim()}`);
  if (codeB !== 0) throw new Error(`${second[0]} exited with ${codeB}: ${errB.trim() || errA.trim()}`);
  if (codeA !== 0) throw new Error(`${first[0]} exited with ${codeA}: ${errA.trim()}`);
  return out;
}
