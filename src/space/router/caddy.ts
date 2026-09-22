import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The Caddy backend: the file on disk and the running instance. ai-space
 * never starts Caddy; the operator's user unit does (docs/install.md). This
 * only writes the configuration and asks the instance to load it through
 * the admin socket. The shell runner is injected so tests use a fake.
 */

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: string[]) => Promise<RunResult>;

export type CaddyOptions = {
  /** The binary; `caddy` on PATH by default. */
  bin: string;
  /** The Caddyfile ai-space writes. */
  file: string;
  /** The admin unix socket the Caddyfile declares. */
  socket: string;
  run?: Runner;
};

export class CaddyBackend {
  private readonly run: Runner;

  constructor(private readonly opts: CaddyOptions) {
    this.run = opts.run ?? spawnCollect;
  }

  get file(): string {
    return this.opts.file;
  }

  /** Write the file when its content differs; true when it was written. */
  async write(text: string): Promise<boolean> {
    const f = Bun.file(this.opts.file);
    if ((await f.exists()) && (await f.text()) === text) return false;
    await mkdir(dirname(this.opts.file), { recursive: true });
    await Bun.write(this.opts.file, text);
    return true;
  }

  /** Ask the running instance to load the file; throws with Caddy's last line on failure. */
  async reload(): Promise<void> {
    const r = await this.run([this.opts.bin, "reload", "--config", this.opts.file, "--adapter", "caddyfile", "--address", `unix/${this.opts.socket}`]);
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `caddy reload exited with ${r.code}`);
  }

  /** True when the binary runs. */
  async installed(): Promise<boolean> {
    return (await this.run([this.opts.bin, "version"])).code === 0;
  }
}

function lastLine(text: string): string {
  return text.trim().split("\n").at(-1)?.trim() ?? "";
}

async function spawnCollect(cmd: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
}
