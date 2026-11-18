import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { S3Client } from "bun";
import type { S3Config } from "../types.ts";

/**
 * Where snapshots go. Two backends behind one small interface: a directory
 * (`file:///abs/dir/`) and an S3-compatible bucket (`s3://bucket/prefix/`,
 * through Bun's `S3Client` with the workspace `SPACE_S3_*` credentials).
 * Keys are relative to the target root and always `<app>/<stamp>.<ext>`.
 */

export type ObjectInfo = { key: string; size: number };

export interface BackupTarget {
  readonly url: string;
  readonly kind: "file" | "s3";
  /** Upload a local file. Large files stream (multipart on S3). */
  put(key: string, localPath: string): Promise<void>;
  putText(key: string, text: string): Promise<void>;
  /** Download to a local path, creating parent directories. */
  get(key: string, localPath: string): Promise<void>;
  /** undefined when the object does not exist. */
  getText(key: string): Promise<string | undefined>;
  list(prefix: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
}

export function parseTargetUrl(url: string): { kind: "file"; dir: string } | { kind: "s3"; bucket: string; prefix: string } {
  const u = url.trim();
  const file = /^file:\/\/(.+)$/.exec(u);
  if (file) return { kind: "file", dir: resolve(file[1]!.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) };
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u);
  if (s3) {
    let prefix = s3[2] ?? "";
    if (prefix && !prefix.endsWith("/")) prefix += "/";
    return { kind: "s3", bucket: s3[1]!, prefix };
  }
  throw new Error(`SPACE_BACKUP_URL must be s3://bucket/prefix/ or file:///dir/, got ${u || "(empty)"}`);
}

export function openBackupTarget(url: string, s3?: S3Config, opts: S3TargetOptions = {}): BackupTarget {
  const parsed = parseTargetUrl(url);
  if (parsed.kind === "file") return new FileTarget(parsed.dir);
  if (!s3) throw new Error(`SPACE_BACKUP_URL is ${url} but SPACE_S3_ACCESS_KEY_ID / SPACE_S3_SECRET_ACCESS_KEY are not set`);
  return new S3Target(parsed.bucket, parsed.prefix, s3, opts);
}

export class FileTarget implements BackupTarget {
  readonly kind = "file" as const;
  readonly url: string;
  constructor(readonly dir: string) {
    this.url = `file://${dir}/`;
  }
  private path(key: string): string {
    const p = resolve(this.dir, key);
    if (!p.startsWith(`${this.dir}/`)) throw new Error(`key escapes the target: ${key}`);
    return p;
  }
  async put(key: string, localPath: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, Bun.file(localPath));
  }
  async putText(key: string, text: string): Promise<void> {
    const dest = this.path(key);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, text);
  }
  async get(key: string, localPath: string): Promise<void> {
    const src = Bun.file(this.path(key));
    if (!(await src.exists())) throw new Error(`no such object: ${key}`);
    await mkdir(dirname(localPath), { recursive: true });
    await Bun.write(localPath, src);
  }
  async getText(key: string): Promise<string | undefined> {
    const f = Bun.file(this.path(key));
    return (await f.exists()) ? f.text() : undefined;
  }
  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    const walk = async (dir: string) => {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        const p = join(dir, name);
        const s = await stat(p);
        if (s.isDirectory()) await walk(p);
        else {
          const key = relative(this.dir, p);
          if (key.startsWith(prefix)) out.push({ key, size: s.size });
        }
      }
    };
    await walk(this.dir);
    return out;
  }
  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
  }
}

/**
 * Waits before the second, third and fourth attempt of an S3 call that failed on the way, not by
 * the service's answer. A laptop that sleeps through its backup slot wakes for a few seconds at a
 * time and goes back to sleep mid-upload, which drops the connection (Bun reports `ConnectionClosed`,
 * "an unexpected error has occurred"); the wait runs on while it sleeps, so a later attempt lands
 * on a later wake. 6¼ minutes in all, well inside the task's timeout.
 */
export const S3_RETRY_DELAYS_MS = [15_000, 60_000, 5 * 60_000];

/**
 * Codes of a Bun `S3Error` worth another attempt: the connection failed or timed out, or the service
 * asked to try again. Anything else (AccessDenied, NoSuchBucket, a bad signature) is the answer.
 */
const TRANSIENT_S3_CODE = /^(Connection\w*|E[A-Z]+|\w*Time[dD]?Out|\w*Timeout|InternalError|ServiceUnavailable|SlowDown)$/;

export function isTransientS3Error(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && TRANSIENT_S3_CODE.test(code);
}

export type S3TargetOptions = {
  /** Waits between attempts; `[]` makes one attempt. Default S3_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Told about each attempt that failed and will be made again. */
  log?: (message: string) => void;
};

export class S3Target implements BackupTarget {
  readonly kind = "s3" as const;
  readonly url: string;
  private readonly client: S3Client;
  private readonly delays: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string) => void;
  constructor(
    readonly bucket: string,
    readonly prefix: string,
    s3: S3Config,
    opts: S3TargetOptions = {},
  ) {
    this.delays = opts.retryDelaysMs ?? S3_RETRY_DELAYS_MS;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.log = opts.log ?? (() => {});
    this.url = `s3://${bucket}/${prefix}`;
    this.client = new S3Client({
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      bucket,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      ...(s3.region ? { region: s3.region } : {}),
    });
  }
  private full(key: string): string {
    return `${this.prefix}${key}`;
  }
  /**
   * Run one S3 call, again after each delay while it fails on the way. The error that ends it
   * names the S3 code, the operation and the attempts, since Bun's own message for a dropped
   * connection says only "an unexpected error has occurred".
   */
  private async attempt<T>(op: string, key: string, fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        const what = `${(e as Error).message ?? String(e)}${typeof code === "string" ? ` (S3 ${code})` : ""}`;
        const delay = this.delays[i];
        if (delay === undefined || !isTransientS3Error(e)) {
          throw new Error(`S3 ${op} ${this.url}${key}: ${what}${i ? ` after ${i + 1} attempts` : ""}`, { cause: e });
        }
        this.log(`S3 ${op} ${key}: ${what}; attempt ${i + 2} of ${this.delays.length + 1} in ${Math.round(delay / 1000)}s`);
        await this.sleep(delay);
      }
    }
  }
  async put(key: string, localPath: string): Promise<void> {
    await this.attempt("put", key, () => this.client.write(this.full(key), Bun.file(localPath)));
  }
  async putText(key: string, text: string): Promise<void> {
    await this.attempt("put", key, () => this.client.write(this.full(key), text, { type: "application/json" }));
  }
  async get(key: string, localPath: string): Promise<void> {
    await mkdir(dirname(localPath), { recursive: true });
    await this.attempt("get", key, () => Bun.write(localPath, this.client.file(this.full(key))));
  }
  async getText(key: string): Promise<string | undefined> {
    return this.attempt("get", key, async () => {
      const f = this.client.file(this.full(key));
      if (!(await f.exists())) return undefined;
      return f.text();
    });
  }
  async list(prefix: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let startAfter: string | undefined;
    for (;;) {
      const page = await this.attempt("list", prefix, () => this.client.list({ prefix: this.full(prefix), maxKeys: 1000, ...(startAfter ? { startAfter } : {}) }));
      for (const o of page.contents ?? []) {
        if (o.key.startsWith(this.prefix)) out.push({ key: o.key.slice(this.prefix.length), size: o.size ?? 0 });
      }
      const last = page.contents?.at(-1)?.key;
      if (!page.isTruncated || !last) break;
      startAfter = last;
    }
    return out;
  }
  async delete(key: string): Promise<void> {
    await this.attempt("delete", key, () => this.client.delete(this.full(key)));
  }
}
