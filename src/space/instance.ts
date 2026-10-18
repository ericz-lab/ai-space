import { dlopen, FFIType } from "bun:ffi";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

/**
 * One Space service per workspace (docs/editions.md#ai-space-local). `start` takes an exclusive
 * `flock` on `<workspace>/run/service.lock` for the life of the process; a second service on the
 * same workspace, from any edition or launcher, finds it held and refuses to boot instead of
 * starting a second scheduler. The kernel drops the lock when the process ends, however it ends,
 * so a crash never leaves a stale lock. `run/service.json` says who holds it, for the message.
 */

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let flock: ((fd: number, op: number) => number) | undefined;

function lib(): (fd: number, op: number) => number {
  if (flock) return flock;
  const name = process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
  const { symbols } = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  flock = (fd, op) => symbols.flock(fd, op);
  return flock;
}

export type Holder = { pid: number; port?: number; edition?: string; version?: string; startedAt: string };

export class WorkspaceBusy extends Error {
  constructor(
    readonly workspace: string,
    readonly holder: Holder | undefined,
  ) {
    super(`another ai-space service already runs on ${workspace}${holder ? ` (pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ""}, since ${holder.startedAt})` : ""}; stop it first, or point SPACE_HOME at another workspace`);
  }
}

export type WorkspaceLock = { release(): void; readonly path: string };

export const lockPath = (runDir: string) => join(runDir, "service.lock");
export const holderPath = (runDir: string) => join(runDir, "service.json");

/** Locks this process holds, kept on `globalThis` so `bun --hot` re-running `start` finds its own. */
const held = ((globalThis as { __spaceWorkspaceLocks?: Map<string, WorkspaceLock> }).__spaceWorkspaceLocks ??= new Map());

/** Takes the workspace's lock or throws `WorkspaceBusy`. Writes `run/service.json` once it holds it. */
export async function acquireWorkspaceLock(runDir: string, workspace: string, holder: Omit<Holder, "pid" | "startedAt">): Promise<WorkspaceLock> {
  mkdirSync(runDir, { recursive: true });
  const path = lockPath(runDir);
  const mine = held.get(path);
  if (mine) return mine;
  const fd = openSync(path, "a+", 0o600);
  if (lib()(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    throw new WorkspaceBusy(workspace, await readHolder(runDir));
  }
  await Bun.write(holderPath(runDir), `${JSON.stringify({ pid: process.pid, ...holder, startedAt: new Date().toISOString() } satisfies Holder, null, 2)}\n`);
  let open = true;
  const lock: WorkspaceLock = {
    path,
    release() {
      if (!open) return;
      open = false;
      held.delete(path);
      lib()(fd, LOCK_UN);
      closeSync(fd);
    },
  };
  held.set(path, lock);
  return lock;
}

/** Whether a service holds the workspace's lock right now, without taking it. */
export function workspaceLocked(runDir: string): boolean {
  let fd: number;
  try {
    fd = openSync(lockPath(runDir), "r");
  } catch {
    return false;
  }
  try {
    if (lib()(fd, LOCK_EX | LOCK_NB) !== 0) return true;
    lib()(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
}

export async function readHolder(runDir: string): Promise<Holder | undefined> {
  try {
    return (await Bun.file(holderPath(runDir)).json()) as Holder;
  } catch {
    return undefined;
  }
}
