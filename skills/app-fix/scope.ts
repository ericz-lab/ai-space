#!/usr/bin/env bun
/**
 * The Fix Engineer's scope check (skills/app-fix/SKILL.md, docs/feedback.md#trust), run before every
 * commit and push:
 *
 *   bun scope.ts app-src/<app> [--workspace DIR]
 *
 * Refuses (exit 1, one line per problem) a checkout that is not `<workspace>/app-src/<name>` or not
 * the top of its own repository, and changes — uncommitted, staged or committed but not yet on the
 * upstream — that touch secret or data files, add a link leaving the repository, or carry text
 * that looks like a credential. Exit 0 prints the files in scope.
 */
import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Paths a fix never adds or changes. */
export const FORBIDDEN = [
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /(^|\/)space\.env$/,
  /(^|\/)runtimes\.yaml$/,
  /^data\//,
  /\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/,
  /(^|\/)node_modules\//,
  /\.(pem|key|p12|pfx)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)\.git\//,
];

/** Added lines that look like credentials. */
export const SECRET_LINE = /(\b(sk-(ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(SPACE_API_TOKEN|SPACE_APP_TOKEN|SPACE_HUB_TOKEN|GH_TOKEN)\s*=\s*\S{8,})/;

export function forbiddenPath(p: string): boolean {
  return FORBIDDEN.some((re) => re.test(p));
}

async function git(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out };
}

export async function checkScope(target: string, workspace: string): Promise<{ problems: string[]; files: string[] }> {
  const problems: string[] = [];
  let dir: string;
  try {
    dir = await realpath(resolve(target));
  } catch {
    return { problems: [`${target}: no such directory`], files: [] };
  }
  const ws = await realpath(workspace).catch(() => resolve(workspace));
  const rel = relative(join(ws, "app-src"), dir);
  if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) problems.push(`${dir} is not a checkout directly under ${join(ws, "app-src")}/`);
  const top = await git(dir, "rev-parse", "--show-toplevel");
  if (top.code !== 0) return { problems: [...problems, `${dir} is not a git checkout`], files: [] };
  if ((await realpath(top.out.trim()).catch(() => top.out.trim())) !== dir) problems.push(`${dir} is inside another repository (${top.out.trim()}), not the top of its own`);

  // What would leave this machine: the working tree's changes, and commits the upstream has not seen.
  const files = new Set<string>();
  const status = await git(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const entries = status.out.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const code = e.slice(0, 2);
    files.add(e.slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // the rename's source path follows
  }
  const upstream = await git(dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}");
  const base = upstream.code === 0 ? upstream.out.trim() : (await git(dir, "rev-parse", "--verify", "-q", "origin/main")).code === 0 ? "origin/main" : "";
  if (base) for (const f of (await git(dir, "diff", "--name-only", `${base}...HEAD`)).out.split("\n").filter(Boolean)) files.add(f);

  for (const f of files) {
    if (forbiddenPath(f)) problems.push(`${f}: secret, data or dependency files are never part of a fix`);
    const abs = join(dir, f);
    const st = await lstat(abs).catch(() => null);
    if (st?.isSymbolicLink()) {
      const to = resolve(dirname(abs), await readlink(abs));
      const r = relative(dir, to);
      if (r.startsWith("..") || isAbsolute(r)) problems.push(`${f}: a link that leaves the repository (${to})`);
    }
  }
  const diffs = [(await git(dir, "diff", "HEAD")).out, base ? (await git(dir, "diff", `${base}...HEAD`)).out : ""];
  for (const f of files) {
    if (!entries.some((e) => e.startsWith("??") && e.slice(3) === f)) continue;
    const text = await Bun.file(join(dir, f)).text().catch(() => "");
    diffs.push(text.split("\n").map((l) => `+${l}`).join("\n"));
  }
  for (const line of diffs.join("\n").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++") && SECRET_LINE.test(line)) {
      problems.push(`an added line looks like a credential: ${line.slice(0, 60)}…`);
      break;
    }
  }
  return { problems, files: [...files].sort() };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const wsAt = args.indexOf("--workspace");
  const workspace = wsAt >= 0 ? args[wsAt + 1] ?? "" : process.env.SPACE_HOME || join(homedir(), ".ai-space");
  const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--workspace");
  if (!target) {
    console.error("usage: bun scope.ts app-src/<app> [--workspace DIR]");
    process.exit(2);
  }
  const { problems, files } = await checkScope(target, workspace);
  if (problems.length) {
    for (const p of problems) console.error(`scope: ${p}`);
    process.exit(1);
  }
  console.log(`scope ok: ${files.length} file(s) in ${target}${files.length ? `\n  ${files.join("\n  ")}` : ""}`);
}
