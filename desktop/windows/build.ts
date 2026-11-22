/**
 * The Windows client as one program file that runs where it lies (docs/windows-desktop.md):
 *
 *   bun desktop/windows/build.ts [--out <dir>] [--arch x64|arm64]
 *
 * The folder (default desktop/windows/build/ai-space) holds AISpace.exe alone: a single-file
 * `dotnet publish` of AISpace/, self-contained for win-<arch>, so the computer needs no .NET (it
 * needs the WebView2 Runtime, which Windows 10 and 11 carry). The native libraries WPF and WebView2
 * load are inside it and unpack themselves on the first start; the version is the file's own.
 *
 * The app carries no AI Space: it finds the one on the computer or runs the release's installer
 * (docs/windows-desktop.md#this-computer). dotnet builds the app anywhere, but only on Windows
 * does the program file get its icon and version (the SDK says NETSDK1074 elsewhere), so releases
 * build it on Windows.
 */
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SPACE_ROOT } from "../../src/space/config.ts";
import { readVersion } from "../../src/space/version.ts";
import { run } from "../../release/server.ts";

const HERE = join(SPACE_ROOT, "desktop", "windows");
export type WindowsArch = "x64" | "arm64";

/** The CPU this machine's .NET and Bun are for, as the release names it. */
export function hostArch(): WindowsArch {
  if (process.arch === "x64" || process.arch === "arm64") return process.arch;
  throw new Error(`no Windows build for ${process.arch}`);
}

/**
 * Publish-only settings, here rather than in the project so `dotnet build` and the tests stay a
 * plain build. No trimming: WPF does not support it. Without the last one the packages' XML API
 * documentation would lie beside the program.
 */
const SINGLE_FILE = ["-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-p:EnableCompressionInSingleFile=true", "-p:DebugType=embedded", "-p:PublishReferencesDocumentationFiles=false"];

export async function buildWindows(opts: { out?: string; arch?: WindowsArch; root?: string } = {}): Promise<{ dir: string; exe: string; version: string }> {
  const root = opts.root ?? SPACE_ROOT;
  const arch = opts.arch ?? hostArch();
  const dir = resolve(opts.out ?? join(HERE, "build", "ai-space"));
  await rm(dir, { recursive: true, force: true });

  // The version comes from Directory.Build.props, a copy of package.json's (bun run set-version).
  await run([process.env.DOTNET || "dotnet", "publish", join(HERE, "AISpace", "AISpace.csproj"), "-c", "Release", "-r", `win-${arch}`, "--self-contained", ...SINGLE_FILE, "--nologo", "-o", dir], root);

  const version = await readVersion(root);
  const exe = join(dir, "AISpace.exe");
  if (!(await Bun.file(exe).exists())) throw new Error(`dotnet publish left no ${exe}`);
  console.error(`[windows] ${version} ${arch} → ${exe}`);
  return { dir, exe, version };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arch = value("--arch");
  if (arch !== undefined && arch !== "x64" && arch !== "arm64") throw new Error("--arch is x64 or arm64");
  const out = value("--out");
  console.log((await buildWindows({ ...(out ? { out } : {}), ...(arch ? { arch } : {}) })).exe);
}
